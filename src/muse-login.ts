import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { GatewayError } from "./contracts";
import type { AccountId } from "./contracts";

const DEFAULT_SITE = "https://muse.ai";
const DEFAULT_LIFETIME_MS = 600_000;
const VIEWPORT = { width: 1280, height: 800 } as const;
/** Muse's own authentication cookies; only these are persisted after a remote login. */
const ESSENTIAL_COOKIES = new Set(["hatch_sess", "hatch_gw", "hatch_vml", "hatch_native_auth_device"]);

export type MuseLoginState = "starting" | "active" | "completing" | "completed" | "cancelled" | "expired" | "failed";

export interface MuseLoginSession {
  readonly id: string;
  readonly accountId: AccountId;
  readonly state: MuseLoginState;
  readonly expiresAt: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** Input forwarded from the console viewer to the remote page. */
export type MuseInput =
  | { readonly t: "mouse"; readonly type: "move" | "down" | "up"; readonly x: number; readonly y: number; readonly button?: string; readonly buttons?: number; readonly clickCount?: number }
  | { readonly t: "wheel"; readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "key"; readonly key: string; readonly code?: string; readonly text?: string };

export interface MuseLoginBrowser {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Subscribes to screencast frames (base64 JPEG). Returns an unsubscribe function. */
  frames(listener: (frame: string) => void): () => void;
  input(event: MuseInput): void;
  /** Closes the browser; complete persists the login profile and its renewed session cookies. */
  close(complete: boolean): Promise<void>;
}

export interface MuseLoginLauncher {
  launch(accountId: AccountId, options: { readonly dataDir: string; readonly site: string; readonly signal: AbortSignal }): Promise<MuseLoginBrowser>;
}

export interface MuseLoginOptions {
  readonly dataDir: string;
  readonly site?: string;
  readonly lifetimeMs?: number;
  /** Injectable for tests; defaults to the Xvfb + Playwright launcher. */
  readonly launcher?: MuseLoginLauncher;
  readonly onEnded?: (session: MuseLoginSession) => void;
}

interface Active {
  session: MuseLoginSession;
  browser: MuseLoginBrowser;
  timer: ReturnType<typeof setTimeout>;
  ending?: { readonly state: MuseLoginState; readonly promise: Promise<MuseLoginSession> };
}

export interface MuseLoginService {
  start(accountId: AccountId): Promise<MuseLoginSession>;
  status(accountId: AccountId): MuseLoginSession | null;
  /** Closes the profile and returns the terminal session; the caller then checks authentication. */
  complete(accountId: AccountId, sessionId: string): Promise<MuseLoginSession>;
  cancel(accountId: AccountId, sessionId: string): Promise<MuseLoginSession>;
  activeBrowser(accountId: AccountId): MuseLoginBrowser | null;
  close(): Promise<void>;
}

function sessionView(active: Active): MuseLoginSession {
  return { ...active.session };
}

/** Starts a private Xvfb display and returns its name plus a stop function. */
export async function startDisplay(parent: AbortSignal = new AbortController().signal): Promise<{ readonly name: string; readonly stop: () => void }> {
  const xvfb = Bun.which("Xvfb");
  if (!xvfb) throw new GatewayError("muse_login_dependency", "Install Xvfb on the server to use remote Muse login.", 503);
  if (parent.aborted) throw new GatewayError("muse_login_closed", "The login was cancelled.", 409);
  // Xvfb atomically owns the display it reports on stdout only after the server is ready.
  const child = Bun.spawn([xvfb, "-displayfd", "1", "-screen", "0", `${VIEWPORT.width}x${VIEWPORT.height}x24`, "-nolisten", "tcp"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  const signal = AbortSignal.any([parent, AbortSignal.timeout(10_000)]);
  const stop = () => { child.kill(); };
  const abort = () => { stop(); void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const exited = child.exited.then(() => { void reader.cancel().catch(() => {}); });
  let ready = false;
  try {
    let output = "";
    const decoder = new TextDecoder();
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (output.length + value.byteLength > 128) break;
      output += decoder.decode(value, { stream: true });
      if (!output.includes("\n")) continue;
      const number = output.slice(0, output.indexOf("\n")).trim();
      if (!/^\d+$/.test(number) || child.exitCode !== null) break;
      ready = true;
      return { name: `:${number}`, stop };
    }
    throw new GatewayError("muse_login_display", "A virtual display (Xvfb) could not be started.", 503);
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!ready) { stop(); await exited; }
  }
}

function keyParameters(key: string, code: string | undefined): Record<string, unknown> {
  const virtual: Readonly<Record<string, number>> = {
    Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
  };
  const windowsVirtualKeyCode = virtual[key] ?? 0;
  return { key, code: code ?? "", windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
}

export interface RelayOptions {
  readonly site: string;
  readonly signal: AbortSignal;
  readonly onClosed?: () => void;
}

/** Wires CDP screencast and input onto an already-open browser context; the caller owns the display. */
export async function attachRelay(context: BrowserContext, options: RelayOptions): Promise<MuseLoginBrowser> {
  const listeners = new Set<(frame: string) => void>();
  let lastFrame = "";
  let cdp: CDPSession | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    options.signal.removeEventListener("abort", onAbort);
    options.onClosed?.();
  };
  const onAbort = () => { void context.close().catch(() => {}); stop(); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  try {
    for (const extra of context.pages().slice(1)) await extra.close();
    const page: Page = context.pages()[0] ?? await context.newPage();
    await page.goto(new URL("/thread/new", options.site).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (params: { data: string; sessionId: number }) => {
      lastFrame = params.data;
      void cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      for (const listener of listeners) listener(params.data);
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
    });
  } catch (error) {
    await context.close().catch(() => {});
    stop();
    throw error instanceof GatewayError ? error : new GatewayError("muse_login_browser", "The Muse login page did not load.", 503);
  }
  const send = (method: Parameters<CDPSession["send"]>[0], params: Parameters<CDPSession["send"]>[1]): void => { void cdp?.send(method, params).catch(() => {}); };
  return {
    viewport: { ...VIEWPORT },
    frames(listener) {
      listeners.add(listener);
      if (lastFrame) listener(lastFrame);
      return () => { listeners.delete(listener); };
    },
    input(event) {
      switch (event.t) {
        case "mouse":
          send("Input.dispatchMouseEvent", {
            type: event.type === "move" ? "mouseMoved" : event.type === "down" ? "mousePressed" : "mouseReleased",
            x: event.x, y: event.y, button: event.button ?? "left",
            buttons: event.buttons ?? (event.type === "up" ? 0 : 1), clickCount: event.clickCount ?? 1,
          });
          break;
        case "wheel":
          send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.dx, deltaY: event.dy });
          break;
        case "text":
          send("Input.insertText", { text: event.text });
          break;
        case "key": {
          const parameters = keyParameters(event.key, event.code);
          send("Input.dispatchKeyEvent", { type: "keyDown", ...parameters, ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}) });
          send("Input.dispatchKeyEvent", { type: "keyUp", ...parameters });
          break;
        }
      }
    },
    async close(complete) {
      listeners.clear();
      if (complete) {
        // Exactly the Muse adapter's persistence policy: keep only Muse's auth cookies with a future expiry.
        const cookies = (await context.cookies([options.site]).catch(() => []))
          .filter((cookie) => ESSENTIAL_COOKIES.has(cookie.name) && cookie.value)
          .map((cookie) => ({ ...cookie, expires: Math.floor(Date.now() / 1000) + 86_400 }));
        if (cookies.length) await context.addCookies(cookies).catch(() => {});
      }
      await context.close().catch(() => {});
      stop();
    },
  };
}

