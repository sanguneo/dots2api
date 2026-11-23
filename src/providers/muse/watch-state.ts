import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import { GatewayError } from "../../contracts";
import { attachmentsInPage, FILE_CARD, mediaBytesInPage, mediaSourceIdentity } from "./media";

const snapshotSchema = z.object({
  messages: z.array(z.string()), sources: z.array(z.string()), cards: z.number(), files: z.array(z.string()),
  users: z.array(z.string()),
  mediaKeys: z.array(z.string()).default([]), presentations: z.array(z.string()).default([]),
  messageIds: z.array(z.string()).default([]),
  mediaHashes: z.array(z.string()).default([]), texts: z.array(z.string()).default([]),
});
const approvalSchema = z.object({
  id: z.uuid(), expiresAt: z.iso.datetime(), clicked: z.boolean(),
});
const stateSchema = z.object({
  approvals: z.record(z.string(), approvalSchema),
  captures: z.record(z.string(), snapshotSchema),
  targets: z.array(z.string()).default([]),
  deliveredHashes: z.array(z.string()).default([]),
});
type WatchState = z.infer<typeof stateSchema>;
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const mediaIdentity = (src: string) => digest(mediaSourceIdentity(src));

export async function readState(path: string): Promise<WatchState> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { approvals: {}, captures: {}, targets: [], deliveredHashes: [] };
    throw error;
  }
}

export async function saveState(path: string, state: WatchState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

export async function readTranscript(page: Page, sourceHashes?: Map<string, string>) {
  const contents = await page.evaluate(({ fileSelector }) => {
    const bubbles = [...document.querySelectorAll<HTMLElement>('div[class*="hatch-agent-bubble-bg"]')];
    return {
      messages: bubbles.map((bubble) => ({
        id: bubble.closest("[data-message-id]")?.getAttribute("data-message-id") ?? "",
        text: bubble.innerText.trim(),
      })),
      cards: document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length,
      presentations: [...document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]')]
        .map(element => `${element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? ""}\n${element.getAttribute("data-testid") ?? ""}`),
      messageIds: [...document.querySelectorAll("[data-message-id]")].map(element => element.getAttribute("data-message-id") ?? ""),
      files: [...document.querySelectorAll(fileSelector)].flatMap((element) => element.getAttribute("data-testid") ?? []),
      fileCards: [...document.querySelectorAll(fileSelector)].map(element => ({
        id: element.getAttribute("data-testid") ?? "",
        owner: element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? "",
      })),
      users: [...document.querySelectorAll<HTMLElement>('[data-message-item="true"][data-message-role="user"],div[class*="chat-user-bubble"]')]
        .map((element) => `${element.getAttribute("data-message-id") ?? ""}\n${element.innerText.trim()}`),
      generating: Boolean(document.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label="Stop"]')),
    };
  }, { fileSelector: FILE_CARD });
  const attachments = (await page.evaluate(attachmentsInPage)).filter(({ src }) => !src.startsWith("data:image/svg"));
  const sources = attachments.map(({ src }) => src);
  const identities = await Promise.all(attachments.map(async item => {
    const key = item.message ? digest(`message\n${item.message}`) :
      item.presentation ? digest(`presentation\n\n${item.presentation}`) : null;
    // Foreground checkpoints only need known DOM owners; unavailable history must not fail a plain request.
    if (!sourceHashes && key) return { hash: null, key };
    const cacheKey = `${item.message}\n${item.presentation}\n${item.src}`;
    let hash = sourceHashes?.get(cacheKey);
    if (!hash) {
      const bytes = await page.evaluate(mediaBytesInPage, item.src);
      if (bytes.error || !bytes.b64) throw new GatewayError("muse_watch_media", "Cannot baseline Muse media bytes.", 502);
      hash = digest(Buffer.from(bytes.b64, "base64"));
      sourceHashes?.set(cacheKey, hash);
    }
    return { hash, key: key ?? hash };
  }));
  const snapshot = {
    messages: contents.messages.map(({ id, text }) => digest(`${id}\n${text}`)),
    sources: sources.map(mediaIdentity), cards: contents.cards, files: contents.files.map(digest), users: contents.users.map(digest),
    mediaKeys: identities.map(item => item.key), mediaHashes: identities.flatMap(item => item.hash ? [item.hash] : []),
    presentations: contents.presentations,
    messageIds: contents.messageIds,
    texts: contents.messages.filter(message => message.text).map(message => digest(message.text)),
  };
  return { ...contents, sources, snapshot };
}
