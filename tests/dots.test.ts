import { expect, test } from "bun:test";
import { z } from "zod";
import { type AdapterContext, accountIdSchema, type Credentials, GatewayError } from "../src/contracts";
import { dotsAdapter } from "../src/providers/dots";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const USER = "user-me";
const DOT = "calpico-member-dot";
const rpcSchema = z.object({ id: z.number().optional(), method: z.string(), params: z.record(z.string(), z.unknown()) });

type Message = { id: string; created_at: string; account_user_id: string; deleted_at?: string | null; content: { text: string; attachments?: unknown[] } };
type Scenario = {
  primary?: () => Response;
  statuses?: string[];
  later?: { afterReads: number; message: () => Message };
  onPost?: (body: Record<string, unknown>) => void;
  replies?: (posted: Message) => Message[];
};
type Seen = { posts: Record<string, unknown>[]; reads: string[]; downloads: number; headers: Headers[]; uploads: File[] };

const context: AdapterContext = {
  accountId: accountIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  dataDir: "/unused",
  signal: new AbortController().signal,
};

async function withDot<T>(scenario: Scenario, action: (credentials: Credentials, seen: Seen) => Promise<T>): Promise<T> {
  const seen: Seen = { posts: [], reads: [], downloads: 0, headers: [], uploads: [] };
  const statuses = [...(scenario.statuses ?? ["idle"])];
  const history: Message[] = [
    { id: "old-user", created_at: "2026-10-01T00:00:00.000000Z", account_user_id: USER, content: { text: "earlier" } },
    { id: "old-dot", created_at: "2026-10-01T00:00:01.000000Z", account_user_id: DOT, content: { text: "earlier reply" } },
  ];
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      seen.headers.push(request.headers);
      if (!request.headers.get("user-agent")?.startsWith("codex/")) return new Response("Codex client required", { status: 403 });
      const url = new URL(request.url);
      if (request.headers.get("upgrade") === "websocket") return server.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
      if (url.pathname === "/tbo/primary") {
        return scenario.primary?.() ?? Response.json({ selection: { thread_id: "root-thread", available: true, messaging_room_id: "room-1" } });
      }
      if (url.pathname === "/messaging/rooms/room-1/messages" && request.method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        seen.posts.push(body);
        scenario.onPost?.(body);
        const posted: Message = { id: "sent-1", created_at: "2026-10-21T03:00:00.000000Z", account_user_id: USER, content: { text: String((body["content"] as { text: string }).text) } };
        history.push(posted, ...(scenario.replies?.(posted) ?? []));
        return Response.json(posted);
      }
      if (url.pathname === "/messaging/rooms/room-1/messages") {
        expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(32);
        return Response.json({ items: history.slice(-32), prev_cursor: null, next_cursor: null });
      }
      if (url.pathname === "/messaging/rooms/room-1/files" && request.method === "POST") {
        const file = (await request.formData()).get("file");
        if (!(file instanceof File)) return new Response("file required", { status: 400 });
        seen.uploads.push(file);
        return Response.json({ file_id: `CalpicoFile_${seen.uploads.length}`, status: "UPLOADED" });
      }
      if (url.pathname === "/files/image.png") { seen.downloads++; return new Response(PNG); }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(peer, raw) {
        const request = rpcSchema.parse(JSON.parse(String(raw)));
        if (request.method === "initialize") peer.send(JSON.stringify({ id: request.id, result: {} }));
        if (request.method === "thread/read") {
          seen.reads.push(String(request.params["threadId"]));
          const type = statuses.length > 1 ? statuses.shift() : statuses[0];
          if (scenario.later && seen.reads.length === scenario.later.afterReads) history.push(scenario.later.message());
          peer.send(JSON.stringify({ id: request.id, result: { thread: { id: request.params["threadId"], status: { type } } } }));
        }
      },
    },
  });
  const credentials = {
    accessToken: "test-token",
    accountId: "account-42",
    endpoint: `ws://127.0.0.1:${server.port}`,
    apiBase: `http://127.0.0.1:${server.port}`,
    pollMs: "1",
  };
  try {
    return await action(credentials, seen);
  } finally {
    await server.stop(true);
  }
}

const reply = (id: string, text: string, attachments: unknown[] = []): Message =>
  ({ id, created_at: `2026-10-21T03:00:0${id.length % 9 + 1}.000000Z`, account_user_id: DOT, content: { text, attachments } });

test("check finds the account's primary Dot with only the supplied credentials", async () => {
  // Given an account whose ChatGPT profile has a primary Dot.
  await withDot({}, async (credentials, seen) => {
    // When the account is checked.
    await dotsAdapter.check(credentials, context);
    // Then the Dot's conversation thread was read with the explicit bearer and account headers.
    expect(seen.reads).toEqual(["root-thread"]);
    expect(seen.headers.every((headers) => headers.get("authorization") === "Bearer test-token")).toBe(true);
    expect(seen.headers.every((headers) => headers.get("chatgpt-account-id") === "account-42")).toBe(true);
  });
});

test("run messages the Dot and returns its replies once the Dot is idle again", async () => {
  // Given a Dot that is still working on the first poll and replies in two messages.
  await withDot({
    statuses: ["active", "idle"],
    replies: () => [reply("r1", "First part"), reply("r22", "Second part")],
  }, async (credentials, seen) => {
    // When a prompt is sent.
    const accepted: (string | null)[] = [];
    const result = await dotsAdapter.run(credentials, "Hello Dot", { ...context, onAccepted: (id) => accepted.push(id) });
    // Then exactly one message carrying the prompt was posted, with an idempotency token.
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]).toMatchObject({ content: { text: "Hello Dot" } });
    expect(seen.posts[0]?.["idempotency_token"]).toBe(seen.posts[0]?.["request_id"]);
    // Then only the Dot's replies after the prompt are returned, oldest first, after it stopped working.
    expect(result).toEqual({ text: "First part\n\nSecond part", remoteId: "sent-1" });
    expect(accepted).toEqual(["sent-1"]);
    expect(seen.reads.length).toBeGreaterThanOrEqual(2);
  });
});

