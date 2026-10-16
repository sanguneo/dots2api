import { expect, test } from "bun:test";
import { createMuseAdapter } from "../src/providers/muse";
import { mediaBytesInPage } from "../src/providers/muse/engine";
import { stderrTail, stopWorker, workerLines } from "../src/providers/muse/io";
import { accountIdSchema, GatewayError } from "../src/contracts";
import type { AdapterContext } from "../src/contracts";

const context: AdapterContext = { accountId: accountIdSchema.parse("44444444-4444-4444-8444-444444444444"), dataDir: "/unused", signal: new AbortController().signal };

test.each([false, true])("uncertain Muse failures never retry, acceptance event=%s", async (accepted) => {
  const operations: string[] = [];
  const adapter = createMuseAdapter("https://muse.ai", 1000, async (operation, _settings, _credentials, _prompt, ctx) => {
    operations.push(operation);
    if (accepted) ctx.onAccepted?.("first");
    throw new GatewayError("muse_uncertain", "Lost completion.", 502, true);
  });
  // Given an ambiguous remote submission, when it fails, then no reconnect or second submission occurs.
  await expect(adapter.run({}, "work", context)).rejects.toMatchObject({ uncertain: true });
  expect(operations).toEqual(["run"]);
});

test("safe pre-submission retry uses credentials repaired by its reconnect", async () => {
  const operations: string[] = [];
  const seen: string[] = [];
  const adapter = createMuseAdapter("https://muse.ai", 1000, async (operation, _settings, credentials, _prompt, ctx) => {
    operations.push(operation);
    if (operation === "check") {
      ctx.saveCredentials?.({ cookieHeader: "hatch_sess=renewed" });
      return { type: "checked", detail: "connected" };
    }
    seen.push(credentials["cookieHeader"] ?? "");
    if (seen.length === 1) throw new GatewayError("muse_auth", "Not assigned before submission.", 401);
    return { type: "completed", text: "done", remoteId: "second", images: [] };
  });
  // Given a definite pre-send failure, when reconnect repairs the cookie, then retry uses only the new value.
  await adapter.run({ cookieHeader: "hatch_sess=old" }, "work", context);
  expect(operations).toEqual(["run", "check", "run"]);
  expect(seen).toEqual(["hatch_sess=old", "hatch_sess=renewed"]);
});

test("worker lines reject overflow and cancel before parsing an unbounded frame", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("123456789")); },
    cancel() { cancelled = true; },
  });
  // Given a frame larger than an injected small budget, when consumed, then the source is cancelled.
  const consume = async () => { for await (const _line of workerLines(source, context.signal, 8)) { /* not reached */ } };
  await expect(consume()).rejects.toMatchObject({ code: "muse_worker", uncertain: true });
  expect(cancelled).toBe(true);
});

test("worker line budget is per line and handles UTF-8 split across chunks", async () => {
  const encoded = new TextEncoder().encode("한\nab\n");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, 1));
      controller.enqueue(encoded.subarray(1));
      controller.close();
    },
  });
  // Given split UTF-8 and several lines in one chunk, when consumed, then bytes and boundaries stay intact.
  const lines: string[] = [];
  for await (const line of workerLines(source, context.signal, 3)) lines.push(line);
  expect(lines).toEqual(["한", "ab"]);
});

test("stderr retains only a bounded raw-byte suffix", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("0123456789"));
      controller.enqueue(new TextEncoder().encode("abcdef"));
      controller.close();
    },
  });
  // Given diagnostics exceeding the retained tail, when drained, then only the last bytes remain.
  const tail = stderrTail(source, 4);
  await tail.done;
  await tail.close();
  expect(tail.text()).toBe("cdef");
});

test("worker cleanup escalates after a persistence exception and has a finite cutoff", async () => {
  const exited = Promise.withResolvers<number>();
  const sent: string[] = [];
  const scheduled = new Map<number, () => void>();
  const child = { exitCode: null, exited: exited.promise, kill(signal: "SIGTERM" | "SIGKILL") { sent.push(signal); } };
  const clock = (callback: () => void, ms: number) => { scheduled.set(ms, callback); return () => { scheduled.delete(ms); }; };
  let stopped = false;
  // Given a callback failure and a child ignoring graceful exit, when finally cleans up, escalation remains armed.
  try { throw new GatewayError("fixture_storage", "Persistence failed."); }
  catch {
    const stopping = stopWorker(child, clock).then(() => { stopped = true; });
    expect(sent).toEqual(["SIGTERM"]);
    scheduled.get(5_000)?.();
    expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    expect(stopped).toBe(false);
    scheduled.get(10_000)?.();
    await stopping;
  }
  expect(stopped).toBe(true);
  expect(scheduled.size).toBe(0);
});

test("worker cleanup cancels escalation only after exit is confirmed", async () => {
  const exited = Promise.withResolvers<number>();
  const scheduled = new Map<number, () => void>();
  const sent: string[] = [];
  const stopping = stopWorker({ exitCode: null, exited: exited.promise, kill(signal) { sent.push(signal); } },
    (callback, ms) => { scheduled.set(ms, callback); return () => { scheduled.delete(ms); }; });
  // Given a child that honors SIGTERM, when exit arrives, then force-kill is disarmed.
  exited.resolve(0);
  await stopping;
  expect(sent).toEqual(["SIGTERM"]);
  expect(scheduled.size).toBe(0);
});

test("headerless image overflow cancels its stream before blob/base64 allocation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); },
    cancel() { cancelled = true; },
  });
  // Given a body without Content-Length and a small remaining aggregate budget.
  globalThis.fetch = Object.assign(async () => new Response(stream), { preconnect: originalFetch.preconnect });
  try {
    // When a chunk crosses the limit, then the never-ending source is cancelled before encoding.
    expect(await mediaBytesInPage({ src: "https://fixture.invalid/image", limit: 8 })).toEqual({ ok: false, err: "media-too-large" });
    expect(cancelled).toBe(true);
  } finally { globalThis.fetch = originalFetch; }
});

if (process.platform === "linux") {
  test("force-kills a real Node worker that ignores graceful termination", async () => {
    // Given a real worker that has installed its SIGTERM handler before publishing readiness.
    const child = Bun.spawn(["node", "-e", "process.on('SIGTERM',()=>{}); process.stdout.write('READY\\n'); process.stdin.resume()"], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    const scheduled = new Map<number, () => void>();
    try {
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toBe("READY\n");
      // When cleanup reaches the grace deadline through a controlled scheduler.
      const stopping = stopWorker(child, (callback, ms) => { scheduled.set(ms, callback); return () => { scheduled.delete(ms); }; });
      scheduled.get(5_000)?.();
      await stopping;
      // Then the actual OS process has exited by SIGKILL, not merely a resolved mock promise.
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
    } finally { reader.releaseLock(); child.kill("SIGKILL"); }
  });
}
