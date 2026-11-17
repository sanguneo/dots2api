import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { GatewayError } from "../src/contracts";
import type { ProviderAdapter, ProviderId, ThreadDeletion } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(options: { run?: ProviderAdapter["run"]; deletion?: ThreadDeletion | "throw"; deleteThread?: ProviderAdapter["deleteThread"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-delete-"));
  const store = new Store(dir);
  const remote = new Set<string>();
  let counter = 0;
  const adapter = (id: ProviderId): ProviderAdapter => ({
    info: { id, name: id, description: "Fake transport", setupUrl: "https://example.org", fields: [],
      contextWindow: 1, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true } },
    validate: (credentials) => credentials,
    check: async () => ({ detail: "fake ready" }),
    run: options.run ?? (async (_credentials, _prompt, context) => {
      const remoteId = context.threadId ?? `thread-${++counter}`;
      remote.add(remoteId);
      context.onAccepted?.(remoteId);
      return { text: "fake answer", remoteId };
    }),
    deleteThread: options.deleteThread ?? (async (_credentials, id) => {
      if (options.deletion === "throw") throw new Error("private upstream detail");
      if (options.deletion === "failed") return "failed";
      const existed = remote.delete(id);
      return options.deletion ?? (existed ? "deleted" : "gone");
    }),
  });
  const gateway = new Gateway(store, { dots: adapter("dots"), muse: adapter("muse") });
  cleanups.push(() => { gateway.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = createApi(gateway);
  const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
  const remove = (key = "w-task") => app.request(`http://localhost/api/muse-threads/${key}`, { method: "DELETE", headers });
  const ready = async () => {
    const account = gateway.create("muse", "Fake Muse", {});
    await gateway.check(account.id);
    return account;
  };
  const ask = (key = "w-task", stream = false) => app.request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { ...headers, "X-Muse-Thread": key },
    body: JSON.stringify({ model: "muse-agent", messages: [{ role: "user", content: "fake brief" }], stream }),
  });
  return { dir, store, gateway, app, headers, remote, remove, ready, ask };
}

test.each([false, true])("successful chat exposes thread id before cleanup (stream=%s)", async (stream) => {
  const f = fixture();
  await f.ready();
  const response = await f.ask("w-task", stream);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Muse-Thread-Id")).toBe("thread-1");
  const jobId = response.headers.get("X-Dots2api-Job-Id");
  const job = await f.app.request(`http://localhost/api/jobs/${jobId}`, { headers: f.headers });
  expect((await job.json()).job.remoteId).toBe("thread-1");
  await response.text();
});

test("deletes only the exact key across accounts and kinds through the real API", async () => {
  const f = fixture();
  const first = await f.ready();
  const second = await f.ready();
  for (const [accountId, kind, thread, threadId] of [
    [first.id, "chat", "w-task", "worker-chat"],
    [second.id, "image", "w-task", "worker-image"],
    [first.id, "chat", "tg123", "brain"],
    [first.id, "chat", "w-task-other", "other"],
  ] as const) {
    f.remote.add(threadId);
    f.store.saveMuseThread({ accountId, kind, key: thread, threadId, lastUsedAt: Date.now() });
  }
  const response = await f.remove();
  expect(response.status).toBe(200);
  expect((await response.json()).threads.map((thread: { threadId: string; status: string }) => [thread.threadId, thread.status]).sort())
    .toEqual([["worker-chat", "deleted"], ["worker-image", "deleted"]]);
  expect([...f.remote].sort()).toEqual(["brain", "other"]);
  expect(f.store.museThreads().map((thread) => thread.key).sort()).toEqual(["tg123", "w-task-other"]);
  expect(await (await f.remove()).json()).toEqual({ key: "w-task", threads: [] });
});

test.each(["failed", "gone", "throw"] as const)("reports ids and preserves retry state on %s", async (deletion) => {
  const f = fixture({ deletion });
  await f.ready();
  await f.ask();
  const response = await f.remove();
  expect(response.status).toBe(deletion === "gone" ? 200 : 502);
  const body = await response.json();
  expect(body.threads.map((thread: { threadId: string; status: string }) => [thread.threadId, thread.status]))
    .toEqual([["thread-1", deletion === "gone" ? "gone" : "failed"]]);
  expect(f.store.museThreads()).toHaveLength(deletion === "gone" ? 0 : 1);
  expect(JSON.stringify(body)).not.toContain("private upstream detail");
});

test.each([
  { host: "localhost", headers: {}, status: 401 },
  { host: "localhost", headers: { "sec-fetch-site": "cross-site" }, status: 401 },
  { host: "localhost", headers: { "sec-fetch-site": "same-origin" }, status: 200 },
  { host: "localhost", headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" }, status: 403 },
  { host: "evil.example", headers: { "sec-fetch-site": "same-origin" }, status: 403 },
])("protects DELETE with the existing host/origin/auth policy: %j", async ({ host, headers, status }) => {
  const f = fixture();
  const response = await f.app.request(`http://${host}/api/muse-threads/w-task`, { method: "DELETE", headers });
  expect(response.status).toBe(status);
});

test.each(["bad%20key", "x".repeat(65)])("rejects invalid deletion keys: %s", async (key) => {
  const f = fixture();
  const response = await f.remove(key);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_thread");
});

test.each(["tg123", "topic", "W-task"])("rejects non-worker deletion key %s and preserves its remote chat", async (key) => {
  const f = fixture();
  await f.ready();
  await f.ask(key);
  const response = await f.remove(key);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_thread");
  expect([...f.remote]).toEqual(["thread-1"]);
  expect(f.store.museThreads().map((thread) => thread.key)).toEqual([key]);
});

test.each(["failed", "throw"] as const)("retries replaced thread after %s deletion and storage restart", async (failure) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let failOld = true;
  const f = fixture({
    run: async (_credentials, _prompt, context) => {
      started.resolve();
      await release.promise;
      f.remote.add("new");
      context.onAccepted?.("new");
      return { text: "answer", remoteId: "new" };
    },
    deleteThread: async (_credentials, id) => {
      if (id === "old" && failOld) {
        if (failure === "throw") throw new Error("private deletion failure");
        return "failed";
      }
      return f.remote.delete(id) ? "deleted" : "gone";
    },
  });
  const account = await f.ready();
  f.remote.add("old");
  f.store.saveMuseThread({ accountId: account.id, kind: "chat", key: "w-task", threadId: "old", lastUsedAt: Date.now() });
  const running = f.ask();
  await started.promise;
  const deleting = f.remove();
  release.resolve();
  await running;
  const first = await deleting;
  expect(first.status).toBe(502);
  expect((await first.json()).threads.map((thread: { threadId: string; status: string }) => [thread.threadId, thread.status]).sort())
    .toEqual([["new", "deleted"], ["old", "failed"]]);
  f.gateway.stop();
  const reopened = new Store(f.dir);
  const restarted = new Gateway(reopened, f.gateway.adapters);
  try {
    failOld = false;
    const response = await createApi(restarted).request("http://localhost/api/muse-threads/w-task", { method: "DELETE", headers: f.headers });
    expect((await response.json()).threads.map((thread: { threadId: string; status: string }) => [thread.threadId, thread.status]))
      .toEqual([["old", "deleted"]]);
    expect([...f.remote]).toEqual([]);
    expect(reopened.museThreads()).toEqual([]);
  } finally { restarted.stop(); reopened.close(); }
});

test("retains every replacement made before DELETE starts", async () => {
  const f = fixture({ run: async (_credentials, _prompt, context) => {
    for (const id of ["intermediate", "new"]) { f.remote.add(id); context.onAccepted?.(id); }
    return { text: "answer", remoteId: "new" };
  } });
  const account = await f.ready();
  f.remote.add("old");
  f.store.saveMuseThread({ accountId: account.id, kind: "chat", key: "w-task", threadId: "old", lastUsedAt: Date.now() });
  await f.ask();
  const response = await f.remove();
  expect((await response.json()).threads.map((thread: { threadId: string }) => thread.threadId).sort())
    .toEqual(["intermediate", "new", "old"]);
  expect([...f.remote]).toEqual([]);
});

test("cleanup waits for queued late creation and excludes new work using that key", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({ run: async (_credentials, prompt, context) => {
    if (prompt === "hold") { started.resolve(); await release.promise; }
    const remoteId = context.threadId ?? prompt;
    f.remote.add(remoteId);
    context.onAccepted?.(remoteId);
    return { text: "fake answer", remoteId };
  } });
  const account = await f.ready();
  const running = f.gateway.submit({ provider: "muse", kind: "chat", thread: "tg123", prompt: "hold" });
  await started.promise;
  const queued = f.gateway.submit({ provider: "muse", kind: "chat", thread: "w-task", prompt: "late-worker" });
  const deleting = f.remove();
  expect(f.gateway.museThreads.isDeleting("w-task")).toBe(true);
  expect(() => f.gateway.submit({ accountId: account.id, kind: "chat", thread: "w-task", prompt: "blocked" }))
    .toThrow(expect.objectContaining({ code: "thread_deleting" }));
  const duplicate = f.remove();
  release.resolve();
  const response = await deleting;
  expect(response.status).toBe(200);
  expect((await response.json()).threads.map((thread: { threadId: string }) => thread.threadId)).toEqual(["late-worker"]);
  expect((await duplicate).status).toBe(200);
  expect((await f.gateway.wait(queued.id)).status).toBe("completed");
  await f.gateway.wait(running.id);
  expect([...f.remote]).toEqual(["hold"]);
  expect(f.store.museThreads().map((thread) => thread.key)).toEqual(["tg123"]);
});

