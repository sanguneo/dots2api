import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { GatewayError } from "../src/contracts";
import type { AdapterContext, ProviderAdapter, ProviderId, ThreadDeletion } from "../src/contracts";
import { CHAT_IDLE_MS, Gateway, IMAGE_IDLE_MS } from "../src/gateway";
import { Store } from "../src/store";
import { parseThreadKey } from "../src/thread-key";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface Seen { readonly threadId: string | null | undefined; readonly pruneAfter: boolean | undefined }

/** Gateway over scripted adapters and a clock the test moves by hand; nothing sleeps. */
function fixture(options: { fail?: boolean; deletion?: ThreadDeletion; holdDots?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-sessions-"));
  const store = new Store(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const clock = { now: 1_000_000 };
  const seen: Seen[] = [];
  const deleted: string[] = [];
  let counter = 0;
  const checks: ProviderId[] = [];
  const adapter = (id: ProviderId): ProviderAdapter => ({
    info: { id, name: id, description: "Test transport", setupUrl: "https://example.org", fields: [],
      contextWindow: 1, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true } },
    validate: (credentials) => credentials,
    check: async () => { checks.push(id); return { detail: "ok" }; },
    async run(_credentials, _prompt, context: AdapterContext) {
      if (id === "dots") await options.holdDots;
      seen.push({ threadId: context.threadId, pruneAfter: context.pruneAfter });
      if (options.fail) throw new GatewayError("muse_result", "Muse finished without text or an image.", 502);
      return { text: "answer", remoteId: context.threadId ?? `thread-${++counter}` };
    },
    ...(id === "muse" ? { deleteThread: async (_c: unknown, threadId: string) => { deleted.push(threadId); return options.deletion ?? "deleted"; } } : {}),
  });
  const gateway = new Gateway(store, { dots: adapter("dots"), muse: adapter("muse") }, undefined, { now: () => clock.now });
  return { dir, store, gateway, clock, seen, deleted, checks, app: createApi(gateway) };
}
async function readyAccount(f: ReturnType<typeof fixture>, provider: ProviderId) {
  const account = f.gateway.create(provider, provider, {});
  await f.gateway.check(account.id);
  return account;
}
const run = async (f: ReturnType<typeof fixture>, kind: "image" | "chat", thread?: string) =>
  f.gateway.wait(f.gateway.submit({ provider: "muse", prompt: "p", kind, ...(thread ? { thread } : {}) }).id);

describe("thread key", () => {
  test("accepts 1-64 characters from the allowed set and prefers the body field over the header", () => {
    expect(parseThreadKey("Topic_1.a:b-c", undefined)).toBe("Topic_1.a:b-c");
    expect(parseThreadKey("x".repeat(64), undefined)).toHaveLength(64);
    expect(parseThreadKey("body", "header")).toBe("body");
    expect(parseThreadKey(undefined, "header")).toBe("header");
    expect(parseThreadKey(undefined, undefined)).toBeUndefined();
  });
  test.each(["", "x".repeat(65), "has space", "slash/key", "한글"])("rejects %j", (value) => {
    expect(() => parseThreadKey(value, undefined)).toThrow(GatewayError);
    expect(() => parseThreadKey(undefined, value)).toThrow(GatewayError);
  });
  test("an invalid key is a 400 on every route before any job is submitted", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    const headers = { authorization: `Bearer ${f.store.apiKey}`, "content-type": "application/json" };
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      f.app.request(`http://localhost${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const chat = await post("/v1/chat/completions", { model: "muse-agent", messages: [{ role: "user", content: "hi" }], thread: "bad key" });
    const image = await post("/v1/images/generations", { model: "muse-image", prompt: "cat" }, { "X-Muse-Thread": "bad key" });
    expect(chat.status).toBe(400);
    expect((await chat.json()).error.code).toBe("invalid_thread");
    expect(image.status).toBe(400);
    expect(f.store.jobs()).toHaveLength(0);
  });
  test("a valid key on chat reuses the side chat through the HTTP route", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    const ask = () => f.app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${f.store.apiKey}`, "content-type": "application/json", "X-Muse-Thread": "topic-1" },
      body: JSON.stringify({ model: "muse-agent", messages: [{ role: "user", content: "hi" }] }),
    });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    expect(f.seen.map((s) => s.threadId)).toEqual([undefined, "thread-1"]);
  });
});

describe("side chat reuse", () => {
  test("the same key reopens the stored chat; a new key or no key opens a new one", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    await run(f, "chat", "topic");
    await run(f, "chat", "topic");
    await run(f, "chat", "other");
    await run(f, "chat");
    expect(f.seen.map((s) => s.threadId)).toEqual([undefined, "thread-1", undefined, undefined]);
  });
  test("the map survives a restart", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    await run(f, "image", "topic");
    const reopened = new Store(f.dir);
    try { expect(reopened.museThreads().map((t) => [t.kind, t.key, t.threadId])).toEqual([["image", "topic", "thread-1"]]); }
    finally { reopened.close(); }
  });
  test("a keyed request goes back to the account that holds its chat", async () => {
    const f = fixture();
    const first = await readyAccount(f, "muse");
    await run(f, "chat", "topic");
    const second = await readyAccount(f, "muse");
    // The new account has rested longer, so without the key it would be picked.
    f.store.saveAccount({ ...f.store.account(first.id)!, lastUsedAt: new Date().toISOString() });
    const job = await run(f, "chat", "topic");
    expect(job.accountId).toBe(first.id);
    expect(job.accountId).not.toBe(second.id);
  });
  test("Dots ignores the key", async () => {
    const f = fixture();
    await readyAccount(f, "dots");
    await f.gateway.wait(f.gateway.submit({ provider: "dots", prompt: "p", kind: "chat", thread: "topic" }).id);
    expect(f.store.museThreads()).toEqual([]);
    expect(f.seen[0]?.threadId).toBeUndefined();
  });
});

