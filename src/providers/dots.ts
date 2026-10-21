import { z } from "zod";
import { type AdapterContext, type CheckResult, type Credentials, GatewayError, type ProviderAdapter, type ReferenceImage, type RunImage } from "../contracts";
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, MAX_IMAGES, sniffImage, validateReferenceImages } from "../images";
import { DotConnection } from "./dots/connection";

const DEFAULT_ENDPOINT = "wss://codex-cloud-backend.chatgpt.com";
const DEFAULT_API = "https://chatgpt.com/backend-api";
const TIMEOUT_MS = 300_000;
const POLL_MS = 1_500;
/**
 * The Dot's thread can read idle for a moment between its first reply and a later attachment (seen live: a reply, a
 * brief idle, then the image ~90 s later), so a reply counts as final only after this many idle polls in a row.
 */
const SETTLE_POLLS = 8;
/** The messages endpoint rejects larger pages (HTTP 422). */
const PAGE_LIMIT = 32;
const USER_AGENT = "codex/0.159.2 (Mac OS 26.0.0; arm64)";

const configurationSchema = z.object({
  accessToken: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  endpoint: z.url().optional(),
  apiBase: z.url().optional(),
  pollMs: z.string().regex(/^\d{1,5}$/).optional(),
});
type Settings = z.infer<typeof configurationSchema>;

const primarySchema = z.object({
  selection: z.object({
    thread_id: z.string().min(1),
    available: z.boolean().nullish(),
    messaging_room_id: z.string().min(1),
  }).nullish(),
});
type PrimaryDot = { readonly threadId: string; readonly roomId: string };

const messageSchema = z.object({
  id: z.string().min(1),
  created_at: z.string().min(1),
  account_user_id: z.string(),
  deleted_at: z.string().nullish(),
  content: z.object({
    text: z.string().nullish(),
    attachments: z.array(z.unknown()).nullish(),
  }),
});
type Message = z.infer<typeof messageSchema>;
const messageListSchema = z.object({ items: z.array(z.unknown()) });
const uploadedSchema = z.object({ file_id: z.string().min(1) });
const fileAttachmentSchema = z.object({
  type: z.literal("file"),
  file: z.object({ mime_type: z.string().nullish(), download_url: z.string().nullish() }),
});
const threadStatusSchema = z.object({
  thread: z.object({ status: z.object({ type: z.string() }).nullish() }),
});

function secureUrl(value: string, secure: string, insecure: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== secure && !(url.protocol === insecure && loopback)) || url.username || url.password || url.hash) {
    throw new GatewayError("dots_config", "Use a secure endpoint (or loopback for local tests).");
  }
  return url;
}

function config(credentials: Credentials): Settings {
  const result = configurationSchema.safeParse(credentials);
  if (!result.success) {
    throw new GatewayError("dots_unconnected", "Sign in to ChatGPT to connect this Dot account.", 401);
  }
  secureUrl(result.data.endpoint ?? DEFAULT_ENDPOINT, "wss:", "ws:");
  secureUrl(result.data.apiBase ?? DEFAULT_API, "https:", "http:");
  return result.data;
}

function headers(settings: Settings): Record<string, string> {
  // Requests without the Codex client identity are refused by the edge (HTTP 403).
  return {
    authorization: `Bearer ${settings.accessToken}`,
    "chatgpt-account-id": settings.accountId,
    originator: "codex_cli_rs",
    "User-Agent": USER_AGENT,
  };
}