test("accepted failed chats remain discoverable for cleanup after reopening storage", async () => {
  const retryFlags: (boolean | undefined)[] = [];
  const f = fixture({ run: async (_credentials, _prompt, context) => {
    retryFlags.push(context.retryAccepted);
    f.remote.add("accepted-worker");
    context.onAccepted?.("accepted-worker");
    throw new GatewayError("muse_result", "No result.", 502);
  } });
  await f.ready();
  expect((await f.ask()).status).toBe(502);
  expect(retryFlags).toEqual([false]);
  const reopened = new Store(f.dir);
  try {
    const restarted = new Gateway(reopened, f.gateway.adapters);
    const response = await createApi(restarted).request("http://localhost/api/muse-threads/w-task", {
      method: "DELETE", headers: f.headers,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).threads.map((thread: { threadId: string }) => thread.threadId)).toEqual(["accepted-worker"]);
    expect([...f.remote]).toEqual([]);
  } finally { reopened.close(); }
});

test("untrusted accounts keep accepted ids in failed cleanup responses", async () => {
  const f = fixture({ run: async (_credentials, _prompt, context) => {
    context.onAccepted?.("uncertain-worker");
    throw new GatewayError("timeout", "Unconfirmed.", 502, true);
  } });
  await f.ready();
  await f.ask();
  const response = await f.remove();
  expect(response.status).toBe(502);
  expect((await response.json()).threads.map((thread: { threadId: string; status: string }) => [thread.threadId, thread.status]))
    .toEqual([["uncertain-worker", "failed"]]);
});
