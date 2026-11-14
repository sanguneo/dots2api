import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TelegramRelay } from "../src/telegram/relay";
import { loadTelegramConfig, RelayError } from "../src/telegram/config";

const roots: string[] = [];
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
const relays: TelegramRelay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
const sender = { id: 7, is_bot: false };
const bot = { id: 111, is_bot: true, username: "FixtureBot" };
function update(id: number, message: object = {}) {
  return { update_id: id, message: { message_id: id, from: sender, chat: { id: 7, type: "private" }, text: "hello", ...message } };
}
type Send = { method: string; chat: string; text?: string; name?: string; bytes?: Buffer; authorization: string | null };
type Generation = { authorization: string | null; thread: string | null; body: unknown };

async function fixture(overrides: object = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dots-telegram-"));
  roots.push(directory);
  const state = {
    updates: [update(1)],
    content: "Hello from the gateway.",
    gatewayMode: "ok",
    photoMode: "ok",
    sendMode: "ok",
    imageMode: "ok",
    generations: new Array<Generation>(),
    sends: new Array<Send>(),
    downloads: new Array<string | null>(),
    offsets: new Array<number>(),
    foreignRequests: 0,
    gatewayURL: "",
  };
  const foreign = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() { state.foreignRequests++; return new Response(png); },
  });
  servers.push(foreign);
  const gateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/chat/completions") {
        state.generations.push({
          authorization: request.headers.get("authorization"), thread: request.headers.get("X-Muse-Thread"),
          body: await request.json(),
        });
        if (state.gatewayMode === "error") return Response.json({ error: { message: "unknown downstream result" } }, { status: 502 });
        if (state.gatewayMode === "slow-body") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }));
        return Response.json({ choices: [{ message: { content: state.content } }] });
      }
      if (path === "/api/jobs/job_123/images/0") {
        state.downloads.push(request.headers.get("authorization"));
        if (state.imageMode === "redirect") return new Response(null, { status: 302, headers: { Location: foreign.url.href + "image.png" } });
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }
      return new Response(null, { status: 404 });
    },
  });
  state.gatewayURL = gateway.url.origin;
  servers.push(gateway);
  const telegram = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/bot111:fixture/")) return new Response(null, { status: 404 });
      const method = path.split("/").at(-1) ?? "";
      if (method === "getMe") return Response.json({ ok: true, result: bot });
      if (method === "getUpdates") {
        const body = z.object({ offset: z.number() }).parse(await request.json());
        state.offsets.push(body.offset);
        return Response.json({ ok: true, result: state.updates.filter((item) => item.update_id >= body.offset) });
      }
      if (method === "sendMessage") {
        const body = z.object({ chat_id: z.number(), text: z.string() }).parse(await request.json());
        state.sends.push({ method, chat: String(body.chat_id), text: body.text, authorization: request.headers.get("authorization") });
      } else if (method === "sendPhoto" || method === "sendDocument") {
        const form = await request.formData();
        const file = form.get(method === "sendPhoto" ? "photo" : "document");
        if (!(file instanceof File)) return Response.json({ ok: false, error_code: 400 }, { status: 400 });
        state.sends.push({
          method, chat: String(form.get("chat_id")), name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()), authorization: request.headers.get("authorization"),
        });
      } else return new Response(null, { status: 404 });
      if (method === "sendPhoto" && state.photoMode === "reject") return Response.json({ ok: false, error_code: 400 }, { status: 400 });
      if (method === "sendPhoto" && state.photoMode === "unknown") return new Response("unconfirmed secret body", { status: 502 });
      if (state.sendMode === "unknown") return new Response("unconfirmed secret body", { status: 502 });
      return Response.json({ ok: true, result: { message_id: 20 } });
    },
  });
  servers.push(telegram);
  await writeFile(join(directory, "key"), "fixture-gateway-key\n", { mode: 0o600 });
  await writeFile(join(directory, "token"), "111:fixture\n", { mode: 0o600 });
  const config = {
    gateway: { baseURL: gateway.url.origin, apiKey: { file: "./key" } },
    telegram: { apiBaseURL: telegram.url.origin, botToken: { file: "./token" } },
    allowedUserIds: [7], allowedChatIds: [-50], systemPrompt: "Fixture system prompt.",
    requestTimeoutMs: 200, pollTimeoutSeconds: 0, ...overrides,
  };
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const connect = async () => {
    const relay = await TelegramRelay.open(configPath);
    relays.push(relay);
    return relay;
  };
  return { state, connect, directory, configPath, config, foreignURL: foreign.url.href };
}

