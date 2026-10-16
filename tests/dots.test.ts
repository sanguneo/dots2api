import { expect, test } from "bun:test";
import { z } from "zod";
import { type AdapterContext, accountIdSchema, type Credentials, GatewayError } from "../src/contracts";
import { dotsAdapter } from "../src/providers/dots";

const requestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});
type Request = z.infer<typeof requestSchema>;
type Peer = { send(message: string): void; close(): void };
const context: AdapterContext = {
  accountId: accountIdSchema.parse("00000000-0000-4000-8000-000000000001"),
  dataDir: "/unused",
  signal: new AbortController().signal,
};

async function withServer<T>(
  handler: (peer: Peer, request: Request) => void,
  action: (credentials: Credentials, headers: () => Headers | undefined) => Promise<T>,
): Promise<T> {
  let headers: Headers | undefined;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      headers = request.headers;
      if (!headers.get("user-agent")?.startsWith("codex/")) {
        return new Response("Codex client required", { status: 403 });
      }
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      message(peer, message) {
        handler(peer, requestSchema.parse(JSON.parse(String(message))));
      },
    },
  });
  const credentials = {
    accessToken: "test-token",
    accountId: "account-42",
    threadId: "dot-thread",
    endpoint: `ws://127.0.0.1:${server.port}`,
  };
  try {
    return await action(credentials, () => headers);
  } finally {
    await server.stop(true);
  }
}

function reply(peer: Peer, request: Request, result: unknown): void {
  peer.send(JSON.stringify({ id: request.id, result }));
}

function handshake(peer: Peer, request: Request): boolean {
  if (request.method === "initialize") {
    reply(peer, request, { userAgent: "test" });
    return true;
  }
  if (request.method === "initialized") return true;
  if (request.method === "thread/read" || request.method === "thread/resume") {
    reply(peer, request, { thread: { id: "dot-thread", threadSource: "aeon" } });
    return true;
  }
  return false;
}

test("check confirms an existing thread with explicit authorization", async () => {
  // Given a local app-server-style WebSocket endpoint.
  await withServer((peer, request) => { handshake(peer, request); }, async (credentials, headers) => {
    // When the account is checked.
    await dotsAdapter.check(credentials, context);
    // Then the selected thread was reachable with only supplied credentials.
    expect(headers()?.get("authorization")).toBe("Bearer test-token");
    expect(headers()?.get("chatgpt-account-id")).toBe("account-42");
  });
});

test("run resumes the selected thread and correlates early completion", async () => {
  const methods: string[] = [];
  // Given competing thread and turn notifications and a completion before the start reply.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      expect(request.params.threadId).toBe("dot-thread");
      expect(request.params.input).toEqual([{ type: "text", text: "Hello Dot" }]);
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "other-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "wrong", type: "agentMessage", text: "wrong thread" }] },
      } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "other-turn", status: "completed", items: [{ id: "wrong", type: "agentMessage", text: "wrong turn" }] },
      } }));
      peer.send(JSON.stringify({ method: "item/completed", params: {
        threadId: "dot-thread", turnId: "turn-1", item: { id: "answer", type: "agentMessage", text: "Actual answer" },
      } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [] },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
    }
  }, async (credentials) => {
    // When a prompt is sent to the existing thread.
    const result = await dotsAdapter.run(credentials, "Hello Dot", context);
    // Then only its own completed turn is returned; no new thread is created.
    expect(result).toEqual({ text: "Actual answer", remoteId: "turn-1" });
  });
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "turn/start"]);
});

test("run prefers accepted same-turn ChatGPT delivery over internal completion", async () => {
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method !== "turn/start") return;
    const delivery = {
      id: "delivery", type: "mcpToolCall", tool: "user_message.send_message",
      status: "completed", arguments: { channel: "chatgpt", text: "Delivered answer" },
      error: null, result: { structuredContent: { status: "accepted" } },
    };
    for (const [threadId, turnId, item] of [
      ["other", "turn-1", { ...delivery, id: "wrong-thread" }],
      ["dot-thread", "other", { ...delivery, id: "wrong-turn" }],
      ["dot-thread", "turn-1", { ...delivery, id: "failed", error: "rejected" }],
      ["dot-thread", "turn-1", { ...delivery, id: "other-channel", arguments: { channel: "email", text: "wrong" } }],
      ["dot-thread", "turn-1", delivery],
    ]) {
      peer.send(JSON.stringify({ method: "item/completed", params: { threadId, turnId, item } }));
    }
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [
        delivery, { id: "final", type: "agentMessage", text: "done" },
      ] },
    } }));
    reply(peer, request, { turn: { id: "turn-1" } });
  }, async (credentials) => {
    expect(await dotsAdapter.run(credentials, "Hello", context)).toEqual({
      text: "Delivered answer", remoteId: "turn-1",
    });
  });
});

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
test("run sends reference images as app-server image inputs, separately from text", async () => {
  const references = [
    { mime: "image/png" as const, data: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) },
    { mime: "image/jpeg" as const, data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
    { mime: "image/webp" as const, data: new Uint8Array(Buffer.from("RIFF0000WEBPVP8 ")) },
  ];
  await withServer((peer, request) => {
    if (handshake(peer, request) || request.method !== "turn/start") return;
    expect(request.params.input).toEqual([
      { type: "text", text: "edit the reference" },
      ...references.map((image) => ({ type: "image", url: `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}` })),
    ]);
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "done" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-1" } });
  }, async (credentials) => {
    expect(await dotsAdapter.run(credentials, "edit the reference", { ...context, referenceImages: references })).toEqual({ text: "done", remoteId: "turn-1" });
  });
});

