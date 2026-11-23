import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { GatewayError, MAX_FILES } from "../../contracts";
import type { MuseWatchContext } from "../../contracts";
import { APPROVAL_CARD_SELECTOR, scanApprovalCard } from "./approval-dom";
import { ApprovalWait } from "./approval-wait";
import { hasPendingMuseTask } from "./completion";
import { attachmentsInPage, downloadFiles, generatedMedia } from "./media";
import { followupContentHash } from "../../muse-followups";
import { digest, mediaIdentity, readState, readTranscript, saveState } from "./watch-state";

const threadId = /^[A-Za-z0-9_-]{1,128}$/;
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
      mediaKeys: [...new Set([...(previous?.mediaKeys ?? []), ...current.mediaKeys])],
      presentations: [...new Set([...(previous?.presentations ?? []), ...current.presentations])],
      messageIds: [...new Set([...(previous?.messageIds ?? []), ...current.messageIds])],
      mediaHashes: [...new Set([...(previous?.mediaHashes ?? []), ...current.mediaHashes])],
      texts: [...new Set([...(previous?.texts ?? []), ...current.texts])],
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
  const baselined = new Set<string>();
  const sourceHashes = new Map<string, string>();
  const activePath = () => /^\/thread\/([A-Za-z0-9_-]{1,128})\/?$/.exec(new URL(page.url()).pathname)?.[1] ?? null;

  const capture = async (id: string) => {
    const current = await readTranscript(page, sourceHashes);
    // URLs are transport handles, never evidence of a new presentation.
    const fingerprint = digest(JSON.stringify({ ...current.snapshot, sources: [] }));
    const baseline = state.captures[id];
    if (!baselined.has(id) || !baseline) {
      if (current.generating) return;
      const candidate = candidates.get(id);
      if (candidate?.fingerprint !== fingerprint) {
        candidates.set(id, { fingerprint, since: Date.now() });
        return;
      }
      // The log mounts before history; real Muse also mounts messages before blob images.
      if (Date.now() - candidate.since < 3_000) return;
      state.captures[id] = current.snapshot;
      baselined.add(id);
      candidates.delete(id);
      await save();
      context.onWatchBaseline?.(id, current.snapshot.mediaHashes);
      return;
    }
    const original = threads.get(id)?.output.trim();
    const text = current.messages.filter(({ id: messageId, text }, index) => text &&
      !baseline.texts.includes(digest(text)) && (!messageId || !baseline.messageIds.includes(messageId)) &&
      !baseline.messages.includes(current.snapshot.messages[index] ?? "") &&
      (!original || (text !== original && !original.startsWith(`${text}\n\n`)))).map((message) => message.text).join("\n\n");
    const freshMedia = current.snapshot.mediaKeys.some((key, index) => !baseline.mediaHashes.includes(current.snapshot.mediaHashes[index] ?? "") &&
      !baseline.mediaKeys.includes(key) &&
      !baseline.messageIds.some(message => digest(`message\n${message}`) === key) &&
      !baseline.presentations.some(presentation => digest(`presentation\n${presentation}`) === key));
    const freshCards = current.fileCards.filter(card => !baseline.files.includes(digest(card.id)) &&
      (!card.owner || !baseline.messageIds.includes(card.owner)));
    const freshFiles = new Set(freshCards.map(card => card.id));
    const hasDelta = text || freshMedia || freshFiles.size;
    if (!hasDelta || current.generating || await page.evaluate(hasPendingMuseTask)) {
      candidates.delete(id);
      return;
    }
    const candidate = candidates.get(id);
    if (candidate?.fingerprint !== fingerprint) {
      candidates.set(id, { fingerprint, since: Date.now() });
      return;
    }
    // Presentations can land in a distinct row a moment after the text message.
    if (Date.now() - candidate.since < 1_000) return;
    const media = freshMedia
      ? await generatedMedia(page, {
        cards: baseline.cards, messages: new Set(baseline.messageIds),
        sources: new Set(current.sources.filter((_src, i) => {
          const key = current.snapshot.mediaKeys[i] ?? "";
          return baseline.mediaHashes.includes(current.snapshot.mediaHashes[i] ?? "") || baseline.mediaKeys.includes(key) ||
            baseline.presentations.some(p => digest(`presentation\n${p}`) === key);
        })),
      })
      : { images: [], files: [], notes: [] };
    const downloaded = await downloadFiles(page, freshFiles, MAX_FILES - media.files.length);
    const body = [text, ...media.notes, ...downloaded.blocks].filter(Boolean).join("\n\n");
    const files = [...media.files, ...downloaded.files];
    if (!body && !media.images.length && !files.length) return;
    context.signal.throwIfAborted();
    const result = {
      text: body, remoteId: id, images: media.images, files, deliveryId: fingerprint,
      followupKeys: [
        ...freshCards.map(card => digest(card.owner ? `message\n${card.owner}` : `file\n${card.id}`)),
        ...current.snapshot.messageIds.filter(m => !baseline.messageIds.includes(m)).map(m => digest(`message\n${m}`)),
        ...current.presentations.filter(p => !baseline.presentations.includes(p)).map(p => digest(`presentation\n${p}`)),
        ...current.snapshot.messages.filter(message => !baseline.messages.includes(message)),
      ],
    };
    const hash = followupContentHash(result);
    const duplicate = state.deliveredHashes.includes(hash);
    if (!duplicate) state.deliveredHashes.push(hash);
    state.captures[id] = {
      ...current.snapshot,
      messages: [...new Set([...baseline.messages, ...current.snapshot.messages])],
      sources: [...new Set([...baseline.sources, ...current.snapshot.sources])],
      files: [...new Set([...baseline.files, ...current.snapshot.files])],
      mediaKeys: [...new Set([...baseline.mediaKeys, ...current.snapshot.mediaKeys])],
      presentations: [...new Set([...baseline.presentations, ...current.snapshot.presentations])],
      messageIds: [...new Set([...baseline.messageIds, ...current.snapshot.messageIds])],
      mediaHashes: [...new Set([...baseline.mediaHashes, ...current.snapshot.mediaHashes])],
      texts: [...new Set([...baseline.texts, ...current.snapshot.texts])],
    };
    candidates.delete(id);
    await save();
    context.signal.throwIfAborted();
    if (!duplicate) context.onWatchResult(id, result);
  };

  const establishBaseline = async (id: string) => {
    const deadline = Date.now() + 30_000;
    while (!baselined.has(id)) {
      context.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new GatewayError("muse_watch_baseline", "Muse transcript did not finish its initial baseline.", 502);
      await capture(id);
      if (!baselined.has(id)) await delay(250, undefined, { signal: context.signal });
    }
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
    sourceHashes.clear();
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
      if (await visit(`/thread/${id}`) && activePath() === id) await establishBaseline(id);
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
          if (await visit(`/thread/${source}`) && activePath() === source) await establishBaseline(source);
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