test("run waits for an attachment the Dot sends after a brief idle gap", async () => {
  // Given a Dot that announces the image, reads idle for a moment, then posts the image as a later message.
  let origin = "";
  await withDot({
    replies: () => [reply("r1", "I'll send it as an attachment.")],
    later: { afterReads: 3, message: () => reply("r22", "", [{ type: "file", file: { mime_type: "image/png", download_url: `${origin}/files/image.png` } }]) },
  }, async (credentials, seen) => {
    origin = String(credentials["apiBase"]);
    // When the prompt runs.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then the job waits through the gap and returns the image instead of only the announcement.
    expect(result.images).toHaveLength(1);
    expect(result.text).toBe("I'll send it as an attachment.");
    expect(seen.downloads).toBe(1);
  });
});

test("run uploads reference images to the Dot conversation and attaches them to the prompt", async () => {
  // Given two valid reference images.
  const references = [
    { mime: "image/png" as const, data: new Uint8Array(PNG) },
    { mime: "image/jpeg" as const, data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
  ];
  await withDot({ replies: () => [reply("r1", "done")] }, async (credentials, seen) => {
    // When a prompt carries them.
    const result = await dotsAdapter.run(credentials, "edit the reference", { ...context, referenceImages: references });
    // Then each image was uploaded as its own file, byte for byte, before the one message that references them.
    expect(seen.uploads.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(new Uint8Array(await seen.uploads[0]!.arrayBuffer())).toEqual(references[0]!.data);
    expect(seen.posts).toEqual([expect.objectContaining({
      content: { text: "edit the reference", attachments: [{ type: "file", file_id: "CalpicoFile_1" }, { type: "file", file_id: "CalpicoFile_2" }] },
    })]);
    expect(result.text).toBe("done");
  });
});

test("run rejects invalid reference images before contacting the Dot", async () => {
  await withDot({}, async (credentials, seen) => {
    await expect(dotsAdapter.run(credentials, "edit", { ...context, referenceImages: [{ mime: "image/png", data: new Uint8Array([1, 2, 3]) }] }))
      .rejects.toMatchObject({ code: "invalid_image", uncertain: false });
    expect(seen.headers).toHaveLength(0);
  });
});

test("run downloads image attachments only from the API origin", async () => {
  // Given a reply with one same-origin image and one image hosted elsewhere.
  let origin = "";
  await withDot({
    replies: () => [reply("r1", "Here it is", [
      { type: "file", file: { mime_type: "image/png", download_url: `${origin}/files/image.png` } },
      { type: "file", file: { mime_type: "image/png", download_url: "https://attacker.example/steal.png" } },
      { type: "file", file: { mime_type: "application/pdf", download_url: `${origin}/files/doc.pdf` } },
    ])],
  }, async (credentials, seen) => {
    origin = String(credentials["apiBase"]);
    // When the prompt completes.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then the same-origin PNG is returned, the foreign one is reported, and the PDF is ignored.
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mime).toBe("image/png");
    expect(seen.downloads).toBe(1);
    expect(result.text).toContain("Here it is");
    expect(result.text).toContain("1 image(s) that could not be downloaded");
  });
});

test("run reports uncertain when it is cancelled after the message was posted", async () => {
  // Given a Dot that never replies and a caller that gives up right after the message is accepted.
  const controller = new AbortController();
  await withDot({ onPost: () => controller.abort() }, async (credentials, seen) => {
    // When the job is cancelled while waiting.
    const failure = dotsAdapter.run(credentials, "Hello", { ...context, signal: controller.signal });
    // Then no reply is fabricated and repeating the prompt is flagged as unsafe.
    await expect(failure).rejects.toMatchObject({ uncertain: true });
    expect(seen.posts).toHaveLength(1);
  });
});

test("an account without an available Dot or with rejected credentials fails before posting", async () => {
  // Given missing credentials, then a profile with no Dot, then a revoked token.
  expect(() => dotsAdapter.validate({})).toThrow(GatewayError);
  await expect(dotsAdapter.run({}, "Hello", context)).rejects.toMatchObject({ code: "dots_unconnected" });
  await withDot({ primary: () => Response.json({ selection: null }) }, async (credentials, seen) => {
    await expect(dotsAdapter.check(credentials, context)).rejects.toMatchObject({ code: "dots_unavailable", uncertain: false });
    await expect(dotsAdapter.run(credentials, "Hello", context)).rejects.toMatchObject({ code: "dots_unavailable", uncertain: false });
    expect(seen.posts).toHaveLength(0);
  });
  await withDot({ primary: () => new Response("no", { status: 401 }) }, async (credentials, seen) => {
    // Then authentication failures keep their status so the gateway asks for a reconnect.
    await expect(dotsAdapter.run(credentials, "Hello", context)).rejects.toMatchObject({ status: 401, uncertain: false });
    expect(seen.posts).toHaveLength(0);
  });
});

test("validate refuses insecure remote endpoints", () => {
  const base = { accessToken: "t", accountId: "a" };
  expect(() => dotsAdapter.validate({ ...base, apiBase: "http://chatgpt.com/backend-api" })).toThrow(GatewayError);
  expect(() => dotsAdapter.validate({ ...base, endpoint: "ws://codex.example" })).toThrow(GatewayError);
  expect(dotsAdapter.validate(base)).toMatchObject({ endpoint: "wss://codex-cloud-backend.chatgpt.com" });
});
