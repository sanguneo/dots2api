import type { Database } from "bun:sqlite";
import { accountIdSchema } from "./contracts";
import type { AccountId } from "./contracts";

/** Every owned side chat stays discoverable until remote deletion succeeds. Only the current mapping is reopened. */
export interface MuseThread {
  readonly accountId: AccountId;
  readonly kind: "image" | "chat";
  readonly key: string;
  readonly threadId: string;
  readonly lastUsedAt: number;
}
type ThreadRow = { account_id: string; kind: "image" | "chat"; key: string; thread_id: string; last_used_at: number };
const museThread = (row: ThreadRow): MuseThread => ({
  accountId: accountIdSchema.parse(row.account_id), kind: row.kind, key: row.key, threadId: row.thread_id, lastUsedAt: row.last_used_at,
});

export class MuseThreadStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS muse_thread_cleanup (
      account_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, thread_id TEXT NOT NULL, last_used_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, kind, key, thread_id)
    )`);
  }
  all(): MuseThread[] {
    return this.db.query<ThreadRow, []>("SELECT * FROM muse_threads UNION ALL SELECT * FROM muse_thread_cleanup").all().map(museThread);
  }
  current(accountId: AccountId, kind: MuseThread["kind"], key: string): MuseThread | null {
    const row = this.db.query<ThreadRow, [string, string, string]>("SELECT * FROM muse_threads WHERE account_id=? AND kind=? AND key=?").get(accountId, kind, key);
    return row ? museThread(row) : null;
  }
  save(thread: MuseThread): void {
    this.db.transaction(() => {
      // Archive before overwriting, in the same commit: a crash must never orphan the previous remote chat.
      this.db.query(`INSERT OR IGNORE INTO muse_thread_cleanup
        SELECT * FROM muse_threads WHERE account_id=? AND kind=? AND key=? AND thread_id<>?`)
        .run(thread.accountId, thread.kind, thread.key, thread.threadId);
      // A previously retired id may become current again; keep one ownership record per remote chat.
      this.db.query("DELETE FROM muse_thread_cleanup WHERE account_id=? AND kind=? AND key=? AND thread_id=?")
        .run(thread.accountId, thread.kind, thread.key, thread.threadId);
      this.db.query(`INSERT INTO muse_threads VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, kind, key) DO UPDATE SET thread_id=excluded.thread_id, last_used_at=excluded.last_used_at`)
        .run(thread.accountId, thread.kind, thread.key, thread.threadId, thread.lastUsedAt);
    })();
  }
  remove(thread: MuseThread): void {
    this.db.transaction(() => {
      for (const table of ["muse_threads", "muse_thread_cleanup"] as const) {
        this.db.query(`DELETE FROM ${table} WHERE account_id=? AND kind=? AND key=? AND thread_id=?`)
          .run(thread.accountId, thread.kind, thread.key, thread.threadId);
      }
    })();
  }
  removeAccount(id: AccountId): void {
    this.db.query("DELETE FROM muse_threads WHERE account_id=?").run(id);
    this.db.query("DELETE FROM muse_thread_cleanup WHERE account_id=?").run(id);
  }
}
