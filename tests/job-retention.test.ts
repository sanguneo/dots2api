import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "../src/contracts";
import { Gateway, JOB_RETENTION_MS } from "../src/gateway";
import { Store } from "../src/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-retention-"));
  const opened = new Store(dir);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => opened.close());
  return opened;
}

function job(status: Job["status"], createdAt: string, finishedAt: string | null): Job {
  return {
    id: crypto.randomUUID(), accountId: crypto.randomUUID(), provider: "muse", prompt: "p", status, output: "o", error: null,
    remoteId: null, images: [], createdAt, finishedAt,
  } as unknown as Job;
}

test("deletes finished jobs and their images past the retention, keeping recent and unfinished ones", () => {
  // Given jobs on both sides of a cutoff, one old job with an image directory and one old job still running.
  const db = store();
  const now = Date.parse("2026-11-17T00:00:00.000Z");
  const old = db.saveJob(job("completed", "2026-11-13T00:00:00.000Z", "2026-11-13T00:01:00.000Z"));
  const oldFailedNoFinish = db.saveJob(job("failed", "2026-11-13T00:00:00.000Z", null));
  const recent = db.saveJob(job("completed", "2026-11-16T00:00:00.000Z", "2026-11-16T00:01:00.000Z"));
  const running = db.saveJob(job("running", "2026-11-10T00:00:00.000Z", null));
  mkdirSync(join(db.dataDir, "images", old.id), { recursive: true });
  writeFileSync(join(db.dataDir, "images", old.id, "0.png"), "image");
  // When the gateway prunes with the three-day retention at `now`.
  const gateway = new Gateway(db, {} as never, undefined, { now: () => now });
  const deleted = gateway.pruneJobs();
  // Then only the finished jobs older than three days are gone, with their images.
  expect(JOB_RETENTION_MS).toBe(3 * 24 * 3_600_000);
  expect(deleted).toBe(2);
  expect(db.job(old.id)).toBeNull();
  expect(db.job(oldFailedNoFinish.id)).toBeNull();
  expect(db.job(recent.id)?.id).toBe(recent.id);
  expect(db.job(running.id)?.id).toBe(running.id);
  expect(existsSync(join(db.dataDir, "images", old.id))).toBe(false);
});
