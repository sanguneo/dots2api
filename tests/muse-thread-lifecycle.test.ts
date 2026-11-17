import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountIdSchema } from "../src/contracts";
import { createMuseAdapter } from "../src/providers/muse";

test.each([true, false])("submits keyed work once when the thread id arrives=%s", async (resolveId) => {
  const dir = await mkdtemp(join(tmpdir(), "dots2api-late-thread-"));
  const firstAcceptance = Promise.withResolvers<void>();
  const navigate = Promise.withResolvers<void>();
  const accepted: (string | null)[] = [];
  let submissions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/session") return Response.json({ status: "assigned" });
      if (path === "/thread-id") {
        submissions++;
        await navigate.promise;
        return new Response("late-created-thread");
      }
      return new Response(`<!doctype html><html><body>
        <textarea></textarea><button aria-label="Send">Send</button><main role="log"></main>
        <script>
          document.querySelector("button").onclick = async () => {
            document.querySelector("main").innerHTML =
              '<div class="chat-user-bubble">brief</div><button aria-label="Stop">Stop</button>';
            const id = await (await fetch("/thread-id")).text();
            history.replaceState(null, "", "/thread/" + id);
          };
        </script></body></html>`, { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const adapter = createMuseAdapter(`http://localhost:${server.port}`, 1_000);
    const context = {
      accountId: accountIdSchema.parse(crypto.randomUUID()), dataDir: dir,
      signal: new AbortController().signal,
      retryAccepted: false,
      onAccepted: (id: string | null) => {
        accepted.push(id);
        if (id === null) firstAcceptance.resolve();
      },
    };
    const running = adapter.run({ cookieHeader: "hatch_sess=fake" }, "brief", context);
    await firstAcceptance.promise;
    if (resolveId) navigate.resolve();
    await expect(running).rejects.toMatchObject({ code: "muse_uncertain", uncertain: true });
    expect(accepted).toEqual(resolveId ? [null, "late-created-thread"] : [null]);
    expect(submissions).toBe(1);
  } finally {
    navigate.resolve();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
