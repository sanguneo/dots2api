import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, jobIdSchema } from "../src/contracts";
import type { RunResult } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

const oldPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const newPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMCJzADxmBAHdI2kgAAAAAElFTkSuQmCC";
const fileT = "task-t.bin";
const fileU = "task-u.bin";
const bytesT = Uint8Array.of(0, 255, 1);
const bytesU = Uint8Array.of(0, 255, 2);
const downloads = new Map([[fileT, bytesT], [fileU, bytesU]]);
const startText = "Starting side work.";
const taskText = "Task T is complete.";
const row = (id: string, content: string) =>
  `<div data-message-item="true" data-message-role="assistant" data-message-id="${id}">${content}</div>`;
const bubble = (text: string) => `<div class="hatch-agent-bubble-bg">${text}</div>`;
const image = (id: string, presentation: string, png: string) =>
  row(id, `<div data-testid="hatch-chat-attachment-presentation-${presentation}"><img data-png="${png}" alt="Side-task image"></div>`);
const file = (name: string) =>
  `<div data-testid="hatch-chat-attachment-presentation-${name}"><button data-testid="hatch-chat-file-card-${name}" data-file="${name}"><span title="${name}">${name}</span></button></div>`;

function threadPage(content: string) {
  return `<!doctype html><main>${row("kickoff", bubble(startText))}${content}</main><textarea></textarea>
    <script type="module">
      const log = document.querySelector("main");
      for (const img of log.querySelectorAll("img[data-png]")) {
        img.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(img.dataset.png), c => c.charCodeAt(0))], { type: "image/png" }));
        await img.decode();
      }
      // Expose the transcript only once its initial images are decoded.
      log.setAttribute("role", "log");
      for (const card of log.querySelectorAll("[data-file]")) {
        card.onclick = () => {
          const panel = document.createElement("section");
          panel.innerHTML = '<button aria-label="More actions">More actions</button><button aria-label="Close">Close</button>';
          document.body.append(panel);
          panel.querySelector('[aria-label="Close"]').onclick = () => panel.remove();
          panel.querySelector('[aria-label="More actions"]').onclick = () => {
            const download = document.createElement("a");
            download.setAttribute("role", "menuitem");
            download.textContent = "Download";
            download.href = "/download/" + card.dataset.file;
            download.download = card.dataset.file;
            panel.append(download);
          };
        };
      }
    </script>`;
}

interface WatchFixture {
  showForVisits(content: string, visits: number): Promise<void>;
  waitForResult(matches: (result: RunResult) => boolean): Promise<RunResult>;
}

async function observeWatch(initial: string, exercise: (fixture: WatchFixture) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-watch-identity-"));
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(40_000);
  const baseline = Promise.withResolvers<void>();
  const results: RunResult[] = [];
  let phase = { content: initial, completed: 0, reportVisit(completed: number) { if (completed === 1) baseline.resolve(); } };
  let visited: typeof phase | undefined;
  let reportResult: (result: RunResult) => void = () => {};
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/session") return Response.json({ status: "assigned" });
        if (path === "/") {
          // Home navigation comes after the preceding thread visit's capture work, including downloads.
          const finished = visited;
          visited = undefined;
          if (finished) finished.reportVisit(++finished.completed);
          return new Response('<main role="log"></main><textarea></textarea>', { headers: { "content-type": "text/html" } });
        }
        if (path === "/thread/origin") {
          visited = phase;
          return new Response(threadPage(phase.content), { headers: { "content-type": "text/html" } });
        }
        const bytes = path.startsWith("/download/") && downloads.get(path.slice("/download/".length));
        if (bytes) return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
        return new Response(null, { status: 404 });
      },
    });
    let watching: Promise<void> | undefined;
    try {
      const adapter = createMuseAdapter(server.url.href, 10_000);
      if (!adapter.watch) throw new Error("Missing Muse watcher");
      watching = adapter.watch({}, {
        accountId: accountIdSchema.parse(crypto.randomUUID()),
        dataDir,
        signal: AbortSignal.any([abort.signal, deadline]),
        threads: [{ threadId: "origin", jobId: jobIdSchema.parse(crypto.randomUUID()), output: startText }],
        onWatchApproval: () => { throw new Error("Unexpected approval in watch fixture"); },
        onWatchResult: (_thread, result) => {
          results.push(result);
          reportResult(result);
        },
      });
      const wait = <T>(event: Promise<T>, milestone: string) => Promise.race([event, watching?.then(() => {
        throw new Error(`Muse watcher ended before ${milestone}${deadline.aborted ? " (fixture deadline)" : ""}`);
      }) ?? Promise.reject(new Error("Muse watcher not started"))]);
      await wait(baseline.promise, "baseline visit completed");
      await exercise({
        showForVisits(content, visits) {
          const observed = Promise.withResolvers<void>();
          phase = { content, completed: 0, reportVisit(completed) { if (completed === visits) observed.resolve(); } };
          return wait(observed.promise, `${visits} visits completed`);
        },
        waitForResult(matches) {
          const existing = results.find(matches);
          if (existing) return Promise.resolve(existing);
          const result = Promise.withResolvers<RunResult>();
          reportResult = value => { if (matches(value)) result.resolve(value); };
          return wait(result.promise, "expected result callback");
        },
      });
    } finally {
      abort.abort();
      try { await watching; } finally { await server.stop(true); }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
  return results;
}