async function api(settings: Settings, path: string, signal: AbortSignal, uncertain: boolean, body?: object | FormData): Promise<unknown> {
  const json = body !== undefined && !(body instanceof FormData);
  let response: Response;
  try {
    response = await fetch(`${settings.apiBase ?? DEFAULT_API}${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...headers(settings), ...(json ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: json ? JSON.stringify(body) : body } : {}),
      signal,
    });
  } catch {
    if (signal.aborted) throw new GatewayError("dots_timeout", "Dot did not finish before the timeout.", 504, uncertain);
    throw new GatewayError("dots_connection", "Dot could not be reached.", 502, uncertain);
  }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? response.status : 502;
    throw new GatewayError("dots_http", `Dot rejected the request (HTTP ${response.status}).`, status, uncertain);
  }
  try {
    return await response.json();
  } catch {
    throw new GatewayError("dots_protocol", "Dot sent an invalid response.", 502, uncertain);
  }
}

async function primaryDot(settings: Settings, signal: AbortSignal): Promise<PrimaryDot> {
  const parsed = primarySchema.safeParse(await api(settings, "/tbo/primary", signal, false));
  if (!parsed.success) throw new GatewayError("dots_protocol", "Dot profile response was invalid.", 502);
  const selection = parsed.data.selection;
  if (!selection || selection.available === false) {
    throw new GatewayError("dots_unavailable", "This ChatGPT account has no available Dot.", 404);
  }
  return { threadId: selection.thread_id, roomId: selection.messaging_room_id };
}

async function withConnection<T>(
  settings: Settings,
  context: AdapterContext,
  action: (connection: DotConnection, signal: AbortSignal, submitted: { mark(): void }) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  if (signal.aborted) throw new GatewayError("dots_timeout", "Dot connection ended before submission.", 504);
  let sent = false;
  // DOM's constructor typing masks Bun's custom-header overload; Reflect preserves the runtime overload.
  const socket: WebSocket = Reflect.construct(WebSocket, [settings.endpoint ?? DEFAULT_ENDPOINT, { headers: headers(settings) }]);
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
    return await action(connection, signal, { mark: () => { sent = true; } });
  } finally {
    connection.close();
  }
}

async function threadStatus(connection: DotConnection, threadId: string): Promise<string | null> {
  const read = threadStatusSchema.safeParse(await connection.request("thread/read", { threadId }));
  if (!read.success) throw new GatewayError("dots_protocol", "Dot thread status was invalid.", 502, true);
  return read.data.thread.status?.type ?? null;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new GatewayError("dots_timeout", "Dot did not finish before the timeout.", 504, true));
    }, { once: true });
  });
}

async function uploadReferences(settings: Settings, roomId: string, images: readonly ReferenceImage[], signal: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, image] of images.entries()) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(image.data)], { type: image.mime }), `reference-${index + 1}.${IMAGE_EXTENSIONS[image.mime]}`);
    const uploaded = uploadedSchema.safeParse(await api(settings, `/messaging/rooms/${encodeURIComponent(roomId)}/files`, signal, false, form));
    if (!uploaded.success) throw new GatewayError("dots_protocol", "Dot did not accept a reference image.", 502);
    ids.push(uploaded.data.file_id);
  }
  return ids;
}

async function repliesAfter(settings: Settings, roomId: string, sent: Message, signal: AbortSignal): Promise<Message[]> {
  const listed = messageListSchema.safeParse(await api(settings, `/messaging/rooms/${encodeURIComponent(roomId)}/messages?limit=${PAGE_LIMIT}`, signal, true));
  if (!listed.success) throw new GatewayError("dots_protocol", "Dot message list was invalid.", 502, true);
  return listed.data.items
    .flatMap((raw) => {
      const message = messageSchema.safeParse(raw);
      return message.success ? [message.data] : [];
    })
    .filter((message) => message.account_user_id !== sent.account_user_id && !message.deleted_at && message.created_at > sent.created_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function downloadImages(settings: Settings, replies: readonly Message[], signal: AbortSignal): Promise<{ images: RunImage[]; missing: number }> {
  const origin = new URL(settings.apiBase ?? DEFAULT_API).origin;
  const images: RunImage[] = [];
  let missing = 0;
  for (const raw of replies.flatMap((message) => message.content.attachments ?? [])) {
    const attachment = fileAttachmentSchema.safeParse(raw);
    if (!attachment.success || !attachment.data.file.mime_type?.startsWith("image/")) continue;
    const url = attachment.data.file.download_url;
    // The bearer token is only ever sent back to the API origin, never to a URL chosen by remote content.
    if (!url || new URL(url, origin).origin !== origin || images.length >= MAX_IMAGES) { missing++; continue; }
    try {
      const response = await fetch(new URL(url, origin), { headers: headers(settings), signal });
      const data = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
      const mime = data ? sniffImage(data) : null;
      if (data && mime && data.byteLength <= MAX_IMAGE_BYTES) images.push({ mime, data });
      else missing++;
    } catch {
      missing++;
    }
  }
  return { images, missing };
}

async function sessionCheck(credentials: Credentials, context: AdapterContext): Promise<CheckResult> {
  const settings = config(credentials);
  return withConnection(settings, context, async (connection, signal) => {
    const dot = await primaryDot(settings, signal);
    await threadStatus(connection, dot.threadId);
    return { detail: "Primary Dot and its conversation are reachable; live compatibility and quota remain unverified." };
  });
}

export const dotsAdapter: ProviderAdapter = {
  info: {
    id: "dots",
    name: "Dots",
    contextWindow: 272_000,
    contextBasis: "configured",
    description: "Messages the account's primary ChatGPT Dot through its conversation; quota and live compatibility are unverified.",
    fields: [
      { key: "accessToken", label: "Access token", help: "Supply a current account bearer token explicitly; no local auth file is read.", secret: true, required: true },
      { key: "accountId", label: "ChatGPT account ID", help: "Account ID that owns the Dot.", secret: false, required: true },
      { key: "endpoint", label: "WebSocket endpoint", help: "Optional endpoint override; default is the hosted Codex cloud backend.", secret: false, required: false },
    ],
    capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true },
    setupUrl: "https://chatgpt.com/dots",
  },
  validate(credentials) {
    const { pollMs, ...settings } = config(credentials);
    return { ...credentials, ...settings, endpoint: settings.endpoint ?? DEFAULT_ENDPOINT, apiBase: settings.apiBase ?? DEFAULT_API, ...(pollMs ? { pollMs } : {}) };
  },
  check: sessionCheck,
  reconnect: sessionCheck,
  async run(credentials, prompt, context) {
    if (context.referenceImages) validateReferenceImages(context.referenceImages);
    const settings = config(credentials);
    if (!prompt.trim()) throw new GatewayError("dots_prompt", "Prompt must not be empty.");
    return withConnection(settings, context, async (connection, signal, submitted) => {
      const dot = await primaryDot(settings, signal);
      const fileIds = context.referenceImages ? await uploadReferences(settings, dot.roomId, context.referenceImages, signal) : [];
      const requestId = crypto.randomUUID();
      submitted.mark();
      const posted = messageSchema.safeParse(await api(settings, `/messaging/rooms/${encodeURIComponent(dot.roomId)}/messages`, signal, true, {
        content: { text: prompt, ...(fileIds.length ? { attachments: fileIds.map((file_id) => ({ type: "file", file_id })) } : {}) },
        request_id: requestId,
        idempotency_token: requestId,
        page_context: { page_id: null },
        timezone_offset_min: new Date().getTimezoneOffset(),
      }));
      if (!posted.success) throw new GatewayError("dots_protocol", "Dot did not confirm the message.", 502, true);
      context.onAccepted?.(posted.data.id);
      const pollMs = Number(settings.pollMs ?? POLL_MS);
      let replies: Message[] = [];
      let idlePolls = 0;
      while (true) {
        const latest = await repliesAfter(settings, dot.roomId, posted.data, signal);
        const idle = latest.length > 0 && (await threadStatus(connection, dot.threadId)) !== "active";
        idlePolls = idle && latest.length === replies.length ? idlePolls + 1 : idle ? 1 : 0;
        replies = latest;
        if (idlePolls >= SETTLE_POLLS) break;
        await pause(pollMs, signal);
      }
      const { images, missing } = await downloadImages(settings, replies, signal);
      let text = replies.map((message) => message.content.text?.trim() ?? "").filter(Boolean).join("\n\n");
      if (missing > 0) text += `${text ? "\n\n" : ""}[dots2api] The Dot attached ${missing} image(s) that could not be downloaded; open the Dot in ChatGPT.`;
      if (!text && images.length === 0) throw new GatewayError("dots_result", "Dot finished without a reply.", 502, true);
      return { text, remoteId: posted.data.id, ...(images.length ? { images } : {}) };
    });
  },
};
