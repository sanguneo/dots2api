import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { z } from "zod";
import { GatewayError, MAX_FILES } from "../../contracts";
import type { MuseWatchContext } from "../../contracts";
import { APPROVAL_CARD_SELECTOR, scanApprovalCard } from "./approval-dom";
import { ApprovalWait } from "./approval-wait";
import { hasPendingMuseTask } from "./completion";
import { attachmentsInPage, downloadFiles, FILE_CARD, generatedMedia, mediaSourceIdentity } from "./media";

const threadId = /^[A-Za-z0-9_-]{1,128}$/;
const snapshotSchema = z.object({
  messages: z.array(z.string()), sources: z.array(z.string()), cards: z.number(), files: z.array(z.string()),
  users: z.array(z.string()),
});
const approvalSchema = z.object({
  id: z.uuid(), expiresAt: z.iso.datetime(), clicked: z.boolean(),
});
const stateSchema = z.object({
  approvals: z.record(z.string(), approvalSchema),
  captures: z.record(z.string(), snapshotSchema),
  targets: z.array(z.string()).default([]),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

type WatchState = z.infer<typeof stateSchema>;

async function readState(path: string): Promise<WatchState> {
  try {
    return stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { approvals: {}, captures: {}, targets: [] };
    throw error;
  }
}

async function saveState(path: string, state: WatchState): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

const mediaIdentity = (src: string) => digest(mediaSourceIdentity(src));

async function readTranscript(page: Page) {
  const contents = await page.evaluate(({ fileSelector }) => {
    const bubbles = [...document.querySelectorAll<HTMLElement>('div[class*="hatch-agent-bubble-bg"]')];
    return {
      messages: bubbles.map((bubble) => ({
        id: bubble.closest("[data-message-id]")?.getAttribute("data-message-id") ?? "",
        text: bubble.innerText.trim(),
      })),
      cards: document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length,
      files: [...document.querySelectorAll(fileSelector)].flatMap((element) => element.getAttribute("data-testid") ?? []),
      users: [...document.querySelectorAll<HTMLElement>('[data-message-item="true"][data-message-role="user"],div[class*="chat-user-bubble"]')]
        .map((element) => `${element.getAttribute("data-message-id") ?? ""}\n${element.innerText.trim()}`),
      generating: Boolean(document.querySelector('[data-testid="hatch-composer-stop-button"],button[aria-label="Stop"]')),
    };
  }, { fileSelector: FILE_CARD });
  const sources = (await page.evaluate(attachmentsInPage)).filter(({ src }) => !src.startsWith("data:image/svg")).map(({ src }) => src);
  const snapshot = {
    messages: contents.messages.map(({ id, text }) => digest(`${id}\n${text}`)),
    sources: sources.map(mediaIdentity), cards: contents.cards, files: contents.files.map(digest), users: contents.users.map(digest),
  };
  return { ...contents, sources, snapshot };
}

/** Snapshot the delivered turn before foreground teardown so a fast follow-up is not mistaken for history. */
export async function rememberMuseTranscript(page: Page, statePath: string, id: string, delivered?: {
  readonly message: { readonly id: string; readonly text: string } | null;
  readonly sources: readonly string[];
  readonly files: readonly string[];
  readonly historicalPresentations: ReadonlySet<string>;
  readonly historicalMessages: ReadonlySet<string>;
}): Promise<readonly string[]> {
  if (!threadId.test(id) || id === "new") return [];
  const state = await readState(statePath);
  const current = (await readTranscript(page)).snapshot;
  const previous = state.captures[id];
  if (!delivered) {
    if (previous) return previous.sources;
    state.captures[id] = current;
  } else {
    const message = delivered.message;
    const historical = (await page.evaluate(attachmentsInPage)).filter(item =>
      delivered.historicalPresentations.has(item.presentation) || delivered.historicalMessages.has(item.message));
    state.captures[id] = {
      messages: [...new Set([...(previous?.messages ?? []), ...(message ? [digest(`${message.id}\n${message.text}`)] : [])])],
      sources: [...new Set([...(previous?.sources ?? []), ...historical.map(item => mediaIdentity(item.src)), ...delivered.sources.map(mediaIdentity)])],
      files: [...new Set([...(previous?.files ?? []), ...delivered.files.map(digest)])],
      cards: current.cards, users: current.users,
    };
  }
  await saveState(statePath, state);
  return state.captures[id]?.sources ?? [];
}

/** Owns navigation of the one already-open account page. Never navigates while a card is pending. */
export async function watchMusePage(page: Page, origin: URL, context: MuseWatchContext, statePath: string, approvalTimeout: number): Promise<void> {
  const state = await readState(statePath);
  const save = () => saveState(statePath, state);
  const threads = new Map(context.threads.filter((entry) => entry.threadId !== "new" && threadId.test(entry.threadId)).map((entry) => [entry.threadId, entry]));
  const targets = new Set([...threads.keys(), ...state.targets.filter(id => threadId.test(id) && id !== "new")]);
  const preflighted = new Set<string>();
  const candidates = new Map<string, { readonly fingerprint: string; readonly since: number }>();
  const activePath = () => /^\/thread\/([A-Za-z0-9_-]{1,128})\/?$/.exec(new URL(page.url()).pathname)?.[1] ?? null;

  const capture = async (id: string) => {
    const current = await readTranscript(page);
    const baseline = state.captures[id];
    if (!baseline) {
      if (current.generating) return;
      state.captures[id] = current.snapshot;
      candidates.delete(id);
      await save();
      return;
    }
    const original = threads.get(id)?.output.trim();
    const text = current.messages.filter(({ text }, index) => text && !baseline.messages.includes(current.snapshot.messages[index] ?? "") &&
      (!original || (text !== original && !original.startsWith(`${text}\n\n`)))).map((message) => message.text).join("\n\n");
    const freshMedia = current.snapshot.sources.some((src) => !baseline.sources.includes(src));
    const freshFiles = new Set(current.files.filter((file) => !baseline.files.includes(digest(file))));
    const hasDelta = text || freshMedia || freshFiles.size;
    if (!hasDelta || current.generating || await page.evaluate(hasPendingMuseTask)) {
      candidates.delete(id);
      return;
    }
    const fingerprint = digest(JSON.stringify(current.snapshot));
    const candidate = candidates.get(id);
    if (candidate?.fingerprint !== fingerprint) {
      candidates.set(id, { fingerprint, since: Date.now() });
      return;
    }
    // Presentations can land in a distinct row a moment after the text message.
    if (Date.now() - candidate.since < 1_000) return;
    const media = freshMedia
      ? await generatedMedia(page, { cards: baseline.cards, sources: new Set(current.sources.filter((src) => baseline.sources.includes(mediaIdentity(src)))) })
      : { images: [], files: [], notes: [] };
    const downloaded = await downloadFiles(page, freshFiles, MAX_FILES - media.files.length);
    const body = [text, ...media.notes, ...downloaded.blocks].filter(Boolean).join("\n\n");
    const files = [...media.files, ...downloaded.files];
    if (!body && !media.images.length && !files.length) return;
    context.signal.throwIfAborted();
    context.onWatchResult(id, { text: body, remoteId: id, images: media.images, files, deliveryId: fingerprint });
    state.captures[id] = current.snapshot;
    candidates.delete(id);
    await save();
  };

  const approvals = new ApprovalWait(page, context, scanApprovalCard, approvalTimeout, {
    async register(identity) {
      const key = digest(identity);
      const existing = state.approvals[key];
      if (existing) return existing.clicked || Date.parse(existing.expiresAt) <= Date.now() ? null : existing;
      const prompt = { id: randomUUID(), expiresAt: new Date(Date.now() + approvalTimeout).toISOString(), clicked: false };
      state.approvals[key] = prompt;
      await save();
      return prompt;
    },
    publish: context.onWatchApproval,
    async clicked(identity) {
      const key = digest(identity);
      const prompt = state.approvals[key];
      if (prompt) state.approvals[key] = { ...prompt, clicked: true };
      await save();
    },
  });
  const visit = async (path: string) => {
    await approvals.dispose();
    const response = await page.goto(new URL(path, origin).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (response?.status() === 404) return false;
    return page.getByRole("log").waitFor({ state: "attached", timeout: 5_000 }).then(() => true, (error: unknown) => {
      context.signal.throwIfAborted();
      if (path === "/" || error instanceof Error && error.name === "TimeoutError") return false;
      throw error;
    });
  };

  try {
    // Snapshot actual DOM before any owner decision, including images/files already delivered
    // with the kickoff. Do not reconstruct earlier output from the latest chat.
    for (const id of targets) {
      if (!state.captures[id] && await visit(`/thread/${id}`) && activePath() === id) await capture(id);
    }
    let next = 0;
    while (!context.signal.aborted) {
      const routes = ["/", ...[...targets].map((id) => `/thread/${id}`)];
      const route = routes[next] ?? "/";
      const ready = await visit(route) || (route === "/" && await visit("/thread/new"));
      for (let tick = 0; tick < 8 && ready; tick++) {
        context.signal.throwIfAborted();
        const card = await page.evaluateHandle(scanApprovalCard, APPROVAL_CARD_SELECTOR);
        const originCard = await card.evaluate(value => value ? { identity: value.identity, threadId: value.threadId } : null);
        await card.dispose();
        const source = originCard?.threadId;
        if (source && threadId.test(source) && !state.captures[source] && !preflighted.has(source)) {
          preflighted.add(source);
          targets.add(source);
          state.targets = [...targets];
          await save();
          // No token has been published yet. Baseline the explicit source, then pin a fresh handle
          // only if the same provider request still owns the card on return.
          const returnTo = new URL(page.url()).pathname;
          if (await visit(`/thread/${source}`) && activePath() === source) await capture(source);
          await visit(returnTo);
          const returned = await page.evaluateHandle(scanApprovalCard, APPROVAL_CARD_SELECTOR);
          const same = await returned.evaluate((value, identity) => value?.identity === identity, originCard.identity);
          await returned.dispose();
          if (!same) continue;
        }
        while (await approvals.check()) { /* Keep the page pinned until this card is resolved or withdrawn. */ }
        const id = activePath();
        if (id && targets.has(id)) await capture(id);
        await delay(250, undefined, { signal: context.signal });
      }
      if (!ready) await delay(250, undefined, { signal: context.signal });
      next = (next + 1) % routes.length;
    }
  } catch (error) {
    if (!context.signal.aborted) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("muse_watch", "Muse approval watcher could not read the account page.", 502);
    }
  } finally { await approvals.dispose().catch(() => undefined); }
}