test("run rejects invalid reference images before connecting", async () => {
  await expect(dotsAdapter.run({}, "edit", { ...context, referenceImages: [{ mime: "image/png", data: new Uint8Array([1, 2, 3]) }] }))
    .rejects.toMatchObject({ code: "invalid_image", uncertain: false });
});
const generated = (extra: object = {}) => ({ id: "img-1", type: "imageGeneration", status: "completed", failure: null, ...extra });
const delivered = {
  id: "delivery", type: "mcpToolCall", tool: "user_message.send_message", status: "completed",
  arguments: { channel: "chatgpt", text: "Delivered as a PNG attachment.", library_file_ids: ["libfile_1"] },
  error: null, result: { structuredContent: { status: "accepted" } },
};

test("run returns a generated image carried by the completed turn", async () => {
  // Given a turn whose completed items include the generated image bytes.
  await withServer((peer, request) => {
    if (handshake(peer, request) || request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [generated({ result: PNG_BASE64 }), delivered] },
    } }));
    reply(peer, request, { turn: { id: "turn-1" } });
  }, async (credentials) => {
    // When the prompt completes.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then the text and one real PNG are returned, with no extra download request.
    expect(result.text).toBe("Delivered as a PNG attachment.");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mime).toBe("image/png");
  });
});

test.each([false, true])("does not replay delivered work because unrelated prose mentions the image limit, references=%s", async (references) => {
  const methods: string[] = [];
  const accepted: (string | null)[] = [];
  // Given acceptance and a delivered side effect preceding an unrelated failure.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request) || request.method !== "turn/start") return;
    reply(peer, request, { turn: { id: "accepted-turn" } });
    peer.send(JSON.stringify({ method: "item/completed", params: {
      threadId: "dot-thread", turnId: "accepted-turn", item: delivered,
    } }));
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "accepted-turn", status: "failed", items: [],
        error: { message: '{"error":{"code":"other_error","message":"Failure after output; not image_request_too_large"}}' } },
    } }));
  }, async (credentials) => {
    // When failure is classified under the new no-replay contract.
    await expect(dotsAdapter.run({ ...credentials, threadImageBytes: "1024" }, "work", {
      ...context, saveCredentials: () => {}, onAccepted: (id) => { accepted.push(id); },
      ...(references ? { referenceImages: [{ mime: "image/png" as const, data: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) }] } : {}),
    })).rejects.toMatchObject({ code: "dots_turn" });
  });
  // Then the first remote identifier remains the only accepted attempt.
  expect(accepted).toEqual(["accepted-turn"]);
  expect(methods.filter((method) => method === "turn/start")).toHaveLength(1);
  expect(methods).not.toContain("thread/start");
});

test.each([undefined, null, ""])("requires provenance when the selected thread source is %s", async (source) => {
  const submitted: string[] = [];
  // Given an unlabelled operator-selected thread without a self marker.
  await withServer((peer, request) => {
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: source, modelProvider: "local" } });
      return;
    }
    if (request.method === "turn/start") submitted.push(String(request.params.threadId));
    handshake(peer, request);
  }, async (credentials) => {
    // When the account has no durable evidence of owning the thread.
    await expect(dotsAdapter.run(credentials, "work", context)).rejects.toMatchObject({ code: "dots_thread_unverified" });
  });
  // Then no original-thread submission took place.
  expect(submitted).toEqual([]);
});

