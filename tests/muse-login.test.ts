import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chromium } from "playwright";
import { accountIdSchema } from "../src/contracts";
import { attachRelay, createMuseLoginService } from "../src/muse-login";
import type { MuseLoginBrowser } from "../src/muse-login";

const account = accountIdSchema.parse("44444444-4444-4444-8444-444444444444");

interface FakeBrowser {
  readonly browser: MuseLoginBrowser;
  readonly closed: () => boolean | null;
  readonly listeners: () => number;
}

function fakeBrowser(): FakeBrowser {
  const frames = new Set<(frame: string) => void>();
  let closed: boolean | null = null;
  return {
    browser: {
      viewport: { width: 1280, height: 800 },
      frames(listener) { frames.add(listener); listener("ZmFrZQ=="); return () => { frames.delete(listener); }; },
      input() {},
      async close(complete) { closed = complete; },
    },
    closed: () => closed,
    listeners: () => frames.size,
  };
}

describe("Muse remote login service", () => {
  it("starts a session, reports it, and completes with profile persistence", async () => {
    // Given a service whose launcher produces a controllable browser.
    const made: FakeBrowser[] = [];
    const service = createMuseLoginService({
      dataDir: "/tmp", lifetimeMs: 60_000,
      launcher: { async launch() { const fake = fakeBrowser(); made.push(fake); return fake.browser; } },
    });
    // When a login session starts.
    const session = await service.start(account);
    // Then it is active, reported, and its browser is reachable.
    expect(session.state).toBe("active");
    expect(service.status(account)?.id).toBe(session.id);
    expect(service.activeBrowser(account)).not.toBeNull();
    // When completed, the profile is persisted (close(true)) and the session is gone.
    await service.complete(account, session.id);
    expect(service.status(account)).toBeNull();
    expect(service.activeBrowser(account)).toBeNull();
    expect(made[0]?.closed()).toBe(true);
    await service.close();
  });

  it("cancels without persisting the profile", async () => {
    const made: FakeBrowser[] = [];
    const service = createMuseLoginService({
      dataDir: "/tmp", lifetimeMs: 60_000,
      launcher: { async launch() { const fake = fakeBrowser(); made.push(fake); return fake.browser; } },
    });
    const session = await service.start(account);
    await service.cancel(account, session.id);
    expect(made[0]?.closed()).toBe(false);
    expect(service.status(account)).toBeNull();
    await service.close();
  });

  it("rejects a stale session id and an unknown account", async () => {
    const service = createMuseLoginService({
      dataDir: "/tmp", lifetimeMs: 60_000,
      launcher: { async launch() { return fakeBrowser().browser; } },
    });
    const session = await service.start(account);
    await expect(service.complete(account, crypto.randomUUID())).rejects.toMatchObject({ code: "muse_login_state" });
    await expect(service.cancel(account, crypto.randomUUID())).rejects.toMatchObject({ code: "muse_login_state" });
    await expect(service.complete(accountIdSchema.parse(crypto.randomUUID()), session.id)).rejects.toMatchObject({ code: "muse_login_state" });
    await service.close();
  });

  it("expires an idle session and releases its browser", async () => {
    const made: FakeBrowser[] = [];
    const ended = Promise.withResolvers<void>();
    const service = createMuseLoginService({
      dataDir: "/tmp", lifetimeMs: 150,
      onEnded: () => ended.resolve(),
      launcher: { async launch() { const fake = fakeBrowser(); made.push(fake); return fake.browser; } },
    });
    await service.start(account);
    await ended.promise;
    expect(service.status(account)).toBeNull();
    expect(made[0]?.closed()).toBe(false);
    expect(made[0]?.listeners()).toBe(0);
    await service.close();
  });

  it("surfaces a launcher dependency failure as a typed error", async () => {
    // Given a launcher whose host is missing the required browser/display dependency.
    const service = createMuseLoginService({
      dataDir: "/tmp", lifetimeMs: 60_000,
      launcher: { async launch() { throw new (await import("../src/contracts")).GatewayError("muse_login_dependency", "Install Xvfb on the server to use remote Muse login.", 503); } },
    });
    // When starting, then the dependency error reaches the caller rather than hanging.
    await expect(service.start(account)).rejects.toMatchObject({ code: "muse_login_dependency", status: 503 });
    await service.close();
  });
});

const PAGE = `<!doctype html><html><body>
<input id="field" autocomplete="off">
<button id="btn" type="button" onclick="window.clicked = true">Go</button>
<script>
  window.clicked = false;
  window.entered = false;
  document.getElementById("field").addEventListener("keydown", (event) => { if (event.key === "Enter") window.entered = true; });
</script>
</body></html>`;

describe("Muse remote login relay", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/thread/new") return new Response(PAGE, { headers: { "content-type": "text/html" } });
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterAll(() => { server.stop(true); });

  it("streams screencast frames and forwards text, keys and clicks to the page", async () => {
    // Given a real browser context on a synthetic page.
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const controller = new AbortController();
    try {
      const relay = await attachRelay(context, { site: `http://localhost:${server.port}`, signal: controller.signal });
      expect(relay.viewport).toEqual({ width: 1280, height: 800 });
      // When subscribing, then a real JPEG frame arrives.
      let unsubscribe = () => {};
      const frame = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No screencast frame arrived.")), 20_000);
        unsubscribe = relay.frames((data) => { clearTimeout(timer); resolve(data); });
      });
      unsubscribe();
      expect(frame.length).toBeGreaterThan(200);
      expect(Buffer.from(frame, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
      const cached: string[] = [];
      const off = relay.frames((data) => cached.push(data));
      off();
      expect(cached).toHaveLength(1);
      expect(Buffer.from(cached[0] ?? "", "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
      const page = context.pages()[0];
      if (!page) throw new Error("The relay did not open a page.");
      await page.focus("#field");
      // Then typed text reaches the page.
      relay.input({ t: "text", text: "hello" });
      await page.waitForFunction(() => (document.getElementById("field") as HTMLInputElement).value === "hello");
      // And a named key (Enter) fires its keydown handler.
      relay.input({ t: "key", key: "Enter", code: "Enter", text: "\r" });
      await page.waitForFunction(() => (window as unknown as { entered: boolean }).entered === true);
      // And a mouse click activates the button.
      const box = await page.evaluate(() => { const rect = document.getElementById("btn")?.getBoundingClientRect(); return { x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 }; });
      relay.input({ t: "mouse", type: "down", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 1 });
      relay.input({ t: "mouse", type: "up", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 0 });
      await page.waitForFunction(() => (window as unknown as { clicked: boolean }).clicked === true);
      await relay.close(false);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
