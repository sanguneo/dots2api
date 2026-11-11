import { GatewayError, jobIdSchema } from "./contracts";
import type { Account, AccountId, Credentials, Job, JobId, ProviderAdapter, ProviderId, ProviderStatus, ReferenceImage } from "./contracts";
import { validateReferenceImages } from "./images";
import { Store } from "./store";
import type { MuseThread } from "./store";
import type { DotsAuth } from "./dots-auth";

/** Work one account may hold (running plus waiting) before submit refuses with 429 instead of growing without bound. */
const QUEUE_LIMIT = 20;

/** Muse image side chats are deleted after this much idle time; chat side chats opened with a topic key after the second. */
export const IMAGE_IDLE_MS = 600_000;
export const CHAT_IDLE_MS = 7 * 24 * 3_600_000;
export interface GatewayOptions {
  /** A clock the idle rules read, so tests can move time without sleeping. */
  readonly now?: () => number;
  readonly imageIdleMs?: number;
  readonly chatIdleMs?: number;
}
type SideChatKind = "image" | "chat";
interface SideChat { readonly kind: SideChatKind; readonly thread?: string }

export class Gateway {
  private readonly busy = new Set<AccountId>();
  private readonly tasks = new Map<JobId, Promise<Job>>();
  private readonly listeners = new Set<() => void>();
  private readonly shutdown = new AbortController();
  private readonly leases = new Set<Promise<void>>();
  /** Interactive leases (login, check): work waits for these to be released instead of joining behind them. */
  private readonly leasesHeld = new Set<AccountId>();
  private readonly leaseWaiters = new Map<AccountId, (() => void)[]>();
  /** One serial chain per account, so a job submitted while the account is busy runs after the current one. */
  private readonly chains = new Map<AccountId, Promise<void>>();
  private readonly depths = new Map<AccountId, number>();
  private readonly now: () => number;
  private readonly imageIdleMs: number;
  private readonly chatIdleMs: number;
  private readonly sweeping = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    readonly store: Store,
    readonly adapters: Readonly<Record<ProviderId, ProviderAdapter>>,
    private readonly dotsAuth?: DotsAuth,
    options: GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.imageIdleMs = options.imageIdleMs ?? IMAGE_IDLE_MS;
    this.chatIdleMs = options.chatIdleMs ?? CHAT_IDLE_MS;
  }

  private async credentials(id: AccountId, signal: AbortSignal): Promise<Credentials> {
    if (this.account(id).provider !== "dots" || !this.dotsAuth) return this.store.credentials(id);
    return this.dotsAuth.refresh(id, {
      read: () => this.store.credentials(id),
      save: (credentials) => { this.store.saveAccount(this.account(id), credentials); },
    }, signal);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  /** Hold an account across an interactive login; only this lease may release it. */
  reserve(id: AccountId): () => void {
    if (this.shutdown.signal.aborted) throw new GatewayError("shutting_down", "Gateway is shutting down.", 503);
    if (this.account(id).busy) throw new GatewayError("account_busy", "An operation is still active.", 409);
    const done = Promise.withResolvers<void>();
    this.leases.add(done.promise);
    this.busy.add(id);
    this.leasesHeld.add(id);
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(id);
      this.leasesHeld.delete(id);
      this.leases.delete(done.promise);
      done.resolve();
      this.wakeLeaseWaiters(id);
      this.changed();
    };
  }
  stop(): void {
    clearInterval(this.sweepTimer);
    this.shutdown.abort();
    for (const id of [...this.leaseWaiters.keys()]) this.wakeLeaseWaiters(id);
  }
  private wakeLeaseWaiters(id: AccountId): void {
    const waiters = this.leaseWaiters.get(id);
    if (!waiters) return;
    this.leaseWaiters.delete(id);
    for (const wake of waiters) wake();
  }
  /** A job waits for a human-facing lease (login, check) to finish before it takes the account. */
  private async waitForLease(id: AccountId): Promise<void> {
    while (this.leasesHeld.has(id) && !this.shutdown.signal.aborted) {
      const wait = Promise.withResolvers<void>();
      this.leaseWaiters.set(id, [...(this.leaseWaiters.get(id) ?? []), wait.resolve]);
      await wait.promise;
    }
  }
  /** Jobs the account holds: the one running plus the ones waiting their turn. */
  private depth(id: AccountId): number { return this.depths.get(id) ?? 0; }
  private releaseDepth(id: AccountId): void {
    const next = this.depth(id) - 1;
    if (next > 0) this.depths.set(id, next); else this.depths.delete(id);
  }
  async drain(): Promise<void> { await Promise.all([...this.leases]); }
  accounts(): Account[] { return this.store.accounts().map((a) => ({ ...a, busy: this.busy.has(a.id) })); }
  /** Every registered provider with the operator's on/off switch applied. */
  providerStatuses(): ProviderStatus[] {
    const states = this.store.providerStates();
    return Object.values(this.adapters).map((adapter) => ({ ...adapter.info, enabled: states[adapter.info.id] }));
  }
  setProviderEnabled(id: ProviderId, enabled: boolean): void {
    this.store.setProviderEnabled(id, enabled);
    this.changed();
  }
  account(id: AccountId): Account {
    const account = this.store.account(id);
    if (!account) throw new GatewayError("account_not_found", "Account not found.", 404);
    return { ...account, busy: this.busy.has(id) };
  }
  create(provider: ProviderId, label: string, credentials: Credentials): Account {
    // Empty configuration can be saved as unconnected; validation occurs when connecting.
    const account = this.store.createAccount(provider, label, credentials);
    this.changed();
    return account;
  }
  update(id: AccountId, patch: { readonly label?: string; readonly enabled?: boolean; readonly keepContext?: boolean; readonly credentials?: Credentials }): Account {
    const account = this.account(id);
    if (account.busy) throw new GatewayError("account_busy", "Wait for the account's current operation.", 409);
    const previous = { ...this.store.credentials(id) };
    if (account.provider === "dots" && patch.credentials &&
      ("accessToken" in patch.credentials || "accountId" in patch.credentials)) {
      for (const key of ["refreshToken", "idToken", "expiresAt", "refreshState"]) delete previous[key];
      if ("accountId" in patch.credentials && !("accessToken" in patch.credentials)) delete previous["accessToken"];
    }
    // A thread the operator picks is theirs: it must not inherit the previous thread's "gateway created this" mark or its
    // image count, or the adapter would skip its identity gate, rotate away from it at once and archive it.
    if (account.provider === "dots" && patch.credentials && "threadId" in patch.credentials &&
      patch.credentials["threadId"] !== previous["threadId"]) {
      for (const key of ["threadOrigin", "threadImageBytes"]) delete previous[key];
    }
    const updated = this.store.saveAccount({
      ...account, label: patch.label ?? account.label, enabled: patch.enabled ?? account.enabled,
      keepContext: patch.keepContext ?? account.keepContext,
      ...(patch.credentials ? { status: "unconnected", detail: "Credentials changed. Check connection again.", checkedAt: null } as const : {}),
    }, patch.credentials ? { ...previous, ...patch.credentials } : undefined);
    this.changed();
    return updated;
  }
  remove(id: AccountId): void {
    const account = this.account(id);
    if (account.busy) throw new GatewayError("account_busy", "An operation is still active.", 409);
    this.store.deleteAccount(id);
    this.changed();
  }
  async check(id: AccountId): Promise<Account> {
    const release = this.reserve(id);
    try { return await this.checkReserved(id); }
    finally { release(); }
  }
  /** Login coordinators call this while retaining their account lease. */
  async checkReserved(id: AccountId): Promise<Account> {
    const account = this.account(id);
    if (!account.busy) throw new GatewayError("account_not_reserved", "Connection check requires an account lease.", 409);
    try {
      const adapter = this.adapters[account.provider];
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = adapter.validate(await this.credentials(id, signal));
      const result = await adapter.check(credentials, {
        accountId: id, dataDir: this.store.dataDir, signal, keepContext: account.keepContext,
        // A check may repair credentials (for example a renewed browser session); persist them without touching status.
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(id), repaired); },
      });
      return this.store.saveAccount({
        ...account, status: "ready", detail: result.detail, checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      return this.store.saveAccount({
        ...account, status: "error", detail: publicError(error), checkedAt: new Date().toISOString(),
      });
    } finally {
      this.changed();
    }
  }
  /**
   * Automatic recovery after an uncertain failure: the provider re-verifies its own session (what the console's Check
   * button does) so a transient remote problem does not quarantine the account until a human notices. Only adapters
   * that declare `reconnect` participate, and a recovery that fails leaves the account in error exactly as before.
   */
  private async autoReconnect(id: AccountId): Promise<Account | null> {
    const adapter = this.adapters[this.account(id).provider];
    if (!adapter.reconnect) return null;
    try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = adapter.validate(await this.credentials(id, signal));
      const result = await adapter.reconnect(credentials, {
        accountId: id, dataDir: this.store.dataDir, signal, keepContext: this.account(id).keepContext,
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(id), repaired); },
      });
      return this.store.saveAccount({
        ...this.account(id), status: "ready",
        detail: `Connection re-verified automatically after an unconfirmed job. ${result.detail}`,
        checkedAt: new Date().toISOString(),
      });
    } catch {
      // The caller's quarantine is the honest outcome when the session cannot be re-verified.
      return null;
    }
  }
  /** Runs account maintenance in the account's own serial order, so it never overlaps a job on the same browser profile. */
  private enqueueMaintenance<T>(id: AccountId, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const task = previous.then(async () => {
      await this.waitForLease(id);
      const done = Promise.withResolvers<void>();
      this.leases.add(done.promise);
      this.busy.add(id);
      this.changed();
      try { return await work(); }
      finally {
        this.busy.delete(id);
        this.leases.delete(done.promise);
        done.resolve();
        this.changed();
      }
    });
    const chained = task.then(() => undefined, () => undefined);
    this.chains.set(id, chained);
    void chained.then(() => { if (this.chains.get(id) === chained) this.chains.delete(id); });
    return task;
  }
  private due(thread: MuseThread, now: number): boolean {
    return now - thread.lastUsedAt >= (thread.kind === "image" ? this.imageIdleMs : this.chatIdleMs);
  }
  /**
   * Deletes the Muse side chats that sat idle past their limit and returns how many were deleted. Only threads in the
   * gateway's own map are ever touched, and a chat that cannot be deleted stays in the map for the next sweep.
   */
  async sweepThreads(): Promise<number> {
    const due = this.store.museThreads().filter((thread) => this.due(thread, this.now()));
    const outcomes = await Promise.all(due.map((thread) => {
      const id = [thread.accountId, thread.kind, thread.key].join("\0");
      if (this.sweeping.has(id)) return false;
      this.sweeping.add(id);
      return this.deleteIdleThread(thread).finally(() => this.sweeping.delete(id));
    }));
    return outcomes.filter(Boolean).length;
  }
  private deleteIdleThread(thread: MuseThread): Promise<boolean> {
    return this.enqueueMaintenance(thread.accountId, async () => {
      // A request that renewed the chat while this waited in line wins.
      const current = this.store.museThread(thread.accountId, thread.kind, thread.key);
      const account = this.store.account(thread.accountId);
      const adapter = account ? this.adapters[account.provider] : undefined;
      if (!current || !this.due(current, this.now()) || !account || !adapter?.deleteThread) return false;
      if (!account.enabled || account.status !== "ready" || this.shutdown.signal.aborted) return false;
      const label = `kind=${thread.kind} account=${account.id.slice(0, 8)} thread=${current.threadId}`;
      try {
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120_000)]);
        const credentials = adapter.validate(await this.credentials(account.id, signal));
        const outcome = await adapter.deleteThread(credentials, current.threadId, {
          accountId: account.id, dataDir: this.store.dataDir, signal,
          saveCredentials: (repaired) => { this.store.saveAccount(this.account(account.id), repaired); },
        });
        if (outcome === "failed") {
          console.warn(`[muse-threads] delete failed, will retry ${label}`);
          return false;
        }
        this.store.deleteMuseThread(thread.accountId, thread.kind, thread.key);
        console.log(`[muse-threads] ${outcome === "gone" ? "already gone" : "deleted"} ${label}`);
        return outcome === "deleted";
      } catch {
        console.warn(`[muse-threads] delete failed, will retry ${label}`);
        return false;
      }
    });
  }
  /** Runs the idle sweep on a timer until stop(). */
  startSweeper(intervalMs = 30_000): void {
    clearInterval(this.sweepTimer);
    this.sweepTimer = setInterval(() => { void this.sweepThreads().catch(() => undefined); }, intervalMs);
    this.sweepTimer.unref();
  }
  /**
   * Startup self-heal: an account left in error (for example by a restart that interrupted its job) is re-checked the way
   * the console's Check button does, so it rejoins the rotation if its session still answers. Returns how many recovered.
   */
  async recheckErroredAccounts(): Promise<number> {
    let recovered = 0;
    for (const account of this.store.accounts().filter((a) => a.status === "error")) {
      if (this.shutdown.signal.aborted) break;
      try { if ((await this.check(account.id)).status === "ready") recovered++; }
      catch { /* a busy account is skipped; the console still offers Check */ }
    }
    return recovered;
  }
  /**
   * `kind` is set by the OpenAI-compatible routes only. It marks an API request: a Dots account that is already working
   * refuses it at once (provider_busy) so the caller can switch to Muse, and a Muse request gets the side-chat rules.
   * `thread` is the caller's topic key; it only means something to Muse.
   */
  submit(input: {
    readonly accountId?: AccountId; readonly provider?: ProviderId; readonly prompt: string;
    readonly referenceImages?: readonly ReferenceImage[]; readonly kind?: SideChatKind; readonly thread?: string;
  }): Job {
    if (input.referenceImages) validateReferenceImages(input.referenceImages);
    // A snapshot, so a queued job still sends the bytes the caller submitted even if the caller's buffer is reused.
    const referenceImages = input.referenceImages?.map((image) => ({ mime: image.mime, data: new Uint8Array(image.data) }));
    const candidates = this.accounts()
      .filter((a) => a.provider === input.provider && a.enabled && a.status === "ready" && !this.leasesHeld.has(a.id));
    if (input.kind && !input.accountId && input.provider === "dots" && candidates.length > 0 &&
      candidates.every((a) => a.busy || this.depth(a.id) > 0)) {
      throw new GatewayError("provider_busy", `Dots is busy with another job. Try ${input.kind === "image" ? "muse-image" : "muse-agent"} instead, or retry later.`, 409);
    }
    // A topic key goes back to the account that already holds its side chat.
    const keyed = input.thread && input.kind && input.provider === "muse"
      ? candidates.find((a) => this.store.museThread(a.id, input.kind!, input.thread!)) : undefined;
    const account = input.accountId
      ? this.account(input.accountId)
      : keyed ?? candidates.filter((a) => !a.busy).sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""))[0]
        // Every candidate is busy: join the shortest queue instead of refusing the work.
        ?? candidates.sort((a, b) => this.depth(a.id) - this.depth(b.id) || (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""))[0];
    if (!account) throw new GatewayError("no_account", "No connected account is available for this provider.", 503);
    if (input.provider && account.provider !== input.provider) throw new GatewayError("provider_mismatch", "Account and provider do not match.");
    if (!this.store.providerEnabled(account.provider)) throw new GatewayError("provider_disabled", `${account.provider} is switched off in the console; no new jobs are routed to it.`, 503);
    if (!account.enabled || account.status !== "ready") throw new GatewayError("account_not_ready", "Enable and check this account before submitting work.", 409);
    // A login or connection check owns the account: queuing behind it would run work on a session being rewritten.
    if (this.leasesHeld.has(account.id)) throw new GatewayError("account_busy", "This account is being connected or checked. Try again when it is free.", 409);
    if (this.depth(account.id) >= QUEUE_LIMIT) throw new GatewayError("queue_full", `This account already has ${QUEUE_LIMIT} jobs waiting.`, 429);
    this.adapters[account.provider].validate(this.store.credentials(account.id));
    const waiting = this.depth(account.id) > 0;
    const job: Job = {
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: account.provider,
      prompt: input.prompt, status: waiting ? "queued" : "running", output: "", error: null, remoteId: null, images: [],
      createdAt: new Date().toISOString(), finishedAt: null,
    };
    this.store.saveAccount({ ...account, lastUsedAt: job.createdAt });
    this.store.saveJob(job);
    this.depths.set(account.id, this.depth(account.id) + 1);
    const previous = this.chains.get(account.id) ?? Promise.resolve();
    const side = input.kind ? { kind: input.kind, ...(input.thread ? { thread: input.thread } : {}) } : undefined;
    const task = previous.then(() => this.startJob(job, referenceImages, side));
    const chained = task.then(() => undefined, () => undefined);
    this.chains.set(account.id, chained);
    // The promise a caller waits on covers the queued time as well as the run.
    this.tasks.set(job.id, task);
    void chained.then(() => {
      this.tasks.delete(job.id);
      if (this.chains.get(account.id) === chained) this.chains.delete(account.id);
    });
    this.changed();
    return job;
  }
  /**
   * Runs one job when its turn on the account comes. The account is marked busy only while the job actually runs, so the
   * console keeps offering Check between queued jobs, and a job whose turn arrives after a restart or a quarantine is
   * failed honestly instead of being sent to a session that is no longer trusted.
   */
  private async startJob(job: Job, referenceImages?: readonly ReferenceImage[], side?: SideChat): Promise<Job> {
    await this.waitForLease(job.accountId);
    try {
      const current = this.store.job(job.id) ?? job;
      if (this.shutdown.signal.aborted) return this.abandon(current, "The gateway stopped before this job started.");
      const account = this.store.account(job.accountId);
      if (!account || !account.enabled || account.status !== "ready") {
        return this.abandon(current, "The account was not ready when this job's turn came; submit it again.");
      }
      this.busy.add(job.accountId);
      // Registered as a lease so drain() waits for the run to be persisted before the process exits.
      const done = Promise.withResolvers<void>();
      this.leases.add(done.promise);
      try {
        // execute() re-saves this object when the provider accepts the work, so it must already read as running.
        const started = this.store.saveJob({ ...current, status: "running" });
        this.changed();
        return await this.execute(started, referenceImages, side);
      } finally {
        this.busy.delete(job.accountId);
        this.leases.delete(done.promise);
        done.resolve();
      }
    } finally {
      this.releaseDepth(job.accountId);
      this.changed();
    }
  }
  /** A job that never reached its provider: no remote work exists, so the account is not quarantined. */
  private abandon(job: Job, reason: string): Job {
    return this.store.saveJob({ ...job, status: "failed", error: reason, finishedAt: new Date().toISOString() });
  }
  async wait(id: JobId): Promise<Job> {
    const pending = this.tasks.get(id);
    if (pending) return pending;
    const job = this.store.job(id);
    if (!job) throw new GatewayError("job_not_found", "Job not found.", 404);
    return job;
  }
  private async execute(job: Job, referenceImages?: readonly ReferenceImage[], side?: SideChat): Promise<Job> {
    let remoteId: string | null = null;
    // Only Muse has side chats. A keyless request owns its chat: `job:<id>` can never match another request.
    const sideChat = job.provider === "muse" ? side : undefined;
    const key = sideChat ? sideChat.thread ?? `job:${job.id}` : undefined;
    const reuse = sideChat?.thread && key ? this.store.museThread(job.accountId, sideChat.kind, key) : null;
    try {
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(300_000)]);
      const credentials = this.adapters[job.provider].validate(await this.credentials(job.accountId, signal));
      const result = await this.adapters[job.provider].run(credentials, job.prompt, {
        accountId: job.accountId, dataDir: this.store.dataDir, signal,
        keepContext: this.store.account(job.accountId)?.keepContext ?? true,
        ...(referenceImages ? { referenceImages } : {}),
        ...(reuse ? { threadId: reuse.threadId } : {}),
        ...(sideChat ? { pruneAfter: sideChat.kind === "chat" && !sideChat.thread } : {}),
        saveCredentials: (repaired) => { this.store.saveAccount(this.account(job.accountId), repaired); },
        onAccepted: (id) => {
          remoteId = id;
          this.store.saveJob({ ...job, remoteId });
          this.changed();
        },
      });
      // The remote work is finished and its text is valid; a local storage problem must not turn it into a failure.
      let images: Job["images"] = [];
      let note = "";
      if (result.images?.length) {
        try {
          images = this.store.saveImages(job.id, result.images);
        } catch {
          note = "\n\n[dots2api] The remote agent produced images, but they could not be saved locally.";
        }
        if (images.length < result.images.length && !note) note = `\n\n[dots2api] ${result.images.length - images.length} image(s) were not stored (unsupported type or too large).`;
      }
      // Only a finished job's side chat is tracked: a failed or uncertain one keeps its chat, untouched, as before.
      // A keyless chat was already deleted by the worker; a failed deletion there leaves it for the operator.
      if (sideChat && key && result.remoteId && (sideChat.kind === "image" || sideChat.thread)) {
        this.store.saveMuseThread({ accountId: job.accountId, kind: sideChat.kind, key, threadId: result.remoteId, lastUsedAt: this.now() });
      }
      return this.store.saveJob({
        ...job, status: "completed", output: result.text + note, remoteId: result.remoteId, images, finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const uncertain = !(error instanceof GatewayError) || error.uncertain;
      if (uncertain || (error instanceof GatewayError && (error.status === 401 || error.status === 403))) {
        const account = this.store.account(job.accountId);
        // Re-verify a session we can no longer trust before quarantining: an account that answers its own check is
        // usable again, which is exactly the state a human would restore by hand.
        const recovered = account && uncertain ? await this.autoReconnect(job.accountId) : null;
        if (account && !recovered) this.store.saveAccount({
          ...account, status: "error",
          detail: uncertain
            ? "Remote work may still be active. Inspect it in the provider, then check this account before reuse."
            : "Provider authentication failed. Reconnect this account before reuse.",
        });
      }
      return this.store.saveJob({
        ...job, remoteId, status: uncertain ? "unknown" : "failed", error: publicError(error),
        finishedAt: new Date().toISOString(),
      });
    } finally { this.changed(); }
  }
}

export function publicError(error: unknown): string {
  // Only adapter-authored errors may reach clients. Raw upstream text can contain credentials.
  if (error instanceof GatewayError) return error.message;
  return "The operation could not be confirmed. Check the provider before retrying.";
}