test("recovers an unresolved second image and merges the first by its remote ID", async () => {
  let lists = 0;
  const saved: Credentials[] = [];
  // Given one inline image and one known image whose bytes were omitted.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      reply(peer, request, { turn: { id: "turn-1" } });
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed",
          items: [generated({ id: "A", result: PNG_BASE64 }), generated({ id: "B", result: null })] },
      } }));
    }
    if (request.method === "thread/turns/list") {
      lists++;
      reply(peer, request, { data: [{ id: "turn-1", items: [
        generated({ id: "A", result: PNG_BASE64 }), generated({ id: "B", result: PNG_BASE64 }),
      ] }] });
    }
  }, async (credentials) => {
    // When the completed result is assembled.
    const result = await dotsAdapter.run(credentials, "draw", { ...context, saveCredentials: (value) => { saved.push(value); } });
    // Then both unique images are returned and counted once each.
    expect(result.images).toHaveLength(2);
    expect(saved.at(-1)?.["threadImageBytes"]).toBe(String(2 * Buffer.from(PNG_BASE64, "base64").length));
    expect(saved.at(-1)?.["threadImageAccounting"]).toBe("complete");
  });
  expect(lists).toBe(1);
});

test("recovers attachments announced only in individual item notifications", async () => {
  let lists = 0;
  // Given a streamed attachment indication absent from the final snapshot.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      reply(peer, request, { turn: { id: "turn-1" } });
      peer.send(JSON.stringify({ method: "item/completed", params: { threadId: "dot-thread", turnId: "turn-1", item: delivered } }));
      peer.send(JSON.stringify({ method: "turn/completed", params: { threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [] } } }));
    }
    if (request.method === "thread/turns/list") {
      lists++;
      reply(peer, request, { data: [{ id: "turn-1", items: [generated({ result: PNG_BASE64 })] }] });
    }
  }, async (credentials) => {
    // When the result completes, then its attachment is downloaded.
    const result = await dotsAdapter.run(credentials, "draw", context);
    expect(result.images).toHaveLength(1);
  });
  expect(lists).toBe(1);
});

test("counts nine generated images while returning eight and adds references once", async () => {
  const saved: Credentials[] = [];
  // Given nine distinct generated items and one reference of the same byte length.
  await withServer((peer, request) => {
    if (handshake(peer, request) || request.method !== "turn/start") return;
    reply(peer, request, { turn: { id: "turn-1" } });
    peer.send(JSON.stringify({ method: "turn/completed", params: { threadId: "dot-thread",
      turn: { id: "turn-1", status: "completed", items: Array.from({ length: 9 }, (_, i) => generated({ id: `image-${i}`, result: PNG_BASE64 })) } } }));
  }, async (credentials) => {
    // When accounting is saved independently of public output truncation.
    const result = await dotsAdapter.run(credentials, "draw", {
      ...context, referenceImages: [{ mime: "image/png", data: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) }],
      saveCredentials: (value) => { saved.push(value); },
    });
    // Then every generated/reference byte is counted exactly once.
    expect(result.images).toHaveLength(8);
    expect(saved.at(-1)?.["threadImageBytes"]).toBe(String(10 * Buffer.from(PNG_BASE64, "base64").length));
  });
});

test("rotates before another job when known image bytes could not be recovered", async () => {
  const saved: Credentials[] = [];
  const targets: string[] = [];
  // Given a completed image with no retrievable bytes followed by another job.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "fresh" } }); return; }
    if (request.method === "thread/turns/list") { reply(peer, request, { data: [] }); return; }
    if (request.method !== "turn/start") return;
    const thread = String(request.params.threadId);
    targets.push(thread);
    reply(peer, request, { turn: { id: "turn-1" } });
    peer.send(JSON.stringify({ method: "turn/completed", params: { threadId: thread,
      turn: { id: "turn-1", status: "completed", items: thread === "dot-thread"
        ? [generated({ result: null })] : [{ id: "answer", type: "agentMessage", text: "done" }] } } }));
  }, async (credentials) => {
    await dotsAdapter.run(credentials, "first", { ...context, saveCredentials: (value) => { saved.push(value); } });
    const repaired = saved.at(-1);
    if (!repaired) throw new Error("Expected incomplete accounting");
    expect(repaired["threadImageAccounting"]).toBe("incomplete");
    // When the next job starts with that durable accounting.
    await dotsAdapter.run(repaired, "next", { ...context, saveCredentials: (value) => { saved.push(value); } });
  });
  // Then it never sends the next job back to the incompletely counted thread.
  expect(targets).toEqual(["dot-thread", "fresh"]);
});

test("bounds early notification accumulation after submission without replay", async () => {
  let submissions = 0;
  // Given a provider flooding the connection before acknowledging its submitted turn.
  await withServer((peer, request) => {
    if (handshake(peer, request) || request.method !== "turn/start") return;
    submissions++;
    for (let i = 0; i < 257; i++) peer.send(JSON.stringify({ method: "fixture/progress", params: { threadId: "dot-thread", index: i } }));
  }, async (credentials) => {
    // When the finite notification queue fills.
    await expect(dotsAdapter.run(credentials, "work", { ...context, saveCredentials: () => {} }))
      .rejects.toMatchObject({ code: "dots_resource_limit", uncertain: true });
  });
  // Then no retry turns the resource failure into duplicate work.
  expect(submissions).toBe(1);
});

