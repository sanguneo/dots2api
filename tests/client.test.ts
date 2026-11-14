import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "dots2api-client-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function cli(args: readonly string[], dir: string, script = join(root, "src/client/cli.ts")) {
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: dir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DOTS2API_"))), HOME: dir, XDG_CONFIG_HOME: dir },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 20_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

function gateway(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanups.push(() => { server.stop(true); });
  return server.url.origin;
}

async function connection(dir: string, address: string) {
  const key = join(dir, "key");
  const config = join(dir, "client.json");
  await writeFile(key, "fixture-private-key\n", { mode: 0o600 });
  const result = await cli(["configure", "--base-url", address + "/v1", "--key-file", key, "--config", config], dir);
  expect(result.exit).toBe(0);
  expect(await readFile(config, "utf8")).not.toContain("fixture-private-key");
  return config;
}

test("a configured client continues a named chat and saves protected images and files", async () => {
  const dir = await directory();
  const turns = new Map<string, number>();
  const address = gateway(async (request) => {
    if (request.headers.get("authorization") !== "Bearer fixture-private-key") return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/api/jobs/job-123/images/0") return new Response(png, { headers: { "content-type": "image/png" } });
    if (path !== "/v1/chat/completions") return new Response(null, { status: 404 });
    const input = await request.json();
    if (input.model !== "muse-agent" || input.messages[0]?.content !== "hello" || !["topic-a", "topic-b"].includes(input.thread)) return new Response(null, { status: 400 });
    const count = (turns.get(input.thread) ?? 0) + 1;
    turns.set(input.thread, count);
    return Response.json({ choices: [{ message: { content: `Turn ${count}\n![image](${address}/api/jobs/job-123/images/0)\n[[file name="../note.txt" encoding="utf8"]]\na useful note\n[[/file]]` } }] });
  });
  const config = await connection(dir, address);
  const args = ["chat", "--config", config, "--session", "topic-a", "--prompt", "hello", "--save-dir", join(dir, "answers")];
  const first = await cli(args, dir);
  const other = await cli(["chat", "--config", config, "--session", "topic-b", "--prompt", "hello"], dir);
  const second = await cli(args, dir);
  expect(first.exit).toBe(0);
  expect(JSON.parse(other.stdout).text.startsWith("Turn 1\n")).toBe(true);
  expect(second.exit).toBe(0);
  const result = JSON.parse(second.stdout);
  expect(result.text.startsWith("Turn 2\n")).toBe(true);
  expect(await readFile(join(dir, "answers/image-1.png"))).toEqual(png);
  expect(await readFile(join(dir, "answers/file-2-note.txt"), "utf8")).toBe("a useful note");
  expect(await Bun.file(join(dir, "note.txt")).exists()).toBe(false);
});

test("reference editing uploads actual image bytes and saves the returned image", async () => {
  const dir = await directory();
  const address = gateway(async (request) => {
    if (new URL(request.url).pathname !== "/v1/images/edits" || request.headers.get("authorization") !== "Bearer fixture-private-key") return new Response(null, { status: 403 });
    const form = await request.formData();
    const reference = form.get("image[]");
    if (!(reference instanceof File) || !Buffer.from(await reference.arrayBuffer()).equals(png) || form.get("model") !== "muse-image") return new Response(null, { status: 400 });
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  });
  const config = await connection(dir, address);
  const reference = join(dir, "reference.png");
  await writeFile(reference, png);
  const result = await cli(["image", "--config", config, "--model", "muse-image", "--prompt", "Change only the background", "--image", reference, "--out", join(dir, "edited")], dir);
  expect(result.exit).toBe(0);
  expect(await readFile(join(dir, "edited.png"))).toEqual(png);
});

test("a foreign image URL is refused without sending the gateway key or downloading it", async () => {
  const dir = await directory();
  let foreignRequests = 0;
  const foreign = gateway(() => { foreignRequests++; return new Response(png); });
  const address = gateway(() => Response.json({ data: [{ url: foreign + "/api/jobs/other/images/0" }] }));
  const config = await connection(dir, address);
  const result = await cli(["image", "--config", config, "--prompt", "A fox", "--out", "fox"], dir);
  expect(result.exit).toBe(1);
  expect(result.stderr).toContain("API key was not sent");
  expect(foreignRequests).toBe(0);
});

test("an uncertain generation is not retried and its error body cannot leak credentials", async () => {
  const dir = await directory();
  let calls = 0;
  const address = gateway(() => { calls++; return new Response("fixture-private-key", { status: 502 }); });
  const config = await connection(dir, address);
  const result = await cli(["image", "--config", config, "--prompt", "A fox", "--out", "fox"], dir);
  expect(result.exit).toBe(1);
  expect(calls).toBe(1);
  expect(result.stderr).not.toContain("fixture-private-key");
  expect(await Bun.file(join(dir, "fox.png")).exists()).toBe(false);
});

test("an installed skill runs from a fresh directory without source files or node_modules", async () => {
  const dir = await directory();
  const destination = join(dir, "installed-skill");
  const install = Bun.spawn(["bash", join(root, "install-skill.sh"), "--dir", destination], {
    cwd: dir, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  expect({ exit, stderr: exit ? stderr : "" }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("Installed dots2api skill");
  const address = gateway((request) => request.headers.get("authorization") === "Bearer fixture-private-key"
    ? Response.json({ data: [{ id: "muse-agent" }, { id: "dots-image" }] })
    : new Response(null, { status: 401 }));
  const config = await connection(dir, address);
  const result = await cli(["models", "--config", config], dir, join(destination, "scripts/client.js"));
  expect(result.exit).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["muse-agent", "dots-image"]);
});