test("watch does not replay a baseline image with identical bytes under a new row, presentation, and blob URL", async () => {
  const replay = image("row-B", "presentation-B", oldPng);
  const results = await observeWatch(image("row-A", "presentation-A", oldPng), async ({ showForVisits }) => {
    await showForVisits(replay, 3);
    await showForVisits(replay + image("row-C", "presentation-C", newPng), 1);
  });
  expect(results.flatMap(result => result.images ?? []).map(({ data }) => Buffer.from(data).toString("base64")))
    .toEqual([newPng]);
  expect(results).toHaveLength(1);
}, 75_000);

test("watch does not publish a file that mounts late under a baselined task", async () => {
  const historicalTask = row("task-T", bubble(taskText));
  const results = await observeWatch(historicalTask, async ({ showForVisits }) => {
    await showForVisits(row("task-T", bubble(taskText) + file(fileT)), 3);
  });
  expect(results.map(result => ({ text: result.text, files: result.files?.map(({ name }) => name) }))).toEqual([]);
}, 75_000);

test("watch publishes new task T once even if its file arrives later, and still delivers task U's file", async () => {
  const results = await observeWatch("", async ({ showForVisits, waitForResult }) => {
    await Promise.all([waitForResult(result => result.text === taskText), showForVisits(row("task-T", bubble(taskText)), 1)]);
    const lateT = row("task-T", bubble(taskText) + file(fileT));
    await showForVisits(lateT, 3);
    await showForVisits(lateT + row("task-U", file(fileU)), 1);
  });
  const delivered = results.flatMap(result => result.files ?? []);
  expect(delivered.find(({ name }) => name === fileU)?.data).toEqual(bytesU);
  expect(results.map(result => ({ text: result.text, files: (result.files ?? []).map(({ name }) => name) })))
    .toEqual([{ text: taskText, files: [] }, { text: "", files: [fileU] }]);
}, 75_000);

test("watch learns historical bytes that hydrate after baseline before their row is relabeled", async () => {
  const placeholder = row("row-A", '<div data-testid="hatch-chat-attachment-presentation-A"></div>');
  const relabeled = image("row-B", "B", oldPng);
  const lateFile = row("row-B", `<div data-testid="hatch-chat-attachment-presentation-B"><img data-png="${oldPng}" alt="Old image"></div>${file(fileT)}`);
  const results = await observeWatch(placeholder, async ({ showForVisits }) => {
    await showForVisits(image("row-A", "A", oldPng), 1);
    await showForVisits(relabeled, 3);
    await showForVisits(lateFile, 1);
    await showForVisits(lateFile + image("row-C", "C", newPng), 1);
  });
  expect(results.flatMap(result => result.images ?? []).map(({ data }) => Buffer.from(data).toString("base64")))
    .toEqual([newPng]);
  expect(results.flatMap(result => result.files ?? [])).toEqual([]);
  expect(results).toHaveLength(1);
}, 75_000);
