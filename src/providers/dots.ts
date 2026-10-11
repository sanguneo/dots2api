import { z } from "zod";
import { type AdapterContext, type CheckResult, type Credentials, GatewayError, type ProviderAdapter, type ReferenceImage, type RunImage, type RunResult } from "../contracts";
import { decodeImage, MAX_IMAGES, validateReferenceImages } from "../images";
import { DotConnection } from "./dots/connection";

const DEFAULT_ENDPOINT = "wss://codex-cloud-backend.chatgpt.com";
const TIMEOUT_MS = 300_000;
const configurationSchema = z.object({
  accessToken: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  threadId: z.string().trim().min(1),
  endpoint: z.url().optional(),
});
const threadSchema = z.object({
  thread: z.object({
    id: z.string(),
    threadSource: z.string().nullish(),
    modelProvider: z.string().nullish(),
    canAcceptDirectInput: z.boolean().nullish(),
  }),
});
const createdThreadSchema = z.object({ thread: z.object({ id: z.string().min(1) }) });
const turnSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
});
const turnErrorSchema = z.object({
  message: z.string().optional(),
}).nullish();
const completedSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.string(),
    items: z.array(z.unknown()).optional(),
    error: turnErrorSchema,
  }),
});
const messageSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    id: z.string(),
    type: z.literal("agentMessage"),
    text: z.string(),
  }),
});
const agentItemSchema = z.object({
  id: z.string(),
  type: z.literal("agentMessage"),
  text: z.string(),
});
const deliveredMessageSchema = z.object({
  id: z.string(),
  type: z.literal("mcpToolCall"),
  tool: z.literal("user_message.send_message"),
  status: z.literal("completed"),
  arguments: z.object({ channel: z.literal("chatgpt"), text: z.string(), library_file_ids: z.array(z.string()).optional() }),
  error: z.null(),
  result: z.object({
    structuredContent: z.object({ status: z.literal("accepted") }),
  }),
});
const imageItemSchema = z.object({
  type: z.literal("imageGeneration"),
  id: z.string(),
  status: z.string(),
  result: z.string().nullish(),
  revisedPrompt: z.string().nullish(),
});
const turnListSchema = z.object({
  data: z.array(z.object({ id: z.string(), items: z.array(z.unknown()).optional() })),
});
const completedItemSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.unknown(),
});

function config(credentials: Credentials): z.infer<typeof configurationSchema> {
  const result = configurationSchema.safeParse(credentials);
  if (!result.success) {
    throw new GatewayError("dots_unconnected", "Supply a Dot accessToken, accountId and existing threadId.", 401);
  }
  const endpoint = new URL(result.data.endpoint ?? DEFAULT_ENDPOINT);
  if ((endpoint.protocol !== "wss:" && !(endpoint.protocol === "ws:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]"))) ||
    endpoint.username || endpoint.password || endpoint.hash) {
    throw new GatewayError("dots_config", "Use a secure WebSocket endpoint (or loopback for local tests).");
  }
  return result.data;
}

/** Dot reports a failed turn's cause in turn.error.message as a JSON error envelope; keep it readable. */
const turnEnvelopeSchema = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional() });

function turnFailureReason(error: z.infer<typeof turnErrorSchema>): string {
  const raw = error?.message?.trim();
  if (!raw) return "";
  let reason = raw;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    envelope = null; // Not an envelope: the message is already the reason.
  }
  const parsed = turnEnvelopeSchema.safeParse(envelope);
  if (parsed.success && parsed.data.error) {
    reason = [parsed.data.error.code, parsed.data.error.message ?? raw].filter(Boolean).join(": ");
  }
  const text = reason.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Failures that mean the stored thread can no longer serve turns and must be replaced. */
const REBINDABLE = new Set(["dots_thread_missing", "dots_thread_unverified"]);

/** Dot's own refusal code for a thread whose resolved image content has grown past its limit. */
const THREAD_IMAGE_LIMIT = "image_request_too_large";

