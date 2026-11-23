import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, jobIdSchema } from "../src/contracts";
import type { JobApproval, MuseWatchContext, RunResult } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

const accountId = accountIdSchema.parse("32b0c35c-239b-4ab8-b004-c554d175f296");
const jobId = jobIdSchema.parse("39fc45d9-63f8-4a2b-aae4-fcba00e6f271");
const card = `
<div role="group" aria-label="Approval request for Browser" data-testid="hatch-inline-approval-card"
 data-hatch-inline-approval-shortcut-surface="true" data-hatch-approval-surface="chat">
 <p>Browser approval <a href="/thread/origin">Original side chat</a></p>
 <div><div><button data-hatch-approval-primary-action="true">이 작업에 대해 허용</button></div>
 <div class="contents"><button data-slot="button">항상 허용</button></div>
 <div class="contents"><button data-slot="button">거부</button></div></div>
</div>`;
const mountCard = `
  const mountCard = (onChoice) => {
    document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(card)});
    const root = document.querySelector('[data-testid="hatch-inline-approval-card"]');
    root['__reactProps$fixture'] = {children: {props: {approval: {approvalId: 'late-approval'}}}};
    for (const button of root.querySelectorAll('button')) button.onclick = async () => {
      await fetch('/choice', {method: 'POST', body: button.textContent}); root.remove(); onChoice();
    };
  };
`;
const chat = (content: string, script = "") => `
  <div role="log">${content}</div><textarea></textarea><script>${mountCard}${script}</script>
`;
const reply = (text: string) => `<div class="hatch-agent-bubble-bg">${text}</div>`;

test.each([
  { linked: true, known: true },
  { linked: false, known: true },
  { linked: true, known: false },
])("idle Muse approval resolves only explicit origins and captures results (%j)", async ({ linked, known }) => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-watch-"));
  const abort = new AbortController();
  const approval = Promise.withResolvers<{ threadId: string | null; prompt: JobApproval; choose: (choiceId: string) => Promise<boolean> }>();
  const result = Promise.withResolvers<{ threadId: string; result: RunResult }>();
  const rechecked = Promise.withResolvers<void>();
  const results: RunResult[] = [];
  const clicks: string[] = [];
  let choiceAt = 0;
  let withdrawals = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/session") return Response.json({ status: "assigned" });
      if (pathname === "/choice") {
        clicks.push(await request.text());
        choiceAt = Date.now();
        return new Response(null, { status: 204 });
      }
      let html: string;
      if (pathname === "/thread/origin") {
        const elapsed = choiceAt ? Date.now() - choiceAt : 0;
        html = chat(reply("Historical reply") + reply("Starting side work.") + (elapsed > 900 ? reply("The side work is finished.") : ""),
          choiceAt && elapsed <= 900 ? `setTimeout(() => document.querySelector('[role=log]').insertAdjacentHTML('beforeend', ${JSON.stringify(reply("The side work is finished."))}), ${900 - elapsed})` : "");
      } else if (pathname === "/thread/unrelated") {
        if (results.length) rechecked.resolve();
        html = chat(reply("Historical unrelated result"));
      } else if (pathname === "/" || pathname === "/thread/new") {
        html = chat("", choiceAt ? "" : "mountCard(() => {});");
        if (!linked) html = html.replace('<a href=\\"/thread/origin\\">Original side chat</a>', 'Original side chat');
      } else {
        return new Response(null, { status: 404 });
      }
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 12_000, 8_000);
  const context: MuseWatchContext = {
    accountId, dataDir, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    threads: [
      { threadId: "unrelated", jobId, output: "Historical unrelated result" },
      ...(known ? [{ threadId: "origin", jobId, output: "Starting side work." }] : []),
    ],
    onWatchApproval(threadId, prompt, choose) {
      approval.resolve({ threadId, prompt, choose });
      return () => { withdrawals++; };
    },
    onWatchResult(threadId, output) {
      results.push(output);
      result.resolve({ threadId, result: output });
    },
  };
  let watching: Promise<void> | undefined;
  try {
    expect(typeof adapter.watch).toBe("function");
    if (!adapter.watch) return;
    watching = adapter.watch({}, context);
    const wait = <T,>(promise: Promise<T>) => Promise.race([
      promise, watching?.then(() => { throw new Error("Watcher closed before producing the expected event."); }) ?? promise,
    ]);
    const prompt = await wait(approval.promise);
    expect(prompt.threadId).toBe(linked ? "origin" : null);
    expect(prompt.prompt.choices.map(({ label }) => label)).toEqual(["이 작업에 대해 허용", "항상 허용", "거부"]);
    expect(results).toEqual([]);
    expect(await prompt.choose("0")).toBe(true);
    expect(await prompt.choose("0")).toBe(false);
    expect(await wait(result.promise)).toMatchObject({ threadId: "origin", result: { text: "The side work is finished." } });
    await wait(rechecked.promise);
    expect(results).toHaveLength(1);
    expect(clicks).toEqual(["이 작업에 대해 허용"]);
    abort.abort();
    await watching;
    expect(withdrawals).toBe(1);
    expect(await adapter.check({}, { accountId, dataDir, signal: AbortSignal.timeout(10_000) })).toMatchObject({ detail: expect.stringContaining("Signed in") });
  } finally {
    abort.abort();
    await watching?.catch(() => undefined);
    await server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 35_000);