test("run downloads the image from the turn list when the completed turn omits its bytes", async () => {
  const methods: string[] = [];
  // Given a turn that only reports a delivered attachment, while the full turn list holds the image.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [delivered] },
      } }));
      reply(peer, request, { turn: { id: "turn-1" } });
    }
    if (request.method === "thread/turns/list") {
      expect(request.params).toMatchObject({ threadId: "dot-thread", itemsView: "full" });
      reply(peer, request, { data: [
        { id: "older", items: [generated({ id: "old", result: PNG_BASE64 })] },
        { id: "turn-1", items: [generated({ result: PNG_BASE64 }), generated({ id: "failed", status: "failed", result: PNG_BASE64 })] },
      ] });
    }
  }, async (credentials) => {
    // When the prompt completes.
    const result = await dotsAdapter.run(credentials, "draw", context);
    // Then only this turn's successful image is returned.
    expect(result.images).toHaveLength(1);
  });
  expect(methods).toContain("thread/turns/list");
});

test("run keeps the text and says so when the image cannot be downloaded", async () => {
  // Given a delivered attachment whose image bytes are unavailable from the turn list.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [delivered] },
      } }));
      reply(peer, request, { turn: { id: "turn-1" } });
    }
    if (request.method === "thread/turns/list") reply(peer, request, { data: [{ id: "turn-1", items: [] }] });
  }, async (credentials) => {
    // When the prompt completes, then the job is not failed and the loss is visible in the text.
    const result = await dotsAdapter.run(credentials, "draw", context);
    expect(result.text).toContain("Delivered as a PNG attachment.");
    expect(result.text).toContain("could not be downloaded");
    expect(result.images).toBeUndefined();
  });
});

test("run reports uncertain when the connection closes after turn submission", async () => {
  // Given a peer that accepts the turn request but loses the connection before its reply.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") peer.close();
  }, async (credentials) => {
    // When the turn is submitted.
    const result = dotsAdapter.run(credentials, "Hello", context);
    // Then no successful response is fabricated and repeating the prompt is unsafe.
    await expect(result).rejects.toMatchObject({ uncertain: true, code: "dots_connection" });
  });
});

test("missing credentials and a non-Dot thread fail without submission", async () => {
  // Given no connected account.
  expect(() => dotsAdapter.validate({})).toThrow(GatewayError);
  // When checked or used without explicit credentials, it cannot claim success.
  await expect(dotsAdapter.check({}, context)).rejects.toMatchObject({ code: "dots_unconnected" });
  await expect(dotsAdapter.run({}, "Hello", context)).rejects.toMatchObject({ code: "dots_unconnected" });

  await withServer((peer, request) => {
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: "cli" } });
    } else if (request.method === "initialize") {
      reply(peer, request, {});
    } else if (request.method === "turn/start") {
      throw new Error("Unexpected submission");
    }
  }, async (credentials) => {
    await expect(dotsAdapter.run(credentials, "Hello", context)).rejects.toMatchObject({
      code: "dots_thread", uncertain: false,
    });
  });
});

test("check refuses a thread that is not an Aeon Dot", async () => {
  // Given a reachable thread carrying some other Dot identity.
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") reply(peer, request, {});
    if (request.method === "thread/read") reply(peer, request, { thread: { id: "dot-thread", threadSource: "user", modelProvider: "local" } });
  }, async (credentials) => {
    // When the account connection is checked.
    await expect(dotsAdapter.check({ ...credentials, threadOrigin: "self" }, context)).rejects.toMatchObject({
      code: "dots_thread", status: 400, uncertain: false,
    });
  });
  // Then a matching thread ID alone cannot mark this account ready.
  expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
});

test("run refuses to submit to a thread that is not an Aeon Dot", async () => {
  // Given a reachable thread carrying some other Dot identity.
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") reply(peer, request, {});
    if (request.method === "thread/read") reply(peer, request, { thread: { id: "dot-thread", threadSource: "user", modelProvider: "", canAcceptDirectInput: false } });
  }, async (credentials) => {
    // When a prompt targets that thread.
    await expect(dotsAdapter.run({ ...credentials, threadOrigin: "self" }, "Hello", {
      ...context,
      saveCredentials: () => { throw new Error("Foreign threads must not be rebound"); },
    })).rejects.toMatchObject({
      code: "dots_thread", status: 400, uncertain: false,
    });
  });
  // Then no resume or turn submission occurs.
  expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
});

function refuse(peer: Peer, request: Request, message: string): void {
  peer.send(JSON.stringify({
    id: request.id,
    error: { code: -32600, data: { grpcStatusCode: 5 }, message },
  }));
}

const RECLAIMED = "Some requested entity was not found: thread not found";