/**
 * A thread keeps every image its turns produced, and Dot refuses a turn once that resolved content is too large; the
 * thread then refuses every following text turn. Rotation is proactive because the limit is a property of the thread,
 * not of the request, and a fresh thread still accepts a prompt that carried its own image. Measured live on one
 * account: six generated images (9.9 MB of image payload) still took text turns, a seventh (12.8 MB) refused them,
 * so the budget sits under the highest load known to work.
 */
const THREAD_IMAGE_BUDGET_BYTES = 8 * 1024 * 1024;

/** How much image content this gateway has already produced on the account's current thread. */
function threadImageBytes(credentials: Credentials): number {
  const stored = Number(credentials["threadImageBytes"]);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

/** True when Dot refused the turn because the thread - not the request - holds too much image content. */
function threadAtImageLimit(error: unknown): boolean {
  return error instanceof GatewayError && error.code === "dots_turn" && error.message.includes(THREAD_IMAGE_LIMIT);
}

/** Tracks whether a submitted turn has left the client; cleared only before a safely retryable submission. */
type Submission = { mark(): void; clear(): void };

async function withConnection<T>(
  credentials: z.infer<typeof configurationSchema>,
  context: AdapterContext,
  action: (connection: DotConnection, submission: Submission) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  if (signal.aborted) throw new GatewayError("dots_timeout", "Dot connection ended before submission.", 504);
  let sent = false;
  // DOM's constructor typing masks Bun's custom-header overload; Reflect preserves the runtime overload.
  const socket: WebSocket = Reflect.construct(WebSocket, [credentials.endpoint ?? DEFAULT_ENDPOINT, {
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "codex_cli_rs",
      "User-Agent": "codex/0.159.2 (Mac OS 26.0.0; arm64)",
    },
  }]);
  const connection = new DotConnection(socket, signal, () => sent);
  try {
    await connection.ready;
    const initialized = await connection.request("initialize", {
      clientInfo: { name: "dots2api", title: "dots2api", version: "0.1.0" },
    });
    if (!z.object({}).safeParse(initialized).success) {
      throw new GatewayError("dots_protocol", "Dot initialization response was invalid.", 502);
    }
    connection.notify("initialized", {});
    return await action(connection, { mark: () => { sent = true; }, clear: () => { sent = false; } });
  } finally {
    connection.close();
  }
}

/** The completed-turn payload may omit the (very large) image bytes; the turn list returns them in full. */
async function turnImages(connection: DotConnection, threadId: string, turnId: string): Promise<RunImage[]> {
  const listed = turnListSchema.safeParse(await connection.request("thread/turns/list", { threadId, limit: 5, itemsView: "full" }));
  if (!listed.success) throw new GatewayError("dots_protocol", "Dot turn list response was invalid.", 502);
  const items = listed.data.data.find((turn) => turn.id === turnId)?.items ?? [];
  return items.flatMap((raw) => {
    const item = imageItemSchema.safeParse(raw);
    const image = item.success && item.data.status === "completed" && item.data.result ? decodeImage(item.data.result) : null;
    return image ? [{ ...image, ...(item.success && item.data.revisedPrompt ? { revisedPrompt: item.data.revisedPrompt } : {}) }] : [];
  });
}

async function existingThread(connection: DotConnection, threadId: string, selfProvisioned = false): Promise<void> {
  const read = threadSchema.safeParse(await connection.request("thread/read", { threadId }));
  if (!read.success || read.data.thread.id !== threadId) {
    throw new GatewayError("dots_thread", "Existing Dot thread could not be verified.", 404);
  }
  const thread = read.data.thread;
  if (thread.threadSource && thread.threadSource !== "aeon") {
    throw new GatewayError("dots_thread", "Selected thread is not an Aeon Dot thread.", 400);
  }
  // A thread whose record outlives its agent still answers reads but can never accept a turn again.
  if (thread.modelProvider === "" || thread.canAcceptDirectInput === false) {
    throw new GatewayError("dots_thread_missing", "Existing Dot thread has no live agent.", 502);
  }
  // A thread without an Aeon source is one this gateway created as a replacement, so its own creation is the
  // authorization; a different, explicitly labelled source is not ours to drive.
  if (selfProvisioned || !thread.threadSource) return;
}

