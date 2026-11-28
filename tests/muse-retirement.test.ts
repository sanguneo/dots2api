import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { jobIdSchema } from "../src/contracts";
import type { Job, MuseWatchContext, ProviderAdapter } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { followupContentHash } from "../src/muse-followups";
import { Store } from "../src/store";
import { createMuseAdapter } from "../src/providers/muse";

const STALE = "Accepted. The attachment is saved and a separate worker is summarizing it.";

async function fixture(watch: (context: MuseWatchContext) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "muse-retire-"));
  const store = new Store(dir);
  const adapter: ProviderAdapter = {
    ...createMuseAdapter("http://localhost:1"),
    check: async () => ({ detail: "Ready" }),
    run: async (_credentials, prompt, context) => {
      const remoteId = context.threadId ?? (prompt.includes("old") ? "old-side" : prompt.includes("other") ? "other-side" : "fresh-side");
      context.onAccepted?.(remoteId);
      return { text: `answer for ${remoteId}`, remoteId };
    },
    watch: async (_credentials, context) => watch(context),
  };
  const gateway = new Gateway(store, { muse: adapter, dots: adapter });
  const account = gateway.create("muse", "Fixture Muse", {});
  await gateway.check(account.id);
  const submit = async (prompt: string, thread: string) => gateway.wait(gateway.submit({ accountId: account.id, prompt, kind: "chat", thread }).id);
  const retiredAt = Date.now() - 60_000;
  const before = new Date(retiredAt - 3_600_000).toISOString();
  const old = store.saveJob({ ...await submit("old request", "retired-thread"), createdAt: before });
  const other = store.saveJob({ ...await submit("other request", "unrelated-thread"), createdAt: before });
  const backlog = store.saveJob({
    id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "muse", prompt: "", status: "completed",
    output: STALE, error: null, remoteId: "old-side", images: [], files: [],
    followup: { originJobId: null, deliveredAt: null, contentHash: followupContentHash({ text: STALE }) },
    createdAt: before, finishedAt: before,
  });
  // Exactly what an operator retirement writes.
  store.db.exec(`CREATE TABLE IF NOT EXISTS muse_watch_retired (
    account_id TEXT NOT NULL, thread_id TEXT NOT NULL, retired_at INTEGER NOT NULL, resumed_at INTEGER,
    PRIMARY KEY(account_id, thread_id))`);
  store.db.query("INSERT INTO muse_watch_retired (account_id, thread_id, retired_at) VALUES (?, ?, ?)").run(account.id, "old-side", retiredAt);
  const headers = { authorization: `Bearer ${store.apiKey}` };
  const events = async (serving = gateway): Promise<Job[]> =>
    (await (await createApi(serving).request("/api/muse-events", { headers })).json()).events;
  return {
    gateway, store, account, old, other, backlog, submit, events,
    async close() {
      gateway.stop();
      await gateway.drain();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const watching = (onContext: (context: MuseWatchContext) => void) => {
  let published = Promise.withResolvers<void>();
  const watch = async (context: MuseWatchContext) => {
    onContext(context);
    published.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  return { watch, published: () => published.promise, rearm: () => { published = Promise.withResolvers<void>(); } };
};

test("a retired side stops republishing its old reply while new and unrelated sides still publish", async () => {
  const seen: string[][] = [];
  const w = watching(context => {
    seen.push(context.threads.map(thread => thread.threadId));
    context.onWatchResult("old-side", { text: STALE, remoteId: "old-side", deliveryId: "stale-again" });
    context.onWatchResult("other-side", { text: "unrelated late result", remoteId: "other-side", deliveryId: "other-1" });
    context.onWatchResult("fresh-side", { text: "genuine new result", remoteId: "fresh-side", deliveryId: "fresh-1" });
  });
  const f = await fixture(w.watch);
  try {
    const genuine = await f.submit("new request", "chat-new-request");
    expect(genuine.remoteId).toBe("fresh-side");
    f.gateway.startMuseWatchers();
    await w.published();
    expect(seen[0]).not.toContain("old-side");
    expect(seen[0]).toEqual(expect.arrayContaining(["other-side", "fresh-side"]));
    const listed = await f.events();
    expect(listed.map(event => event.remoteId).sort()).toEqual(["fresh-side", "other-side"]);
    expect(listed.find(event => event.remoteId === "fresh-side")?.followup?.originJobId).toBe(genuine.id);
    expect(f.store.job(f.backlog.id)).toEqual(f.backlog);
    expect(f.store.jobs(-1).filter(job => job.remoteId === "old-side" && job.followup)).toEqual([f.backlog]);
    expect(f.store.job(f.old.id)).toEqual(f.old);

    f.gateway.stop();
    await f.gateway.drain();
    const restarted = new Gateway(f.store, f.gateway.adapters);
    try {
      w.rearm();
      restarted.startMuseWatchers();
      await w.published();
      expect(seen[1]).not.toContain("old-side");
      expect(f.store.jobs(-1).filter(job => job.remoteId === "old-side" && job.followup)).toEqual([f.backlog]);
    } finally { restarted.stop(); await restarted.drain(); }
  } finally { await f.close(); }
});

test("a request made after the reset that reuses a retired side receives its follow-ups", async () => {
  const seen: string[][] = [];
  const w = watching(context => {
    seen.push(context.threads.map(thread => thread.threadId));
    context.onWatchResult("old-side", { text: "reply to the new request", remoteId: "old-side", deliveryId: "reuse-1" });
  });
  const f = await fixture(w.watch);
  try {
    const reuse = await f.submit("again", "retired-thread");
    expect(reuse.remoteId).toBe("old-side");
    f.gateway.startMuseWatchers();
    await w.published();
    expect(seen[0]).toContain("old-side");
    const listed = await f.events();
    expect(listed.map(event => event.output)).toEqual(["reply to the new request"]);
    expect(listed.some(event => event.id === f.backlog.id)).toBe(false);
  } finally { await f.close(); }
});

test("a resumed side keeps publishing after retention removes the resuming request while its old backlog stays hidden", async () => {
  const seen: string[][] = [];
  const w = watching(context => {
    seen.push(context.threads.map(thread => thread.threadId));
    context.onWatchResult("old-side", { text: "reply after the resumed request aged out", remoteId: "old-side", deliveryId: "resumed-later" });
  });
  const f = await fixture(w.watch);
  try {
    const reuse = await f.submit("again", "retired-thread");
    f.store.db.query("DELETE FROM jobs WHERE id=?").run(reuse.id);
    f.gateway.stop();
    await f.gateway.drain();
    const restarted = new Gateway(f.store, f.gateway.adapters);
    try {
      restarted.startMuseWatchers();
      await w.published();
      expect(seen[0]).toContain("old-side");
      const listed = await f.events(restarted);
      expect(listed.map(event => event.output)).toEqual(["reply after the resumed request aged out"]);
      expect(f.store.job(f.backlog.id)).toEqual(f.backlog);
    } finally { restarted.stop(); await restarted.drain(); }
  } finally { await f.close(); }
});