test("run binds a replacement thread when the selected Dot thread lost its agent", async () => {
  // Given an account whose selected thread can never accept a turn again.
  const methods: string[] = [];
  const saved: Credentials[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/archive") {
      // Then the dead thread this gateway created is retired once it is replaced.
      expect(request.params.threadId).toBe("dot-thread");
      reply(peer, request, {});
      return;
    }
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "healed-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    if (request.params.threadId === "dot-thread") {
      refuse(peer, request, RECLAIMED);
      return;
    }
    // Then the replacement thread receives the same prompt and completes there.
    expect(request.params.threadId).toBe("healed-thread");
    expect(request.params.input).toEqual([{ type: "text", text: "Hello Dot" }]);
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-9", status: "completed", items: [{ id: "wrong", type: "agentMessage", text: "stale" }] },
    } }));
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "healed-thread", turn: { id: "turn-2", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Recovered" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-2", status: "inProgress" } });
  }, async (credentials) => {
    // When a prompt hits the reclaimed thread.
    const validated = dotsAdapter.validate({ ...credentials, refreshToken: "refresh-token", threadOrigin: "self" });
    expect(validated).toMatchObject({ refreshToken: "refresh-token", threadOrigin: "self" });
    const result = await dotsAdapter.run(validated, "Hello Dot", {
      ...context,
      saveCredentials: (repaired) => { saved.push(repaired); },
    });
    // Then the turn is retried once on the replacement and its own completion is returned.
    expect(result).toEqual({ text: "Recovered", remoteId: "turn-2" });
  });
  // Then the rebind is submitted once and persisted for later jobs.
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "turn/start", "thread/start", "thread/archive", "turn/start"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ accessToken: "test-token", accountId: "account-42", threadId: "healed-thread", threadOrigin: "self", refreshToken: "refresh-token" });
});

test("run does not rebind a reclaimed thread without a credential store", async () => {
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") refuse(peer, request, RECLAIMED);
  }, async (credentials) => {
    const failure = await dotsAdapter.run(credentials, "Hello Dot", context).catch((error: unknown) => error);
    // Then the reclaimed thread is reported with the upstream reason and no replacement is created.
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ code: "dots_thread_missing", status: 502, uncertain: false });
    expect((failure as GatewayError).message).toContain("thread not found");
    expect((failure as GatewayError).message).toContain("-32600");
  });
});

test("run reports the upstream reason for an unrelated RPC rejection", async () => {
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "Method not found" } }));
    }
  }, async (credentials) => {
    await expect(dotsAdapter.run(credentials, "Hello Dot", context)).rejects.toMatchObject({
      code: "dots_rpc",
      message: "Dot rejected an RPC request (-32601): Method not found",
    });
  });
});

test("run reports Dot's own reason when a turn fails", async () => {
  // Given a failing turn whose cause arrives as Dot's JSON error envelope.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread",
        turn: {
          id: "turn-1",
          status: "failed",
          items: [],
          error: { message: JSON.stringify({ type: "error", error: {
            message: "The combined resolved image content is too large. Reduce the number or size of input images.",
            type: "invalid_request_error",
            param: "input",
            code: "image_request_too_large",
          }, status: 400 }) },
        },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "failed" } });
    }
  }, async (credentials) => {
    // When the turn runs.
    await expect(dotsAdapter.run(credentials, "Hello Dot", context)).rejects.toMatchObject({
      code: "dots_turn",
      status: 502,
      uncertain: false,
      message: 'Dot turn finished without successful completion (status "failed"): image_request_too_large: '
        + "The combined resolved image content is too large. Reduce the number or size of input images.",
    });
  });
});

test("run bounds a turn failure reason that is not an error envelope", async () => {
  // Given a failing turn with prose of its own and no envelope to unwrap.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread",
        turn: { id: "turn-1", status: "interrupted", items: [], error: { message: "x".repeat(400) } },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "interrupted" } });
    }
  }, async (credentials) => {
    // When the turn runs.
    await expect(dotsAdapter.run(credentials, "Hello Dot", context)).rejects.toMatchObject({
      code: "dots_turn",
      message: `Dot turn finished without successful completion (status "interrupted"): ${"x".repeat(197)}...`,
    });
  });
});

test("run rebinds a Dot thread whose record survived without its agent", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: "aeon", modelProvider: "", canAcceptDirectInput: false } });
      return;
    }
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "healed-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "healed-thread", turn: { id: "turn-3", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Recovered" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-3", status: "inProgress" } });
  }, async (credentials) => {
    // Then a dead-looking thread is replaced before any turn is submitted to it.
    const result = await dotsAdapter.run(credentials, "Hello Dot", { ...context, saveCredentials: (repaired) => { saved.push(repaired); } });
    expect(result).toEqual({ text: "Recovered", remoteId: "turn-3" });
  });
  expect(methods).not.toContain("thread/resume");
  expect(saved[0]).toMatchObject({ threadId: "healed-thread", threadOrigin: "self" });
});