/** Submits one turn and returns the acceptance Dot reported. */
async function startTurn(
  connection: DotConnection,
  threadId: string,
  prompt: string,
  referenceImages?: readonly ReferenceImage[],
): Promise<z.infer<typeof turnSchema>> {
  const started = turnSchema.safeParse(await connection.request("turn/start", {
    threadId,
    // App-server UserInput::Image flattens ImageReference::Inline { url }; this is not a Responses input_image.
    input: [
      { type: "text", text: prompt },
      ...(referenceImages ?? []).map((image) => ({
        type: "image", url: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`,
      })),
    ],
  }));
  if (!started.success) throw new GatewayError("dots_protocol", "Dot did not return a turn ID.", 502, true);
  return started.data;
}

/**
 * Retires the thread a replacement takes over: without it every rotation leaves a dead one behind in the account's
 * list. Only threads this gateway created are archived, since a thread the operator selected in the console is theirs.
 */
async function archiveReplacedThread(connection: DotConnection, credentials: Credentials): Promise<void> {
  const replaced = credentials["threadId"];
  if (credentials["threadOrigin"] !== "self" || !replaced) return;
  try {
    await connection.request("thread/archive", { threadId: replaced });
  } catch {
    // Housekeeping alone: a thread left behind is untidy, never a reason to fail a job that produced its answer.
  }
}

/**
 * A reclaimed Dot thread keeps its record but loses its agent, so no turn can ever be accepted again.
 * Creating a replacement thread on the same credentials restores the account without a manual reconnect.
 */
async function provisionThread(
  connection: DotConnection,
  save: (credentials: Credentials) => void,
  credentials: Credentials,
): Promise<string> {
  const created = createdThreadSchema.safeParse(await connection.request("thread/start", {}));
  if (!created.success) throw new GatewayError("dots_thread", "Dot did not create a replacement thread.", 502);
  const threadId = created.data.thread.id;
  save({ ...credentials, threadId, threadOrigin: "self", threadImageBytes: "0" });
  // The replacement is durable before the thread it supersedes is archived, so this can never strand the account.
  await archiveReplacedThread(connection, credentials);
  return threadId;
}

/**
 * One session check serves both the console's Check button and automatic recovery: a Dot that answers its own handshake
 * is usable again, so a rejected, closed or unverifiable connection no longer quarantines the account until a human
 * presses Check. It never submits work, so it can run after an uncertain job.
 */
async function sessionCheck(credentials: Credentials, context: AdapterContext): Promise<CheckResult> {
  const settings = config(credentials);
  return withConnection(settings, context, async (connection) => {
    try {
      await existingThread(connection, settings.threadId, credentials["threadOrigin"] === "self");
      return { detail: "Existing thread reports Aeon Dot identity; live compatibility and quota remain unverified." };
    } catch (error) {
      // A Dot that has moved to the new backend keeps its thread record but can never accept a turn again. run rebinds
      // such a thread; a check that only reports the failure would end a fresh device login in error and keep submit
      // from ever reaching run. provisionThread archives only a thread this gateway created, never the operator's.
      if (!(error instanceof GatewayError) || !REBINDABLE.has(error.code) || !context.saveCredentials) throw error;
      await provisionThread(connection, context.saveCredentials, credentials);
      return { detail: "The stored thread cannot accept input, so a replacement thread was created for this account." };
    }
  });
}

/** Opens a thread that belongs to one job; nothing is stored, so an account switched back on keeps the thread it had. */
async function openThread(connection: DotConnection): Promise<string> {
  const created = createdThreadSchema.safeParse(await connection.request("thread/start", {}));
  if (!created.success) throw new GatewayError("dots_thread", "Dot did not create a thread for this job.", 502);
  return created.data.thread.id;
}

/** Housekeeping for a job-owned thread: one left behind is untidy, never a reason to fail a job that produced an answer. */
async function archiveThread(connection: DotConnection, threadId: string): Promise<void> {
  try {
    await connection.request("thread/archive", { threadId });
  } catch {
    // Ignored on purpose, as in archiveReplacedThread.
  }
}

/** Waits for one submitted turn and assembles its answer; a turn Dot did not complete is reported with its reason. */
async function collectTurn(connection: DotConnection, threadId: string, turnId: string): Promise<RunResult> {
  const messages = new Map<string, string>();
  const delivered = new Map<string, string>();
  const images = new Map<string, RunImage>();
  let imageMissing = false;
  const noteImage = (raw: unknown): void => {
    const item = imageItemSchema.safeParse(raw);
    if (!item.success || item.data.status !== "completed") return;
    const image = item.data.result ? decodeImage(item.data.result) : null;
    if (image) images.set(item.data.id, { ...image, ...(item.data.revisedPrompt ? { revisedPrompt: item.data.revisedPrompt } : {}) });
    else imageMissing = true;
  };
  while (true) {
    const event = await connection.next();
    if (event.method === "item/completed") {
      const completedItem = completedItemSchema.safeParse(event.params);
      if (completedItem.success && completedItem.data.threadId === threadId && completedItem.data.turnId === turnId) {
        const delivery = deliveredMessageSchema.safeParse(completedItem.data.item);
        if (delivery.success) delivered.set(delivery.data.id, delivery.data.arguments.text);
        noteImage(completedItem.data.item);
      }
      const item = messageSchema.safeParse(event.params);
      if (item.success && item.data.threadId === threadId && item.data.turnId === turnId) {
        messages.set(item.data.item.id, item.data.item.text);
      }
    }
    if (event.method !== "turn/completed") continue;
    const completed = completedSchema.safeParse(event.params);
    if (!completed.success || completed.data.threadId !== threadId || completed.data.turn.id !== turnId) continue;
    if (completed.data.turn.status !== "completed") {
      const status = completed.data.turn.status;
      const reason = turnFailureReason(completed.data.turn.error);
      throw new GatewayError("dots_turn", reason
        ? `Dot turn finished without successful completion (status "${status}"): ${reason}`
        : `Dot turn finished without successful completion (status "${status}").`, 502);
    }
    for (const raw of completed.data.turn.items ?? []) {
      const delivery = deliveredMessageSchema.safeParse(raw);
      if (delivery.success) {
        delivered.set(delivery.data.id, delivery.data.arguments.text);
        if (delivery.data.arguments.library_file_ids?.length && images.size === 0) imageMissing = true;
      }
      noteImage(raw);
      const item = agentItemSchema.safeParse(raw);
      if (item.success) messages.set(item.data.id, item.data.text);
    }
    let text = [...(delivered.size ? delivered : messages).values()].join("\n\n").trim();
    if (!text && images.size === 0 && !imageMissing) throw new GatewayError("dots_result", "Dot completed without an agent text response.", 502, true);
    if (imageMissing && images.size === 0) {
      try {
        for (const image of await turnImages(connection, threadId, turnId)) images.set(`list-${images.size}`, image);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
      }
      if (images.size === 0) text += "\n\n[dots2api] The Dot generated an image, but it could not be downloaded; open the Dot thread in ChatGPT.";
    }
    return { text, remoteId: turnId, ...(images.size ? { images: [...images.values()].slice(0, MAX_IMAGES) } : {}) };
  }
}

export const dotsAdapter: ProviderAdapter = {
  info: {
    id: "dots",
    name: "Dots",
    contextWindow: 272_000,
    contextBasis: "configured",
    description: "Continues an explicitly selected existing Dot thread; quota and live compatibility are unverified.",
    fields: [
      { key: "accessToken", label: "Access token", help: "Supply a current account bearer token explicitly; no local auth file is read.", secret: true, required: true },
      { key: "accountId", label: "ChatGPT account ID", help: "Account ID associated with this Dot thread.", secret: false, required: true },
      { key: "threadId", label: "Existing Dot thread ID", help: "Use an existing consumer Dot thread ID; this adapter never creates an Astra thread.", secret: false, required: true },
      { key: "endpoint", label: "WebSocket endpoint", help: "Optional endpoint override; default is the hosted Codex cloud backend.", secret: false, required: false },
    ],
    capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true },
    setupUrl: "https://developers.openai.com/codex/app-server/",
  },
  validate(credentials) {
    const settings = config(credentials);
    return { ...credentials, ...settings, endpoint: settings.endpoint ?? DEFAULT_ENDPOINT };
  },
  check: sessionCheck,
  reconnect: sessionCheck,
  async run(credentials, prompt, context) {
    if (context.referenceImages) validateReferenceImages(context.referenceImages);
    const settings = config(credentials);
    if (!prompt.trim()) throw new GatewayError("dots_prompt", "Prompt must not be empty.");
    return withConnection(settings, context, async (connection, submission) => {
      if (context.keepContext === false) {
        // The operator keeps no context on this account: the job gets a thread of its own, which is retired afterwards.
        const ownThread = await openThread(connection);
        try {
          submission.mark();
          const started = await startTurn(connection, ownThread, prompt, context.referenceImages);
          const turnId = started.turn.id;
          context.onAccepted?.(turnId);
          const result = await collectTurn(connection, ownThread, turnId);
          await archiveThread(connection, ownThread);
          return result;
        } catch (error) {
          // An uncertain turn may still be running remotely, and archiving it would discard work still producing an
          // answer; a turn that definitely failed leaves a thread nobody will ever use again.
          if (error instanceof GatewayError && !error.uncertain) await archiveThread(connection, ownThread);
          throw error;
        }
      }
      // The selected thread is a consumer Dot and keeps its identity gate; a replacement is trusted by creation.
      let threadId = settings.threadId;
      let rotated = false;
      // Tracked per thread, not per account: a replacement starts empty and the stored count follows it.
      let threadBytes = threadImageBytes(credentials);
      try {
        await existingThread(connection, threadId, credentials["threadOrigin"] === "self");
        const resumed = threadSchema.safeParse(await connection.request("thread/resume", { threadId }));
        if (!resumed.success || resumed.data.thread.id !== threadId) {
          throw new GatewayError("dots_thread", "Dot did not resume the selected thread.", 502);
        }
      } catch (error) {
        // A rejected or agentless thread is never accepted by the agent, so rebinding and retrying once cannot
        // duplicate remote work.
        if (!(error instanceof GatewayError) || !REBINDABLE.has(error.code) || !context.saveCredentials) throw error;
        threadId = await provisionThread(connection, context.saveCredentials, credentials);
        threadBytes = 0;
        rotated = true;
      }
      if (context.saveCredentials && !rotated && threadBytes >= THREAD_IMAGE_BUDGET_BYTES) {
        threadId = await provisionThread(connection, context.saveCredentials, credentials);
        threadBytes = 0;
        rotated = true;
      }
      while (true) {
        // The socket buffers notifications before submission; completion may beat the RPC reply.
        submission.mark();
        try {
          const started = await startTurn(connection, threadId, prompt, context.referenceImages);
          const turnId = started.turn.id;
          context.onAccepted?.(turnId);
          const result = await collectTurn(connection, threadId, turnId);
          // Reference images stay on the thread too, so both count towards the next job's rotation decision.
          const produced = (result.images?.reduce((sum, image) => sum + image.data.length, 0) ?? 0)
            + (context.referenceImages?.reduce((sum, image) => sum + image.data.length, 0) ?? 0);
          if (produced && context.saveCredentials) {
            threadBytes += produced;
            context.saveCredentials({ ...credentials, threadId, threadImageBytes: String(threadBytes) });
          }
          return result;
        } catch (error) {
          // A refused submission produced no remote work, so the prompt can be resubmitted safely: either the thread
          // lost its agent, or Dot refused a text-only turn because the thread's own image content is over the limit.
          const rebindable = error instanceof GatewayError && REBINDABLE.has(error.code);
          const atImageLimit = !context.referenceImages?.length && threadAtImageLimit(error);
          if (rotated || !context.saveCredentials || !(rebindable || atImageLimit)) throw error;
          rotated = true;
          submission.clear();
          threadId = await provisionThread(connection, context.saveCredentials, credentials);
          threadBytes = 0;
        }
      }
    });
  },
};
