import type { Hono } from "hono";
import { z } from "zod";
import { accountIdSchema, GatewayError } from "./contracts";
import type { Account, AccountId } from "./contracts";
import type { Gateway } from "./gateway";
import type { MuseLoginService, MuseLoginSession } from "./muse-login";

interface LoginLease {
  readonly release: () => void;
  sessionId?: string;
  completion?: Promise<Account>;
}

/** Holds one account lease for the whole remote login so no job can run against a half-saved profile. */
export class MuseLoginRoutes {
  private readonly leases = new Map<AccountId, LoginLease>();
  constructor(private readonly gateway: Gateway, private readonly service: MuseLoginService) {}

  private release(id: AccountId, owner: LoginLease): void {
    if (this.leases.get(id) !== owner) return;
    this.leases.delete(id);
    owner.release();
  }

  /** Called by the service when a session ends; a non-completed end releases the lease here. */
  readonly handleEnded = (session: MuseLoginSession): void => {
    const owner = this.leases.get(session.accountId);
    if (owner?.sessionId === session.id && session.state !== "completed") this.release(session.accountId, owner);
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
      const owner: LoginLease = { release: this.gateway.reserve(id) };
      this.leases.set(id, owner);
      try {
        const session = await this.service.start(id);
        owner.sessionId = session.id;
        return c.json({ session });
      } catch (error) {
        this.release(id, owner);
        throw error;
      }
    });
    app.get("/api/accounts/:id/muse-login", (c) => c.json({ session: this.service.status(this.account(c.req.param("id"))) }));
    app.post("/api/accounts/:id/muse-login/complete", async (c) => {
      const id = this.account(c.req.param("id"));
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(await c.req.json());
      const owner = this.leases.get(id);
      if (!owner || owner.sessionId !== sessionId) throw new GatewayError("muse_login_state", "No matching login lease is active.", 409);
      owner.completion ??= (async () => {
        try {
          await this.service.complete(id, sessionId);
          // A pasted cookie must never outlive the profile this login just authenticated.
          const current = this.gateway.account(id);
          this.gateway.store.saveAccount({ ...current, status: "unconnected" }, { login: "false" });
          return await this.gateway.checkReserved(id);
        } finally { this.release(id, owner); }
      })();
      return c.json({ status: "connected", account: await owner.completion });
    });
    app.post("/api/accounts/:id/muse-login/cancel", async (c) => {
      const id = this.account(c.req.param("id"));
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(await c.req.json());
      const session = await this.service.cancel(id, sessionId);
      const owner = this.leases.get(id);
      if (owner?.sessionId === session.id && session.state !== "completed") this.release(id, owner);
      return c.json({ session });
    });
  }

  /** Releases every lease held for a login that is still running. */
  close(): void {
    for (const [id, owner] of this.leases) this.release(id, owner);
  }
}
