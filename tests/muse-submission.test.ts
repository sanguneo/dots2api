import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test.each([false, undefined])("lost click acknowledgement respects retryAccepted=%s before acceptance", async (retryAccepted) => {
  const dir = await mkdtemp(join(tmpdir(), "dots2api-submitted-"));
  const preload = fileURLToPath(new URL("./fixtures/muse-click-exception.mjs", import.meta.url));
  let submissions = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/session") return Response.json({ status: "assigned" });
    if (path === "/sent") { submissions++; return new Response("ok"); }
    return new Response(`<!doctype html><html><body>
      <textarea></textarea><button aria-label="Send">Send</button><main role="log"></main>
      <script>document.querySelector("button").onclick = () => {
        const record = new XMLHttpRequest(); record.open("POST", "/sent", false); record.send();
      };</script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    // A separate Bun starts with NODE_OPTIONS: the adapter's Node worker inherits startup environment.
    const driver = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/muse-submission-driver.ts", import.meta.url))], {
      env: { ...process.env, NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --import=${preload}` },
      stdin: new Blob([JSON.stringify({ site: `http://localhost:${server.port}`, dataDir: dir, retryAccepted })]),
      stdout: "pipe", stderr: "pipe",
    });
    const [result, stderr, code] = await Promise.all([new Response(driver.stdout).json(), new Response(driver.stderr).text(), driver.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(result.failure).toMatchObject({ code: "muse_uncertain", uncertain: true });
    expect(result.accepted).toEqual([]);
    expect(submissions).toBe(retryAccepted === false ? 1 : 2);
    expect(result.submitted).toBe(retryAccepted === false ? 1 : 2);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