test("run replaces a thread that is already at Dot's image ceiling before submitting", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  // Given an account whose thread already carries more image content than Dot accepts.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    // Then the prompt never reaches the thread that is over the limit.
    expect(request.params.threadId).toBe("fresh-thread");
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-1", status: "completed", items: [generated({ result: PNG_BASE64 })] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    // When a prompt is sent to that account.
    await dotsAdapter.run({ ...credentials, threadImageBytes: "12582912" }, "Hello Dot", {
      ...context, saveCredentials: (repaired) => { saved.push(repaired); },
    });
  });
  // Then the replacement is created before submission and its counter counts only what the replacement carried.
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "thread/start", "turn/start"]);
  expect(saved[0]).toMatchObject({ threadId: "fresh-thread", threadOrigin: "self", threadImageBytes: "0" });
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ threadId: "fresh-thread", threadOrigin: "self", threadImageBytes: String(Buffer.from(PNG_BASE64, "base64").length) });
});

test("run archives the thread it replaces when this gateway created that thread", async () => {
  const methods: string[] = [];
  const archived: string[] = [];
  const saved: Credentials[] = [];
  // Given an account whose own thread is over Dot's image ceiling.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/archive") {
      archived.push(String(request.params.threadId));
      reply(peer, request, {});
      return;
    }
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Drawn" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    // When the next job finds that thread over the limit.
    await dotsAdapter.run({ ...credentials, threadOrigin: "self", threadImageBytes: "12582912" }, "Hello Dot", {
      ...context, saveCredentials: (repaired) => { saved.push(repaired); },
    });
  });
  // Then the replaced thread is archived, and only the replacement stays in the account's list.
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "thread/start", "thread/archive", "turn/start"]);
  expect(archived).toEqual(["dot-thread"]);
  expect(saved[0]).toMatchObject({ threadId: "fresh-thread", threadOrigin: "self" });
});

test("run still answers when the replaced thread cannot be archived", async () => {
  const methods: string[] = [];
  // Given a rotation whose archive request Dot rejects.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/archive") {
      refuse(peer, request, "unsupported app-server method: thread/archive");
      return;
    }
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Drawn" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    // When a job rotates the account onto a replacement thread.
    const result = await dotsAdapter.run({ ...credentials, threadOrigin: "self", threadImageBytes: "12582912" }, "Hello Dot", {
      ...context, saveCredentials: () => {},
    });
    // Then housekeeping failure is not reported as a failed generation.
    expect(result).toEqual({ text: "Drawn", remoteId: "turn-1" });
  });
  expect(methods).toContain("thread/archive");
});

test("run leaves a thread the operator selected unarchived when it rotates away from it", async () => {
  const archived: string[] = [];
  // Given a thread bound by the operator in the console.
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method === "thread/archive") {
      archived.push(String(request.params.threadId));
      reply(peer, request, {});
      return;
    }
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Drawn" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    // When a rotation takes the account off that thread.
    await dotsAdapter.run({ ...credentials, threadImageBytes: "12582912" }, "Hello Dot", {
      ...context, saveCredentials: () => {},
    });
  });
  // Then the operator's own thread is left as it was.
  expect(archived).toEqual([]);
});

test("run does not replay an accepted text turn after an image-limit failure", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  // Given a thread Dot refuses because its resolved image content is too large.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    if (request.params.threadId === "dot-thread") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread",
        turn: { id: "turn-1", status: "failed", items: [], error: { message: JSON.stringify({ type: "error", error: {
          code: "image_request_too_large", message: "The combined resolved image content is too large.",
        }, status: 400 }) } },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "failed" } });
      return;
    }
    // Then the same prompt is submitted once to a replacement thread.
    expect(request.params.threadId).toBe("fresh-thread");
    expect(request.params.input).toEqual([{ type: "text", text: "Hello Dot" }]);
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-2", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Recovered" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-2", status: "inProgress" } });
  }, async (credentials) => {
    // When a text-only prompt hits the refused thread.
    await expect(dotsAdapter.run(credentials, "Hello Dot", {
      ...context, saveCredentials: (repaired) => { saved.push(repaired); },
    })).rejects.toMatchObject({ code: "dots_turn" });
  });
  // Then the accepted turn is not replayed and accounting forces a fresh next job.
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "turn/start"]);
  expect(saved[0]).toMatchObject({ threadId: "dot-thread", threadImageAccounting: "incomplete" });
});

