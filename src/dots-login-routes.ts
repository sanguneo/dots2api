import type { Hono } from "hono";
import { accountIdSchema, GatewayError } from "./contracts";
import type { AccountId } from "./contracts";
import type { Gateway } from "./gateway";
import type { DotsAuth } from "./dots-auth";

export function attachDotsLogin(app: Hono, gateway: Gateway, device: DotsAuth): void {
  const account = (raw: string): AccountId => {
    const id = accountIdSchema.parse(raw);
    if (gateway.account(id).provider !== "dots") {
      throw new GatewayError("unsupported_login", "Device login is only for Dots.");
    }
    return id;
  };
  app.post("/api/accounts/:id/dots-login/start", async (c) => {
    const id = account(c.req.param("id"));
    const release = gateway.reserve(id);
    try { return c.json(await device.start(id)); }
    finally { release(); }
  });
  app.post("/api/accounts/:id/dots-login/complete", async (c) => {
    const id = account(c.req.param("id"));
    const release = gateway.reserve(id);
    try {
      const result = await device.finish(id);
      if (result.status === "pending") return c.json(result);
      // Replace rather than merge: a new identity must not inherit old refresh state/endpoints.
      gateway.store.saveAccount({
        ...gateway.account(id), status: "unconnected", checkedAt: null,
        detail: "Device authorized. Checking the account's Dot.",
      }, result.credentials);
      return c.json({ status: "connected", account: await gateway.checkReserved(id) });
    } finally { release(); }
  });
  app.post("/api/accounts/:id/dots-login/cancel", (c) => {
    const id = account(c.req.param("id"));
    if (gateway.account(id).busy) throw new GatewayError("account_busy", "A login operation is active.", 409);
    device.clear(id);
    return c.json({ ok: true });
  });
}
