import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GatewayError, MAX_FILE_BYTES, MAX_FILES } from "../contracts";
import type { AdapterContext, CheckResult, Credentials, ProviderAdapter, RunFile, RunImage, RunResult, ThreadDeletion } from "../contracts";
import { createMuseAdapter as createBrowserAdapter, sanitizeDiagnostics } from "./muse/engine";

const MAX_ATTEMPTS = 2;
const WORKER_LOG_LIMIT = 256 * 1024;
const WORKER_LOG_TAIL = 2_000;
/** Failures a second attempt cannot fix: the request, the reference upload or the account configuration is wrong, not the session. */
const FATAL_CODES = new Set(["muse_cancelled", "muse_credentials", "muse_prompt", "muse_attachment"]);
const RETRY_NOTE = "The first Muse attempt did not confirm completion; the account session was re-verified and the run was retried once.";

/**
 * Appends one bounded, credential-free line per worker run under `<dataDir>/logs`. A failure here must never surface as a
 * job failure, and the file is trimmed before it can grow without bound.
 */
async function logWorkerRun(context: AdapterContext, line: string): Promise<void> {
  try {
    const directory = join(context.dataDir, "logs");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "muse-worker.log");
    const existing = await stat(file).catch(() => null);
    if (existing && existing.size > WORKER_LOG_LIMIT) await truncate(file, 0);
    await appendFile(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Diagnostics are best-effort.
  }
}

const imageSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataB64: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  revisedPrompt: z.string().optional(),
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submitted") }),
  z.object({ type: z.literal("accepted"), remoteId: z.string().nullable() }),
  z.object({ type: z.literal("credentials"), credentials: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("checked"), detail: z.string() }),
  z.object({ type: z.literal("deleted"), outcome: z.enum(["deleted", "gone", "failed"]) }),
  z.object({ type: z.literal("file"), name: z.string(), mime: z.string(), dataB64: z.string().max(Math.ceil(MAX_FILE_BYTES / 3) * 4) }),
  z.object({ type: z.literal("completed"), text: z.string(), remoteId: z.string().nullable(), images: z.array(imageSchema).default([]) }),
  z.object({ type: z.literal("failed"), code: z.string(), message: z.string(), status: z.number(), uncertain: z.boolean() }),
]);
type WorkerEvent = z.infer<typeof eventSchema>;
type Terminal = Extract<WorkerEvent, { type: "checked" | "deleted" | "completed" | "failed" }>;
type WorkerReply = Exclude<Terminal, { type: "failed" } | { type: "completed" }>
  | (Extract<Terminal, { type: "completed" }> & { readonly files: readonly RunFile[] });

// Compile our TypeScript worker once; the browser's officially supported Node
// runtime owns all Playwright subprocesses. Credentials travel over stdin only.
let program: Promise<string> | undefined;
function workerProgram(): Promise<string> {
  program ??= Bun.build({
    entrypoints: [fileURLToPath(new URL("./muse/worker.ts", import.meta.url))],
    target: "node", packages: "external",
  }).then(async (build) => {
    if (!build.success || !build.outputs[0]) throw new GatewayError("muse_worker", "Could not compile the Muse browser worker.", 503);
    return build.outputs[0].text();
  });
  return program;
}

// A service manager's PATH is not the interactive shell's PATH, so report a missing or too-old node
// as the runtime problem it is instead of blaming the user's Node.js installation.
let resolvedNode: string | undefined;
function nodeBinary(): string {
  if (resolvedNode) return resolvedNode;
  const node = Bun.which("node");
  if (!node) {
    throw new GatewayError("muse_runtime", "The Muse browser worker needs Node.js 22 or newer, but no \"node\" was found on the gateway service PATH.", 503);
  }
  const version = new TextDecoder().decode(Bun.spawnSync([node, "-v"], { stdout: "pipe" }).stdout).trim();
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? "");
  if (!Number.isInteger(major) || major < 22) {
    throw new GatewayError("muse_runtime", `The Muse browser worker needs Node.js 22 or newer, but the gateway service PATH provides Node.js ${version || node}.`, 503);
  }
  resolvedNode = node;
  return node;
}

/** Fixed per adapter and sent to every worker over stdin; the worker never reads the gateway's environment. */
interface WorkerSettings {
  readonly site: string;
  readonly chatTimeout: number;
  readonly pruneThreads: boolean;
}

