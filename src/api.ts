import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { accountIdSchema, approvalChoiceIdSchema, GatewayError, jobIdSchema, jobResultError, providerIdSchema } from "./contracts";
import type { ProviderId } from "./contracts";
import type { Gateway } from "./gateway";
import { chatBridgeInputSchema, prepareChatBridge, parseRemoteAssistant } from "./chat-bridge";
import { attachDotsLogin } from "./dots-login-routes";
import { attachImageGeneration, IMAGE_MODELS } from "./images-api";
import type { MuseLoginRoutes } from "./muse-login-routes";
import type { DotsAuth } from "./dots-auth";
import { parseThreadKey, THREAD_HEADER } from "./thread-key";

const credentials = z.record(z.string().max(100), z.string().max(100_000));
const createAccount = z.object({ provider: providerIdSchema, label: z.string().trim().min(1).max(80), credentials: credentials.default({}) });
const patchAccount = z.object({ label: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), keepContext: z.boolean().optional(), credentials: credentials.optional() });
const jobInput = z.object({ accountId: accountIdSchema.optional(), provider: providerIdSchema.optional(), prompt: z.string().trim().min(1).max(4_000_000) })
  .refine((value) => value.accountId || value.provider, "Choose an account or provider.");
/** Chat models this gateway serves and the provider account each one runs on. */
const CHAT_MODELS = { "dots-agent": "dots", "muse-agent": "muse" } as const satisfies Readonly<Record<string, ProviderId>>;
const chatInput = chatBridgeInputSchema.extend({
  model: z.enum(["dots-agent", "muse-agent"]),
  stream: z.boolean().default(false),
  thread: z.string().optional(),
  response_format: z.unknown().optional(),
});

