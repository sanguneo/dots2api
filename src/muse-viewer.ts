import type { ServerWebSocket } from "bun";
import type { AccountId } from "./contracts";
import type { MuseLoginBrowser, MuseLoginService } from "./muse-login";

export interface ViewerData {
  readonly accountId: AccountId;
  readonly sessionId: string;
  readonly browser: MuseLoginBrowser;
  unsubscribe?: () => void;
}

/** A socket owns exactly the browser generation authorized at its upgrade. */
export function createMuseViewer(service: MuseLoginService) {
  const sockets = new Set<ServerWebSocket<ViewerData>>();
  const current = (data: ViewerData) =>
    service.status(data.accountId)?.id === data.sessionId && service.activeBrowser(data.accountId) === data.browser;
  return {
    data(accountId: AccountId): ViewerData | null {
      const session = service.status(accountId);
      const browser = service.activeBrowser(accountId);
      return session?.state === "active" && browser ? { accountId, sessionId: session.id, browser } : null;
    },
    closeSession(sessionId: string) {
      for (const ws of sockets) {
        if (ws.data.sessionId !== sessionId) continue;
        ws.data.unsubscribe?.();
        sockets.delete(ws);
        ws.close(1000, "Login session ended.");
      }
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      open(ws: ServerWebSocket<ViewerData>) {
        if (!current(ws.data)) { ws.close(1000, "Login session ended."); return; }
        sockets.add(ws);
        ws.data.unsubscribe = ws.data.browser.frames((frame) => { ws.send(JSON.stringify({ t: "frame", d: frame })); });
        ws.send(JSON.stringify({ t: "ready", w: ws.data.browser.viewport.width, h: ws.data.browser.viewport.height }));
      },
      message(ws: ServerWebSocket<ViewerData>, raw: string | Buffer) {
        if (!current(ws.data)) { ws.data.unsubscribe?.(); ws.close(1000, "Login session ended."); return; }
        try { ws.data.browser.input(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"))); }
        catch { return; } // Malformed viewer input cannot change another session.
      },
      close(ws: ServerWebSocket<ViewerData>) {
        ws.data.unsubscribe?.();
        sockets.delete(ws);
      },
    },
  };
}
