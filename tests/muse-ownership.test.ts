import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { accountIdSchema } from "../src/contracts";
import type { ProviderAdapter, ProviderId } from "../src/contracts";
import { createMuseLoginService, startDisplay } from "../src/muse-login";
import { MuseLoginRoutes } from "../src/muse-login-routes";
import { createMuseViewer } from "../src/muse-viewer";
import type { ViewerData } from "../src/muse-viewer";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";
import { createApi } from "../src/api";

const accountId = accountIdSchema.parse("44444444-4444-4444-8444-444444444444");
function browser(close: (persist: boolean) => Promise<void> = async () => {}, input: () => void = () => {}) {
  return { viewport: { width: 1280, height: 800 }, frames() { return () => {}; }, input, close };
}

test("login completion is single-flight and conflicting cancellation never ends ownership", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const events: string[] = [];
  let closes = 0;
  const service = createMuseLoginService({
    dataDir: "/unused", onEnded: (session) => events.push(session.state),
    launcher: { async launch() { return browser(async () => { closes++; entered.resolve(); await finish.promise; }); } },
  });
  const session = await service.start(accountId);
  // When duplicate completion and a competing cancel target the same session.
  const first = service.complete(accountId, session.id);
  const second = service.complete(accountId, session.id);
  await entered.promise;
  expect(first).toBe(second);
  await expect(service.cancel(accountId, session.id)).rejects.toMatchObject({ code: "muse_login_state" });
  expect(events).toEqual([]);
  finish.resolve();
  await first;
  await service.close();
  // Then browser persistence and terminal publication occur once.
  expect(closes).toBe(1);
  expect(events).toEqual(["completed"]);
});

test("shutdown drains an outstanding launch and closes a late browser", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let closed = 0;
  let signal: AbortSignal | undefined;
  const service = createMuseLoginService({
    dataDir: "/unused", launcher: { async launch(_id, options) {
      signal = options.signal;
      entered.resolve(); await finish.promise;
      return browser(async () => { closed++; });
    } },
  });
  const starting = service.start(accountId);
  await entered.promise;
  // When shutdown begins before launch finishes.
  const closing = service.close();
  expect(signal?.aborted).toBe(true);
  finish.resolve();
  await expect(starting).rejects.toMatchObject({ code: "muse_login_closed" });
  await closing;
  // Then a late browser is closed instead of becoming active.
  expect(closed).toBe(1);
  expect(service.status(accountId)).toBeNull();
  expect(service.activeBrowser(accountId)).toBeNull();
});

test("duplicate completion routes share verification and an old end cannot release a new session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-ownership-"));
  const store = new Store(dir);
  const checked = Promise.withResolvers<void>();
  const finishCheck = Promise.withResolvers<void>();
  let checks = 0;
  const adapter = (id: ProviderId): ProviderAdapter => ({
    info: { id, name: id, description: "", setupUrl: "", fields: [], contextWindow: 1, contextBasis: "configured",
      capabilities: { chat: false, nativeTools: false, usage: "unknown", execution: "remote-agent" } },
    validate: (value) => value,
    async check() { checks++; checked.resolve(); await finishCheck.promise; return { detail: "connected" }; },
    async run() { return { text: "done", remoteId: null }; },
  });
  const gateway = new Gateway(store, { dots: adapter("dots"), muse: adapter("muse") });
  const account = gateway.create("muse", "ownership", {});
  const service = createMuseLoginService({ dataDir: dir, launcher: { async launch() { return browser(); } },
    onEnded: (session) => routes.handleEnded(session) });
  const routes = new MuseLoginRoutes(gateway, service);
  const app = createApi(gateway, undefined, routes);
  const post = (path: string, body: object = {}) => app.request(`http://localhost/api/accounts/${account.id}/muse-login/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${store.apiKey}` }, body: JSON.stringify(body),
  });
  try {
    const started = await (await post("start")).json();
    const id = String(started.session.id);
    // When two HTTP completions overlap in the connection verification phase.
    const first = post("complete", { sessionId: id });
    await checked.promise;
    const second = post("complete", { sessionId: id });
    const cancel = await post("cancel", { sessionId: id });
    expect(cancel.status).toBe(409);
    expect(gateway.account(account.id).busy).toBe(true);
    finishCheck.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(checks).toBe(1);
    const next = await (await post("start")).json();
    // Then a late callback from the old generation cannot unlock its successor.
    routes.handleEnded({ id, accountId: account.id, state: "cancelled", expiresAt: "", error: null });
    expect(gateway.account(account.id).busy).toBe(true);
    expect(service.status(account.id)?.id).toBe(next.session.id);
  } finally {
    finishCheck.resolve();
    await service.close(); routes.close(); gateway.stop(); await gateway.drain();
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("viewer sockets close with their original session and new viewers keep working", async () => {
  const received = Promise.withResolvers<void>();
  let inputs = 0;
  const service = createMuseLoginService({
    dataDir: "/unused",
    launcher: { async launch() { return browser(async () => {}, () => { inputs++; received.resolve(); }); } },
    onEnded: (session) => viewer.closeSession(session.id),
  });
  const viewer = createMuseViewer(service);
  const server = Bun.serve<ViewerData>({
    hostname: "127.0.0.1", port: 0, websocket: viewer.websocket,
    fetch(request, server) {
      const data = viewer.data(accountId);
      return data && server.upgrade(request, { data }) ? undefined : new Response("", { status: 404 });
    },
  });
  const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", () => resolve(), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let next: WebSocket | undefined;
  try {
    const first = await service.start(accountId);
    const old = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await opened(old);
    const closed = new Promise<void>((resolve) => old.addEventListener("close", () => resolve(), { once: true }));
    // When the original login ends and another generation starts.
    await service.cancel(accountId, first.id);
    await closed;
    await service.start(accountId);
    expect(old.readyState).toBe(WebSocket.CLOSED);
    expect(inputs).toBe(0);
    next = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await opened(next);
    next.send(JSON.stringify({ t: "text", text: "new generation" }));
    await received.promise;
    // Then only the new generation's viewer delivered input.
    expect(inputs).toBe(1);
  } finally { next?.close(); await service.close(); await server.stop(true); }
});

if (process.platform === "linux") {
  test("concurrent Xvfb launches own distinct displays and survive the other's stop", async () => {
    // Given actual Linux Xvfb processes allocating their displays atomically.
    const [first, second] = await Promise.all([startDisplay(), startDisplay()]);
    try {
      expect(first.name).not.toBe(second.name);
      // When one owned display is stopped, then the other still accepts connections.
      first.stop();
      const socket = await Bun.connect({ unix: `/tmp/.X11-unix/X${second.name.slice(1)}`, socket: { data() {} } });
      socket.end();
    } finally { first.stop(); second.stop(); }
  });
}
