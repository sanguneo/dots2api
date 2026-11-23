import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import type { MuseWatchContext, ProviderAdapter } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";
import { createMuseAdapter } from "../src/providers/muse";

async function fixture(watch: (context: MuseWatchContext) => Promise<void>, onRun = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "muse-events-"));
  const store = new Store(dir);
  const adapter: ProviderAdapter = {
    ...createMuseAdapter("http://localhost:1"),
    check: async () => ({ detail: "Ready" }),
    run: async (_credentials, _prompt, context) => {
      onRun();
      context.onAccepted?.("origin-thread");
      return { text: "들어갈게요.", remoteId: "origin-thread" };
    },
    watch: async (_credentials, context) => watch(context),
  };
  const gateway = new Gateway(store, { muse: adapter, dots: adapter });
  const account = gateway.create("muse", "Ellie", {});
  await gateway.check(account.id);
  const original = gateway.submit({ accountId: account.id, prompt: "Open site", kind: "chat", thread: "tg-owner" });
  await gateway.wait(original.id);
  const app = createApi(gateway);
  const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
  return {
    gateway, store, original, account, app, headers,
    async close() {
      gateway.stop();
      await gateway.drain();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("late approvals and side task files remain deliverable after the original job completed", async () => {
  const published = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<void>();
  let clicks = 0;
  const approval = {
    id: crypto.randomUUID(), description: "Browser approval",
    choices: [{ id: "once", label: "이 작업에 대해 허용" }, { id: "always", label: "항상 허용" }, { id: "deny", label: "거부" }],
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const f = await fixture(async context => {
    expect(context.threads).toContainEqual({ threadId: "origin-thread", jobId: f.original.id, output: "들어갈게요." });
    const withdraw = context.onWatchApproval("origin-thread", approval, async () => {
      clicks++;
      answered.resolve();
      return true;
    });
    published.resolve();
    await Promise.race([answered.promise, new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    withdraw();
    if (context.signal.aborted) return;
    const output = {
      text: "Copied prompt", remoteId: "origin-thread",
      files: [{ name: "prompt.txt", mime: "text/plain", data: new TextEncoder().encode("actual prompt") }],
      deliveryId: "transcript-result-1",
    };
    context.onWatchResult("origin-thread", output);
    context.onWatchResult("origin-thread", output);
    result.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    f.gateway.startMuseWatchers();
    await published.promise;
    const url = "/api/muse-events";
    expect((await f.app.request(url, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(401);
    const { events } = await (await f.app.request(url, { headers: f.headers })).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "approval_required", approval, followup: { originJobId: f.original.id } });
    const answerUrl = `/api/jobs/${events[0].id}/approvals/${approval.id}`;
    expect((await f.app.request(answerUrl, { method: "POST", headers: f.headers, body: '{"choiceId":"once"}' })).status).toBe(200);
    await result.promise;
    expect((await f.app.request(answerUrl, { method: "POST", headers: f.headers, body: '{"choiceId":"once"}' })).status).toBe(409);
    expect(clicks).toBe(1);
    const deliveredEvents = (await (await f.app.request(url, { headers: f.headers })).json()).events;
    expect(deliveredEvents).toHaveLength(1);
    const completed = deliveredEvents[0];
    expect(completed).toMatchObject({ status: "completed", output: "Copied prompt", files: [{ name: "prompt.txt" }] });
    const file = await f.app.request(`/api/jobs/${completed.id}/files/0`, { headers: f.headers });
    expect(await file.text()).toBe("actual prompt");
    expect((await f.app.request(`${url}/${completed.id}/ack`, { method: "POST", headers: f.headers })).status).toBe(200);
    expect((await (await f.app.request(url, { headers: f.headers })).json()).events).toEqual([]);
    expect(f.store.job(f.original.id)?.output).toBe("들어갈게요.");
  } finally { await f.close(); }
});

test("foreground work waits until the idle watcher releases the account browser", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = false;
  let runs = 0;
  const f = await fixture(async context => {
    started.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    await release.promise;
    closed = true;
  }, () => {
    if (runs++ > 0) expect(closed).toBe(true);
  });
  try {
    f.gateway.startMuseWatchers();
    await started.promise;
    const job = f.gateway.submit({ accountId: f.account.id, prompt: "Next", kind: "chat", thread: "tg-owner" });
    release.resolve();
    await f.gateway.wait(job.id);
    expect(closed).toBe(true);
    expect(runs).toBe(2);
    expect(f.store.job(job.id)?.status).toBe("completed");
  } finally { release.resolve(); await f.close(); }
});

test("identical follow-up bytes survive changing delivery IDs and gateway restart", async () => {
  let published = Promise.withResolvers<void>();
  const f = await fixture(async context => {
    for (let i = 0; i < 4; i++) context.onWatchResult("origin-thread", {
      text: "Finished side task", remoteId: "origin-thread", deliveryId: `unstable-snapshot-${i}`,
      files: [{ name: "result.txt", mime: "text/plain", data: new TextEncoder().encode("same bytes") }],
    });
    published.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    f.gateway.startMuseWatchers();
    await published.promise;
    expect(f.store.jobs(-1).filter(job => job.followup && job.status === "completed")).toHaveLength(1);
    f.gateway.stop();
    await f.gateway.drain();
    const restarted = new Gateway(f.store, f.gateway.adapters);
    try {
      published = Promise.withResolvers<void>();
      restarted.startMuseWatchers();
      await published.promise;
      expect(f.store.jobs(-1).filter(job => job.followup && job.status === "completed")).toHaveLength(1);
    } finally { restarted.stop(); await restarted.drain(); }
  } finally { await f.close(); }
});

test("the fourth distinct follow-up pauses the account watcher", async () => {
  const published = Promise.withResolvers<void>();
  const f = await fixture(async context => {
    for (let i = 0; i < 5; i++) context.onWatchResult("origin-thread", {
      text: `Distinct task ${i}`, remoteId: "origin-thread", deliveryId: `result-${i}`,
    });
    published.resolve();
    if (context.signal.aborted) return;
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    f.gateway.startMuseWatchers();
    await published.promise;
    expect(f.store.jobs(-1).filter(job => job.followup && job.status === "completed")).toHaveLength(3);
  } finally { await f.close(); }
});

test("unlinked account approvals do not claim the most recent request as their origin", async () => {
  const published = Promise.withResolvers<void>();
  const approval = {
    id: crypto.randomUUID(), description: "Unlinked Browser approval",
    choices: [{ id: "deny", label: "거부" }], expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const f = await fixture(async context => {
    const withdraw = context.onWatchApproval(null, approval, async () => true);
    published.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    withdraw();
  });
  try {
    f.gateway.startMuseWatchers();
    await published.promise;
    const response = await f.app.request("/api/muse-events", { headers: f.headers });
    const { events } = await response.json();
    expect(events).toHaveLength(1);
    expect(events[0].followup.originJobId).toBeNull();
    expect((await f.app.request(`/api/muse-events/${events[0].id}/ack`, { method: "POST", headers: f.headers })).status).toBe(409);
  } finally { await f.close(); }
});

test("a shared conversation does not identify which original request spawned an approval", async () => {
  const published = Promise.withResolvers<void>();
  const f = await fixture(async context => {
    const withdraw = context.onWatchApproval("origin-thread", {
      id: crypto.randomUUID(), description: "Shared conversation approval",
      choices: [{ id: "deny", label: "거부" }], expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }, async () => true);
    published.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    withdraw();
  });
  try {
    const second = f.gateway.submit({ accountId: f.account.id, prompt: "Another request", kind: "chat", thread: "tg-owner" });
    await f.gateway.wait(second.id);
    f.gateway.startMuseWatchers();
    await published.promise;
    const { events } = await (await f.app.request("/api/muse-events", { headers: f.headers })).json();
    expect(events[0].followup.originJobId).toBeNull();
  } finally { await f.close(); }
});

test("an answered unlinked approval leaves no orphan running event", async () => {
  const published = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<void>();
  const approval = {
    id: crypto.randomUUID(), description: "Unlinked approval",
    choices: [{ id: "deny", label: "거부" }], expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const f = await fixture(async context => {
    const withdraw = context.onWatchApproval(null, approval, async () => { selected.resolve(); return true; });
    published.resolve();
    await Promise.race([selected.promise, new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    withdraw();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  try {
    f.gateway.startMuseWatchers();
    await published.promise;
    const { events } = await (await f.app.request("/api/muse-events", { headers: f.headers })).json();
    const answered = await f.app.request(`/api/jobs/${events[0].id}/approvals/${approval.id}`, {
      method: "POST", headers: f.headers, body: '{"choiceId":"deny"}',
    });
    expect(answered.status).toBe(200);
    expect((await (await f.app.request("/api/muse-events", { headers: f.headers })).json()).events).toEqual([]);
  } finally { await f.close(); }
});