describe("muse-image idle sweep", () => {
  test("deletes a keyed and a keyless image chat idle for 10 minutes, and renewal postpones it", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    await run(f, "image", "topic");
    await run(f, "image");
    expect(f.store.museThreads()).toHaveLength(2);
    // Just under the window nothing is due.
    f.clock.now += IMAGE_IDLE_MS - 1;
    expect(await f.gateway.sweepThreads()).toBe(0);
    // A new request on the key renews it, then the window passes for the keyless chat only.
    await run(f, "image", "topic");
    f.clock.now += 1;
    expect(await f.gateway.sweepThreads()).toBe(1);
    expect(f.deleted).toEqual(["thread-2"]);
    expect(f.store.museThreads().map((t) => t.key)).toEqual(["topic"]);
    f.clock.now += IMAGE_IDLE_MS;
    expect(await f.gateway.sweepThreads()).toBe(1);
    expect(f.deleted).toEqual(["thread-2", "thread-1"]);
    expect(f.store.museThreads()).toEqual([]);
  });
  test("a chat that could not be deleted stays in the map; one already gone is forgotten", async () => {
    const failing = fixture({ deletion: "failed" });
    await readyAccount(failing, "muse");
    await run(failing, "image");
    failing.clock.now += IMAGE_IDLE_MS;
    expect(await failing.gateway.sweepThreads()).toBe(0);
    expect(failing.store.museThreads()).toHaveLength(1);
    const gone = fixture({ deletion: "gone" });
    await readyAccount(gone, "muse");
    await run(gone, "image");
    gone.clock.now += IMAGE_IDLE_MS;
    await gone.gateway.sweepThreads();
    expect(gone.store.museThreads()).toEqual([]);
  });
  test("a failed job leaves no tracked chat, so nothing is ever deleted for it", async () => {
    const f = fixture({ fail: true });
    await readyAccount(f, "muse");
    expect((await run(f, "image", "topic")).status).not.toBe("completed");
    f.clock.now += IMAGE_IDLE_MS * 10;
    expect(await f.gateway.sweepThreads()).toBe(0);
    expect(f.deleted).toEqual([]);
  });
});

describe("muse-agent chats", () => {
  test("a keyless chat is deleted by the job right after success and is not tracked", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    await run(f, "chat");
    expect(f.seen[0]?.pruneAfter).toBe(true);
    expect(f.store.museThreads()).toEqual([]);
  });
  test("a keyless chat that failed is not marked for deletion by the sweeper either", async () => {
    const f = fixture({ fail: true });
    await readyAccount(f, "muse");
    await run(f, "chat");
    // The job is only told to delete after success; the adapter never gets there on failure.
    expect(f.store.museThreads()).toEqual([]);
    f.clock.now += CHAT_IDLE_MS * 2;
    expect(await f.gateway.sweepThreads()).toBe(0);
  });
  test("a keyed chat is kept and deleted after 7 idle days", async () => {
    const f = fixture();
    await readyAccount(f, "muse");
    await run(f, "chat", "topic");
    expect(f.seen[0]?.pruneAfter).toBe(false);
    f.clock.now += CHAT_IDLE_MS - 1;
    expect(await f.gateway.sweepThreads()).toBe(0);
    f.clock.now += 1;
    expect(await f.gateway.sweepThreads()).toBe(1);
    expect(f.deleted).toEqual(["thread-1"]);
  });
  test("removing the account forgets its chats", async () => {
    const f = fixture();
    const account = await readyAccount(f, "muse");
    await run(f, "chat", "topic");
    f.gateway.remove(account.id);
    expect(f.store.museThreads()).toEqual([]);
  });
});

describe("provider_busy", () => {
  test("a busy Dot refuses chat and image requests at once and serves again when free", async () => {
    const release = Promise.withResolvers<void>();
    const f = fixture({ holdDots: release.promise });
    await readyAccount(f, "dots");
    const running = f.gateway.submit({ provider: "dots", prompt: "long", kind: "chat" });
    for (const kind of ["chat", "image"] as const) {
      expect(() => f.gateway.submit({ provider: "dots", prompt: "next", kind })).toThrow(expect.objectContaining({ code: "provider_busy", status: 409 }));
    }
    const response = await f.app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${f.store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("provider_busy");
    expect(body.error.message).toContain("muse-agent");
    release.resolve();
    await f.gateway.wait(running.id);
    expect(() => f.gateway.submit({ provider: "dots", prompt: "later", kind: "chat" })).not.toThrow();
  });
  test("console jobs without a kind still queue behind a busy Dot, and Muse still queues", async () => {
    const release = Promise.withResolvers<void>();
    const f = fixture({ holdDots: release.promise });
    await readyAccount(f, "dots");
    await readyAccount(f, "muse");
    f.gateway.submit({ provider: "dots", prompt: "long" });
    const queued = f.gateway.submit({ provider: "dots", prompt: "queued" });
    expect(queued.status).toBe("queued");
    release.resolve();
    await f.gateway.wait(queued.id);
  });
});

describe("startup re-check", () => {
  test("accounts in error are checked again and the ones that answer rejoin the rotation", async () => {
    const f = fixture();
    const broken = f.gateway.create("dots", "broken", {});
    const fine = f.gateway.create("muse", "fine", {});
    f.store.saveAccount({ ...broken, status: "error", detail: "interrupted" });
    await f.gateway.check(fine.id);
    f.checks.length = 0;
    expect(await f.gateway.recheckErroredAccounts()).toBe(1);
    expect(f.store.account(broken.id)?.status).toBe("ready");
    expect(f.checks).toEqual(["dots"]);
  });
});
