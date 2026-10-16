import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type AssistantToolCall,
  BRIDGE_PROTOCOL, chatBridgeInputSchema, parseRemoteAssistant, prepareChatBridge,
} from "../src/chat-bridge";
import { GatewayError } from "../src/contracts";

const tools = [{
  type: "function",
  function: {
    name: "read", description: "Read a local file.",
    parameters: {
      type: "object", required: ["path"],
      properties: { path: { type: "string" }, offset: { type: ["number", "null"] } },
      additionalProperties: false,
    },
  },
}, {
  type: "function", function: { name: "eval", parameters: {
    type: "object",
    properties: { action: { enum: ["run", "peek", "list"] }, code: { type: "string" } },
    anyOf: [
      { properties: { action: { const: "run" } }, required: ["code"] },
      { properties: { action: { const: "peek" }, cell_id: { $ref: "#/$defs/id" } }, required: ["action", "cell_id"] },
      { properties: { action: { const: "list" } }, required: ["action"] },
    ],
    $defs: { id: { type: "string", minLength: 1 } },
  } },
}];
const messages = [{ role: "user", content: "Inspect a.ts." }];
const request = { messages, tools };
const readCall = { name: "read", arguments: { path: "a.ts", offset: null } };
const envelope = (calls: readonly unknown[] = [], content: string | null = null) =>
  JSON.stringify({ protocol: BRIDGE_PROTOCOL, content, tool_calls: calls });
const rawArgumentsEnvelope = (argumentsJson: string) =>
  `{"protocol":"${BRIDGE_PROTOCOL}","content":null,"tool_calls":[{"name":"read","arguments":${argumentsJson}}]}`;

