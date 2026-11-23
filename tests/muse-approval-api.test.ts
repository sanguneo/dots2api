import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { GatewayError, jobIdSchema } from "../src/contracts";
import type { ProviderAdapter } from "../src/contracts";
import { Gateway, JOB_RETENTION_MS } from "../src/gateway";
import { createMuseAdapter } from "../src/providers/muse";
import { Store } from "../src/store";

async function setup(run: ProviderAdapter["run"]) {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-approval-api-"));
  const store = new Store(dir);
  const adapter = { ...createMuseAdapter("http://127.0.0.1:1"), run, check: async () => ({ detail: "Fixture ready" }) };
  const gateway = new Gateway(store, { muse: adapter, dots: adapter });
  const account = gateway.create("muse", "Approval fixture", {});
  await gateway.check(account.id);
  const app = createApi(gateway);
  const auth = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
  return {
    dir, store, gateway, account, app, auth,
    async close() {
      gateway.stop();
      await gateway.drain();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const chat = JSON.stringify({ model: "muse-agent", messages: [{ role: "user", content: "Publish fixture" }] });

test("async chat exposes approvals on the keyed job and acknowledges only once the live action finishes", async () => {
  const published = Promise.withResolvers<void>();
  const clicked = Promise.withResolvers<void>();
  const finishClick = Promise.withResolvers<void>();
  const approval = {
    id: crypto.randomUUID(), description: "Publish static site",
    choices: [{ id: "deny", label: "거절" }, { id: "once", label: "이번만 허용" }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const fixture = await setup(async (_credentials, prompt, context) => {
    expect(prompt).toBe("Publish fixture");
    expect(context.threadId).toBe("saved-thread");
    context.onAccepted?.("saved-thread");
    if (!context.onApproval) return { text: "Missing approval support", remoteId: "saved-thread" };
    const done = Promise.withResolvers<void>();
    const stop = context.onApproval(approval, async (choice) => {
      expect(choice).toBe("once");
      clicked.resolve();
      await finishClick.promise;
      done.resolve();
      return true;
    });
    published.resolve();
    const abort = () => done.resolve();
    context.signal.addEventListener("abort", abort, { once: true });
    await done.promise;
    context.signal.removeEventListener("abort", abort);
    stop();
    return { text: "Published fixture", remoteId: "saved-thread" };
  });
  const { app, auth, store, account, gateway } = fixture;
  store.saveMuseThread({ accountId: account.id, kind: "chat", key: "approval-topic", threadId: "saved-thread", lastUsedAt: Date.now() });
  try {
    const submitted = await app.request("/v1/chat/completions", {
      method: "POST", headers: { ...auth, prefer: "wait=1, respond-async", "x-muse-thread": "approval-topic" }, body: chat,
    });
    expect(submitted.status).toBe(202);
    const { job } = await submitted.json();
    await published.promise;
    const url = `/api/jobs/${job.id}`;
    const answer = `${url}/approvals/${approval.id}`;
    const request = async (path: string, choiceId: string, headers: HeadersInit = auth) =>
      app.request(path, { method: "POST", headers, body: JSON.stringify({ choiceId }) });
    expect((await (await app.request(url, { headers: auth })).json()).job).toMatchObject({
      status: "approval_required", remoteId: "saved-thread", approval,
    });
    expect(gateway.account(account.id).busy).toBe(true);
    expect((await request(answer, "once", { "content-type": "application/json" })).status).toBe(401);
    expect((await request(answer, "unlisted", {
      "content-type": "application/json", "sec-fetch-site": "same-origin",
    })).status).toBe(401);
    expect((await request(`${url}/approvals/old`, "once")).status).toBe(409);
    expect((await request(answer, "unlisted")).status).toBe(409);
    let acknowledged = false;
    const first = request(answer, "once").then((response) => { acknowledged = true; return response; });
    await clicked.promise;
    expect(acknowledged).toBe(false);
    expect((await request(answer, "deny")).status).toBe(409);
    finishClick.resolve();
    expect(await (await first).json()).toEqual({ ok: true });
    expect((await request(answer, "once")).status).toBe(409);
    await gateway.wait(jobIdSchema.parse(job.id));
    const completed = (await (await app.request(url, { headers: auth })).json()).job;
    expect(completed).toMatchObject({ status: "completed", output: "Published fixture", remoteId: "saved-thread", images: [], files: [] });
    expect(completed.approval).toBeUndefined();
  } finally {
    finishClick.resolve();
    await fixture.close();
  }
});

test("synchronous chat reports approval_timeout instead of upstream_unconfirmed", async () => {
  const fixture = await setup(async () => {
    throw new GatewayError("approval_timeout", "Muse approval expired without a choice.", 504);
  });
  try {
    const response = await fixture.app.request("/v1/chat/completions", { method: "POST", headers: fixture.auth, body: chat });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "approval_timeout" } });
    expect(fixture.store.jobs()[0]).toMatchObject({ status: "failed", errorCode: "approval_timeout" });
  } finally { await fixture.close(); }
});

test("retention keeps approval jobs active and restart removes their actionable prompt", async () => {
  const fixture = await setup(async () => ({ text: "", remoteId: null }));
  const { store, account } = fixture;
  const id = jobIdSchema.parse(crypto.randomUUID());
  const old = new Date(Date.now() - JOB_RETENTION_MS * 2).toISOString();
  try {
    store.saveJob({
      id, accountId: account.id, provider: "muse", prompt: "fixture", status: "approval_required", output: "",
      error: null, remoteId: "fixture-thread", images: [], createdAt: old, finishedAt: null,
      approval: { id: "prompt-1", choices: [{ id: "once", label: "이번만 허용" }], description: "Publish", expiresAt: old },
    });
    expect(fixture.gateway.pruneJobs()).toBe(0);
    const reopened = new Store(fixture.dir);
    try {
      reopened.recoverInterruptedJobs();
      expect(reopened.job(id)).toMatchObject({ status: "unknown", remoteId: "fixture-thread" });
      expect(reopened.job(id)?.approval).toBeUndefined();
      expect(reopened.account(account.id)?.status).toBe("error");
    } finally { reopened.close(); }
  } finally { await fixture.close(); }
});
