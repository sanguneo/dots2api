import type { Hono } from "hono";
import { z } from "zod";
import { accountIdSchema, GatewayError } from "./contracts";
import type { AccountId } from "./contracts";
import type { Gateway } from "./gateway";
import type { MuseLoginService, MuseLoginSession } from "./muse-login";

/** Holds one account lease for the whole remote login so no job can run against a half-saved profile. */
export class MuseLoginRoutes {
  private readonly leases = new Map<AccountId, () => void>();
  constructor(private readonly gateway: Gateway, private readonly service: MuseLoginService) {}

  private release(id: AccountId): void {
    this.leases.get(id)?.();
    this.leases.delete(id);
  }

  /** Called by the service when a session ends; a non-completed end releases the lease here. */
  readonly handleEnded = (session: MuseLoginSession): void => {
    if (session.state !== "completed") this.release(session.accountId);
  };

  private account(raw: string): AccountId {
    const id = accountIdSchema.parse(raw);
    if (this.gateway.account(id).provider !== "muse") {
      throw new GatewayError("unsupported_login", "Remote browser login is only for Muse accounts.");
    }
    return id;
  }

  attach(app: Hono): void {
    app.post("/api/accounts/:id/muse-login/start", async (c) => {
      const id = this.account(c.req.param("id"));
      if (this.leases.has(id)) throw new GatewayError("muse_login_state", "A login session is already active for this account.", 409);
      this.leases.set(id, this.gateway.reserve(id));
      try {
        await this.gateway.pauseMuseWatcher(id);
        return c.json({ session: await this.service.start(id) });
      } catch (error) {
        this.release(id);
        throw error;
      }
    });
    app.get("/api/accounts/:id/muse-login", (c) => c.json({ session: this.service.status(this.account(c.req.param("id"))) }));
    app.post("/api/accounts/:id/muse-login/complete", async (c) => {
      const id = this.account(c.req.param("id"));
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(await c.req.json());
      const session = await this.service.complete(id, sessionId);
      try {
        // A pasted cookie must never outlive the profile this login just authenticated.
        const current = this.gateway.account(id);
        this.gateway.store.saveAccount({ ...current, status: "unconnected" }, { login: "false" });
        return c.json({ status: "connected", account: await this.gateway.checkReserved(id) });
      } finally {
        this.release(id);
      }
    });
    app.post("/api/accounts/:id/muse-login/cancel", async (c) => {
      const id = this.account(c.req.param("id"));
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(await c.req.json());
      const session = await this.service.cancel(id, sessionId);
      if (session.state !== "completed") this.release(id);
      return c.json({ session });
    });
  }

  /** Releases every lease held for a login that is still running. */
  close(): void {
    for (const id of [...this.leases.keys()]) this.release(id);
  }
}