async function callWorker(
  operation: "check" | "run" | "delete",
  settings: WorkerSettings,
  credentials: Credentials,
  prompt: string,
  context: AdapterContext,
): Promise<WorkerReply> {
  const node = nodeBinary();
  if (context.signal.aborted) throw new GatewayError("muse_cancelled", "Muse operation cancelled.", 409);
  const child = Bun.spawn([node, "--input-type=module", "--eval", await workerProgram()], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdin: new Blob([JSON.stringify({
      operation, ...settings, credentials, prompt, accountId: context.accountId, dataDir: context.dataDir, threadId: context.threadId ?? null,
      referenceImages: (context.referenceImages ?? []).map((image) => ({ mime: image.mime, dataB64: Buffer.from(image.data).toString("base64") })),
    })]),
    stdout: "pipe", stderr: "pipe",
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  // Drain stderr privately: Chrome diagnostics must not leak paths or credentials to API clients.
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let terminal: Terminal | undefined;
  let outcome = "the worker ended before confirming a result";
  const files: RunFile[] = [];
  let fragments: string[] = [];
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const lines = decoder.decode(chunk.value, { stream: true }).split("\n");
      const tail = lines.pop() ?? "";
      for (const piece of lines) {
        fragments.push(piece);
        const line = fragments.join("");
        fragments = [];
        if (!line) continue;
        const event = eventSchema.parse(JSON.parse(line));
        switch (event.type) {
          case "submitted": context.onSubmitted?.(); break;
          case "accepted": context.onAccepted?.(event.remoteId); break;
          case "credentials": context.saveCredentials?.(event.credentials); break;
          case "file": {
            const data = Buffer.from(event.dataB64, "base64");
            if (files.length >= MAX_FILES || data.byteLength > MAX_FILE_BYTES) {
              throw new GatewayError("muse_worker", "Muse worker exceeded the attachment limit.", 502, true);
            }
            files.push({ name: event.name, mime: event.mime, data });
            break;
          }
          case "checked":
          case "deleted":
          case "completed":
          case "failed": terminal = event; break;
        }
      }
      if (tail) fragments.push(tail);
    }
    const code = await child.exited;
    await stderr;
    if (code !== 0 || !terminal) throw new GatewayError("muse_worker", "Muse browser worker ended before confirming a result.", 502, operation === "run");
    if (terminal.type === "failed") {
      outcome = `${terminal.code}: ${terminal.message}`;
      throw new GatewayError(terminal.code, terminal.message, terminal.status, terminal.uncertain);
    }
    outcome = terminal.type === "completed" ? "completed" : "checked";
    return terminal.type === "completed" ? { ...terminal, files } : terminal;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    outcome = "the worker response could not be verified";
    throw new GatewayError("muse_worker", "Muse worker response could not be verified.", 502, operation === "run");
  } finally {
    context.signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    const noise = (await stderr).trim();
    reader.releaseLock();
    // Chrome diagnostics stay out of API responses, but a trimmed tail belongs in the operator's own log file.
    const tail = noise && outcome !== "completed" && outcome !== "checked"
      ? ` | chrome: ${sanitizeDiagnostics(noise.slice(-WORKER_LOG_TAIL))}`
      : "";
    await logWorkerRun(context, `op=${operation} outcome=${sanitizeDiagnostics(outcome)}${tail}`);
  }
}

export function createMuseAdapter(site = "https://muse.ai", chatTimeout = 600_000): ProviderAdapter {
  const definition = createBrowserAdapter(site, chatTimeout);
  const settings: WorkerSettings = { site, chatTimeout, pruneThreads: false };
  /** Re-verifies the account's session: the same work the console's Check button performs. */
  const reconnect = async (credentials: Credentials, context: AdapterContext): Promise<CheckResult> => {
    definition.validate(credentials);
    const result = await callWorker("check", settings, credentials, "", context);
    if (result.type !== "checked") throw new GatewayError("muse_worker", "Unexpected Muse check result.", 502);
    return { detail: result.detail };
  };
  /**
   * A finished job deletes its own side chat when the gateway says so (`pruneAfter`: a keyless chat request) or the account's
   * context switch is off (the older rule, kept as is). Deletion cannot be undone, so nothing else may turn it on.
   */
  const runSettings = (context: AdapterContext): WorkerSettings => ({ ...settings, pruneThreads: context.keepContext === false || context.pruneAfter === true });
  const runOnce = async (credentials: Credentials, prompt: string, context: AdapterContext): Promise<RunResult> => {
    const result = await callWorker("run", runSettings(context), credentials, prompt, context);
    if (result.type !== "completed") throw new GatewayError("muse_worker", "Unexpected Muse job result.", 502, true);
    const images: RunImage[] = result.images.map((image) => ({
      mime: image.mime,
      data: new Uint8Array(Buffer.from(image.dataB64, "base64")),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
    }));
    return {
      text: result.text, remoteId: result.remoteId,
      ...(images.length ? { images } : {}),
      ...(result.files.length ? { files: result.files } : {}),
    };
  };
  return {
    info: definition.info,
    validate: definition.validate,
    check: reconnect,
    /**
     * Recovery around a failed attempt. Each attempt is a new worker process, a new browser and a new thread, so a dead
     * browser or a lapsed session is exactly what a second attempt needs. The session is re-verified first, and only a
     * session that answers its own check is retried: without that proof the retry would fail for the same reason and the
     * original failure is reported unchanged. A submission cannot be cancelled remotely, so the abandoned thread may still
     * finish on Muse; the job keeps only the delivered result and says that a retry happened.
     */
    async run(credentials, prompt, context) {
      definition.validate(credentials);
      let lastError: unknown;
      let submitted = false;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await runOnce(credentials, prompt, {
            ...context,
            onSubmitted: () => {
              submitted = true;
              context.onSubmitted?.();
            },
          });
          return attempt === 1 ? result : { ...result, text: `${result.text}\n\n[dots2api] ${RETRY_NOTE}`.trim() };
        } catch (error) {
          lastError = error;
          if (submitted && context.retryAccepted === false) break;
          if (!(error instanceof GatewayError) || context.signal.aborted || FATAL_CODES.has(error.code) || attempt === MAX_ATTEMPTS) break;
          try {
            await reconnect(credentials, context);
          } catch {
            break;
          }
        }
      }
      throw lastError;
    },
    reconnect,
    async deleteThread(credentials, threadId, context): Promise<ThreadDeletion> {
      definition.validate(credentials);
      const result = await callWorker("delete", settings, credentials, "", { ...context, threadId });
      if (result.type !== "deleted") throw new GatewayError("muse_worker", "Unexpected Muse delete result.", 502);
      return result.outcome;
    },
  };
}
export const museAdapter = createMuseAdapter();
