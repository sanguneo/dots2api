import { GatewayError } from "../../contracts";

export const MAX_WORKER_LINE_BYTES = 64 * 1024 * 1024;
export const MAX_WORKER_STDERR_BYTES = 256 * 1024;

/** A protocol line is bounded before parsing; cancellation also interrupts a silent pipe. */
export async function* workerLines(stream: ReadableStream<Uint8Array>, signal: AbortSignal, limit = MAX_WORKER_LINE_BYTES): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new GatewayError("muse_cancelled", "Muse operation cancelled.", 409, true);
      if (chunk.done) break;
      // Split raw bytes so multiple small lines in a single chunk do not consume each other's budget.
      let start = 0;
      for (let end = 0; end < chunk.value.length; end++) {
        if (chunk.value[end] !== 10) continue;
        const part = chunk.value.subarray(start, end);
        bytes += part.byteLength;
        if (bytes > limit) throw new GatewayError("muse_worker", "Muse worker exceeded the protocol line budget.", 502, true);
        buffer += decoder.decode(part, { stream: true }) + decoder.decode();
        if (buffer) yield buffer;
        buffer = "";
        bytes = 0;
        start = end + 1;
      }
      const part = chunk.value.subarray(start);
      bytes += part.byteLength;
      if (bytes > limit) throw new GatewayError("muse_worker", "Muse worker exceeded the protocol line budget.", 502, true);
      buffer += decoder.decode(part, { stream: true });
    }
    if (bytes) throw new GatewayError("muse_worker", "Muse worker ended with an incomplete protocol line.", 502, true);
  } finally {
    signal.removeEventListener("abort", abort);
    // A pipe owned by the exited worker must not retain data after the consumer stops.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Retain only the raw-byte tail while continuously draining diagnostics. */
export function stderrTail(stream: ReadableStream<Uint8Array>, limit = MAX_WORKER_STDERR_BYTES) {
  const reader = stream.getReader();
  let tail = new Uint8Array(0);
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const suffix = value.subarray(Math.max(0, value.byteLength - limit));
        const keep = Math.min(tail.byteLength, limit - suffix.byteLength);
        const next = new Uint8Array(keep + suffix.byteLength);
        next.set(tail.subarray(tail.byteLength - keep));
        next.set(suffix, keep);
        tail = next;
      }
    } finally { reader.releaseLock(); }
  })();
  // Observe rejection immediately, including when the consumer is still processing stdout.
  const settled = done.catch(() => {});
  return {
    done: settled,
    text: () => new TextDecoder().decode(tail),
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reader.cancel().catch(() => {}), settled,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}

interface WorkerProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}
type Schedule = (callback: () => void, ms: number) => () => void;
const schedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** Every exceptional path keeps escalation armed until exit, with a final bounded cutoff. */
export function stopWorker(child: WorkerProcess, clock: Schedule = schedule): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let finished = false;
    const timers: (() => void)[] = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const cancel of timers) cancel();
      resolve();
    };
    timers.push(clock(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 5_000));
    timers.push(clock(finish, 10_000));
    void child.exited.then(finish, finish);
    child.kill("SIGTERM");
  });
}
