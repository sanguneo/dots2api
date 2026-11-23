import { jobIdSchema } from "./contracts";
import { GatewayError } from "./contracts";
import type { AccountId, Job, MuseWatchContext, RunResult } from "./contracts";
import type { Gateway } from "./gateway";
import { followupContentHash, followupMediaHashes, MuseFollowups } from "./muse-followups";

/** Idle browser ownership is released before any foreground account operation acquires the profile. */
export class MuseEvents {
  private readonly watching = new Map<AccountId, { readonly abort: AbortController; readonly done: Promise<void> }>();
  private readonly decisions = new Map<AccountId, Set<Promise<void>>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  private readonly followups: MuseFollowups;
  constructor(private readonly gateway: Gateway) { this.followups = new MuseFollowups(gateway.store); }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), 3_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const watcher of this.watching.values()) watcher.abort.abort();
  }

  async pause(id: AccountId): Promise<void> {
    const watcher = this.watching.get(id);
    if (!watcher) return;
    // Keep the pinned card alive while its owner is deciding. New work queues behind the same decision budget.
    await Promise.all(this.decisions.get(id) ?? []);
    watcher.abort.abort();
    await watcher.done;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.watching.values()].map(watcher => watcher.done));
  }

  pending(): Job[] {
    return this.gateway.store.jobs(-1).filter(job => job.followup && !job.followup.deliveredAt &&
      (job.status !== "unknown" || job.output || job.error));
  }

  acknowledge(id: Job["id"]): boolean {
    const job = this.gateway.store.job(id);
    if (!job?.followup || !["completed", "failed", "unknown"].includes(job.status)) return false;
    this.gateway.store.saveJob({ ...job, followup: { ...job.followup, deliveredAt: new Date().toISOString() } });
    return true;
  }

  private tick(): void {
    if (this.stopped) return;
    for (const account of this.gateway.accounts()) {
      const adapter = this.gateway.adapters[account.provider];
      if (account.provider !== "muse" || !adapter.watch || !account.enabled || account.status !== "ready" ||
        !this.gateway.store.providerEnabled("muse") || account.busy || this.gateway.hasQueuedWork(account.id)) {
        if (!this.decisions.get(account.id)?.size) this.watching.get(account.id)?.abort.abort();
        continue;
      }
      if (this.watching.has(account.id)) continue;
      if (this.followups.pausedUntil(account.id) > Date.now()) continue;
      const abort = new AbortController();
      // Defer execution until the ownership record exists, even when an adapter fails synchronously.
      const done = Promise.resolve().then(async () => {
        const credentials = adapter.validate(await this.gateway.credentials(account.id, abort.signal));
        abort.signal.throwIfAborted();
        const latest = new Map<string, Job>();
        for (const job of [...this.gateway.store.jobs(-1)].reverse()) {
          if (job.accountId === account.id && job.remoteId && (!job.followup || job.status === "completed")) latest.set(job.remoteId, job);
        }
        const context: MuseWatchContext = {
          accountId: account.id, dataDir: this.gateway.store.dataDir, signal: abort.signal,
          threads: [...latest.values()].map(job => ({
            threadId: job.remoteId ?? "", jobId: job.followup?.originJobId ?? job.id, output: job.output,
          })),
          saveCredentials: repaired => { this.gateway.store.saveAccount(this.gateway.account(account.id), repaired); },
          onWatchBaseline: (threadId, hashes) => this.followups.baseline(account.id, threadId, hashes),
          onWatchApproval: (threadId, prompt, choose) => {
            const event = this.event(account.id, threadId);
            const withdrawn = Promise.withResolvers<void>();
            const decisions = this.decisions.get(account.id) ?? new Set<Promise<void>>();
            decisions.add(withdrawn.promise);
            this.decisions.set(account.id, decisions);
            const withdraw = this.gateway.openApproval(event, prompt, async choice => {
              const clicked = await choose(choice);
              if (clicked && threadId === null) {
                // An answered approval with no source is a delivered decision receipt, not an
                // invented running task. Independently discovered transcript results get their own event.
                const current = this.gateway.store.job(event.id) ?? event;
                this.gateway.store.saveJob({
                  ...current, status: "completed", approval: undefined, finishedAt: new Date().toISOString(),
                  followup: { originJobId: null, deliveredAt: new Date().toISOString() },
                });
              }
              return clicked;
            });
            return () => {
              withdraw();
              decisions.delete(withdrawn.promise);
              if (!decisions.size) this.decisions.delete(account.id);
              withdrawn.resolve();
            };
          },
          onWatchResult: (threadId, result) => this.result(account.id, threadId, result),
        };
        await adapter.watch?.(credentials, context);
      }).catch(error => {
        if (!abort.signal.aborted) {
          console.warn(`[muse-events] watcher failed account=${account.id}: ${error instanceof Error ? error.name : "unknown"}`);
          if (error instanceof GatewayError && error.code === "approval_timeout") {
            for (const event of this.pending().filter(job => job.accountId === account.id && ["running", "approval_required"].includes(job.status))) {
              this.gateway.store.saveJob({
                ...event, status: "failed", approval: undefined, errorCode: error.code,
                error: error.message, finishedAt: new Date().toISOString(),
              });
            }
          }
        }
      }).finally(() => {
        if (this.watching.get(account.id)?.abort === abort) this.watching.delete(account.id);
      });
      this.watching.set(account.id, { abort, done });
    }
  }

  private event(accountId: AccountId, threadId: string | null): Job {
    const jobs = this.gateway.store.jobs(-1);
    const active = jobs.find(job => job.accountId === accountId && job.remoteId === threadId && job.followup &&
      !job.followup.deliveredAt && ["running", "approval_required"].includes(job.status));
    if (active) return active;
    const originals = threadId ? jobs.filter(job => job.accountId === accountId && job.remoteId === threadId && !job.followup) : [];
    // A reused conversation can contain several unrelated side tasks. Its UUID alone cannot identify one request.
    const original = originals.length === 1 ? originals[0] : undefined;
    return this.gateway.store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId, provider: "muse", prompt: "",
      status: "running", output: "", error: null, remoteId: threadId, images: [], files: [],
      followup: { originJobId: original?.id ?? null, deliveredAt: null },
      createdAt: new Date().toISOString(), finishedAt: null,
    });
  }

  private result(accountId: AccountId, threadId: string, result: RunResult): void {
    if (result.deliveryId && this.gateway.store.jobs(-1).some(job => job.accountId === accountId &&
      job.remoteId === threadId && job.followup?.deliveryId === result.deliveryId)) return;
    const contentHash = followupContentHash(result);
    const claim = this.followups.claim(accountId, threadId, contentHash, result.followupKeys ?? [], Date.now(), followupMediaHashes(result));
    if (claim === "duplicate") return;
    if (claim === "paused") {
      console.warn(`[muse-events] follow-up rate limit; watcher paused account=${accountId} until=${new Date(this.followups.pausedUntil(accountId)).toISOString()}`);
      this.watching.get(accountId)?.abort.abort();
      return;
    }
    const event = this.event(accountId, threadId);
    const images = this.gateway.store.saveImages(event.id, result.images ?? []);
    const files = this.gateway.store.saveFiles(event.id, result.files ?? []);
    this.gateway.store.saveJob({
      ...event, status: "completed", approval: undefined, output: result.text,
      followup: { originJobId: event.followup?.originJobId ?? null, deliveredAt: null, contentHash, ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}) },
      remoteId: result.remoteId ?? threadId, images, files, finishedAt: new Date().toISOString(),
    });
    for (const original of this.gateway.store.jobs(-1)) {
      if (original.accountId === accountId && original.remoteId === threadId && original.pendingTask) {
        this.gateway.store.saveJob({ ...original, pendingTask: false });
      }
    }
  }
}
