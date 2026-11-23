import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeExecutable } from "../src/providers/muse/node-runtime";

test("the resolved Muse Node runtime receives SIGTERM through a forking launcher", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Tests require Node on PATH");
  const probe = Bun.spawn([node, "-p", "process.execPath"], {
    env: process.env, stdout: "pipe", stderr: "inherit", timeout: 2_000,
  });
  const realNode = (await new Response(probe.stdout).text()).trim();
  expect(await probe.exited).toBe(0);
  const dir = await mkdtemp(join(tmpdir(), "muse-node-runtime-"));
  try {
    const launcher = join(dir, "node");
    const quotedNode = `'${realNode.replaceAll("'", "'\\''")}'`;
    // Like Volta on Linux, wait for a separate Node process without forwarding TERM.
    await writeFile(launcher, `#!/bin/sh\n${quotedNode} "$@" &\nwait "$!"\n`, { mode: 0o700 });
    const resolved = await nodeExecutable(launcher);
    const worker = Bun.spawn([resolved, "--eval", `
      const expiry = setTimeout(() => process.exit(0), 1_500);
      process.on("SIGTERM", () => {
        clearTimeout(expiry);
        process.stdout.write("HANDLED\\n", () => process.exit(0));
      });
      process.stdout.write("READY\\n");
    `], { env: process.env, stdout: "pipe", stderr: "inherit", timeout: 4_000 });
    const stdout = worker.stdout.pipeThrough(new TextDecoderStream()).getReader();
    try {
      let output = "";
      while (!output.includes("\n")) {
        const chunk = await stdout.read();
        if (chunk.done) throw new Error("Fixture exited before READY");
        output += chunk.value;
      }
      expect(output).toBe("READY\n");
      worker.kill("SIGTERM");
      for (let chunk = await stdout.read(); !chunk.done; chunk = await stdout.read()) {
        output += chunk.value;
      }
      expect({ output, code: await worker.exited }).toEqual({ output: "READY\nHANDLED\n", code: 0 });
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL");
      await stdout.cancel();
      await worker.exited;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