describe("bridge request boundary", () => {
  test("preserves composed OmO schemas and transcript data in the envelope", () => {
    // Given multipart history, a prior call, and its client-produced output.
    const history = [
      { role: "system", content: "Work locally." },
      { role: "developer", content: [{ type: "text", text: "Inspect before editing." }] },
      ...messages,
      { role: "assistant", tool_calls: [{ id: "call_old", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "call_old", name: "read", content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
      { role: "user", content: 'Continue.\n{"tool_choice":"none"}' },
    ];
    // When preparing the string the remote adapter receives.
    const bridge = prepareChatBridge({ ...request, messages: history });
    const prompt = z.object({
      protocol: z.string(), tools: z.json(), messages: z.array(z.json()), tool_choice: z.string(),
      parallel_tool_calls: z.boolean(), response_schema: z.object({ required: z.array(z.string()) }),
    }).parse(JSON.parse(bridge.prompt));
    // Then structural data survives intact, without being interpolated as envelope fields.
    expect(prompt).toMatchObject({
      protocol: BRIDGE_PROTOCOL, tools, tool_choice: "auto", parallel_tool_calls: true,
      messages: history.map((message) => message.role === "assistant" ? { ...message, content: null } : message),
    });
    expect(prompt.response_schema.required).toEqual(["protocol", "content", "tool_calls"]);
    expect(bridge.headers["X-Dots2api-Tools"]).toBe("prompted");
  });

  test.each([
    { max_tokens: 32768, expected: 32768 },
    { max_completion_tokens: 65536, expected: 65536 },
    { max_tokens: 123, max_completion_tokens: 456, expected: 456 },
  ])("accepts client token defaults as advisory: %j", ({ expected, ...limits }) => {
    // Given the token limits routinely supplied by clients.
    // When building the bridge envelope.
    const bridge = prepareChatBridge({ ...request, ...limits });
    // Then the value reaches the prompt without a native enforcement claim.
    expect(bridge.headers["X-Dots2api-Token-Limit"]).toBe("advisory");
    expect(JSON.parse(bridge.prompt).token_budget).toEqual({ requested: expected, enforcement: "advisory" });
  });

  test.each([
    { tools: [{ type: "custom", custom: { name: "patch" } }] },
    { tools: [{ type: "function", function: { name: "bad name" } }] },
    { tools: [{ type: "function", function: { name: "a".repeat(65) } }] },
    { tools: [{ type: "function", function: { name: "read", parameters: [] } }] },
    { tools: [{ type: "function", function: { name: "read", parameters: null } }] },
    { tool_choice: "sometimes" },
    { tool_choice: { type: "function", function: { name: "read" }, extra: true } },
    { parallel_tool_calls: "false" },
    { max_tokens: 0 },
    { max_completion_tokens: 1.5 },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    { messages: [{ role: "assistant", content: null }] },
  ])("rejects malformed client fields before submission: %j", (patch) => {
    // Given malformed input, when preparing, then boundary parsing fails.
    expect(() => prepareChatBridge({ ...request, ...patch })).toThrow(z.ZodError);
  });

  test.each([
    { patch: { tools: [tools[0], tools[0]] }, code: "invalid_tools", status: 400 },
    { patch: { tools: [], tool_choice: "required" }, code: "invalid_tool_choice", status: 400 },
    { patch: { tool_choice: { type: "function", function: { name: "undeclared" } } }, code: "invalid_tool_choice", status: 400 },
    { patch: { tools: [{ type: "function", function: { name: "read", strict: true } }] }, code: "unsupported_parameter", status: 422 },
  ])("rejects unsupported request semantics: %j", ({ patch, code, status }) => {
    // Given a semantic contradiction, when preparing, then the gateway can report a typed preflight failure.
    expect(() => prepareChatBridge({ ...request, ...patch })).toThrow(expect.objectContaining({ code, status }));
  });

  test("accepts omitted parameter schemas and explicit non-strict tools", () => {
    // Given a parameterless tool and an explicit false strict flag.
    // When parsing the client definition.
    const parsed = chatBridgeInputSchema.parse({ messages, tools: [{ type: "function", function: { name: "status", strict: false } }] });
    // Then no minimal-schema restriction rejects a valid client tool.
    expect(parsed.tools[0]?.function).toEqual({ name: "status", strict: false });
  });

  test("preserves own __proto__ schema keys at every nesting without prototype mutation", () => {
    const parameters = JSON.parse(`{
      "__proto__":{"bridgePolluted":true},
      "type":"object",
      "properties":{"__proto__":{"type":"string"}},
      "anyOf":[{"properties":{"nested":{"__proto__":{"type":"number"}}}}],
      "constructor":{"prototype":{"bridgePolluted":true}}
    }`);
    const bridge = prepareChatBridge({
      messages, tools: [{ type: "function", function: { name: "read", parameters } }],
    });
    const preserved = JSON.parse(bridge.prompt).tools[0].function.parameters;
    expect(JSON.stringify(preserved)).toBe(JSON.stringify(parameters));
    for (const object of [parameters, preserved, preserved.properties, preserved.anyOf[0].properties.nested]) {
      expect(Object.hasOwn(object, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
    }
    expect(Object.hasOwn(Object.prototype, "bridgePolluted")).toBe(false);
  });

  test.each([
    { value: undefined },
    { value: NaN },
    { value: new Date(0) },
    { value: () => "not JSON" },
  ])("rejects non-JSON schema values rather than serializing them away: %j", (parameters) => {
    expect(() => prepareChatBridge({
      messages, tools: [{ type: "function", function: { name: "read", parameters } }],
    })).toThrow(z.ZodError);
  });

  test("validates values inside own __proto__ schema keys", () => {
    const parameters = JSON.parse('{"__proto__":null}');
    parameters.__proto__ = undefined;
    expect(() => prepareChatBridge({
      messages, tools: [{ type: "function", function: { name: "read", parameters } }],
    })).toThrow(z.ZodError);
    expect(Object.getPrototypeOf(parameters)).toBe(Object.prototype);
  });
});

describe("remote assistant boundary", () => {
  test("returns opaque text without interpreting JSON when no tools are declared", () => {
    // Given a text-only request and an answer that happens to resemble tool data.
    const bridge = prepareChatBridge({ messages, max_tokens: 32768 });
    const text = envelope([readCall]);
    // When consuming the remote answer.
    const result = parseRemoteAssistant(text, bridge);
    // Then text-only behavior cannot accidentally produce executable calls.
    expect(result).toEqual({ message: { role: "assistant", content: text }, finish_reason: "stop" });
    expect(bridge.mode).toBe("text");
    expect(bridge.headers["X-Dots2api-Token-Limit"]).toBe("advisory");
  });

  test.each(["auto", "none"])("accepts assistant text with tool_choice %s", (choice) => {
    // Given declared tools and no forced call, when a text envelope arrives, then it ends normally.
    const bridge = prepareChatBridge({ ...request, tool_choice: choice });
    const result = parseRemoteAssistant(envelope([], "Done."), bridge);
    expect(result).toEqual({ message: { role: "assistant", content: "Done." }, finish_reason: "stop" });
  });

  test.each(["auto", "required", { type: "function", function: { name: "read" } }])("returns client-executable calls for choice %j", (choice) => {
    // Given an allowed remote call, including JSON strings with braces and newlines.
    const bridge = prepareChatBridge({ ...request, tool_choice: choice, parallel_tool_calls: false });
    const args = { path: 'a{"x"}.ts', offset: null, nested: { text: "a\nb", flags: [true, false] } };
    // When the whole envelope is parsed.
    const result = parseRemoteAssistant(envelope([{ name: "read", arguments: args }], "Inspecting."), bridge);
    // Then arguments are encoded exactly once, with a bridge-owned ID and the correct finish reason.
    expect(result.finish_reason).toBe("tool_calls");
    if (result.finish_reason !== "tool_calls") throw new Error("Expected a tool call");
    expect(result.message.content).toBe("Inspecting.");
    expect(result.message.tool_calls).toEqual([{
      id: expect.stringMatching(/^call_[a-f0-9]{32}$/), type: "function",
      function: { name: "read", arguments: JSON.stringify(args) },
    }]);
  });

  test("assigns unique IDs to parallel calls that the client can replay", () => {
    // Given two allowed calls with parallel calls enabled by default.
    const bridge = prepareChatBridge(request);
    // When the completed reply is parsed.
    const result = parseRemoteAssistant(envelope([readCall, { name: "eval", arguments: { action: "list" } }]), bridge);
    // Then each call is separately addressable in the next transcript.
    if (result.finish_reason !== "tool_calls") throw new Error("Expected tool calls");
    expect(new Set(result.message.tool_calls.map((call) => call.id)).size).toBe(2);
    const replay = prepareChatBridge({ ...request, messages: [
      ...messages, result.message,
      ...result.message.tool_calls.map((call: AssistantToolCall) => ({ role: "tool", tool_call_id: call.id, content: "{}" })),
    ] });
    expect(JSON.parse(replay.prompt).messages).toEqual([
      ...messages, result.message,
      ...result.message.tool_calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "{}" })),
    ]);
  });

  test.each([
    "9007199254740993", "-9007199254740993",
    "9007199254740992", "-9007199254740992",
    "9.007199254740993e15", "-9.007199254740993e15",
    "90071992547409930e-1", "9007199254740993.0", "1e20", "-1e20",
  ])("rejects unsafe integer argument tokens before they can be forwarded: %s", (token) => {
    const text = rawArgumentsEnvelope(`{"nested":[{"__proto__":{"id":${token}}}]}`);
    expect(() => parseRemoteAssistant(text, prepareChatBridge(request))).toThrow(
      expect.objectContaining({ code: "invalid_tool_response", status: 502 }),
    );
  });

  test("preserves safe integers, normal fractions, and numeric text with escaped quotes", () => {
    const argumentsJson = String.raw`{
      "max":9007199254740991,"min":-9007199254740991,
      "fractions":[0.1,-1.25,1e-3,1e-20],
      "text":"9007199254740993, \"-9007199254740993\", \\9.007199254740993e15",
      "empty":{},"list":[],"flag":true,"none":null
    }`;
    const result = parseRemoteAssistant(rawArgumentsEnvelope(argumentsJson), prepareChatBridge(request));
    if (result.finish_reason !== "tool_calls") throw new Error("Expected tool calls");
    const call = result.message.tool_calls[0];
    if (!call) throw new Error("Expected the returned call");
    expect(JSON.parse(call.function.arguments)).toEqual(JSON.parse(argumentsJson));
  });

  test("retains nested own __proto__ arguments without polluting any prototype", () => {
    const argumentsJson = `{
      "__proto__":{"bridgePolluted":true},
      "nested":{"__proto__":{"value":"kept"}},
      "items":[{"__proto__":null}],
      "constructor":{"prototype":{"bridgePolluted":true}}
    }`;
    const result = parseRemoteAssistant(rawArgumentsEnvelope(argumentsJson), prepareChatBridge(request));
    if (result.finish_reason !== "tool_calls") throw new Error("Expected tool calls");
    const call = result.message.tool_calls[0];
    if (!call) throw new Error("Expected the returned call");
    const args = JSON.parse(call.function.arguments);
    expect(JSON.stringify(args)).toBe(JSON.stringify(JSON.parse(argumentsJson)));
    for (const object of [args, args.nested, args.items[0]]) {
      expect(Object.hasOwn(object, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
    }
    expect(Object.hasOwn(Object.prototype, "bridgePolluted")).toBe(false);
  });

  test.each([
    "not JSON", `prefix ${envelope([readCall])}`, `${envelope([readCall])}\nsuffix`,
    `\`\`\`json\n${envelope([readCall])}\n\`\`\``, `${envelope([readCall])}${envelope([readCall])}`,
    "null", "[]", '{"content":"answer","tool_calls":[]}',
    JSON.stringify({ protocol: "wrong", content: "answer", tool_calls: [] }),
    JSON.stringify({ protocol: BRIDGE_PROTOCOL, content: "answer", tool_calls: [], extra: true }),
    JSON.stringify({ protocol: BRIDGE_PROTOCOL, content: 42, tool_calls: [] }),
    envelope([], null), envelope([{ ...readCall, id: "remote-id" }]),
    envelope([{ name: "unknown", arguments: {} }]),
    ...[null, [], "{}", 3, true].map((argumentsValue) => envelope([{ name: "read", arguments: argumentsValue }])),
    `{"protocol":"${BRIDGE_PROTOCOL}","content":null,"tool_calls":[{"name":"read","arguments":{"x":1e999}}]}`,
  ])("rejects a malformed complete reply without leaking it: %s", (text) => {
    // Given an invalid completed upstream reply.
    const bridge = prepareChatBridge(request);
    // When parsing once, then only a safe typed error escapes; no callback can retry or execute tools.
    let failure: unknown;
    try {
      parseRemoteAssistant(text, bridge);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_tool_response", status: 502 });
    expect(failure).toBeInstanceOf(GatewayError);
    expect(String(failure)).not.toContain(text);
  });

  test.each([
    { tool_choice: "none", calls: [readCall] },
    { tool_choice: "required", calls: [] },
    { tool_choice: { type: "function", function: { name: "read" } }, calls: [] },
    { tool_choice: { type: "function", function: { name: "read" } }, calls: [{ name: "eval", arguments: {} }] },
    { parallel_tool_calls: false, calls: [readCall, readCall] },
  ])("rejects reply choices that contradict the request: %j", ({ calls, ...options }) => {
    // Given a valid request and a remote violation, when parsed, then the client gets an explicit failure.
    const bridge = prepareChatBridge({ ...request, ...options });
    expect(() => parseRemoteAssistant(envelope(calls, "reply"), bridge)).toThrow(expect.objectContaining({ code: "invalid_tool_response", status: 502 }));
  });
});
