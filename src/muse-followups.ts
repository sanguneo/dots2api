import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountId, RunResult } from "./contracts";
import type { Store } from "./store";

const WINDOW_MS = 600_000;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export function followupMediaHashes(result: Pick<RunResult, "images" | "files">): readonly string[] {
  return [...(result.images ?? []), ...(result.files ?? [])].map(media => digest(media.data));
}

/** Provider URLs, DOM ordering and job IDs are deliberately absent from this receipt. */
export function followupContentHash(result: Pick<RunResult, "text" | "images" | "files">): string {
  return digest(JSON.stringify({
    text: result.text.trim(),
    images: (result.images ?? []).map(image => digest(image.data)).sort(),
    files: (result.files ?? []).map(file => digest(file.data)).sort(),
  }));
}

/** Receipts outlive job retention and are claimed before the next observation can publish. */
export class MuseFollowups {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS muse_followup_receipts (
        account_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(account_id, thread_id, kind, key)
      );
      CREATE TABLE IF NOT EXISTS muse_followup_limits (account_id TEXT PRIMARY KEY, paused_until INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS muse_followup_content ON muse_followup_receipts(account_id, key) WHERE kind='content';
    `);
    this.importLegacy();
  }

  pausedUntil(accountId: AccountId): number {
    return this.store.db.query<{ paused_until: number }, [string]>(
      "SELECT paused_until FROM muse_followup_limits WHERE account_id=?",
    ).get(accountId)?.paused_until ?? 0;
  }

  baseline(accountId: AccountId, threadId: string, hashes: readonly string[]): void {
    this.store.db.transaction(() => {
      const insert = this.store.db.query("INSERT OR IGNORE INTO muse_followup_receipts VALUES (?,?,?,?,?)");
      for (const hash of hashes) insert.run(accountId, threadId, "media", hash, 0);
    }).immediate();
  }

  claim(accountId: AccountId, threadId: string, hash: string, keys: readonly string[], now = Date.now(),
    mediaHashes: readonly string[] = []): "claimed" | "duplicate" | "paused" {
    const db = this.store.db;
    return db.transaction(() => {
      const seen = db.query("SELECT 1 FROM muse_followup_receipts WHERE account_id=? AND thread_id=? AND kind=? AND key=?");
      if (db.query("SELECT 1 FROM muse_followup_receipts WHERE account_id=? AND kind='content' AND key=?").get(accountId, hash) ||
        mediaHashes.some(key => db.query("SELECT 1 FROM muse_followup_receipts WHERE account_id=? AND kind='media' AND key=?").get(accountId, key)) ||
        keys.some(key => seen.get(accountId, threadId, "presentation", key))) return "duplicate";
      if (this.pausedUntil(accountId) > now) return "paused";
      const recent = db.query<{ created_at: number }, [string, number]>(
        "SELECT created_at FROM muse_followup_receipts WHERE account_id=? AND kind='content' AND created_at>? ORDER BY created_at",
      ).all(accountId, now - WINDOW_MS);
      if (recent.length >= 3) {
        db.query("INSERT INTO muse_followup_limits VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET paused_until=excluded.paused_until")
          .run(accountId, (recent[0]?.created_at ?? now) + WINDOW_MS);
        return "paused";
      }
      const insert = db.query("INSERT INTO muse_followup_receipts VALUES (?,?,?,?,?)");
      insert.run(accountId, threadId, "content", hash, now);
      for (const key of new Set(keys)) insert.run(accountId, threadId, "presentation", key, now);
      this.baseline(accountId, threadId, mediaHashes);
      return "claimed";
    }).immediate();
  }

  /** Seed PR #12 receipts, including the final unacknowledged duplicate left by rollback. */
  private importLegacy(): void {
    const db = this.store.db;
    const insert = db.query("INSERT OR IGNORE INTO muse_followup_receipts VALUES (?,?,?,?,?)");
    for (const job of this.store.jobs(-1).reverse()) {
      if (!job.followup || job.status !== "completed" || !job.remoteId) continue;
      const images = job.images.flatMap((_image, i) => {
        const image = this.store.image(job.id, i);
        return image ? [image] : [];
      });
      const result = {
        text: job.output, images,
        files: (job.files ?? []).map((file, i) => ({ ...file, data: readFileSync(join(this.store.dataDir, "files", job.id, String(i))) })),
      };
      this.baseline(job.accountId, job.remoteId, followupMediaHashes(result));
      if (job.followup.contentHash) continue;
      const hash = followupContentHash(result);
      db.transaction(() => {
        const recorded = insert.run(job.accountId, job.remoteId, "content", hash, Date.parse(job.createdAt)).changes;
        this.store.saveJob({
          ...job, followup: {
            ...job.followup,
            originJobId: job.followup?.originJobId ?? null,
            deliveredAt: job.followup?.deliveredAt ?? (recorded ? null : new Date().toISOString()),
            contentHash: hash,
          },
        });
      }).immediate();
    }
  }
}
