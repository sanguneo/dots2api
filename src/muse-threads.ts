import type { ThreadDeletion } from "./contracts";
import { CHAT_IDLE_MS, IMAGE_IDLE_MS } from "./gateway";
import type { Gateway, GatewayOptions } from "./gateway";
import type { MuseThread } from "./store";

export type DeletedMuseThread = MuseThread & { readonly status: ThreadDeletion };
export interface MuseThreadDeletion {
  readonly key: string;
  readonly threads: readonly DeletedMuseThread[];
}

/** Idle and explicit cleanup share the same account queue and remote deletion operation. */
export class MuseThreads {
  private readonly sweeping = new Set<string>();
  private readonly deleting = new Map<string, Promise<MuseThreadDeletion>>();
  constructor(
    private readonly gateway: Gateway,
    private readonly options: GatewayOptions,
    private readonly signal: AbortSignal,
  ) {}

  isDeleting(key: string): boolean { return this.deleting.has(key); }
  private due(thread: MuseThread): boolean {
    const idle = thread.kind === "image"
      ? this.options.imageIdleMs ?? IMAGE_IDLE_MS
      : this.options.chatIdleMs ?? CHAT_IDLE_MS;
    return (this.options.now ?? Date.now)() - thread.lastUsedAt >= idle;
  }

  async sweep(): Promise<number> {
    const due = this.gateway.store.museThreads().filter((thread) => this.due(thread));
    const outcomes = await Promise.all(due.map((thread) => {
      const id = [thread.accountId, thread.kind, thread.key].join("\0");
      if (this.sweeping.has(id)) return undefined;
      this.sweeping.add(id);
      return this.gateway.enqueueMaintenance(thread.accountId, () => this.remove(thread, true))
        .finally(() => this.sweeping.delete(id));
    }));
    return outcomes.filter((outcome) => outcome === "deleted").length;
  }

  deleteKey(key: string): Promise<MuseThreadDeletion> {
    const pending = this.deleting.get(key);
    if (pending) return pending;
    const known = this.gateway.store.museThreads().filter((thread) => thread.key === key);
    // Enqueue on every Muse account before yielding: a queued job may not have created its mapping yet.
    const tasks = this.gateway.store.accounts().filter((account) => account.provider === "muse")
      .map((account) => this.gateway.enqueueMaintenance(account.id, async () => {
        const current = this.gateway.store.museThreads().filter((thread) => thread.key === key);
        const threads = [...new Map([...known, ...current]
          .filter((thread) => thread.accountId === account.id)
          .map((thread) => [`${thread.kind}\0${thread.threadId}`, thread])).values()];
        const results: DeletedMuseThread[] = [];
        for (const thread of threads) {
          results.push({ ...thread, status: await this.remove(thread, false) ?? "gone" });
        }
        return results;
      }));
    const task = Promise.all(tasks).then((threads) => ({ key, threads: threads.flat() }))
      .finally(() => this.deleting.delete(key));
    this.deleting.set(key, task);
    return task;
  }

  private async remove(thread: MuseThread, idle: boolean): Promise<ThreadDeletion | undefined> {
    const { store, adapters } = this.gateway;
    const current = idle ? store.museThread(thread.accountId, thread.kind, thread.key) : thread;
    // A request that renewed the chat while an idle sweep waited in line wins.
    if (!current || (idle && !this.due(current))) return undefined;
    const account = store.account(thread.accountId);
    const adapter = account ? adapters[account.provider] : undefined;
    if (!account || !adapter?.deleteThread || !account.enabled || account.status !== "ready" || this.signal.aborted) return "failed";
    const label = `kind=${thread.kind} account=${account.id.slice(0, 8)} thread=${current.threadId}`;
    try {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]);
      const credentials = adapter.validate(await this.gateway.credentials(account.id, signal));
      const outcome = await adapter.deleteThread(credentials, current.threadId, {
        accountId: account.id, dataDir: store.dataDir, signal,
        saveCredentials: (repaired) => { store.saveAccount(this.gateway.account(account.id), repaired); },
      });
      if (outcome === "failed") {
        console.warn(`[muse-threads] delete failed, will retry ${label}`);
        return outcome;
      }
      if (store.museThread(thread.accountId, thread.kind, thread.key)?.threadId === current.threadId) {
        store.deleteMuseThread(thread.accountId, thread.kind, thread.key);
      }
      console.log(`[muse-threads] ${outcome === "gone" ? "already gone" : "deleted"} ${label}`);
      return outcome;
    } catch (error) { // Remote deletion boundary: retain the mapping for retry without exposing upstream secrets.
      console.warn(`[muse-threads] delete failed, will retry ${label}`);
      return "failed";
    }
  }
}
