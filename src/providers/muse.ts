import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GatewayError } from "../contracts";
import type { AdapterContext, CheckResult, Credentials, ProviderAdapter, RunImage, RunResult } from "../contracts";
import { createMuseAdapter as createBrowserAdapter, sanitizeDiagnostics } from "./muse/engine";
import { stderrTail, stopWorker, workerLines } from "./muse/io";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../images";

const MAX_ATTEMPTS = 2;
const WORKER_LOG_LIMIT = 256 * 1024;
const WORKER_LOG_TAIL = 2_000;
/** Only the engine can prove these failures happened before it tried to click Send. */
const RETRYABLE_CODES = new Set(["muse_auth", "muse_unavailable", "muse_browser", "muse_send"]);
const RETRY_NOTE = "The first Muse attempt failed before submission; the account session was re-verified and the run was retried once.";

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
  z.object({ type: z.literal("accepted"), remoteId: z.string().nullable() }),
  z.object({ type: z.literal("credentials"), credentials: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("checked"), detail: z.string() }),
  z.object({ type: z.literal("completed"), text: z.string(), remoteId: z.string().nullable(), images: z.array(imageSchema).max(MAX_IMAGES).default([]) }),
  z.object({ type: z.literal("failed"), code: z.string(), message: z.string(), status: z.number(), uncertain: z.boolean() }),
]);
type Terminal = Exclude<z.infer<typeof eventSchema>, { type: "accepted" } | { type: "credentials" }>;

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
  operation: "check" | "run",
  settings: WorkerSettings,
  credentials: Credentials,
  prompt: string,
  context: AdapterContext,
): Promise<Terminal> {
  const node = nodeBinary();
  if (context.signal.aborted) throw new GatewayError("muse_cancelled", "Muse operation cancelled.", 409);
  const child = Bun.spawn([node, "--input-type=module", "--eval", await workerProgram()], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stdin: new Blob([JSON.stringify({
      operation, ...settings, credentials, prompt, accountId: context.accountId, dataDir: context.dataDir,
      referenceImages: (context.referenceImages ?? []).map((image) => ({ mime: image.mime, dataB64: Buffer.from(image.data).toString("base64") })),
    })]),
    stdout: "pipe", stderr: "pipe",
  });
  let stopping: Promise<void> | undefined;
  const terminate = () => stopping ??= stopWorker(child);
  const abort = () => { void terminate(); };
  context.signal.addEventListener("abort", abort, { once: true });
  if (context.signal.aborted) abort();
  // Drain stderr privately: Chrome diagnostics must not leak paths or credentials to API clients.
  const stderr = stderrTail(child.stderr);
  let terminal: Terminal | undefined;
  let outcome = "the worker ended before confirming a result";
  try {
    for await (const line of workerLines(child.stdout, context.signal)) {
        const event = eventSchema.parse(JSON.parse(line));
        switch (event.type) {
          case "accepted": context.onAccepted?.(event.remoteId); break;
          case "credentials": context.saveCredentials?.(event.credentials); break;
          case "checked":
          case "completed":
          case "failed": terminal = event; break;
        }
      if (terminal) break;
    }
    if (!terminal) throw new GatewayError("muse_worker", "Muse browser worker ended before confirming a result.", 502, operation === "run");
    if (terminal.type === "failed") {
      outcome = `${terminal.code}: ${terminal.message}`;
      throw new GatewayError(terminal.code, terminal.message, terminal.status, terminal.uncertain);
    }
    outcome = terminal.type === "completed" ? "completed" : "checked";
    return terminal;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    outcome = "the worker response could not be verified";
    throw new GatewayError("muse_worker", "Muse worker response could not be verified.", 502, operation === "run");
  } finally {
    await terminate();
    context.signal.removeEventListener("abort", abort);
    await stderr.close();
    const noise = stderr.text().trim();
    // Chrome diagnostics stay out of API responses, but a trimmed tail belongs in the operator's own log file.
    const tail = noise && outcome !== "completed" && outcome !== "checked"
      ? ` | chrome: ${sanitizeDiagnostics(noise.slice(-WORKER_LOG_TAIL))}`
      : "";
    await logWorkerRun(context, `op=${operation} outcome=${sanitizeDiagnostics(outcome)}${tail}`);
  }
}

export function createMuseAdapter(site = "https://muse.ai", chatTimeout = 300_000, execute = callWorker): ProviderAdapter {
  const definition = createBrowserAdapter(site, chatTimeout);
  const settings: WorkerSettings = { site, chatTimeout, pruneThreads: false };
  /** Re-verifies the account's session: the same work the console's Check button performs. */
  const reconnect = async (credentials: Credentials, context: AdapterContext): Promise<CheckResult> => {
    definition.validate(credentials);
    const result = await execute("check", settings, credentials, "", context);
    if (result.type !== "checked") throw new GatewayError("muse_worker", "Unexpected Muse check result.", 502);
    return { detail: result.detail };
  };
  /**
   * Muse starts a thread per job anyway, so the account's context switch alone decides whether the side chat it leaves
   * is deleted: on keeps it, off deletes it. Deletion cannot be undone, so nothing else may turn it on behind the switch.
   */
  const runSettings = (context: AdapterContext): WorkerSettings => ({ ...settings, pruneThreads: context.keepContext === false });
  const runOnce = async (credentials: Credentials, prompt: string, context: AdapterContext): Promise<RunResult> => {
    const result = await execute("run", runSettings(context), credentials, prompt, context);
    if (result.type !== "completed") throw new GatewayError("muse_worker", "Unexpected Muse job result.", 502, true);
    let bytes = 0;
    for (const image of result.images) {
      bytes += Buffer.byteLength(image.dataB64, "base64");
      if (bytes > MAX_IMAGE_BYTES) throw new GatewayError("muse_worker", "Muse worker exceeded the image result budget.", 502, true);
    }
    const images: RunImage[] = result.images.map((image) => ({
      mime: image.mime,
      data: new Uint8Array(Buffer.from(image.dataB64, "base64")),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
      ...(image.revisedPrompt !== undefined ? { revisedPrompt: image.revisedPrompt } : {}),
    }));
    return { text: result.text, remoteId: result.remoteId, ...(images.length ? { images } : {}) };
  };
  return {
    info: definition.info,
    validate: definition.validate,
    check: reconnect,
    /** Reconnection repairs authentication, never evidence that an earlier submission was not accepted. */
    async run(credentials, prompt, context) {
      definition.validate(credentials);
      let currentCredentials = credentials;
      let accepted = false;
      const attemptContext: AdapterContext = {
        ...context,
        onAccepted: (remoteId) => {
          accepted = true;
          context.onAccepted?.(remoteId);
        },
        saveCredentials: (repaired) => {
          currentCredentials = repaired;
          context.saveCredentials?.(repaired);
        },
      };
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await runOnce(currentCredentials, prompt, attemptContext);
          return attempt === 1 ? result : { ...result, text: `${result.text}\n\n[dots2api] ${RETRY_NOTE}`.trim() };
        } catch (error) {
          lastError = error;
          if (!(error instanceof GatewayError) || error.uncertain || accepted || context.signal.aborted ||
            !RETRYABLE_CODES.has(error.code) || attempt === MAX_ATTEMPTS) break;
          try {
            await reconnect(currentCredentials, attemptContext);
          } catch {
            break;
          }
        }
      }
      throw lastError;
    },
    reconnect,
  };
}
export const museAdapter = createMuseAdapter();
