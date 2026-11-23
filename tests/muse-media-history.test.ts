import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, jobIdSchema } from "../src/contracts";
import type { RunResult } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

const oldImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const newImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEJMCJzADxmBAHdI2kgAAAAAElFTkSuQmCC", "base64");

test.each(["rotated-url", "placeholder", "late-history", "late-row"])("a text reply excludes an old side-task image when history uses %s", async history => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-media-history-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path === "/old.png") return new Response(oldImage, { headers: { "content-type": "image/png" } });
      const presentation = '<div data-testid="hatch-chat-attachment-presentation-old"></div>';
      return new Response(`<!doctype html><html><body>
        <textarea></textarea><button aria-label="Send">Send</button><main role="log">
          ${history === "late-row" ? "" : `<div data-message-item="true" data-message-role="assistant" data-message-id="old-side-result">
            ${history === "late-history" ? "" : presentation}
          </div>`}
        </main><script>
          const old = document.querySelector('[data-message-id="old-side-result"]') ?? document.createElement('div');
          ${history === "rotated-url" ? `old.querySelector('div').innerHTML = '<img src="/old.png?token=before">';` : ""}
          document.querySelector('button').onclick = () => {
            document.querySelector('main').insertAdjacentHTML('beforeend',
              '<div class="chat-user-bubble">Hello</div><button aria-label="Stop">Stop</button>');
            setTimeout(() => {
              if (!old.isConnected) {
                old.dataset.messageId = 'old-side-result';
                document.querySelector('main').prepend(old);
              }
              old.innerHTML = ${JSON.stringify(presentation)};
              old.querySelector('div').innerHTML = '<img src="/old.png?token=after">';
              document.querySelector('button[aria-label=Stop]').remove();
              document.querySelector('main').insertAdjacentHTML('beforeend',
                '<div data-message-item="true" data-message-role="assistant" data-message-id="current"><div class="hatch-agent-bubble-bg">Plain reply.</div></div>');
            }, 80);
          };
        </script></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const adapter = createMuseAdapter(server.url.href, 10_000);
    const result = await adapter.run({}, "Hello", {
      accountId: accountIdSchema.parse(crypto.randomUUID()), dataDir, threadId: "origin",
      signal: AbortSignal.timeout(20_000),
    });
    expect(result.text).toBe("Plain reply.");
    expect(result.images).toBeUndefined();
  } finally { server.stop(true); await rm(dataDir, { recursive: true, force: true }); }
}, 25_000);

test("a side-task image is delivered once and never attached to the next text request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-side-image-once-"));
  const accountId = accountIdSchema.parse(crypto.randomUUID());
  const abort = new AbortController();
  const sideResult = Promise.withResolvers<RunResult>();
  let sideDone = false;
  let turn = 0;
  const historical = '<div data-message-id="kickoff"><div class="hatch-agent-bubble-bg">Starting side work.</div></div>';
  const sideText = '<div data-message-id="side-text"><div class="hatch-agent-bubble-bg">Side image ready.</div></div>';
  const image = '<div data-message-id="side-picture"><div data-testid="hatch-chat-attachment-presentation-side"><img src="/side.png?token=renewed"></div></div>';
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path === "/side.png") return new Response(oldImage, { headers: { "content-type": "image/png" } });
      if (path === "/submit") { turn++; return Response.json({ turn }); }
      // The old image is deliberately absent when the next foreground page hydrates.
      const content = path === "/thread/origin" ? (turn ? historical : "") + (sideDone ? sideText : "") : "";
      return new Response(`<!doctype html><html><body><textarea></textarea><button aria-label="Send">Send</button>
        <main role="log">${content}</main><script>
          const log = document.querySelector('main');
          ${sideDone && path === "/thread/origin" ? `setTimeout(() => {
            if (!window.submitted) log.insertAdjacentHTML('beforeend',${JSON.stringify(image)});
          },350);` : ""}
          document.querySelector('button').onclick = async () => {
            window.submitted = true;
            const { turn } = await (await fetch('/submit')).json();
            log.insertAdjacentHTML('beforeend','<div class="chat-user-bubble">Request '+turn+'</div><button aria-label="Stop">Stop</button>');
            setTimeout(() => {
              log.querySelector('button').remove();
              log.insertAdjacentHTML('beforeend',turn === 1
                ? ${JSON.stringify(historical)} + '<button aria-label="Stop task">Stop task</button>'
                : ${JSON.stringify(image)} + '<div data-message-id="plain"><div class="hatch-agent-bubble-bg">Just text.</div></div>');
            },80);
          };
        </script></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 10_000);
  let watching: Promise<void> | undefined;
  try {
    const context = { accountId, dataDir, threadId: "origin", signal: AbortSignal.timeout(25_000) };
    expect((await adapter.run({}, "Start side work", context)).pendingTask).toBe(true);
    sideDone = true;
    if (!adapter.watch) throw new Error("Missing Muse watcher");
    watching = adapter.watch({}, {
      accountId, dataDir, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      threads: [{ threadId: "origin", jobId: jobIdSchema.parse(crypto.randomUUID()), output: "Starting side work." }],
      onWatchApproval: () => () => {},
      onWatchResult: (_thread, result) => sideResult.resolve(result),
    });
    const result = await Promise.race([sideResult.promise, watching.then(() => { throw new Error("Missing side-task image"); })]);
    expect(result.text).toBe("Side image ready.");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.data).toEqual(new Uint8Array(oldImage));
    abort.abort();
    await watching;
    const next = await adapter.run({}, "Plain request", context);
    expect(next.text).toBe("Just text.");
    expect(next.images).toBeUndefined();
  } finally {
    abort.abort();
    await watching?.catch(() => undefined);
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 35_000);

test("a new current-turn image is returned while the old presentation is rerendered", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-media-current-"));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path.endsWith(".png")) return new Response(path === "/old.png" ? oldImage : newImage, { headers: { "content-type": "image/png" } });
      return new Response(`<!doctype html><html><body><textarea></textarea><button aria-label="Send">Send</button>
        <main role="log"><div data-message-id="old"><div data-testid="hatch-chat-attachment-presentation-old"><img src="/old.png?token=before"></div></div></main>
        <script>document.querySelector('button').onclick = () => {
          const log = document.querySelector('main');
          log.insertAdjacentHTML('beforeend','<div class="chat-user-bubble">Draw</div><button aria-label="Stop">Stop</button>');
          setTimeout(() => {
            document.querySelector('img').src='/old.png?token=after';
            log.querySelector('button').remove();
            log.insertAdjacentHTML('beforeend','<div data-message-id="new"><div class="hatch-agent-bubble-bg">New drawing.<div data-testid="hatch-chat-attachment-presentation-new"><img src="/new.png"></div></div></div>');
          },80);
        };</script></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const result = await createMuseAdapter(server.url.href, 10_000).run({}, "Draw", {
      accountId: accountIdSchema.parse(crypto.randomUUID()), dataDir, threadId: "origin",
      signal: AbortSignal.timeout(20_000),
    });
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.data).toEqual(new Uint8Array(newImage));
  } finally { server.stop(true); await rm(dataDir, { recursive: true, force: true }); }
}, 25_000);
