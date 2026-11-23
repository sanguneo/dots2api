import { GatewayError } from "../../contracts";
import { isAbsolute } from "node:path";
import { z } from "zod";

const runtimeSchema = z.object({ version: z.string(), execPath: z.string().refine(isAbsolute) });

/** Resolve the executable once before starting any browser worker. */
export async function nodeExecutable(node: string): Promise<string> {
  const probe = Bun.spawn([node, "-p", "JSON.stringify({version:process.version,execPath:process.execPath})"], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [out, _noise, code] = await Promise.all([
    new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GatewayError("muse_runtime", "The Muse browser worker could not identify its Node.js runtime.", 503);
  }
  const runtime = runtimeSchema.safeParse(value);
  if (code !== 0 || !runtime.success) {
    throw new GatewayError("muse_runtime", "The Muse browser worker could not identify its Node.js runtime.", 503);
  }
  const major = Number(/^v?(\d+)/.exec(runtime.data.version)?.[1] ?? "");
  if (!Number.isInteger(major) || major < 22 || !Bun.which(runtime.data.execPath)) {
    throw new GatewayError("muse_runtime", "The Muse browser worker needs a working Node.js 22 or newer executable.", 503);
  }
  // A PATH entry can be a Volta-style parent process. Signals must reach Node itself.
  return runtime.data.execPath;
}