async function launchChromium(accountId: AccountId, options: { readonly dataDir: string; readonly site: string; readonly signal: AbortSignal }): Promise<MuseLoginBrowser> {
  // A headless server needs its own display; a desktop host (macOS) uses the native one.
  const display = process.platform === "linux" ? await startDisplay(options.signal) : undefined;
  const stopDisplay = () => display?.stop();
  const bundled = chromium.executablePath();
  const system = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
  const executablePath = existsSync(bundled) ? bundled : system;
  if (!executablePath) {
    stopDisplay();
    throw new GatewayError("muse_login_dependency", "Install Playwright Chromium or a system Chromium.", 503);
  }
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(resolve(options.dataDir, "muse", accountId), {
      executablePath, headless: false, viewport: { ...VIEWPORT }, timeout: 30_000,
      ...(display ? { env: { ...process.env, DISPLAY: display.name } } : {}),
      args: [
        ...(display ? ["--ozone-platform=x11"] : []),
        "--window-position=0,0", `--window-size=${VIEWPORT.width},${VIEWPORT.height + 100}`,
      ],
    });
  } catch (error) {
    stopDisplay();
    throw error instanceof GatewayError ? error : new GatewayError("muse_login_browser", "The login browser could not open. On a headless server install Xvfb; on a desktop host make sure a graphical session is available.", 503);
  }
  return attachRelay(context, { site: options.site, signal: options.signal, onClosed: stopDisplay });
}

