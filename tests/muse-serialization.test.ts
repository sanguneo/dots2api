import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/contracts";
import { Gateway } from "../src/gateway";
import { Store } from "../src/store";

test("same-account brain chat stays queued until the worker releases its browser lane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dots2api-serialization-"));
  const store = new Store(dir);
  const workerStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const adapter: ProviderAdapter = {
    info: { id: "muse", name: "Fake Muse", description: "Local queue test", setupUrl: "https://example.org", fields: [],
      contextWindow: 1, contextBasis: "configured",
      capabilities: { nativeTools: false, usage: "unknown", execution: "remote-agent", chat: true } },
    validate: (credentials) => credentials,
    check: async () => ({ detail: "ready" }),
    run: async (_credentials, prompt) => {
      events.push(`start:${prompt}`);
      if (prompt === "worker") { workerStarted.resolve(); await release.promise; }
      events.push(`finish:${prompt}`);
      return { text: prompt, remoteId: prompt };
    },
  };
  const gateway = new Gateway(store, { muse: adapter, dots: { ...adapter, info: { ...adapter.info, id: "dots" } } });
  try {
    const account = gateway.create("muse", "Shared Muse", {});
    await gateway.check(account.id);
    const worker = gateway.submit({ provider: "muse", kind: "chat", thread: "w-task", prompt: "worker" });
    await workerStarted.promise;
    const brain = gateway.submit({ provider: "muse", kind: "chat", thread: "tg123", prompt: "brain" });
    expect(brain.accountId).toBe(worker.accountId);
    expect(brain.status).toBe("queued");
    expect(events).toEqual(["start:worker"]);
    release.resolve();
    expect((await gateway.wait(brain.id)).output).toBe("brain");
    await gateway.wait(worker.id);
    expect(events).toEqual(["start:worker", "finish:worker", "start:brain", "finish:brain"]);
  } finally {
    release.resolve();
    gateway.stop();
    await gateway.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
