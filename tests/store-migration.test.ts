import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function legacyDirectory(): { readonly dir: string; readonly rows: Record<string, { id: string }>; readonly jobs: Record<string, { id: string }> } {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, "bot2api.sqlite"), { create: true });
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, body TEXT NOT NULL, credentials TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('api_key', 'b2a_existing-key');
  `);
  const account = (provider: string) => ({
    id: crypto.randomUUID(), provider, label: provider, enabled: true, status: "ready", detail: "",
    createdAt: "2026-10-03T00:00:00.000Z", checkedAt: null, lastUsedAt: null, hasCredentials: false, busy: false,
  });
  const job = (provider: string, accountId: string) => ({
    id: crypto.randomUUID(), accountId, provider, prompt: "p", status: "completed", output: "o", error: null, remoteId: null,
    createdAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
  });
  const rows = { dots: account("dots"), muse: account("muse"), grok: account("grok") };
  for (const row of Object.values(rows)) db.query("INSERT INTO accounts VALUES (?, ?, ?)").run(row.id, JSON.stringify(row), "sealed");
  const jobs = { dots: job("dots", rows.dots.id), muse: job("muse", rows.muse.id), grok: job("grok", rows.grok.id) };
  for (const row of Object.values(jobs)) db.query("INSERT INTO jobs VALUES (?, ?, ?)").run(row.id, row.accountId, JSON.stringify(row));
  db.close();
  for (const row of Object.values(jobs)) {
    mkdirSync(join(dir, "images", row.id), { recursive: true });
    writeFileSync(join(dir, "images", row.id, "0"), "image");
  }
  mkdirSync(join(dir, "muse", rows.muse.id), { recursive: true });
  return { dir, rows, jobs };
}

test("adopts the old bot2api database, keeps its API key, and drops Grok data while keeping Muse and Dots", () => {
  // Given a data directory from before the rename with accounts, jobs, images and a browser profile of three providers.
  const { dir, jobs } = legacyDirectory();
  // When the current code opens it.
  const store = new Store(dir);
  cleanups.push(() => store.close());
  // Then only the Grok data is gone, under the new file name, with the same API key.
  expect(existsSync(join(dir, "dots2api.sqlite"))).toBe(true);
  expect(existsSync(join(dir, "bot2api.sqlite"))).toBe(false);
  expect(store.apiKey).toBe("b2a_existing-key");
  expect(store.accounts().map((account) => account.provider).sort()).toEqual(["dots", "muse"]);
  expect(String(store.job(jobs["dots"]!.id as never)?.id)).toBe(jobs["dots"]!.id);
  expect(String(store.job(jobs["muse"]!.id as never)?.id)).toBe(jobs["muse"]!.id);
  expect(store.job(jobs["grok"]!.id as never)).toBeNull();
  expect(existsSync(join(dir, "images", jobs["dots"]!.id))).toBe(true);
  expect(existsSync(join(dir, "images", jobs["muse"]!.id))).toBe(true);
  expect(existsSync(join(dir, "images", jobs["grok"]!.id))).toBe(false);
  expect(existsSync(join(dir, "muse"))).toBe(true);
});

test("does not overwrite an existing new database with an old one", () => {
  // Given both a new and a leftover old database.
  const dir = mkdtempSync(join(tmpdir(), "dots2api-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = new Store(dir);
  const key = fresh.apiKey;
  fresh.close();
  writeFileSync(join(dir, "bot2api.sqlite"), "not a database");
  // When opening again, then the new database is used and the old file is left alone.
  const store = new Store(dir);
  cleanups.push(() => store.close());
  expect(store.apiKey).toBe(key);
  expect(existsSync(join(dir, "bot2api.sqlite"))).toBe(true);
});

test("reads accounts saved with split chat and image flags as a single enabled flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new Store(dir);
  const ids = [false, true].map((chat, index) => {
    const id = seed.createAccount("dots", `split-${index}`, {}).id;
    const row = seed.db.query<{ body: string }, [string]>("SELECT body FROM accounts WHERE id=?").get(id);
    const { enabled: _enabled, ...rest } = JSON.parse(row?.body ?? "{}");
    seed.db.query("UPDATE accounts SET body=? WHERE id=?").run(JSON.stringify({ ...rest, chatEnabled: chat, imageEnabled: false }), id);
    return id;
  });
  seed.close();
  const store = new Store(dir);
  cleanups.push(() => store.close());
  expect(ids.map((id) => store.account(id as never)?.enabled)).toEqual([false, true]);
});

test("reads an account saved before the context switch as keeping context", () => {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const seed = new Store(dir);
  const id = seed.createAccount("dots", "legacy-context", {}).id;
  const row = seed.db.query<{ body: string }, [string]>("SELECT body FROM accounts WHERE id=?").get(id);
  const { keepContext: _keepContext, ...rest } = JSON.parse(row?.body ?? "{}");
  seed.db.query("UPDATE accounts SET body=? WHERE id=?").run(JSON.stringify(rest), id);
  seed.close();
  const store = new Store(dir);
  cleanups.push(() => store.close());
  expect(store.account(id as never)?.keepContext).toBe(true);
});
