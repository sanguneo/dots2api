import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import ky from "ky";
import { z } from "zod";
import { IMAGE_EXTENSIONS, sniffImage } from "../images";
import { THREAD_HEADER } from "../thread-key";
import { loadTelegramConfig, RelayError } from "./config";

const userSchema = z.object({ id: z.number().int().safe(), is_bot: z.boolean(), username: z.string().regex(/^[A-Za-z0-9_]+$/).optional() });
const messageSchema = z.object({
  message_id: z.number().int(),
  from: userSchema.optional(),
  sender_chat: z.unknown().optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(z.unknown()).optional(),
  reply_to_message: z.object({ from: userSchema.optional() }).optional(),
});
const updateSchema = z.object({ update_id: z.number().int().nonnegative(), message: messageSchema.optional() });
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error_code: z.number().optional() }),
]);
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const stateSchema = z.object({
  version: z.literal(1),
  botId: z.number().int().safe(),
  offset: z.number().int().nonnegative(),
  pending: z.object({ updateId: z.number().int(), chatId: z.number().int().safe() }).nullable(),
}).strict();
type State = z.infer<typeof stateSchema>;
type Loaded = Awaited<ReturnType<typeof loadTelegramConfig>>;
type Message = z.infer<typeof messageSchema>;

/** Plain text only: UTF-16 chunks never bisect a surrogate pair. */
function chunks(text: string): string[] {
  const result: string[] = [];
  let part = "";
  for (const character of text) {
    if (part.length + character.length > 4000) { result.push(part); part = ""; }
    part += character;
  }
  if (part.trim()) result.push(part);
  return result;
}

export class TelegramRelay {
  private state: State;
  private busy = false;
  private closed = false;
  private constructor(
    private readonly loaded: Loaded,
    private readonly bot: z.infer<typeof userSchema>,
    state: State,
    private readonly signal: AbortSignal,
  ) { this.state = state; }

  static async open(configPath: string, signal = new AbortController().signal): Promise<TelegramRelay> {
    const loaded = await loadTelegramConfig(configPath);
    await mkdir(loaded.stateDir, { recursive: true, mode: 0o700 });
    try { await mkdir(join(loaded.stateDir, "relay.lock"), { mode: 0o700 }); }
    catch { throw new RelayError("locked"); }
    try {
      const bot = userSchema.parse(await TelegramRelay.call(loaded, signal, "getMe", {}));
      if (!bot.is_bot || !bot.username) throw new RelayError("protocol");
      let state: State = { version: 1, botId: bot.id, offset: 0, pending: null };
      try { state = stateSchema.parse(JSON.parse(await readFile(join(loaded.stateDir, "state.json"), "utf8"))); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new RelayError("state");
      }
      if (state.botId !== bot.id) throw new RelayError("state");
      if (state.pending) throw new RelayError("pending");
      return new TelegramRelay(loaded, bot, state, signal);
    } catch (error) {
      await rmdir(join(loaded.stateDir, "relay.lock"));
      if (error instanceof RelayError) throw error;
      throw new RelayError("protocol");
    }
  }

