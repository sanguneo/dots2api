import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the Node worker emits binary attachments before confirming completion", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../src/providers/muse/worker.ts", import.meta.url))],
    target: "node", packages: "external",
    plugins: [{ name: "offline-engine", setup(builder) {
      builder.onResolve({ filter: /^\.\/engine$/ }, () => ({ path: "engine", namespace: "fixture" }));
      builder.onLoad({ filter: /^engine$/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        export const createMuseAdapter = () => ({
          run: async () => ({
            text: "ready", remoteId: null,
            files: [{ name: "영상.mp4", mime: "video/mp4", data: new Uint8Array([0, 255, 10, 128]) }],
          }),
        });
      ` }));
    } }],
  });
  const output = build.outputs[0];
  if (!build.success || !output) throw new Error("Could not build the test worker");
  const worker = Bun.spawn(["node", "--input-type=module", "--eval", await output.text()], {
    cwd: root, env: process.env, timeout: 5000, stdout: "pipe", stderr: "pipe",
    stdin: new Blob([JSON.stringify({
      operation: "run", site: "https://example.invalid", chatTimeout: 1000, credentials: {},
      accountId: crypto.randomUUID(), dataDir: root, prompt: "offline fixture",
    })]),
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited,
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { type: "file", name: "영상.mp4", mime: "video/mp4", dataB64: "AP8KgA==" },
    { type: "completed", text: "ready", remoteId: null, images: [] },
  ]);
});