test("an intervening foreground turn does not consume a prior side task result", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-unconsumed-result-"));
  const abort = new AbortController();
  const received = Promise.withResolvers<RunResult>();
  let finished = false;
  const row = (id: string, text: string) => `<div data-message-id="${id}">${reply(text)}</div>`;
  const history = row("kickoff", "Starting old task.");
  const late = row("late-result", "Old task finished.");
  const current = row("current-result", "Current plain reply.");
  const user = '<div class="chat-user-bubble" data-message-id="current-user">Another request</div>';
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path === "/finished") { finished = true; return new Response(null, { status: 204 }); }
      return new Response(chat(path === "/thread/origin" ? history + (finished ? user + late + current : "") : "", `
        document.body.insertAdjacentHTML('beforeend','<button aria-label="Send">Send</button>');
        document.querySelector('button[aria-label=Send]').onclick = () => {
          const log = document.querySelector('[role=log]');
          log.insertAdjacentHTML('beforeend',${JSON.stringify(user)}+'<button aria-label="Stop">Stop</button>');
          setTimeout(() => {
            log.querySelector('button').remove();
            log.insertAdjacentHTML('beforeend',${JSON.stringify(late + current)});
            fetch('/finished');
          },80);
        };
      `), { headers: { "content-type": "text/html" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 10_000);
  let watching: Promise<void> | undefined;
  try {
    const context = { accountId, dataDir, signal: AbortSignal.timeout(20_000), threadId: "origin" };
    expect((await adapter.run({}, "Another request", context)).text).toBe("Current plain reply.");
    if (!adapter.watch) throw new Error("Missing Muse watcher");
    watching = adapter.watch({}, {
      accountId, dataDir, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      threads: [{ threadId: "origin", jobId, output: "Current plain reply." }],
      onWatchApproval: () => () => {},
      onWatchResult: (_id, result) => received.resolve(result),
    });
    const result = await Promise.race([received.promise, watching.then(() => { throw new Error("Missing unconsumed side task result"); })]);
    expect(result.text).toBe("Old task finished.");
  } finally {
    abort.abort();
    await watching?.catch(() => undefined);
    server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 25_000);

test("approval arriving during completion extraction is published before the foreground job ends", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-late-card-"));
  const clicks: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/session") return Response.json({ status: "assigned" });
      if (pathname === "/choice") {
        clicks.push(await request.text());
        return new Response(null, { status: 204 });
      }
      return new Response(chat("", `
        const log = document.querySelector('[role=log]');
        document.body.insertAdjacentHTML('beforeend', '<button aria-label="Send">Send</button>');
        const stop = '<button aria-label="Stop">Stop</button>';
        document.querySelector('button[aria-label=Send]').onclick = () => {
          history.pushState({}, '', '/thread/origin');
          log.innerHTML = '<div class="chat-user-bubble">Prompt</div>' + stop;
          setTimeout(() => {
            log.querySelector('button').remove();
            log.insertAdjacentHTML('beforeend', ${JSON.stringify(reply("Starting side work."))});
          }, 80);
          setTimeout(() => mountCard(() => {
            log.insertAdjacentHTML('beforeend', stop);
            setTimeout(() => {
              log.querySelector('button').remove();
              log.insertAdjacentHTML('beforeend', ${JSON.stringify(reply("Work completed."))});
            }, 400);
          }), 550);
        };
      `), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 8_000);
  try {
    const result = await adapter.run({}, "Prompt", {
      accountId, dataDir, signal: AbortSignal.timeout(15_000),
      onApproval(_approval, choose) {
        void choose("0");
        return () => {};
      },
    });
    expect(clicks).toEqual(["이 작업에 대해 허용"]);
    expect(result).toMatchObject({ remoteId: "origin", text: "Work completed." });
  } finally {
    await server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);

test("an interim reply with an active delegated task preserves a normally pruned conversation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-pending-task-"));
  const events: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/session") return Response.json({ status: "assigned" });
      if (pathname === "/prune") {
        events.push("pruned");
        return new Response(null, { status: 204 });
      }
      return new Response(chat("", `
        const log = document.querySelector('[role=log]');
        document.body.insertAdjacentHTML('beforeend', '<button aria-label="Send">Send</button>');
        document.querySelector('button[aria-label=Send]').onclick = () => {
          history.pushState({}, '', '/thread/origin');
          log.innerHTML = '<div class="chat-user-bubble">Prompt</div><button aria-label="Stop">Stop</button>';
          setTimeout(() => {
            log.querySelector('button').remove();
            log.insertAdjacentHTML('beforeend', ${JSON.stringify(reply("Starting side work."))} + '<button aria-label="Stop task">Stop task</button>');
          }, 120);
        };
        document.body.insertAdjacentHTML('beforeend', '<div data-testid="hatch-thread-row" aria-current="page"><button aria-label="More thread actions">More</button></div><button role="menuitem">Delete</button><div role="dialog">Delete side chat?<button>Delete</button></div>');
        document.querySelector('[role=dialog] button').onclick = () => {
          fetch('/prune');
          document.querySelector('[role=dialog]').remove();
        };
      `), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 8_000);
  try {
    const result = await adapter.run({}, "Prompt", {
      accountId, dataDir, pruneAfter: true, signal: AbortSignal.timeout(15_000),
    });
    expect(result).toMatchObject({ remoteId: "origin", pendingTask: true, text: "Starting side work." });
    expect(events).toEqual([]);
  } finally {
    await server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);