test("authorized text, protected image and file blocks reach Telegram with isolated credentials", async () => {
  const f = await fixture();
  const text = "a".repeat(3999) + "😀" + "b".repeat(30);
  f.state.content = `${text}\n![generated](${f.state.gatewayURL}/api/jobs/job_123/images/0)\n`
    + '[[file name="../notes.txt" encoding="utf8"]]\nhello file\n[[/file]]\n'
    + '[[file name="binary.dat" encoding="base64"]]\nAAEC/w==\n[[/file]]';
  const relay = await f.connect();

  await relay.pollOnce();

  expect(f.state.generations).toEqual([{
    authorization: "Bearer fixture-gateway-key", thread: "telegram:111:7",
    body: { model: "muse-agent", stream: false, messages: [
      { role: "system", content: "Fixture system prompt." }, { role: "user", content: "hello" },
    ] },
  }]);
  const texts = f.state.sends.filter((send) => send.method === "sendMessage").map((send) => send.text ?? "");
  expect(texts.join("")).toBe(text);
  expect(texts.map((part) => part.length)).toEqual([3999, 32]);
  expect(f.state.sends.map((send) => send.method)).toEqual(["sendMessage", "sendMessage", "sendPhoto", "sendDocument", "sendDocument"]);
  expect(f.state.sends.map((send) => send.authorization)).toEqual([null, null, null, null, null]);
  expect(f.state.downloads).toEqual(["Bearer fixture-gateway-key"]);
  expect(f.state.sends.find((send) => send.method === "sendPhoto")?.bytes).toEqual(png);
  expect(f.state.sends.find((send) => send.name === "notes.txt")?.bytes?.toString()).toBe("hello file");
  expect(f.state.sends.find((send) => send.name === "binary.dat")?.bytes).toEqual(Buffer.from([0, 1, 2, 255]));
});

test("photo rejection falls back to a document using the same bytes without generation replay", async () => {
  const f = await fixture();
  f.state.content = `[[file name="picture.png" encoding="base64"]]\n${png.toString("base64")}\n[[/file]]`;
  f.state.photoMode = "reject";
  const relay = await f.connect();

  await relay.pollOnce();

  expect(f.state.sends.map((send) => send.method)).toEqual(["sendPhoto", "sendDocument"]);
  expect(f.state.sends.map((send) => send.bytes)).toEqual([png, png]);
  expect(f.state.generations.length).toBe(1);
});

test.each([
  { name: "unauthorized user", patch: { from: { id: 8, is_bot: false } }, config: {} },
  { name: "bot disabled", patch: { from: { id: 7, is_bot: true }, text: "@FixtureBot hello" }, config: {} },
  { name: "bot reply without mention", patch: { from: { id: 7, is_bot: true }, reply_to_message: { from: bot } }, config: { allowBotMessages: true } },
  { name: "own bot", patch: { from: bot, text: "@FixtureBot hello" }, config: { allowBotMessages: true, allowedUserIds: [111] } },
  { name: "unlisted group", patch: { chat: { id: -51, type: "group" }, text: "@FixtureBot hello" }, config: {} },
  { name: "unaddressed group", patch: { chat: { id: -50, type: "supergroup" } }, config: {} },
  { name: "partial handle", patch: { chat: { id: -50, type: "group" }, text: "@FixtureBotOther hello" }, config: {} },
  { name: "anonymous sender", patch: { sender_chat: { id: -50 } }, config: {} },
])("rejects $name without submitting or sending", async ({ patch, config }) => {
  const f = await fixture(config);
  f.state.updates = [update(1, patch)];
  const relay = await f.connect();

  await relay.pollOnce();

  expect(f.state.generations).toEqual([]);
  expect(f.state.sends).toEqual([]);
});

test.each([
  { text: "@FixtureBot hello", from: sender },
  { text: "hello", from: sender, reply_to_message: { from: bot } },
  { text: "@fixturebot hello", from: { id: 7, is_bot: true } },
])("accepts addressed allowlisted group messages: %j", async (message) => {
  const f = await fixture({ allowBotMessages: true });
  f.state.updates = [update(1, { ...message, chat: { id: -50, type: "supergroup" } })];
  const relay = await f.connect();

  await relay.pollOnce();

  expect(f.state.generations.map((entry) => entry.thread)).toEqual(["telegram:111:-50"]);
  expect(f.state.sends.map((entry) => entry.chat)).toEqual(["-50"]);
});

test("offset resumption deduplicates completed work and preserves separate chat threads", async () => {
  const f = await fixture();
  const first = await f.connect();
  await first.pollOnce();
  await first.close();
  f.state.updates = [update(1), update(2), update(3, { chat: { id: -50, type: "group" }, text: "@FixtureBot other chat" })];
  const resumed = await f.connect();

  await resumed.pollOnce();

  expect(f.state.offsets).toEqual([0, 2]);
  expect(f.state.generations.map((entry) => entry.thread)).toEqual(["telegram:111:7", "telegram:111:7", "telegram:111:-50"]);
  expect(f.state.sends.map((entry) => entry.chat)).toEqual(["7", "7", "-50"]);
});