function authorized(header: string | undefined, key: string): boolean {
  const provided = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${key}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createApi(gateway: Gateway, dotsAuth?: DotsAuth, museLogin?: MuseLoginRoutes): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return c.json({ error: { message: "Local access only.", code: "invalid_host" } }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && origin !== url.origin) return c.json({ error: { message: "Origin is not allowed.", code: "invalid_origin" } }, 403);
    const bearer = authorized(c.req.header("authorization"), gateway.store.apiKey);
    const sameOriginBrowser = c.req.header("sec-fetch-site") === "same-origin";
    if (url.pathname.startsWith("/v1/") ? !bearer : !bearer && !sameOriginBrowser) {
      return c.json({ error: { message: "API key required.", code: "unauthorized" } }, 401);
    }
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: { message: "Invalid request.", code: "invalid_request", fields: error.issues.map((i) => i.path.join(".")) } }, 400);
    if (error instanceof GatewayError) {
      const headers = new Headers(c.res.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      return new Response(JSON.stringify({ error: { message: error.message, code: error.code } }), {
        status: error.status, headers,
      });
    }
    if (error instanceof SyntaxError) return c.json({ error: { message: "Invalid JSON.", code: "invalid_json" } }, 400);
    return c.json({ error: { message: "Internal operation failed.", code: "internal_error" } }, 500);
  });
  app.get("/api/providers", (c) => c.json({ providers: gateway.providerStatuses() }));
  app.patch("/api/providers/:id", async (c) => {
    const id = providerIdSchema.parse(c.req.param("id"));
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    gateway.setProviderEnabled(id, enabled);
    return c.json({ provider: gateway.providerStatuses().find((provider) => provider.id === id) });
  });
  if (dotsAuth) attachDotsLogin(app, gateway, dotsAuth);
  museLogin?.attach(app);
  app.get("/api/accounts", (c) => c.json({ accounts: gateway.accounts() }));
  app.post("/api/accounts", async (c) => {
    const body = createAccount.parse(await c.req.json());
    return c.json({ account: gateway.create(body.provider, body.label, body.credentials) }, 201);
  });
  app.patch("/api/accounts/:id", async (c) => {
    const body = patchAccount.parse(await c.req.json());
    const patch = {
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.keepContext === undefined ? {} : { keepContext: body.keepContext }),
      ...(body.credentials === undefined ? {} : { credentials: body.credentials }),
    };
    return c.json({ account: gateway.update(accountIdSchema.parse(c.req.param("id")), patch) });
  });
  app.delete("/api/accounts/:id", (c) => {
    const id = accountIdSchema.parse(c.req.param("id"));
    gateway.remove(id);
    dotsAuth?.clear(id);
    return c.json({ ok: true });
  });
  app.post("/api/accounts/:id/check", async (c) => c.json({ account: await gateway.check(accountIdSchema.parse(c.req.param("id"))) }));
  app.get("/api/jobs", (c) => c.json({ jobs: gateway.store.jobs() }));
  app.delete("/api/muse-threads/:key", async (c) => {
    const key = parseThreadKey(c.req.param("key"), undefined);
    // Route parameters are always present; parsing applies the same contract as creation.
    if (key === undefined || !key.startsWith("w-")) throw new GatewayError("invalid_thread", "Only worker thread keys starting with w- can be deleted.", 400);
    const result = await gateway.museThreads.deleteKey(key);
    return c.json(result, result.threads.some((thread) => thread.status === "failed") ? 502 : 200);
  });
  app.post("/api/jobs", async (c) => {
    const body = jobInput.parse(await c.req.json());
    const job = gateway.submit({
      prompt: body.prompt,
      ...(body.accountId ? { accountId: body.accountId } : {}),
      ...(body.provider ? { provider: body.provider } : {}),
    });
    return c.json({ job }, 202);
  });
  app.get("/api/jobs/:id", (c) => {
    const job = gateway.store.job(jobIdSchema.parse(c.req.param("id")));
    if (!job) throw new GatewayError("job_not_found", "Job not found.", 404);
    return c.json({ job });
  });
  app.post("/api/jobs/:id/approvals/:promptId", async (c) => {
    if (!authorized(c.req.header("authorization"), gateway.store.apiKey)) {
      throw new GatewayError("unauthorized", "API key required.", 401);
    }
    const id = jobIdSchema.parse(c.req.param("id"));
    const { choiceId } = z.object({ choiceId: approvalChoiceIdSchema }).parse(await c.req.json());
    await gateway.approve(id, c.req.param("promptId"), choiceId);
    return c.json({ ok: true });
  });
  app.get("/api/jobs/:id/images/:index", (c) => {
    const id = jobIdSchema.parse(c.req.param("id"));
    const index = z.coerce.number().int().min(0).parse(c.req.param("index"));
    const image = gateway.store.image(id, index);
    if (!image) throw new GatewayError("image_not_found", "Image not found.", 404);
    // The type comes from the stored signature check, never from the remote agent; raster formats only.
    return c.body(image.data, 200, {
      "Content-Type": image.mime,
      "Content-Disposition": `inline; filename="job-${id.slice(0, 8)}-${index + 1}.${image.extension}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
  app.get("/api/jobs/:id/files/:index", (c) => {
    const id = jobIdSchema.parse(c.req.param("id"));
    const index = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).pipe(z.number().int()).parse(c.req.param("index"));
    const file = gateway.store.file(id, index);
    if (!file) throw new GatewayError("file_not_found", "File not found.", 404);
    const { name, mime, bytes } = file.metadata;
    const fallback = name.replace(/[^a-zA-Z0-9._ -]/g, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return c.body(file.data.stream(), 200, {
      "Content-Type": mime,
      "Content-Length": String(bytes),
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
  app.get("/api/settings", (c) => c.json({ apiKey: gateway.store.apiKey, baseUrl: `${new URL(c.req.url).origin}/v1` }));
  app.get("/api/events", (c) => streamSSE(c, async (stream) => {
    let sequence = 0;
    let dirty = true;
    let signal = Promise.withResolvers<void>();
    const publish = () => {
      dirty = true;
      signal.resolve();
    };
    const unsubscribe = gateway.subscribe(publish);
    try {
      stream.onAbort(() => signal.resolve());
      while (!stream.aborted) {
        if (dirty) {
          dirty = false;
          await stream.writeSSE({ event: "change", data: "{}", id: String(++sequence) });
        }
        if (!dirty && !stream.aborted) {
          signal = Promise.withResolvers<void>();
          await signal.promise;
        }
      }
    } finally { unsubscribe(); }
  }));
  attachImageGeneration(app, gateway);
  app.get("/v1/models", (c) => c.json({
    object: "list",
    data: [
      ...Object.values(gateway.adapters).filter((a) => a.info.capabilities.chat).map((a) => ({
        id: `${a.info.id}-agent`, object: "model", owned_by: a.info.id,
        context_window: a.info.contextWindow, context_basis: a.info.contextBasis,
        capabilities: a.info.capabilities,
      })),
      ...Object.entries(IMAGE_MODELS).map(([id, provider]) => ({ id, object: "model", owned_by: provider, capabilities: { images: true } })),
    ],
  }));
  app.post("/v1/chat/completions", async (c) => {
    const body = chatInput.parse(await c.req.json());
    if (body.response_format !== undefined) throw new GatewayError("unsupported_parameter", "response_format is not supported.", 422);
    const provider = CHAT_MODELS[body.model];
    // Muse is a browser agent chat: it has no prompted-tool bridge, so tools fail before any remote work is submitted.
    if (provider === "muse" && (body.tools.length > 0 || (body.tool_choice !== undefined && body.tool_choice !== "none"))) {
      throw new GatewayError("unsupported_parameter", "muse-agent does not support tools or tool_choice.", 400);
    }
    const bridge = prepareChatBridge(body);
    for (const [name, value] of Object.entries(bridge.headers)) c.header(name, value);
    const thread = parseThreadKey(body.thread, c.req.header(THREAD_HEADER));
    const respondAsync = c.req.header("prefer")?.split(",").some((value) => value.trim().toLowerCase() === "respond-async");
    const job = gateway.submit({ provider, prompt: bridge.prompt, kind: "chat", ...(thread ? { thread } : {}) });
    c.header("X-Dots2api-Job-Id", job.id);
    c.header("X-Dots2api-Usage", "unknown");
    if (respondAsync) {
      c.header("Preference-Applied", "respond-async");
      c.header("Location", `/api/jobs/${job.id}`);
      return c.json({ job }, 202);
    }
    const result = await gateway.wait(job.id);
    if (result.status !== "completed") throw jobResultError(result);
    if (provider === "muse" && result.remoteId) c.header("X-Muse-Thread-Id", result.remoteId);
    // An image answer is reachable as a stored job image; an image-only answer still has a non-empty reply.
    const origin = new URL(c.req.url).origin;
    const imageLinks = provider === "muse"
      ? result.images.map((_, index) => `![image ${index + 1}](${origin}/api/jobs/${job.id}/images/${index})`)
      : [];
    const text = [result.output, ...imageLinks].filter((part) => part.trim().length > 0).join("\n\n");
    const completion = parseRemoteAssistant(text, bridge);
    const fileLinks = (result.files ?? []).map(({ name }, index) =>
      `[${name.replace(/[\\[\]]/g, "\\$&")}](${origin}/api/jobs/${job.id}/files/${index})`);
    const message = fileLinks.length ? {
      ...completion.message,
      content: [completion.message.content, ...fileLinks].filter((part) => part?.trim()).join("\n\n"),
    } : completion.message;
    const id = `chatcmpl-${job.id}`;
    const created = Math.floor(Date.now() / 1000);
    if (!body.stream) return c.json({
      id, object: "chat.completion", created, model: body.model,
      choices: [{ index: 0, message, finish_reason: completion.finish_reason }],
    });
    // Buffered result delivery is explicit: no manufactured token pacing or usage counters.
    c.header("X-Dots2api-Streaming", "buffered");
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model: body.model,
        choices: [{ index: 0, delta: { ...message, ...(completion.finish_reason === "tool_calls" ? { tool_calls: completion.message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: null }],
      }) });
      await stream.writeSSE({ data: JSON.stringify({
        id, object: "chat.completion.chunk", created, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: completion.finish_reason }],
      }) });
      await stream.writeSSE({ data: "[DONE]" });
    });
  });
  app.post("/v1/responses", () => {
    throw new GatewayError("unsupported_protocol", "Use jobs or Chat Completions. Responses tool semantics are not supported.", 422);
  });
  return app;
}