export function createMuseLoginService(options: MuseLoginOptions): MuseLoginService {
  const site = options.site ?? DEFAULT_SITE;
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  const launcher = options.launcher ?? { launch: launchChromium };
  const active = new Map<AccountId, Active>();
  const pending = new Map<AccountId, { readonly controller: AbortController; readonly promise: Promise<MuseLoginSession> }>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const finish = (entry: Active, state: MuseLoginState, complete: boolean): Promise<MuseLoginSession> => {
    if (entry.ending) {
      return entry.ending.state === state ? entry.ending.promise
        : Promise.reject(new GatewayError("muse_login_state", "This login session is already ending.", 409));
    }
    clearTimeout(entry.timer);
    entry.session = { ...entry.session, state: state === "completed" ? "completing" : state };
    // Publish the flight before invoking browser code or terminal callbacks.
    const promise = Promise.resolve().then(async () => {
      let failure: GatewayError | undefined;
      try {
        await entry.browser.close(complete);
      } catch (error) {
        failure = error instanceof GatewayError ? error : new GatewayError("muse_login_shutdown", "The login browser did not close cleanly.", 502);
      }
      if (active.get(entry.session.accountId) === entry) active.delete(entry.session.accountId);
      entry.session = {
        ...entry.session, state: failure ? "failed" : state,
        error: failure ? { code: failure.code, message: failure.message } : null,
      };
      options.onEnded?.(sessionView(entry));
      if (failure) throw failure;
      return sessionView(entry);
    });
    entry.ending = { state, promise };
    return promise;
  };

  return {
    start(accountId) {
      if (closed) return Promise.reject(new GatewayError("muse_login_closed", "The server is shutting down.", 503));
      if (pending.has(accountId)) return Promise.reject(new GatewayError("muse_login_state", "A login session is already starting.", 409));
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        try {
          const existing = active.get(accountId);
          if (existing) await finish(existing, "cancelled", false);
          if (closed) throw new GatewayError("muse_login_closed", "The server is shutting down.", 503);
          const browser = await launcher.launch(accountId, { dataDir: options.dataDir, site, signal: controller.signal });
          if (closed || controller.signal.aborted) {
            await browser.close(false);
            throw new GatewayError("muse_login_closed", "The server is shutting down.", 503);
          }
          const entry: Active = {
            session: {
              id: crypto.randomUUID(), accountId, state: "active",
              expiresAt: new Date(Date.now() + lifetimeMs).toISOString(), error: null,
            },
            browser,
            timer: setTimeout(() => { void finish(entry, "expired", false).catch(() => {}); }, lifetimeMs),
          };
          entry.timer.unref?.();
          active.set(accountId, entry);
          return sessionView(entry);
        } catch (error) {
          throw error instanceof GatewayError ? error : new GatewayError("muse_login_browser", "The login browser could not start.", 503);
        } finally {
          if (pending.get(accountId)?.controller === controller) pending.delete(accountId);
        }
      });
      pending.set(accountId, { controller, promise });
      return promise;
    },
    status(accountId) {
      const entry = active.get(accountId);
      return entry ? sessionView(entry) : null;
    },
    complete(accountId, sessionId) {
      const entry = active.get(accountId);
      if (!entry || entry.session.id !== sessionId) return Promise.reject(new GatewayError("muse_login_state", "No matching login session is active.", 409));
      return finish(entry, "completed", true);
    },
    cancel(accountId, sessionId) {
      const entry = active.get(accountId);
      if (!entry || entry.session.id !== sessionId) {
        return Promise.reject(new GatewayError("muse_login_state", "No matching login session is active.", 409));
      }
      return finish(entry, "cancelled", false);
    },
    activeBrowser(accountId) {
      const entry = active.get(accountId);
      return entry && !entry.ending ? entry.browser : null;
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const launch of pending.values()) launch.controller.abort();
      closing = Promise.allSettled([
        ...[...pending.values()].map((launch) => launch.promise),
        ...[...active.values()].map((entry) => entry.ending?.promise ?? finish(entry, "cancelled", false)),
      ]).then(() => {});
      return closing;
    },
  };
}
