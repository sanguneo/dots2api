import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { GatewayError, jobIdSchema } from "../src/contracts";
import type { ProviderAdapter, ProviderId, ReferenceImage, RunResult } from "../src/contracts";
import { MAX_IMAGE_BYTES, MAX_IMAGES } from "../src/images";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(run: ProviderAdapter["run"] = async () => ({ text: "fixture result", remoteId: "remote-1" }), reconnect?: ProviderAdapter["reconnect"], queueBytes?: number) {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-test-"));
  const store = new Store(dir);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function adapter(id: ProviderId): ProviderAdapter {
    return {
      info: { id, name: id, description: "Test transport", setupUrl: "https://example.org", fields: [],
        contextWindow: 123456, contextBasis: "configured",
        capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: id === "dots" } },
      validate: (credentials) => credentials,
      check: async () => ({ detail: "Connected to fixture." }),
      run,
      ...(reconnect ? { reconnect } : {}),
    };
  }
  const gateway = new Gateway(store, { dots: adapter("dots"), muse: adapter("muse") }, undefined, queueBytes);
  return { dir, store, gateway, app: createApi(gateway) };
}

describe("account storage", () => {
  test("persists encrypted credentials without exposing them in account records", () => {
    // Given an account credential unique to this test.
    const { store, dir } = fixture();
    const secret = "fixture-secret-DO-NOT-EXPOSE";
    // When saved and read through the account and secret paths.
    const account = store.createAccount("dots", "Private bot", { token: secret });
    const publicRecords = store.accounts();
    // Then credentials remain available only through the private decrypting path.
    expect(JSON.stringify(publicRecords)).not.toContain(secret);
    expect(store.credentials(account.id)["token"]).toBe(secret);
    const encrypted = store.db.query<{ credentials: string }, []>("SELECT credentials FROM accounts").get();
    expect(encrypted?.credentials).not.toContain(secret);
    expect(readFileSync(join(dir, "master.key")).length).toBe(32);
  });
  test("preserves accounts and key when reopened and marks interrupted work unknown", async () => {
    // Given a stored account and an unfinished job.
    const { store, gateway, dir } = fixture();
    const account = gateway.create("dots", "Persistent", { token: "private" });
    await gateway.check(account.id);
    const job = store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "dots",
      prompt: "unfinished", status: "running", output: "", error: null, remoteId: null, images: [],
      createdAt: new Date().toISOString(), finishedAt: null,
    });
    const key = store.apiKey;
    for (let i = 0; i < 201; i++) store.saveJob({
      ...job, id: jobIdSchema.parse(crypto.randomUUID()), status: "completed",
      output: "completed fixture", finishedAt: new Date().toISOString(),
    });
    // When a second store opens the persisted data as a restart would.
    const reopened = new Store(dir);
    reopened.recoverInterruptedJobs();
    try {
      // Then state and secrets survive but the remote job is not falsely retried/completed.
      expect(reopened.account(account.id)?.label).toBe("Persistent");
      expect(reopened.credentials(account.id)["token"]).toBe("private");
      expect(reopened.apiKey).toBe(key);
      expect(reopened.job(job.id)?.status).toBe("unknown");
    } finally { reopened.close(); }
  });
  test("fails queued work at restart without quarantining the account it waited on", async () => {
    // Given a ready account whose next job never got its turn.
    const { store, gateway, dir } = fixture();
    const account = gateway.create("dots", "Waiting", { token: "private" });
    await gateway.check(account.id);
    const queued = store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "dots",
      prompt: "queued", status: "queued", output: "", error: null, remoteId: null, images: [],
      createdAt: new Date().toISOString(), finishedAt: null,
    });
    // When a second store opens the persisted data as a restart would.
    const reopened = new Store(dir);
    reopened.recoverInterruptedJobs();
    try {
      // Then a job that never reached the provider is failed honestly instead of being left queued forever.
      expect(reopened.job(queued.id)?.status).toBe("failed");
      expect(reopened.job(queued.id)?.error).toContain("submit it again");
      // And the account it was waiting on stays usable.
      expect(reopened.account(account.id)?.status).toBe("ready");
    } finally { reopened.close(); }
  });
});

