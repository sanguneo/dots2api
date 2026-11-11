import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { createApi } from "./api";
import { Gateway } from "./gateway";
import { Store } from "./store";
import { dotsAdapter } from "./providers/dots";
import { museAdapter } from "./providers/muse";
import index from "./web/index.html";
import { DotsAuth } from "./dots-auth";
import { createMuseLoginService } from "./muse-login";
import { MuseLoginRoutes } from "./muse-login-routes";
import { accountIdSchema } from "./contracts";
import { MAX_IMAGE_BYTES } from "./images";

const store = new Store(resolve(process.env["DOTS2API_DATA_DIR"] ?? "data"));
store.recoverInterruptedJobs();
const dotsAuth = new DotsAuth();
const imageIdleSeconds = Number(process.env["DOTS2API_MUSE_IMAGE_IDLE_SECONDS"] ?? 600);
const gateway = new Gateway(store, { dots: dotsAdapter, muse: museAdapter }, dotsAuth, {
  ...(Number.isFinite(imageIdleSeconds) && imageIdleSeconds > 0 ? { imageIdleMs: imageIdleSeconds * 1000 } : {}),
});
const museLogin = createMuseLoginService({ dataDir: store.dataDir, onEnded: (session) => museRoutes.handleEnded(session) });
const museRoutes = new MuseLoginRoutes(gateway, museLogin);
const api = createApi(gateway, dotsAuth, museRoutes);
let stopping = false;

interface ViewerData { readonly accountId: string; unsubscribe?: () => void; }
const STREAM_PATH = /^\/api\/accounts\/([^/]+)\/muse-login\/stream$/;

/** The viewer WebSocket is same-origin only and exists just while a login session is active. */
function upgradeViewer(request: Request, server: Bun.Server<ViewerData>): Response | undefined {
  const url = new URL(request.url);
  const match = STREAM_PATH.exec(url.pathname);
  if (!match?.[1]) return undefined;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return new Response("Local access only.", { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("Origin is not allowed.", { status: 403 });
  const accountId = accountIdSchema.safeParse(decodeURIComponent(match[1]));
  if (!accountId.success || !museLogin.activeBrowser(accountId.data)) return new Response("No active login session.", { status: 404 });
  return server.upgrade(request, { data: { accountId: accountId.data } }) ? undefined : new Response("Upgrade failed.", { status: 400 });
}

const server = Bun.serve<ViewerData>({
  hostname: "127.0.0.1",
  port: Number(process.env["PORT"] ?? 3010),
  idleTimeout: 255,
  // Context budgets include multilingual text and tool schemas; bytes are not tokens.
  // Reference images are bytes rather than tokens, so this bound has to clear the multipart route's own limit;
  // otherwise Bun answers 413 with an empty body before the route can explain what the limit is.
  maxRequestBodySize: MAX_IMAGE_BYTES + 4 * 1024 * 1024,
  development: process.env["NODE_ENV"] !== "production",
  routes: { "/": index },
  websocket: {
    open(ws: ServerWebSocket<ViewerData>) {
      const browser = museLogin.activeBrowser(accountIdSchema.parse(ws.data.accountId));
      if (!browser) { ws.close(1011, "No active login session."); return; }
      ws.data.unsubscribe = browser.frames((frame) => { try { ws.send(JSON.stringify({ t: "frame", d: frame })); } catch { return; } });
      ws.send(JSON.stringify({ t: "ready", w: browser.viewport.width, h: browser.viewport.height }));
    },
    message(ws: ServerWebSocket<ViewerData>, raw: string | Buffer) {
      const browser = museLogin.activeBrowser(accountIdSchema.parse(ws.data.accountId));
      if (!browser) return;
      try { browser.input(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"))); } catch { return; }
    },
    close(ws: ServerWebSocket<ViewerData>) { ws.data.unsubscribe?.(); },
  },
  fetch(request, server) {
    if (stopping) return new Response("Server is shutting down.", { status: 503 });
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const upgraded = upgradeViewer(request, server);
      if (upgraded !== undefined) return upgraded;
    }
    // Provider operations have their own bounded deadlines; do not kill a valid login at 255s.
    server.timeout(request, 0);
    return api.fetch(request);
  },
});
console.log(`dots2api ready at ${server.url}`);
console.log("Open the local console to connect accounts. Credentials are stored encrypted in data/.");
gateway.startSweeper();
// A restart can leave an account in error; re-verify those the way the Check button does.
void gateway.recheckErroredAccounts().then((recovered) => { if (recovered > 0) console.log(`Re-checked accounts at startup: ${recovered} back in rotation.`); });

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  gateway.stop();
  dotsAuth.close();
  try {
    await museLogin.close();
    await gateway.drain();
  } finally {
    museRoutes.close();
    await server.stop(true);
    store.close();
  }
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