  private static async call(loaded: Loaded, signal: AbortSignal, method: string, body: object | FormData): Promise<unknown> {
    const timeout = method === "getUpdates"
      ? (loaded.config.pollTimeoutSeconds + 10) * 1000 : loaded.config.requestTimeoutMs;
    try {
      const response = await ky.post(`${loaded.config.telegram.apiBaseURL.replace(/\/$/, "")}/bot${loaded.botToken}/${method}`, {
        ...(body instanceof FormData ? { body } : { json: body }),
        retry: 0, timeout, redirect: "manual", throwHttpErrors: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
      const envelope = envelopeSchema.parse(await response.json());
      if (!envelope.ok) {
        // Only an explicit bad-photo rejection permits a document fallback.
        if (method === "sendPhoto" && envelope.error_code === 400 && [200, 400].includes(response.status)) {
          throw new RelayError("rejected");
        }
        throw new RelayError("protocol");
      }
      if (!response.ok) throw new RelayError("protocol");
      return envelope.result;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError("network");
    }
  }

  /** Persist before each side effect; a leftover pending record blocks replay after a crash. */
  private async save(state: State): Promise<void> {
    const path = join(this.loaded.stateDir, "state.json");
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.loaded.stateDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    this.state = state;
  }

  private accepts(message: Message): boolean {
    const { config } = this.loaded;
    if (!message.from || message.sender_chat || !config.allowedUserIds.includes(message.from.id)) return false;
    const text = message.text ?? message.caption ?? "";
    const handle = this.bot.username ?? "";
    const mentioned = new RegExp(`(^|[^A-Za-z0-9_])@${handle}(?![A-Za-z0-9_])`, "i").test(text);
    if (message.from.is_bot && (!config.allowBotMessages || !mentioned || message.from.id === this.bot.id)) return false;
    if (message.chat.type === "private") return true;
    return ["group", "supergroup"].includes(message.chat.type)
      && config.allowedChatIds.includes(message.chat.id)
      && (mentioned || message.reply_to_message?.from?.id === this.bot.id);
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    for (const textPart of chunks(text)) {
      await TelegramRelay.call(this.loaded, this.signal, "sendMessage", { chat_id: chatId, text: textPart });
    }
  }

  private async sendFile(chatId: number, bytes: Uint8Array, name: string, image: boolean, mime = "application/octet-stream"): Promise<void> {
    const form = (field: string) => {
      const data = new FormData();
      data.set("chat_id", String(chatId));
      data.set(field, new Blob([Buffer.from(bytes)], { type: mime }), basename(name.replace(/\\/g, "/")).replace(/[\r\n"]/g, "_") || "attachment");
      return data;
    };
    if (image) {
      try {
        await TelegramRelay.call(this.loaded, this.signal, "sendPhoto", form("photo"));
        return;
      } catch (error) {
        if (!(error instanceof RelayError && error.code === "rejected")) throw error;
      }
    }
    await TelegramRelay.call(this.loaded, this.signal, "sendDocument", form("document"));
  }

  private async output(chatId: number, content: string): Promise<void> {
    const files: { name: string; bytes: Uint8Array }[] = [];
    let text = content.replace(/\[\[file name="([^"\r\n]+)" encoding="(utf8|base64)"\]\]\r?\n([\s\S]*?)\r?\n\[\[\/file\]\]/g,
      (_block: string, name: string, encoding: string, data: string) => {
        if (encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.replace(/\s/g, ""))) {
          throw new RelayError("protocol");
        }
        files.push({ name, bytes: Buffer.from(data, encoding === "utf8" ? "utf8" : "base64") });
        return "";
      });
    const images: URL[] = [];
    const base = new URL(this.loaded.config.gateway.baseURL);
    const image = (href: string) => {
      const url = new URL(href, base);
      if (url.origin !== base.origin || url.username || url.password || url.search || url.hash
        || !/^\/api\/jobs\/[A-Za-z0-9_-]+\/images\/\d+$/.test(url.pathname)) throw new RelayError("image");
      images.push(url);
      return "";
    };
    text = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (_match: string, href: string) => image(href));
    text = text.replace(/https?:\/\/[^\s<>)]+\/api\/jobs\/[A-Za-z0-9_-]+\/images\/\d+(?:[?#][^\s<>)]*)?|\/api\/jobs\/[A-Za-z0-9_-]+\/images\/\d+(?:[?#][^\s<>)]*)?/g,
      (href: string) => image(href));
    // Remove duplicates when the provider emits the same stored image twice.
    const uniqueImages = [...new Map(images.map((url) => [url.href, url])).values()];
    if (!text.trim() && !uniqueImages.length && !files.length) throw new RelayError("protocol");
    await this.sendText(chatId, text.trim());
    for (const url of uniqueImages) {
      const timeout = this.loaded.config.requestTimeoutMs;
      const response = await ky.get(url, {
        headers: { Authorization: `Bearer ${this.loaded.apiKey}` },
        retry: 0, timeout, redirect: "manual", throwHttpErrors: false,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]),
      });
      if (!response.ok) throw new RelayError("image");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime) throw new RelayError("image");
      await this.sendFile(chatId, bytes, `image.${IMAGE_EXTENSIONS[mime]}`, true, mime);
    }
    for (const file of files) {
      const mime = sniffImage(file.bytes);
      await this.sendFile(chatId, file.bytes, file.name, mime !== null, mime ?? undefined);
    }
  }

  private async handle(message: Message): Promise<void> {
    if (message.photo?.length) {
      await this.sendText(message.chat.id, "Photo input is unsupported by this chat API. Please send a text request; I have not seen the attached photo.");
      return;
    }
    if (!message.text?.trim()) return;
    const timeout = this.loaded.config.requestTimeoutMs;
    const response = await ky.post(new URL("/v1/chat/completions", this.loaded.config.gateway.baseURL), {
      headers: { Authorization: `Bearer ${this.loaded.apiKey}`, [THREAD_HEADER]: `telegram:${this.bot.id}:${message.chat.id}` },
      json: {
        model: this.loaded.config.model, stream: false,
        messages: [
          ...(this.loaded.config.systemPrompt ? [{ role: "system", content: this.loaded.config.systemPrompt }] : []),
          { role: "user", content: message.text },
        ],
      },
      retry: 0, timeout, redirect: "manual", throwHttpErrors: false,
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) throw new RelayError("protocol");
    const completion = completionSchema.parse(await response.json());
    const first = completion.choices[0];
    if (!first) throw new RelayError("protocol");
    await this.output(message.chat.id, first.message.content);
  }

  async pollOnce(): Promise<void> {
    if (this.closed || this.busy) throw new RelayError("locked");
    if (this.state.pending) throw new RelayError("pending");
    this.busy = true;
    try {
      const updates = z.array(updateSchema).parse(await TelegramRelay.call(this.loaded, this.signal, "getUpdates", {
        offset: this.state.offset, timeout: this.loaded.config.pollTimeoutSeconds, allowed_updates: ["message"],
      }));
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        if (update.update_id < this.state.offset) continue;
        if (update.message && this.accepts(update.message)) {
          await this.save({ ...this.state, pending: { updateId: update.update_id, chatId: update.message.chat.id } });
          await this.handle(update.message);
        }
        await this.save({ ...this.state, offset: update.update_id + 1, pending: null });
      }
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(this.state.pending ? "pending" : "network");
    } finally { this.busy = false; }
  }

  async close(): Promise<void> {
    if (this.busy) throw new RelayError("locked");
    if (!this.closed) {
      await rmdir(join(this.loaded.stateDir, "relay.lock"));
      this.closed = true;
    }
  }
}