describe("account isolation and job state", () => {
  test("acquires job ownership before a competing login can reserve the account", async () => {
    // Given a ready account with a submitted job whose start is scheduled.
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const { gateway } = fixture(async () => {
      started.resolve();
      await finish.promise;
      return { text: "done", remoteId: "remote" };
    });
    const account = gateway.create("dots", "Ownership", {});
    await gateway.check(account.id);
    const job = gateway.submit({ accountId: account.id, prompt: "work" });
    // When a login races the continuation after acquisition.
    await Promise.resolve();
    try {
      expect(() => gateway.reserve(account.id)).toThrow(GatewayError);
      await started.promise;
      // Then the account remains owned by the running job.
      expect(gateway.account(account.id).busy).toBe(true);
    } finally { finish.resolve(); await gateway.wait(job.id); }
  });

  test("drains every accepted queued job before returning and refuses new work", async () => {
    // Given one controlled run and nineteen accepted waiting jobs.
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let runs = 0;
    const { gateway, store } = fixture(async () => {
      runs++;
      started.resolve();
      await finish.promise;
      return { text: "done", remoteId: "remote" };
    });
    const account = gateway.create("dots", "Drain", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "first" });
    await started.promise;
    const waiting = Array.from({ length: 19 }, () => gateway.submit({ accountId: account.id, prompt: "queued" }));
    // When shutdown begins and the active run completes.
    gateway.stop();
    expect(() => gateway.submit({ accountId: account.id, prompt: "late" })).toThrow(GatewayError);
    finish.resolve();
    await gateway.drain();
    // Then all accepted jobs are terminal and no queued work reached the provider.
    expect([first, ...waiting].map((job) => store.job(job.id)?.status)).toEqual(["completed", ...waiting.map(() => "failed" as const)]);
    expect(runs).toBe(1);
  });

  test("routes to spare capacity before scheduled jobs have marked accounts busy", async () => {
    // Given a full first account and a second account with one pending job.
    const finish = Promise.withResolvers<void>();
    const { gateway } = fixture(async () => {
      await finish.promise;
      return { text: "done", remoteId: "remote" };
    });
    const a = gateway.create("dots", "A", {});
    const b = gateway.create("dots", "B", {});
    await gateway.check(a.id); await gateway.check(b.id);
    const jobs = Array.from({ length: 20 }, () => gateway.submit({ accountId: a.id, prompt: "full" }));
    jobs.push(gateway.submit({ accountId: b.id, prompt: "one" }));
    // When automatic routing runs in the same synchronous submission burst.
    try {
      const next = gateway.submit({ provider: "dots", prompt: "automatic" });
      jobs.push(next);
      // Then the full account cannot conceal the second account's capacity.
      expect(next.accountId).toBe(b.id);
    } finally { finish.resolve(); await Promise.all(jobs.map((job) => gateway.wait(job.id))); }
  });

  test("rejects retained bytes before persistence and releases reservations on completion", async () => {
    // Given a deliberately small quota and a held run that exactly fills it.
    const finish = Promise.withResolvers<void>();
    const { gateway, store } = fixture(async () => {
      await finish.promise;
      return { text: "done", remoteId: null };
    }, undefined, 8);
    const account = gateway.create("dots", "Budget", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "four" });
    // When another request exceeds the retained UTF-16 input quota.
    try {
      expect(() => gateway.submit({ accountId: account.id, prompt: "x" })).toThrow(GatewayError);
      // Then rejection left no partial record or capacity allocation.
      expect(store.jobs()).toHaveLength(1);
    } finally { finish.resolve(); await gateway.wait(first.id); }
    const next = gateway.submit({ accountId: account.id, prompt: "four" });
    expect((await gateway.wait(next.id)).status).toBe("completed");
  });

  test("returns byte reservations when queued work is abandoned by shutdown", async () => {
    // Given two jobs filling a controlled quota.
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const { gateway } = fixture(async () => {
      started.resolve(); await finish.promise;
      return { text: "done", remoteId: null };
    }, undefined, 8);
    const account = gateway.create("dots", "Budget stop", {});
    await gateway.check(account.id);
    gateway.submit({ accountId: account.id, prompt: "aa" });
    await started.promise;
    gateway.submit({ accountId: account.id, prompt: "bb" });
    // When shutdown abandons the queue.
    gateway.stop(); finish.resolve(); await gateway.drain();
    // Then every accepted reservation was released once.
    expect(gateway["queuedBytes"]).toBe(0);
  });

  test("rolls back interrupted recovery if account quarantine cannot be persisted", async () => {
    // Given a running job and a SQLite fault at the quarantine write.
    const { gateway, store, dir } = fixture();
    const account = gateway.create("dots", "Recovery", {});
    await gateway.check(account.id);
    const job = store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "dots",
      prompt: "work", status: "running", output: "", error: null, remoteId: "accepted",
      images: [], createdAt: new Date().toISOString(), finishedAt: null,
    });
    store.db.exec("CREATE TEMP TRIGGER fail_quarantine BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'quarantine fault'); END");
    // When the recovery transaction fails and is subsequently retried.
    expect(() => store.recoverInterruptedJobs()).toThrow("quarantine fault");
    expect(store.job(job.id)?.status).toBe("running");
    store.db.exec("DROP TRIGGER fail_quarantine");
    const reopened = new Store(dir);
    try {
      reopened.recoverInterruptedJobs();
      // Then job uncertainty and quarantine became durable together.
      expect(reopened.job(job.id)?.status).toBe("unknown");
      expect(reopened.account(account.id)?.status).toBe("error");
    } finally { reopened.close(); }
  });
  test("shutdown aborts work and drains its persistence before releasing ownership", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const { gateway, store } = fixture(async (_credentials, _prompt, context) => {
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await aborted.promise;
      await cleanup.promise;
      throw new GatewayError("cancelled", "Stopped after submission.", 503, true);
    });
    const account = gateway.create("dots", "Shutdown", {});
    await gateway.check(account.id);
    const job = gateway.submit({ accountId: account.id, prompt: "work" });
    await started.promise;
    gateway.stop();
    await aborted.promise;
    let drained = false;
    const draining = gateway.drain().then(() => { drained = true; });
    expect(drained).toBe(false);
    expect(() => gateway.reserve(account.id)).toThrow(GatewayError);
    cleanup.resolve();
    await draining;
    expect(store.job(job.id)?.status).toBe("unknown");
    expect(gateway.account(account.id).busy).toBe(false);
  });
  test("manual Dots token replacement drops OAuth state while thread edits retain it", () => {
    const { gateway, store } = fixture();
    const account = gateway.create("dots", "Manual", {
      accessToken: "old", accountId: "workspace", refreshToken: "old-refresh",
      refreshState: "revoked", expiresAt: "1", idToken: "old-id", threadId: "old-thread",
    });
    gateway.update(account.id, { credentials: { threadId: "new-thread" } });
    expect(store.credentials(account.id)["refreshToken"]).toBe("old-refresh");
    gateway.update(account.id, { credentials: { accessToken: "new" } });
    expect(store.credentials(account.id)).toEqual({
      accessToken: "new", accountId: "workspace", threadId: "new-thread",
    });
  });
  test("a login lease excludes work and stale release cannot unlock a later operation", async () => {
    // Given a ready account reserved for interactive login.
    const { gateway } = fixture();
    const account = gateway.create("dots", "Login", {});
    await gateway.check(account.id);
    const release = gateway.reserve(account.id);
    // When other account operations race the login.
    expect(() => gateway.submit({ accountId: account.id, prompt: "work" })).toThrow(GatewayError);
    await expect(gateway.check(account.id)).rejects.toMatchObject({ code: "account_busy" });
    expect(() => gateway.update(account.id, { label: "Changed" })).toThrow(GatewayError);
    expect(() => gateway.remove(account.id)).toThrow(GatewayError);
    release();
    const nextRelease = gateway.reserve(account.id);
    release();
    // Then an expired lease cannot release the new operation's lock.
    expect(gateway.account(account.id).busy).toBe(true);
    nextRelease();
    expect(gateway.account(account.id).busy).toBe(false);
  });
  test("queues work for a busy account while routing another account independently", async () => {
    // Given two ready accounts and an event-controlled upstream.
    const first = Promise.withResolvers<RunResult>();
    const started = Promise.withResolvers<void>();
    const order: string[] = [];
    const { gateway } = fixture(async (_credentials, prompt, context) => {
      order.push(`start:${prompt}`);
      if (context.accountId === a.id) { started.resolve(); return first.promise; }
      return { text: "second result", remoteId: "second" };
    });
    const a = gateway.create("dots", "First", {});
    const b = gateway.create("dots", "Second", {});
    await gateway.check(a.id); await gateway.check(b.id);
    // When the first account remains in flight and more work arrives.
    const jobA = gateway.submit({ accountId: a.id, prompt: "A" });
    await started.promise;
    const jobA2 = gateway.submit({ accountId: a.id, prompt: "A2" });
    const jobB = gateway.submit({ provider: "dots", prompt: "B" });
    // Then provider routing still uses the free account while the busy account holds the extra work as queued.
    expect(jobB.accountId).toBe(b.id);
    expect(jobA2.status).toBe("queued");
    expect((await gateway.wait(jobB.id)).output).toBe("second result");
    expect(gateway.account(a.id).busy).toBe(true);
    first.resolve({ text: "first result", remoteId: "first" });
    const resultA = await gateway.wait(jobA.id);
    const resultA2 = await gateway.wait(jobA2.id);
    // Then both jobs of the busy account completed, in order.
    expect(resultA.output).toBe("first result");
    expect(resultA2.output).toBe("first result");
    expect(order).toEqual(["start:A", "start:B", "start:A2"]);
    expect(gateway.account(a.id).busy).toBe(false);
  });
  test("runs a queued job after the current one instead of refusing it", async () => {
    // Given one account whose first job is held open by the upstream.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const { gateway, store } = fixture(async (_credentials, prompt) => {
      order.push(`start:${prompt}`);
      if (prompt === "first") { started.resolve(); await gate.promise; }
      order.push(`end:${prompt}`);
      return { text: `result:${prompt}`, remoteId: `remote-${prompt}` };
    });
    const account = gateway.create("dots", "Serial", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "first" });
    await started.promise;
    // When a second job arrives for the busy account.
    const second = gateway.submit({ accountId: account.id, prompt: "second" });
    // Then it is accepted as queued rather than rejected, and it has not started yet.
    expect(second.status).toBe("queued");
    expect(store.job(second.id)?.status).toBe("queued");
    expect(order).toEqual(["start:first"]);
    // When the first job finishes.
    gate.resolve();
    const queued = await gateway.wait(second.id);
    // Then the queue drained in order and both jobs completed.
    expect(queued.status).toBe("completed");
    expect(queued.output).toBe("result:second");
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
    expect(store.job(first.id)?.status).toBe("completed");
    expect(gateway.account(account.id).busy).toBe(false);
  });
  test("keeps a queued job marked running once its provider accepts it", async () => {
    // Given a job queued behind one that is still running.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let secondId = jobIdSchema.parse(crypto.randomUUID());
    let observed = "";
    const { gateway, store } = fixture(async (_credentials, prompt, context) => {
      if (prompt === "first") { started.resolve(); await gate.promise; return { text: "first", remoteId: "remote-first" }; }
      context.onAccepted?.("remote-second");
      observed = store.job(secondId)?.status ?? "missing";
      return { text: "second", remoteId: "remote-second" };
    });
    const account = gateway.create("dots", "Accepted", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "first" });
    await started.promise;
    const second = gateway.submit({ accountId: account.id, prompt: "second" });
    secondId = second.id;
    // When the queued job gets its turn and the provider accepts it.
    gate.resolve();
    const result = await gateway.wait(second.id);
    // Then the record that provider event re-saves still reads running, and the job finishes normally.
    expect(observed).toBe("running");
    expect(result.status).toBe("completed");
    expect(store.job(second.id)?.remoteId).toBe("remote-second");
    expect(store.job(first.id)?.status).toBe("completed");
  });
  test("does not start queued work after the account has been quarantined", async () => {
    // Given a provider whose running job fails with an unknown outcome and cannot re-verify itself.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { gateway } = fixture(async () => {
      started.resolve();
      await gate.promise;
      throw new GatewayError("timeout", "Accepted work timed out.", 504, true);
    });
    const account = gateway.create("dots", "Quarantined", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "first" });
    await started.promise;
    const waiting = gateway.submit({ accountId: account.id, prompt: "second" });
    // When the first job quarantines the account.
    gate.resolve();
    await gateway.wait(first.id);
    const result = await gateway.wait(waiting.id);
    // Then the queued job fails honestly without work being sent to the untrusted session.
    expect(gateway.account(account.id).status).toBe("error");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not ready");
    expect(result.remoteId).toBeNull();
  });
  test("refuses work beyond the queue limit and accepts it again once the queue drains", async () => {
    // Given an account whose running job holds a queue at its limit.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { gateway } = fixture(async (_credentials, prompt) => {
      if (prompt === "running") { started.resolve(); await gate.promise; }
      return { text: `result:${prompt}`, remoteId: `remote-${prompt}` };
    });
    const account = gateway.create("dots", "Full", {});
    await gateway.check(account.id);
    const running = gateway.submit({ accountId: account.id, prompt: "running" });
    await started.promise;
    const queued = Array.from({ length: 19 }, (_unused, index) => gateway.submit({ accountId: account.id, prompt: `queued-${index}` }));
    expect(() => gateway.submit({ accountId: account.id, prompt: "overflow" })).toThrow(GatewayError);
    // When the queue drains.
    gate.resolve();
    await Promise.all([running, ...queued].map((job) => gateway.wait(job.id)));
    // Then the account takes work again.
    const next = gateway.submit({ accountId: account.id, prompt: "after" });
    expect(next.status).toBe("running");
    expect((await gateway.wait(next.id)).status).toBe("completed");
  });
  test("leaves queued work unstarted when the gateway stops", async () => {
    // Given a queued job whose turn comes only after a shutdown.
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { gateway, store } = fixture(async (_credentials, prompt) => {
      if (prompt === "first") { started.resolve(); await gate.promise; }
      return { text: `result:${prompt}`, remoteId: `remote-${prompt}` };
    });
    const account = gateway.create("dots", "Stopped", {});
    await gateway.check(account.id);
    const first = gateway.submit({ accountId: account.id, prompt: "first" });
    await started.promise;
    const waiting = gateway.submit({ accountId: account.id, prompt: "second" });
    // When the gateway stops while the first job is still in flight.
    gateway.stop();
    gate.resolve();
    await gateway.wait(first.id);
    const result = await gateway.wait(waiting.id);
    // Then the job that never got its turn fails without being sent, and the account stays usable.
    expect(result.status).toBe("failed");
    expect(result.error).toContain("stopped before this job started");
    expect(store.job(waiting.id)?.status).toBe("failed");
    expect(gateway.account(account.id).status).toBe("ready");
  });
  test("quarantines an account after an accepted job has an uncertain outcome", async () => {
    // Given an upstream which cannot confirm an accepted request.
    const { gateway } = fixture(async (_credentials, _prompt, context) => {
      context.onAccepted?.("remote-known");
      throw new GatewayError("timeout", "Accepted work timed out.", 504, true);
    });
    const account = gateway.create("dots", "Uncertain", {});
    await gateway.check(account.id);
    // When the gateway observes that failure.
    const result = await gateway.wait(gateway.submit({ accountId: account.id, prompt: "work" }).id);
    // Then it does not label it safely failed or route more work automatically.
    expect(result.status).toBe("unknown");
    expect(result.remoteId).toBe("remote-known");
    expect(gateway.account(account.id).status).toBe("error");
    expect(() => gateway.submit({ provider: "dots", prompt: "retry" })).toThrow(GatewayError);
  });
  test("re-verifies a recoverable account instead of quarantining it after an uncertain job", async () => {
    // Given a provider that can re-verify its own session through an adapter-declared reconnect.
    let reconnects = 0;
    const { gateway } = fixture(async (_credentials, _prompt, context) => {
      context.onAccepted?.("remote-known");
      throw new GatewayError("timeout", "Accepted work timed out.", 504, true);
    }, async () => {
      reconnects += 1;
      return { detail: "Session re-verified." };
    });
    const account = gateway.create("muse", "Recoverable", {});
    await gateway.check(account.id);
    // When the gateway observes that failure.
    const result = await gateway.wait(gateway.submit({ accountId: account.id, prompt: "work" }).id);
    // Then the job is still honestly uncertain, but the account is usable again without a human pressing Check.
    expect(result.status).toBe("unknown");
    expect(reconnects).toBe(1);
    expect(gateway.account(account.id).status).toBe("ready");
    expect(gateway.account(account.id).detail).toContain("re-verified automatically");
    const next = gateway.submit({ provider: "muse", prompt: "next" });
    expect(next.status).toBe("running");
    await gateway.wait(next.id);
  });
  test("keeps the quarantine when the session cannot be re-verified", async () => {
    // Given a provider whose recovery check fails too.
    const { gateway } = fixture(async () => {
      throw new GatewayError("timeout", "Accepted work timed out.", 504, true);
    }, async () => {
      throw new GatewayError("muse_check", "Muse chat sign-in could not be confirmed.", 502);
    });
    const account = gateway.create("muse", "Unrecoverable", {});
    await gateway.check(account.id);
    // When the gateway observes that failure.
    const result = await gateway.wait(gateway.submit({ accountId: account.id, prompt: "work" }).id);
    // Then the account stays quarantined and more work is still refused.
    expect(result.status).toBe("unknown");
    expect(gateway.account(account.id).status).toBe("error");
    expect(() => gateway.submit({ provider: "muse", prompt: "blocked" })).toThrow(GatewayError);
  });
  test("preserves existing credentials when only the label changes", () => {
    // Given an account with a saved secret.
    const { gateway, store } = fixture();
    const a = gateway.create("dots", "Old", { accessToken: "secret" });
    // When editing only its label.
    gateway.update(a.id, { label: "New" });
    // Then credentials are retained, not replaced by form blanks.
    expect(store.credentials(a.id)["accessToken"]).toBe("secret");
    expect(gateway.account(a.id).label).toBe("New");
  });
  test("a Dot thread the operator picks does not inherit the replaced thread's rotation state", () => {
    // Given an account running on a thread this gateway created, with image content recorded on it.
    const { gateway, store } = fixture();
    const a = gateway.create("dots", "Rotated", {
      accessToken: "secret", threadId: "gateway-thread", threadOrigin: "self", threadImageBytes: "9000000", threadImageAccounting: "incomplete",
    });
    // When the operator points the account at a different thread in the console.
    gateway.update(a.id, { credentials: { threadId: "operator-thread" } });
    // Then that thread is not marked as gateway-created and starts with no image count, so it is never archived.
    const credentials = store.credentials(a.id);
    expect(credentials["threadId"]).toBe("operator-thread");
    expect(credentials["accessToken"]).toBe("secret");
    expect(credentials["threadOrigin"]).toBeUndefined();
    expect(credentials["threadImageBytes"]).toBeUndefined();
    expect(credentials["threadImageAccounting"]).toBeUndefined();
  });
  test("re-saving the same Dot thread keeps its rotation state", () => {
    // Given an account on a gateway-created thread with a recorded image count.
    const { gateway, store } = fixture();
    const a = gateway.create("dots", "Same", { threadId: "gateway-thread", threadOrigin: "self", threadImageBytes: "9000000" });
    // When the console saves the same thread ID again.
    gateway.update(a.id, { credentials: { threadId: "gateway-thread" } });
    // Then nothing about that thread is forgotten.
    expect(store.credentials(a.id)).toMatchObject({ threadOrigin: "self", threadImageBytes: "9000000" });
  });
  test("accepts long async job input without truncating the provider prompt", async () => {
    // Given a ready provider and an input above the old 100,000-character limit.
    let received = "";
    const { app, store, gateway } = fixture(async (_credentials, prompt) => {
      received = prompt;
      return { text: "accepted", remoteId: null };
    });
    const account = gateway.create("dots", "Long input", {});
    await gateway.check(account.id);
    const prompt = "x".repeat(720_000);
    // When a client uses the asynchronous job API.
    const response = await app.request("http://localhost/api/jobs", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ accountId: account.id, prompt }),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    await gateway.wait(jobIdSchema.parse(body.job.id));
    // Then the transport retains every character for the adapter.
    expect(received).toBe(prompt);
  });
  test("publishes adapter context metadata in provider and model discovery", async () => {
    // Given an adapter with a non-default context budget.
    const { app, store } = fixture();
    const headers = { authorization: `Bearer ${store.apiKey}` };
    // When clients discover providers and OpenAI-compatible models.
    const providers = await app.request("http://localhost/api/providers", { headers });
    const models = await app.request("http://localhost/v1/models", { headers });
    // Then both discovery paths retain the adapter's budget and evidence basis.
    expect((await providers.json()).providers[0]).toMatchObject({ contextWindow: 123456, contextBasis: "configured" });
    expect((await models.json()).data[0]).toMatchObject({ context_window: 123456, context_basis: "configured" });
  });
  test("requires authentication and rejects foreign browser origins", async () => {
    // Given the API handler.
    const { app, store } = fixture();
    // When called without auth and with foreign Origin despite valid key.
    const unauthenticated = await app.request("http://localhost/api/accounts");
    const foreign = await app.request("http://localhost/api/accounts", {
      headers: { origin: "https://evil.example", authorization: `Bearer ${store.apiKey}` },
    });
    // Then both access paths are denied.
    expect(unauthenticated.status).toBe(401);
    expect(foreign.status).toBe(403);
  });
  test("serves real HTTP account and job requests without secret fields", async () => {
    // Given a loopback server backed by the real SQLite store and deterministic adapter.
    const { app, store } = fixture();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const headers = { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" };
    try {
      // When creating an account through HTTP.
      const response = await fetch(new URL("/api/accounts", server.url), {
        method: "POST", headers, body: JSON.stringify({ provider: "dots", label: "HTTP account", credentials: { token: "http-secret" } }),
      });
      // Then the endpoint persists it and never returns the supplied secret.
      expect(response.status).toBe(201);
      expect(await response.text()).not.toContain("http-secret");
      const listed = await fetch(new URL("/api/accounts", server.url), { headers });
      expect(await listed.text()).toContain("HTTP account");
    } finally { await server.stop(true); }
  });
  test("rejects malformed tool definitions before invoking any remote work", async () => {
    // Given a valid API credential and a transport that must not be called.
    let calls = 0;
    const { app, store } = fixture(async () => { calls++; return { text: "bad", remoteId: null }; });
    // When client requests native function tools.
    const result = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "read" }], tools: [{ type: "function" }] }),
    });
    // Then failure is explicit and no allowance is consumed.
    expect(result.status).toBe(400);
    expect(calls).toBe(0);
  });
  test("returns the remote result in Chat Completions without invented usage", async () => {
    // Given a ready account.
    const { app, store, gateway } = fixture();
    const a = gateway.create("dots", "Chat", {});
    await gateway.check(a.id);
    // When making a real chat request.
    const result = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "hello" }] }),
    });
    // Then text is returned and usage is declared unknown rather than zero.
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("fixture result");
    expect(text).not.toContain('"usage"');
    expect(result.headers.get("x-dots2api-usage")).toBe("unknown");
  });
  test("preserves developer instructions and ordered text parts in chat history", async () => {
    // Given a ready agent and a multipart OmO conversation.
    let prompt = "";
    const { app, store, gateway } = fixture(async (_credentials, input) => {
      prompt = input;
      return { text: "done", remoteId: null };
    });
    const account = gateway.create("dots", "History", {});
    await gateway.check(account.id);
    // When OmO sends the conversation through Chat Completions.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [
        { role: "developer", content: "Follow this instruction." },
        { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
        { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
        { role: "user", content: "continue" },
      ] }),
    });
    // Then no instruction or text part disappears in the remote prompt.
    expect(response.status).toBe(200);
    expect(prompt).toBe("DEVELOPER:\nFollow this instruction.\n\nUSER:\nfirst\nsecond\n\nASSISTANT:\nprior answer\n\nUSER:\ncontinue");
  });
  test("preserves prior tool calls and results as transcript text", async () => {
    // Given a ready agent and completed tool history, without requesting new tools.
    let prompt = "";
    const { app, store, gateway } = fixture(async (_credentials, input) => {
      prompt = input;
      return { text: "done", remoteId: null };
    });
    const account = gateway.create("dots", "History", {});
    await gateway.check(account.id);
    // When OmO replays a tool call with null assistant content and its result.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [
        { role: "user", content: "Read the file." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
        { role: "tool", tool_call_id: "call_1", name: "read", content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
        { role: "user", content: "Summarize it." },
      ] }),
    });
    // Then the tool identity, arguments, output and surrounding turns reach the provider.
    expect(response.status).toBe(200);
    expect(prompt).toBe('USER:\nRead the file.\n\nASSISTANT:\nTOOL CALL call_1 (read):\n{"path":"a.ts"}\n\nTOOL RESULT call_1 (read):\nline 1\nline 2\n\nUSER:\nSummarize it.');
  });
  test("rejects non-text history instead of dropping it", async () => {
    // Given an authenticated endpoint without a connected provider.
    const { app, store } = fixture();
    // When a turn contains an image.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] },
      ] }),
    });
    // Then the image cannot be mistaken for an empty text prompt.
    expect(response.status).toBe(400);
  });
  test("rejects assistant null without a tool call", async () => {
    // Given an authenticated endpoint without a connected provider.
    const { app, store } = fixture();
    // When a previous assistant turn has neither text nor a tool call.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "assistant", content: null }] }),
    });
    // Then it is not accepted as an empty history turn.
    expect(response.status).toBe(400);
  });
  test("returns tool calls through SSE and accepts advisory OmO output limits", async () => {
    // Given a ready remote agent requesting one declared client tool.
    const { app, store, gateway } = fixture(async () => ({
      text: JSON.stringify({ protocol: "dots2api.chat.v1", content: null, tool_calls: [{ name: "read", arguments: { path: "a.ts" } }] }), remoteId: "tool-round",
    }));
    const account = gateway.create("dots", "Tools", {});
    await gateway.check(account.id);
    // When OmO supplies tools, an output budget and streaming.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "Read a.ts" }], stream: true,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
        max_completion_tokens: 128 }),
    });
    // Then the client receives indexed calls and truthful capability headers.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dots2api-token-limit")).toBe("advisory");
    expect(response.headers.get("x-dots2api-tools")).toBe("prompted");
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
    expect(events.at(-1)).toBe("[DONE]");
    const chunk = JSON.parse(events[0] ?? "null");
    expect(chunk.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } });
    expect(JSON.parse(events[1] ?? "null").choices[0].finish_reason).toBe("tool_calls");
  });
  describe("image generation endpoint", () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
    const webp = Uint8Array.from(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("VP8 "), Buffer.alloc(16)]));
    const post = (app: ReturnType<typeof fixture>["app"], key: string | null, body: unknown) =>
      app.request("http://localhost/v1/images/generations", {
        method: "POST", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
      });

    const edit = (app: ReturnType<typeof fixture>["app"], key: string | null, form: FormData) =>
      app.request("http://localhost/v1/images/edits", {
        method: "POST", headers: key ? { authorization: `Bearer ${key}` } : {}, body: form,
      });

    test("edits carry ordered signature-validated files through the gateway for every requested image", async () => {
      const received: (readonly ReferenceImage[])[] = [];
      const { app, store, gateway } = fixture(async (_credentials, prompt, context) => {
        expect(prompt).not.toContain(Buffer.from(png).toString("base64"));
        received.push(context.referenceImages ?? []);
        return { text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }] };
      });
      await gateway.check(gateway.create("dots", "Edits", {}).id);
      const form = new FormData();
      form.set("prompt", "make the dot blue");
      form.set("n", "2");
      form.set("response_format", "url");
      form.append("image", new Blob([png], { type: "text/plain" }), "first.txt");
      form.append("image[]", new Blob([webp]), "second.webp");
      const response = await edit(app, store.apiKey, form);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toHaveLength(2);
      expect(received).toHaveLength(2);
      for (const images of received) {
        expect(images.map((image) => image.mime)).toEqual(["image/png", "image/webp"]);
        expect(images[0]?.data).toEqual(png);
        expect(images[1]?.data).toEqual(webp);
      }
      expect(JSON.stringify(store.jobs())).not.toContain(Buffer.from(png).toString("base64"));
    });

    test.each(["missing", "url", "signature", "count", "mask", "duplicate", "empty"])("rejects %s edit input before submission", async (kind) => {
      let runs = 0;
      const { app, store, gateway } = fixture(async () => { runs++; return { text: "unexpected", remoteId: null }; });
      const form = new FormData();
      form.set("prompt", "edit");
      if (kind !== "missing") form.append("image", new Blob([kind === "signature" ? "not an image" : kind === "empty" ? "" : png]), "reference.png");
      if (kind === "url") form.set("image", "http://127.0.0.1/private");
      if (kind === "count") for (let i = 0; i < MAX_IMAGES; i++) form.append("image[]", new Blob([png]), `${i}.png`);
      if (kind === "mask") form.set("mask", new Blob([png]), "mask.png");
      if (kind === "duplicate") form.append("prompt", "other");
      const response = await edit(app, store.apiKey, form);
      expect(response.status).toBe(kind === "empty" ? 413 : 400);
      expect(runs).toBe(0);
      expect(gateway.store.jobs()).toHaveLength(0);
    });

    test("rejects over-limit reference bytes and requires multipart and authorization", async () => {
      const { app, store } = fixture();
      const form = new FormData();
      form.set("prompt", "edit");
      form.append("image", new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)]), "huge.png");
      expect((await edit(app, store.apiKey, form)).status).toBe(413);
      expect((await edit(app, null, new FormData())).status).toBe(401);
      expect((await app.request("http://localhost/v1/images/edits", {
        method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "edit", image: "https://example.org/image.png" }),
      })).status).toBe(400);
    });

    test("a Muse edit carries its reference through instead of rejecting the request", async () => {
      const received: (readonly ReferenceImage[] | undefined)[] = [];
      const { app, store, gateway } = fixture(async (_credentials, _prompt, context) => {
        received.push(context.referenceImages);
        return { text: "edited", remoteId: "muse-thread", images: [{ mime: "image/png", data: png }] };
      });
      await gateway.check(gateway.create("muse", "Muse", {}).id);
      const form = new FormData();
      form.set("prompt", "edit");
      form.set("model", "muse-image");
      form.append("image", new Blob([png]), "reference.png");
      const response = await edit(app, store.apiKey, form);
      expect(response.status).toBe(200);
      expect(store.jobs()).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(received[0]?.[0]?.data).toEqual(png);
    });

    test("gateway validates and snapshots reference bytes before asynchronous execution", async () => {
      let received: readonly ReferenceImage[] | undefined;
      const { gateway } = fixture(async (_credentials, _prompt, context) => {
        received = context.referenceImages;
        return { text: "done", remoteId: "r" };
      });
      await gateway.check(gateway.create("dots", "References", {}).id);
      expect(() => gateway.submit({ provider: "dots", prompt: "edit", referenceImages: [] })).toThrow(GatewayError);
      expect(() => gateway.submit({ provider: "dots", prompt: "edit", referenceImages: [{ mime: "image/jpeg", data: png }] })).toThrow(GatewayError);
      const data = new Uint8Array(png);
      const job = gateway.submit({ provider: "dots", prompt: "edit", referenceImages: [{ mime: "image/png", data }] });
      data.fill(0);
      expect((await gateway.wait(job.id)).status).toBe("completed");
      expect(received?.[0]?.data).toEqual(png);
    });

    test("a queued job still delivers its own reference images when its turn comes", async () => {
      // Given one account whose first job is held open, and a second job with references submitted behind it.
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const received = new Map<string, readonly ReferenceImage[] | undefined>();
      const { gateway } = fixture(async (_credentials, prompt, context) => {
        received.set(prompt, context.referenceImages);
        if (prompt === "first") { started.resolve(); await gate.promise; }
        return { text: prompt, remoteId: prompt };
      });
      const account = gateway.create("dots", "Queue", {});
      await gateway.check(account.id);
      const first = gateway.submit({ accountId: account.id, prompt: "first" });
      await started.promise;
      const data = new Uint8Array(png);
      const queued = gateway.submit({ accountId: account.id, prompt: "edit", referenceImages: [{ mime: "image/png", data }] });
      // When the caller reuses its buffer while the job waits, and the first job then finishes.
      data.fill(0);
      expect(queued.status).toBe("queued");
      gate.resolve();
      await gateway.wait(first.id);
      // Then the queued job ran with the bytes that were submitted, and the first job had none.
      expect((await gateway.wait(queued.id)).status).toBe("completed");
      expect(received.get("first")).toBeUndefined();
      expect(received.get("edit")?.[0]?.data).toEqual(png);
    });

    test("returns base64 images, passes size and quality as plain words, and reports revised prompts", async () => {
      // Given a Dot that returns one PNG with a revised prompt.
      const prompts: string[] = [];
      const { app, store, gateway } = fixture(async (_c, input) => {
        prompts.push(input);
        return { text: "done", remoteId: "r", images: [{ mime: "image/png", data: png, revisedPrompt: "a red dot, revised" }] };
      });
      await gateway.check(gateway.create("dots", "Images", {}).id);
      // When asking for one landscape high-quality image.
      const response = await post(app, store.apiKey, { prompt: "a red dot", size: "1536x1024", quality: "high" });
      // Then the payload follows the OpenAI shape and the Dot was asked in words.
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data).toHaveLength(1);
      expect(Buffer.from(json.data[0].b64_json, "base64").equals(Buffer.from(png))).toBe(true);
      expect(json.data[0].revised_prompt).toBe("a red dot, revised");
      expect(json.output_format).toBe("png");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("a red dot");
      expect(prompts[0]).toContain("landscape (3:2)");
      expect(prompts[0]).toContain("Maximum detail");
      expect(response.headers.get("x-dots2api-job-id")).toBeTruthy();
    });

    test("returns URLs on request and runs n images one after another", async () => {
      // Given a Dot that records overlapping runs.
      let active = 0; let maxActive = 0;
      const { app, store, gateway } = fixture(async () => {
        active++; maxActive = Math.max(maxActive, active);
        await Promise.resolve(); active--;
        return { text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }] };
      });
      await gateway.check(gateway.create("dots", "Images", {}).id);
      // When asking for two images as URLs.
      const response = await post(app, store.apiKey, { prompt: "p", n: 2, response_format: "url" });
      const json = await response.json();
      // Then two distinct downloadable URLs come back and runs never overlapped.
      expect(json.data).toHaveLength(2);
      expect(new Set(json.data.map((d: { url: string }) => d.url)).size).toBe(2);
      expect(json.data[0].url.startsWith("http://localhost/api/jobs/")).toBe(true);
      expect(maxActive).toBe(1);
      const image = await app.request(json.data[0].url, { headers: { authorization: `Bearer ${store.apiKey}` } });
      expect(image.headers.get("content-type")).toBe("image/png");
    });

    test("fails clearly when the Dot answers in text only, without an invented image", async () => {
      // Given a Dot that refuses with prose.
      const { app, store, gateway } = fixture(async () => ({ text: "I can't make images right now.", remoteId: "r" }));
      await gateway.check(gateway.create("dots", "Refuses", {}).id);
      const response = await post(app, store.apiKey, { prompt: "p" });
      expect(response.status).toBe(502);
      const json = await response.json();
      expect(json.error.code).toBe("image_not_generated");
      expect(json.error.message).toContain("I can't make images right now");
    });

    test("returns already generated images when a later one fails", async () => {
      // Given a Dot that succeeds once, then fails definitively.
      let runs = 0;
      const { app, store, gateway } = fixture(async () => {
        if (++runs === 2) throw new GatewayError("dots_failed", "Turn failed.", 502);
        return { text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }] };
      });
      await gateway.check(gateway.create("dots", "Partial", {}).id);
      const response = await post(app, store.apiKey, { prompt: "p", n: 3 });
      // Then the paid-for image is returned with headers that say it is partial, and nothing is retried.
      expect(response.status).toBe(200);
      expect((await response.json()).data).toHaveLength(1);
      expect(response.headers.get("x-dots2api-images-requested")).toBe("3");
      expect(response.headers.get("x-dots2api-images-returned")).toBe("1");
      expect(runs).toBe(2);
    });

    test("preserves the first image and its correlation ID when the next admission fails", async () => {
      // Given a provider disabled after the first image was produced.
      const { app, store, gateway } = fixture(async () => {
        gateway.setProviderEnabled("dots", false);
        return { text: "done", remoteId: "first", images: [{ mime: "image/png", data: png }] };
      });
      await gateway.check(gateway.create("dots", "Partial admission", {}).id);
      // When the same HTTP request asks for two images.
      const response = await post(app, store.apiKey, { prompt: "p", n: 2 });
      // Then its completed image is returned even though submission two was refused.
      expect(response.status).toBe(200);
      expect((await response.json()).data).toHaveLength(1);
      expect(response.headers.get("x-dots2api-images-requested")).toBe("2");
      expect(response.headers.get("x-dots2api-images-returned")).toBe("1");
      expect(response.headers.get("x-dots2api-job-id")).toBe(store.jobs()[0]?.id ?? null);
    });

    test("rejects unsupported explicit output encoding before remote generation", async () => {
      // Given an image-capable provider whose output encoding cannot be controlled.
      let runs = 0;
      const { app, store, gateway } = fixture(async () => {
        runs++;
        return { text: "done", remoteId: "r", images: [{ mime: "image/webp", data: webp }] };
      });
      await gateway.check(gateway.create("muse", "Format", {}).id);
      // When a client requires PNG rather than the actual provider encoding.
      const response = await post(app, store.apiKey, { model: "muse-image", prompt: "p", output_format: "png" });
      // Then the unsupported guarantee is rejected without consuming remote work.
      expect(response.status).toBe(422);
      expect(runs).toBe(0);
      expect(store.jobs()).toHaveLength(0);
    });

    test.each([
      [{ prompt: "" }], [{ prompt: "p", n: 5 }], [{ prompt: "p", size: "512x512" }], [{ prompt: "p", style: "vivid" }],
    ])("rejects invalid request %j", async (body) => {
      const { app, store } = fixture();
      expect((await post(app, store.apiKey, body)).status).toBe(400);
    });

    test("rejects foreign models and requires the API key", async () => {
      const { app, store } = fixture();
      expect((await post(app, store.apiKey, { prompt: "p", model: "dall-e-3" })).status).toBe(422);
      expect((await post(app, null, { prompt: "p" })).status).toBe(401);
    });

    test("routes the muse-image model to a Muse account and reports the real format", async () => {
      // Given a ready Dot account and a ready Muse account.
      const { app, store, gateway } = fixture(async () => ({ text: "done", remoteId: "r", images: [{ mime: "image/webp", data: webp }] }));
      await gateway.check(gateway.create("dots", "Dot", {}).id);
      await gateway.check(gateway.create("muse", "Muse", {}).id);
      // When asking for the muse-image model.
      const response = await post(app, store.apiKey, { model: "muse-image", prompt: "a red dot" });
      // Then it runs on the Muse account and returns WebP, not a hardcoded png label.
      expect(response.status).toBe(200);
      const jobId = response.headers.get("x-dots2api-job-id") ?? "";
      expect(String(gateway.store.job(jobId as never)?.provider)).toBe("muse");
      const json = await response.json();
      expect(json.data).toHaveLength(1);
      expect(json.output_format).toBe("webp");
      expect(Buffer.from(json.data[0].b64_json, "base64").equals(Buffer.from(webp))).toBe(true);
    });

    test("refuses a switched-off provider's image model instead of silently rerouting", async () => {
      // Given a ready Muse account and the Muse provider switched off.
      const { app, store, gateway } = fixture(async () => ({ text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }] }));
      await gateway.check(gateway.create("muse", "Muse", {}).id);
      gateway.setProviderEnabled("muse", false);
      // When asking for the muse-image model.
      const response = await post(app, store.apiKey, { model: "muse-image", prompt: "p" });
      // Then it fails clearly rather than running on Dots.
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("provider_disabled");
    });
  });

  describe("provider on/off", () => {
    const jsonHeaders = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const patchProvider = (app: ReturnType<typeof fixture>["app"], id: string, body: unknown) =>
      app.request(`http://localhost/api/providers/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });

    test("a disabled provider accepts no new jobs until it is switched back on", async () => {
      // Given a ready Dot account.
      const { gateway } = fixture();
      await gateway.check(gateway.create("dots", "Dot", {}).id);
      // When the operator switches Dots off.
      gateway.setProviderEnabled("dots", false);
      // Then a Dots job is refused with a clear reason.
      expect(() => gateway.submit({ provider: "dots", prompt: "x" })).toThrow(GatewayError);
      expect(() => gateway.submit({ provider: "dots", prompt: "x" })).toThrow(/switched off/);
      // When switched back on, the same request runs.
      gateway.setProviderEnabled("dots", true);
      const job = gateway.submit({ provider: "dots", prompt: "x" });
      expect((await gateway.wait(job.id)).status).toBe("completed");
    });

    test("lists every provider with its switch and updates it over HTTP", async () => {
      const { app } = fixture();
      const listed = await (await app.request("http://localhost/api/providers", { headers: { "sec-fetch-site": "same-origin" } })).json();
      expect(listed.providers.map((p: { id: string; enabled: boolean }) => [p.id, p.enabled])).toEqual([["dots", true], ["muse", true]]);
      // When the operator switches Muse off over HTTP.
      const patched = await patchProvider(app, "muse", { enabled: false });
      expect(patched.status).toBe(200);
      expect((await patched.json()).provider.enabled).toBe(false);
      // Then the listing reflects it.
      const after = await (await app.request("http://localhost/api/providers", { headers: { "sec-fetch-site": "same-origin" } })).json();
      expect(after.providers.find((p: { id: string }) => p.id === "muse").enabled).toBe(false);
    });

    test("rejects an unknown provider id", async () => {
      const { app } = fixture();
      expect((await patchProvider(app, "bogus", { enabled: false })).status).toBe(400);
    });
  });

  describe("account context switch", () => {
    const jsonHeaders = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const patchAccount = (app: ReturnType<typeof fixture>["app"], id: string, body: unknown) =>
      app.request(`http://localhost/api/accounts/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
    const accounts = async (app: ReturnType<typeof fixture>["app"]): Promise<{ id: string; keepContext: boolean }[]> =>
      (await (await app.request("http://localhost/api/accounts", { headers: { "sec-fetch-site": "same-origin" } })).json()).accounts;

    test("keeps context by default and follows the console switch", async () => {
      // Given a freshly connected account, the console reads the switch as on.
      const { app, gateway } = fixture();
      const id = gateway.create("dots", "Switch", {}).id;
      expect((await accounts(app)).find((account) => account.id === id)?.keepContext).toBe(true);
      // When the operator switches it off.
      const response = await patchAccount(app, id, { keepContext: false });
      // Then the account is saved off and the listing reflects it.
      expect(response.status).toBe(200);
      expect((await response.json()).account.keepContext).toBe(false);
      expect((await accounts(app)).find((account) => account.id === id)?.keepContext).toBe(false);
    });

    test("rejects a context switch that is not a boolean", async () => {
      const { app, gateway } = fixture();
      const id = gateway.create("dots", "Switch", {}).id;
      expect((await patchAccount(app, id, { keepContext: "off" })).status).toBe(400);
    });
  });

  describe("job images", () => {
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
    const submit = async (app: ReturnType<typeof fixture>["app"], key: string) => {
      const response = await app.request("http://localhost/api/jobs", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ provider: "dots", prompt: "draw" }),
      });
      return (await response.json()).job.id as string;
    };
    const get = (app: ReturnType<typeof fixture>["app"], key: string, path: string) =>
      app.request(`http://localhost${path}`, { headers: { authorization: `Bearer ${key}` } });

    test("stores a remote image and serves it by its detected type", async () => {
      // Given a remote result that carries one image plus a bogus non-image attachment.
      const { app, store, gateway } = fixture(async () => ({
        text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }, { mime: "image/png", data: new TextEncoder().encode("<script>x</script>") }],
      }));
      await gateway.check(gateway.create("dots", "Images", {}).id);
      // When the job finishes.
      const id = await submit(app, store.apiKey);
      const job = await gateway.wait(id as never);
      // Then only the real image is recorded, with a note about the one that was dropped.
      expect(job.images).toEqual([{ mime: "image/png", bytes: png.byteLength, width: 1, height: 1 }]);
      expect(job.output).toContain("1 image(s) were not stored");
      const response = await get(app, store.apiKey, `/api/jobs/${id}/images/0`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    });

    test("answers 404 for a missing image or job and requires the API key", async () => {
      // Given a finished job without images.
      const { app, store, gateway } = fixture();
      await gateway.check(gateway.create("dots", "None", {}).id);
      const id = await submit(app, store.apiKey);
      await gateway.wait(id as never);
      // When asking for images that do not exist, then 404; without credentials, 401.
      expect((await get(app, store.apiKey, `/api/jobs/${id}/images/0`)).status).toBe(404);
      expect((await get(app, store.apiKey, `/api/jobs/${crypto.randomUUID()}/images/0`)).status).toBe(404);
      expect((await get(app, store.apiKey, `/api/jobs/${id}/images/-1`)).status).toBe(400);
      expect((await app.request(`http://localhost/api/jobs/${id}/images/0`)).status).toBe(401);
    });

    test("reads job records saved before images existed as having none", () => {
      // Given a job saved without any images field, as older databases hold it.
      const { store } = fixture();
      const legacy = { id: crypto.randomUUID(), accountId: crypto.randomUUID(), provider: "dots", prompt: "old", status: "completed", output: "x", error: null, remoteId: null, createdAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z" };
      store.db.query("INSERT INTO jobs VALUES (?, ?, ?)").run(legacy.id, legacy.accountId, JSON.stringify(legacy));
      // When read back, then it parses with an empty image list.
      expect(store.job(legacy.id as never)?.images).toEqual([]);
    });

    test("writes images with the extension of their detected format", async () => {
      // Given a job that produced a PNG.
      const { dir, gateway } = fixture(async () => ({ text: "done", remoteId: "r", images: [{ mime: "image/png", data: png }] }));
      const account = gateway.create("dots", "Ext", {});
      await gateway.check(account.id);
      const job = gateway.submit({ accountId: account.id, prompt: "draw" });
      await gateway.wait(job.id);
      // When stored, then the file carries the detected extension.
      expect(existsSync(join(dir, "images", job.id, "0.png"))).toBe(true);
      expect(existsSync(join(dir, "images", job.id, "0"))).toBe(false);
    });

    test("renames a legacy extension-less image on open and still reads it", async () => {
      // Given a data directory holding an image saved without an extension.
      const dir = mkdtempSync(join(tmpdir(), "dots2api-ext-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const first = new Store(dir);
      const jobId = crypto.randomUUID();
      mkdirSync(join(dir, "images", jobId), { recursive: true });
      writeFileSync(join(dir, "images", jobId, "0"), png);
      first.db.query("INSERT INTO jobs VALUES (?, ?, ?)").run(jobId, crypto.randomUUID(), JSON.stringify({
        id: jobId, accountId: crypto.randomUUID(), provider: "dots", prompt: "p", status: "completed", output: "", error: null, remoteId: null,
        images: [{ mime: "image/png", bytes: png.byteLength }], createdAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
      }));
      first.close();
      // When the store opens again, then the file is renamed and the image still reads back.
      const store = new Store(dir);
      cleanups.push(() => store.close());
      expect(existsSync(join(dir, "images", jobId, "0.png"))).toBe(true);
      expect(existsSync(join(dir, "images", jobId, "0"))).toBe(false);
      expect(store.image(jobId as never, 0)?.mime).toBe("image/png");
    });
  });
  test("returns a job correlation header when remote completion is uncertain", async () => {
    // Given an authenticated account with a disconnect after submission.
    const { app, store, gateway } = fixture(async () => {
      throw new GatewayError("disconnected", "Remote result is unknown.", 502, true);
    });
    const account = gateway.create("dots", "Uncertain HTTP", {});
    await gateway.check(account.id);
    // When Chat Completions reports the upstream failure.
    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { authorization: `Bearer ${store.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "hello" }] }),
    });
    // Then the client can retrieve that exact job rather than repeating its prompt.
    expect(response.status).toBe(502);
    const id = jobIdSchema.parse(response.headers.get("x-dots2api-job-id"));
    expect(store.job(id)?.status).toBe("unknown");
  });
});
