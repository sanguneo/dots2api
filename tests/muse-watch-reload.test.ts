import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema, jobIdSchema } from "../src/contracts";
import type { RunResult } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

test.each([false, true])("reloaded blob media is emitted once only when added after baseline (historical=%s)", async historical => {
  const dataDir = await mkdtemp(join(tmpdir(), "muse-reload-"));
  if (historical) {
    const profile = join(dataDir, "muse", "32b0c35c-239b-4ab8-b004-c554d175f296");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "watch-state.json"), JSON.stringify({
      approvals: {}, captures: { origin: { messages: ["old-row-1", "old-row-2"], sources: [], cards: 0, files: [], users: [] } },
    }));
  }
  const results: RunResult[] = [];
  let available = historical;
  let visits = 0;
  let observed = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path === "/image") return new Response(png, { headers: { "content-type": "image/png" } });
      if (path === "/observed") {
        if (++visits >= 3) observed.resolve();
        return new Response(null, { status: 204 });
      }
      if (path === "/") available = true;
      const media = path === "/thread/origin" && available;
      return new Response(`<div role="log">
        <div data-message-id="kickoff"><div class="hatch-agent-bubble-bg">Starting work.</div></div>
        ${media ? '<div data-testid="hatch-chat-attachment-presentation-stable"><img></div>' : ""}
        </div><textarea></textarea><script>
        ${media ? `fetch('/image').then(r => r.blob()).then(b => {
          const img=document.querySelector('img'); img.src=URL.createObjectURL(b);
          img.onload=()=>fetch('/observed');
        });` : ""}
        </script>`, { headers: { "content-type": "text/html" } });
    },
  });
  const adapter = createMuseAdapter(server.url.href, 10_000);
  try {
    for (let restart = 0; restart < 2; restart++) {
      const abort = new AbortController();
      visits = 0;
      observed = Promise.withResolvers<void>();
      if (!adapter.watch) throw new Error("Missing watcher");
      const watching = adapter.watch({}, {
        accountId: accountIdSchema.parse("32b0c35c-239b-4ab8-b004-c554d175f296"),
        dataDir, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(25_000)]),
        threads: [{ threadId: "origin", jobId: jobIdSchema.parse("39fc45d9-63f8-4a2b-aae4-fcba00e6f271"), output: "Starting work." }],
        onWatchApproval: () => () => {},
        onWatchResult: (_id, result) => { results.push(result); },
      });
      try {
        await Promise.race([observed.promise, watching.then(() => { throw new Error("Watcher ended before three page reloads"); })]);
      } finally {
        abort.abort();
        await watching;
      }
    }
    expect(results).toHaveLength(historical ? 0 : 1);
  } finally {
    await server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);