test("run keeps the thread when the refused request carried its own reference image", async () => {
  const methods: string[] = [];
  const references = [{ mime: "image/png" as const, data: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) }];
  // Given a refusal whose cause may be the request's own image rather than the thread's content.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread",
      turn: { id: "turn-1", status: "failed", items: [], error: { message: JSON.stringify({ error: {
        code: "image_request_too_large", message: "The combined resolved image content is too large.",
      } }) } },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "failed" } });
  }, async (credentials) => {
    // When that request runs.
    await expect(dotsAdapter.run(credentials, "edit", {
      ...context, referenceImages: references, saveCredentials: () => undefined,
    })).rejects.toMatchObject({ code: "dots_turn" });
  });
  // Then the failure is reported instead of rotating a thread the request would fill again.
  expect(methods).not.toContain("thread/start");
});

test("run replaces a thread before submitting when a reference image would push it over Dot's image ceiling", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  const reference = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
  // Given a thread just under the 8 MiB ceiling and a reference image that pushes the combined content over it.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    expect(request.params.threadId).toBe("fresh-thread");
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-1", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Edited" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    const prior = 8 * 1024 * 1024 - reference.length + 1;
    const result = await dotsAdapter.run({ ...credentials, threadImageBytes: String(prior) }, "edit", {
      ...context,
      referenceImages: [{ mime: "image/png", data: reference }],
      saveCredentials: (repaired) => { saved.push(repaired); },
    });
    expect(result).toEqual({ text: "Edited", remoteId: "turn-1" });
  });
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "thread/start", "turn/start"]);
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ threadId: "fresh-thread", threadOrigin: "self", threadImageBytes: String(reference.length) });
});

test("run does not replay an accepted reference turn on a non-empty thread", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  const reference = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));
  // Given a thread that already holds images below the proactive budget, and a reference-image turn Dot refuses on it.
  await withServer((peer, request) => {
    methods.push(request.method);
    if (handshake(peer, request)) return;
    if (request.method === "thread/start") {
      reply(peer, request, { thread: { id: "fresh-thread" } });
      return;
    }
    if (request.method !== "turn/start") return;
    if (request.params.threadId === "dot-thread") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread",
        turn: { id: "turn-1", status: "failed", items: [], error: { message: JSON.stringify({ error: {
          code: "image_request_too_large", message: "The combined resolved image content is too large.",
        } }) } },
      } }));
      reply(peer, request, { turn: { id: "turn-1", status: "failed" } });
      return;
    }
    expect(request.params.threadId).toBe("fresh-thread");
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "fresh-thread", turn: { id: "turn-2", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Edited" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-2", status: "inProgress" } });
  }, async (credentials) => {
    await expect(dotsAdapter.run({ ...credentials, threadImageBytes: "1024" }, "edit", {
      ...context,
      referenceImages: [{ mime: "image/png", data: reference }],
      saveCredentials: (repaired) => { saved.push(repaired); },
    })).rejects.toMatchObject({ code: "dots_turn" });
  });
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/resume", "turn/start"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ threadId: "dot-thread", threadImageAccounting: "incomplete", threadImageBytes: String(1024 + reference.length) });
});

test("run records the image content a turn leaves on the thread", async () => {
  const saved: Credentials[] = [];
  await withServer((peer, request) => {
    if (handshake(peer, request)) return;
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "dot-thread", turn: { id: "turn-1", status: "completed", items: [generated({ result: PNG_BASE64 })] },
    } }));
    reply(peer, request, { turn: { id: "turn-1", status: "inProgress" } });
  }, async (credentials) => {
    // Given a thread that already carries known content, a turn adds a generated image and the reference it carried.
    await dotsAdapter.run({ ...credentials, threadImageBytes: "5" }, "draw", {
      ...context,
      referenceImages: [{ mime: "image/png" as const, data: new Uint8Array(Buffer.from(PNG_BASE64, "base64")) }],
      saveCredentials: (repaired) => { saved.push(repaired); },
    });
  });
  // Then the budget follows the thread for the next job.
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ threadId: "dot-thread", threadImageBytes: String(5 + 2 * Buffer.from(PNG_BASE64, "base64").length) });
});