test.each(["generation error", "generation body timeout", "unknown send", "unknown photo"])("%s leaves pending work and cannot automatically resubmit on restart", async (scenario) => {
  const f = await fixture();
  if (scenario === "generation error") f.state.gatewayMode = "error";
  if (scenario === "generation body timeout") f.state.gatewayMode = "slow-body";
  if (scenario === "unknown send") f.state.sendMode = "unknown";
  if (scenario === "unknown photo") {
    f.state.content = "![image](/api/jobs/job_123/images/0)";
    f.state.photoMode = "unknown";
  }
  const relay = await f.connect();

  const error = await relay.pollOnce().then(() => null, (error: unknown) => error);
  await relay.close();
  const restartError = await f.connect().then(() => null, (error: unknown) => error);

  expect(error).toBeInstanceOf(RelayError);
  expect(restartError).toMatchObject({ code: "pending" });
  expect(f.state.generations.length).toBe(1);
  expect(f.state.sends.map((send) => send.method)).toEqual(
    scenario === "unknown send" ? ["sendMessage"] : scenario === "unknown photo" ? ["sendPhoto"] : [],
  );
  const persisted = JSON.parse(await readFile(join(f.directory, "telegram-state/state.json"), "utf8"));
  expect(persisted).toMatchObject({ offset: 0, pending: { updateId: 1, chatId: 7 } });
  expect(String(error)).not.toContain("fixture");
  expect(String(error)).not.toContain("secret body");
});

test.each(["foreign image", "redirected gateway image"])("%s never sends credentials to another origin", async (scenario) => {
  const f = await fixture();
  f.state.content = scenario === "foreign image" ? `![image](${f.foreignURL}image.png)` : "![image](/api/jobs/job_123/images/0)";
  if (scenario === "redirected gateway image") f.state.imageMode = "redirect";
  const relay = await f.connect();

  const error = await relay.pollOnce().then(() => null, (error: unknown) => error);

  expect(error).toBeInstanceOf(RelayError);
  expect(f.state.foreignRequests).toBe(0);
  expect(f.state.sends).toEqual([]);
});

test("photo input is explicitly unsupported without calling the gateway", async () => {
  const f = await fixture();
  f.state.updates = [update(1, { text: undefined, photo: [{ file_id: "not-downloaded" }], caption: "Describe this" })];
  const relay = await f.connect();

  await relay.pollOnce();

  expect(f.state.generations).toEqual([]);
  expect(f.state.sends.map((send) => send.method)).toEqual(["sendMessage"]);
  expect(f.state.sends[0]?.text).toMatch(/photo input is unsupported/i);
  expect(f.state.sends[0]?.text).toMatch(/have not seen/i);
});

test("concurrent relay instances cannot consume the same bot state", async () => {
  const f = await fixture();
  await f.connect();

  const error = await f.connect().then(() => null, (error: unknown) => error);

  expect(error).toMatchObject({ code: "locked" });
  expect(f.state.generations).toEqual([]);
});

test.each([
  { allowedUserIds: [] },
  { allowedUserIds: undefined },
  { gateway: { baseURL: "http://user:password@127.0.0.1", apiKey: { file: "./key" } } },
  { telegram: { botToken: { file: "./token", env: "ALSO_SECRET" } } },
  { model: "anything" },
])("invalid configuration fails closed before polling: %j", async (patch) => {
  const f = await fixture(patch);

  const error = await f.connect().then(() => null, (error: unknown) => error);

  expect(error).toMatchObject({ code: "configuration" });
  expect(f.state.offsets).toEqual([]);
});

test("environment secret references and loopback defaults resolve without embedding secrets in configuration", async () => {
  const f = await fixture();
  process.env["DOTS_RELAY_TEST_KEY"] = "env-key";
  process.env["DOTS_RELAY_TEST_TOKEN"] = "111:environment";
  try {
    await writeFile(f.configPath, JSON.stringify({
      allowedUserIds: [7], gateway: { apiKey: { env: "DOTS_RELAY_TEST_KEY" } },
      telegram: { botToken: { env: "DOTS_RELAY_TEST_TOKEN" } },
    }));

    const loaded = await loadTelegramConfig(f.configPath);

    expect(loaded.apiKey).toBe("env-key");
    expect(loaded.botToken).toBe("111:environment");
    expect(loaded.config.gateway.baseURL).toBe("http://127.0.0.1:3010");
    expect(loaded.config.telegram.apiBaseURL).toBe("https://api.telegram.org");
    expect(loaded.config.allowBotMessages).toBe(false);
    expect(loaded.config.allowedChatIds).toEqual([]);
    expect(loaded.stateDir).toBe(join(f.directory, "telegram-state"));
  } finally {
    delete process.env["DOTS_RELAY_TEST_KEY"];
    delete process.env["DOTS_RELAY_TEST_TOKEN"];
  }
});
