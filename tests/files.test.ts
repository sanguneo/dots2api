import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api";
import { jobIdSchema } from "../src/contracts";
import type { ProviderAdapter } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

const origin = "http://localhost:3010";
const clip = { name: "영상 [final].mp4", mime: "video/mp4", data: new Uint8Array([0, 255, 10, 128]) };
const inline = "Done.\n\n[[file name=\"old.txt\"]]\nlegacy text\n[[/file]]";
const fixture = (files: readonly (typeof clip)[] = [clip]) => {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-files-"));
  const store = new Store(dir);
  const adapter: ProviderAdapter = {
    info: { id: "dots", name: "Fake Dots", description: "", fields: [], setupUrl: "https://example.org",
      contextWindow: 1, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true } },
    validate: (credentials) => credentials,
    check: async () => ({ detail: "ready" }),
    run: async () => ({ text: inline, remoteId: null, files }),
  };
  const gateway = new Gateway(store, { dots: adapter, muse: { ...adapter, info: { ...adapter.info, id: "muse" } } });
  const account = gateway.create("dots", "File fixture", {});
  store.saveAccount({ ...account, status: "ready" });
  onTestFinished(async () => {
    gateway.stop();
    await gateway.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = createApi(gateway);
  const auth = { Authorization: `Bearer ${store.apiKey}` };
  return { api, auth, gateway, store };
};

test("a chat completion preserves inline file text and links to an authenticated binary download", async () => {
  const { api, auth, store } = fixture();
  const response = await api.request(`${origin}/v1/chat/completions`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dots-agent", messages: [{ role: "user", content: "file please" }] }),
  });
  expect(response.status).toBe(200);
  const id = jobIdSchema.parse(response.headers.get("X-Dots2api-Job-Id"));
  const url = `${origin}/api/jobs/${id}/files/0`;
  const result = await response.json();
  expect(result.choices[0].message.content).toBe(`${inline}\n\n[영상 \\[final\\].mp4](${url})`);
  const reopened = new Store(store.dataDir);
  try {
    expect(reopened.job(id)?.files).toEqual([{ name: clip.name, mime: clip.mime, bytes: 4 }]);
  } finally { reopened.close(); }
  expect((await api.request(url)).status).toBe(401);
  const download = await api.request(url, { headers: auth });
  expect(download.status).toBe(200);
  expect(download.headers.get("Content-Type")).toBe("video/mp4");
  expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;.*filename\*=UTF-8''%EC%98%81%EC%83%81%20%5Bfinal%5D\.mp4$/);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(clip.data);
  expect((await api.request(`${origin}/api/jobs/${id}/files/1`, { headers: auth })).status).toBe(404);
});

test("the store limits files by byte size and count, compacts indexes and prunes persisted bytes", async () => {
  const max = 50 * 1024 * 1024;
  const { api, auth, gateway, store } = fixture([
    { ...clip, name: "too-large.mp4", data: new Uint8Array(max + 1) },
    { ...clip, name: "max.mp4", data: new Uint8Array(max) },
    { ...clip, name: "second.mp4" }, { ...clip, name: "third.mp4" }, { ...clip, name: "fourth.mp4" },
  ]);
  const result = await gateway.wait(gateway.submit({ provider: "dots", prompt: "files" }).id);
  expect(result.status).toBe("completed");
  expect(result.files?.map(({ name, bytes }) => [name, bytes])).toEqual([
    ["max.mp4", max], ["second.mp4", 4], ["third.mp4", 4],
  ]);
  const fileDir = join(store.dataDir, "files", result.id);
  expect(existsSync(fileDir)).toBe(true);
  expect(store.pruneJobs("9999-01-01T00:00:00.000Z")).toBe(1);
  expect(existsSync(fileDir)).toBe(false);
  expect((await api.request(`${origin}/api/jobs/${result.id}/files/0`, { headers: auth })).status).toBe(404);
});

test("legacy job rows without a files field deserialize with empty metadata", () => {
  const { store } = fixture();
  const account = store.accounts()[0];
  if (!account) throw new Error("Expected a fixture account");
  const id = jobIdSchema.parse(crypto.randomUUID());
  store.saveJob({
    id, accountId: account.id, provider: "dots", status: "completed", output: "legacy",
    prompt: "legacy", error: null, remoteId: null, images: [],
    createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
  });
  expect(store.job(id)?.files).toEqual([]);
});