test("run keeps using a thread this gateway created itself", async () => {
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: null, modelProvider: "local", canAcceptDirectInput: true } });
      return;
    }
    if (handshake(peer, request)) return;
    if (request.method === "turn/start") {
      peer.send(JSON.stringify({ method: "turn/completed", params: {
        threadId: "dot-thread", turn: { id: "turn-4", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Reused" }] },
      } }));
      reply(peer, request, { turn: { id: "turn-4", status: "inProgress" } });
    }
  }, async (credentials) => {
    // Given credentials already rebound by a previous job, the replacement is trusted without a new one.
    const result = await dotsAdapter.run({ ...credentials, threadOrigin: "self" }, "Hello Dot", context);
    expect(result).toEqual({ text: "Reused", remoteId: "turn-4" });
  });
  expect(methods).not.toContain("thread/start");
});
test("check rebinds a Dot thread that can never accept a turn again", async () => {
  // Given a stored thread whose agent is gone, the state a Dot that moved to the new backend leaves behind.
  const methods: string[] = [];
  const saved: Credentials[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/read" || request.method === "thread/resume") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: "aeon", modelProvider: "", canAcceptDirectInput: false } });
      return;
    }
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "healed-thread" } }); return; }
    if (request.method === "thread/archive") { reply(peer, request, {}); return; }
  }, async (credentials) => {
    // When the console checks the account.
    const result = await dotsAdapter.check(credentials, { ...context, saveCredentials: (repaired) => { saved.push(repaired); } });
    // Then the check repairs the account instead of reporting a thread that can never work again.
    expect(result.detail).toContain("replacement");
  });
  // Then the replacement is stored for later jobs, and the operator's own thread is left untouched.
  expect(methods).toEqual(["initialize", "initialized", "thread/read", "thread/start"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ threadId: "healed-thread", threadOrigin: "self", threadImageBytes: "0" });
});

test("check archives the thread it replaces when the gateway created it", async () => {
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: null, modelProvider: "", canAcceptDirectInput: false } });
      return;
    }
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "healed-thread" } }); return; }
    if (request.method === "thread/archive") {
      expect(request.params.threadId).toBe("dot-thread");
      reply(peer, request, {});
      return;
    }
  }, async (credentials) => {
    await dotsAdapter.check({ ...credentials, threadOrigin: "self" }, { ...context, saveCredentials: () => {} });
  });
  expect(methods).toContain("thread/archive");
});

test("check without a credential store reports the missing agent instead of rebinding", async () => {
  await withServer((peer, request) => {
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/read") {
      reply(peer, request, { thread: { id: "dot-thread", threadSource: "aeon", modelProvider: "", canAcceptDirectInput: false } });
    }
  }, async (credentials) => {
    const failure = await dotsAdapter.check(credentials, context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "dots_thread_missing", status: 502 });
  });
});

test("run with context switched off opens a thread per job and retires it", async () => {
  const methods: string[] = [];
  const saved: Credentials[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "job-thread" } }); return; }
    if (request.method === "thread/archive") {
      expect(request.params.threadId).toBe("job-thread");
      reply(peer, request, {});
      return;
    }
    if (request.method !== "turn/start") return;
    expect(request.params.threadId).toBe("job-thread");
    expect(request.params.input).toEqual([{ type: "text", text: "Hello Dot" }]);
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "job-thread", turn: { id: "turn-7", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Fresh" }] },
    } }));
    reply(peer, request, { turn: { id: "turn-7", status: "inProgress" } });
  }, async (credentials) => {
    const result = await dotsAdapter.run(credentials, "Hello Dot", { ...context, keepContext: false, saveCredentials: (repaired) => { saved.push(repaired); } });
    expect(result).toEqual({ text: "Fresh", remoteId: "turn-7" });
  });
  // Then the account's stored thread is neither read nor written, and the job's own thread is archived.
  expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start", "thread/archive"]);
  expect(saved).toEqual([]);
});

test("a fresh-thread job archives its thread after a failed turn", async () => {
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "job-thread" } }); return; }
    if (request.method === "thread/archive") { reply(peer, request, {}); return; }
    if (request.method !== "turn/start") return;
    peer.send(JSON.stringify({ method: "turn/completed", params: {
      threadId: "job-thread", turn: { id: "turn-8", status: "failed", items: [] },
    } }));
    reply(peer, request, { turn: { id: "turn-8", status: "inProgress" } });
  }, async (credentials) => {
    const failure = await dotsAdapter.run(credentials, "Hello Dot", { ...context, keepContext: false, saveCredentials: () => {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "dots_turn", uncertain: false });
  });
  expect(methods).toContain("thread/archive");
});

test("a fresh-thread job leaves an uncertain turn's thread alone", async () => {
  const methods: string[] = [];
  await withServer((peer, request) => {
    methods.push(request.method);
    if (request.method === "initialize") { reply(peer, request, { userAgent: "test" }); return; }
    if (request.method === "initialized") return;
    if (request.method === "thread/start") { reply(peer, request, { thread: { id: "job-thread" } }); return; }
    if (request.method === "thread/archive") { reply(peer, request, {}); return; }
    // A submission Dot never confirmed: it may still be running remotely.
    if (request.method === "turn/start") reply(peer, request, {});
  }, async (credentials) => {
    const failure = await dotsAdapter.run(credentials, "Hello Dot", { ...context, keepContext: false, saveCredentials: () => {} })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "dots_protocol", uncertain: true });
  });
  expect(methods).not.toContain("thread/archive");
});
