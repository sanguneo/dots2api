import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobIdSchema } from "../src/contracts";
import { MuseFollowups } from "../src/muse-followups";
import { Store } from "../src/store";

test("receipts and presentation claims outlive jobs and database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-receipts-"));
  let store = new Store(dir);
  try {
    const account = store.createAccount("muse", "owner", {});
    let ledger = new MuseFollowups(store);
    expect(ledger.claim(account.id, "thread", "bytes-1", ["task-1"], 1000)).toBe("claimed");
    store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "muse",
      prompt: "", status: "completed", output: "Delivered result", error: null, remoteId: "thread",
      images: [], files: [], followup: { originJobId: null, deliveredAt: "2026-11-23T04:20:01Z", contentHash: "bytes-1" },
      createdAt: "2026-11-23T04:20:00Z", finishedAt: "2026-11-23T04:20:01Z",
    });
    expect(store.pruneJobs("9999")).toBe(1);
    store.close();
    store = new Store(dir);
    ledger = new MuseFollowups(store);
    expect(ledger.claim(account.id, "thread", "bytes-1", ["new-url"], 2000)).toBe("duplicate");
    expect(ledger.claim(account.id, "other-thread", "bytes-1", [], 2000)).toBe("duplicate");
    expect(ledger.claim(account.id, "thread", "changed-bytes", ["task-1"], 2000)).toBe("duplicate");
    expect(ledger.claim(account.id, "thread", "bytes-2", ["task-2"], 2000)).toBe("claimed");
    expect(ledger.claim(account.id, "other-thread", "bytes-3", [], 3000)).toBe("claimed");
    expect(ledger.claim(account.id, "third-thread", "bytes-4", [], 4000)).toBe("paused");
    store.close();
    store = new Store(dir);
    ledger = new MuseFollowups(store);
    expect(ledger.pausedUntil(account.id)).toBe(601000);
    expect(ledger.claim(account.id, "third-thread", "bytes-4", [], 601000)).toBe("claimed");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy delivered payload suppresses the final unacknowledged rollback duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "followup-migration-"));
  const store = new Store(dir);
  try {
    const account = store.createAccount("muse", "owner", {});
    for (const deliveredAt of ["2026-11-23T04:22:00Z", null]) store.saveJob({
      id: jobIdSchema.parse(crypto.randomUUID()), accountId: account.id, provider: "muse",
      prompt: "", status: "completed", output: "Old result", error: null, remoteId: "thread",
      images: [], files: [], followup: { originJobId: null, deliveredAt },
      createdAt: "2026-11-23T04:20:00Z", finishedAt: "2026-11-23T04:20:01Z",
    });
    new MuseFollowups(store);
    expect(store.jobs(-1).filter(job => job.followup?.deliveredAt === null)).toEqual([]);
    const hashes = store.jobs(-1).map(job => job.followup?.contentHash);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toMatch(/^[a-f0-9]{64}$/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
