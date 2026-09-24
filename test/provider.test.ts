import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Message } from "../src/core/types.ts";
import { AnthropicProvider, sanitizeFallbackContent } from "../src/provider/anthropic.ts";
import { catalogLookup } from "../src/provider/catalog.ts";
import { OpenAICompatibleProvider } from "../src/provider/openai.ts";
import { OpenAIResponsesProvider, toResponsesInput } from "../src/provider/openai-responses.ts";
import { parseModelRef, ProviderRegistry } from "../src/provider/registry.ts";
import { type ChatRequest, type ModelInfo, ProviderError, type StreamEvent } from "../src/provider/types.ts";
import { MockLLM } from "./helpers/mock-llm.ts";

const claude: ModelInfo = {
  ...catalogLookup("anthropic", "claude-opus-5")!,
  provider: "anthropic",
  source: "catalog",
};

function request(messages: Message[], model: ModelInfo = claude): ChatRequest {
  return {
    model,
    system: "You are a test.",
    messages,
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    effort: "high",
    signal: new AbortController().signal,
    sessionId: "ses_test",
  };
}

const userMsg = (text: string): Message => ({ id: "m1", role: "user", time: 0, origin: "prompt", parts: [{ type: "text", text }] });

describe("anthropic provider", () => {
  const mock = new MockLLM();
  let url = "";
  before(async () => {
    url = await mock.start();
  });
  after(() => mock.stop());

  it("streams text, thinking and tool calls", async () => {
    mock.push({
      blocks: [
        { type: "thinking", thinking: "Let me look.", signature: "sig-abc" },
        { type: "text", text: "Reading the file now." },
        { type: "tool_use", name: "read", input: { path: "src/a.ts" } },
      ],
      usage: { input: 12, output: 34, cacheRead: 1000, cacheWrite: 50 },
    });
    const p = new AnthropicProvider({ id: "anthropic", apiKey: "k", baseURL: url });
    const events: StreamEvent[] = [];
    const res = await p.chat(request([userMsg("hi")]), (e) => events.push(e));
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(
      res.parts.map((x) => x.type),
      ["reasoning", "text", "tool_call"],
    );
    const call = res.parts.find((x) => x.type === "tool_call");
    assert.deepEqual(call && call.type === "tool_call" ? call.input : null, { path: "src/a.ts" });
    assert.deepEqual(res.usage, { input: 12, output: 34, cacheRead: 1000, cacheWrite: 50 });
    assert.ok(events.some((e) => e.type === "text"));
    assert.ok(events.some((e) => e.type === "tool_call_start"));
    const native = res.native!.content as Array<{ type: string; signature?: string }>;
    assert.equal(native[0]!.type, "thinking");
    assert.equal(native[0]!.signature, "sig-abc");

    const req = mock.requests.at(-1)!.body;
    assert.deepEqual(req.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(req.output_config, { effort: "high" });
    // Custom base URL: explicit cache breakpoints, no eager streaming, no fallbacks.
    assert.equal(req.cache_control, undefined);
    assert.deepEqual(req.system[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(req.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" });
    assert.equal(req.tools[0].eager_input_streaming, undefined);
    assert.equal(req.fallbacks, undefined);
    assert.equal(req.temperature, undefined);
  });

  it("replays native assistant content verbatim", async () => {
    mock.push({ blocks: [{ type: "text", text: "ok" }] });
    const p = new AnthropicProvider({ id: "anthropic", apiKey: "k", baseURL: url });
    const history: Message[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        time: 0,
        provider: "anthropic",
        model: "claude-opus-5",
        parts: [{ type: "tool_call", id: "toolu_1", name: "read", input: { path: "x" } }],
        native: {
          format: "anthropic",
          content: [
            { type: "thinking", thinking: "", signature: "sig-1" },
            { type: "tool_use", id: "toolu_1", name: "read", input: { path: "x" } },
          ],
        },
      },
      {
        id: "u2",
        role: "user",
        time: 0,
        origin: "tool_results",
        parts: [
          { type: "tool_result", callId: "toolu_1", name: "read", output: "contents" },
          { type: "text", text: "<reminder>", synthetic: true },
        ],
      },
    ];
    await p.chat(request(history), () => {});
    const req = mock.requests.at(-1)!.body;
    assert.deepEqual(req.messages[1].content[0], { type: "thinking", thinking: "", signature: "sig-1" });
    assert.equal(req.messages[2].content[0].type, "tool_result");
    assert.equal(req.messages[2].content[0].tool_use_id, "toolu_1");
    assert.equal(req.messages[2].content[1].type, "text");
  });

  it("maps HTTP and mid-stream errors", async () => {
    const p = new AnthropicProvider({ id: "anthropic", apiKey: "k", baseURL: url });
    mock.push({ blocks: [], error: { status: 529, type: "overloaded_error", message: "Overloaded" } });
    await assert.rejects(p.chat(request([userMsg("x")]), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded" && e.retryable);
    mock.push({ blocks: [{ type: "text", text: "partial" }], midStreamError: { type: "overloaded_error", message: "Overloaded" } });
    await assert.rejects(p.chat(request([userMsg("x")]), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "overloaded");
    mock.push({ blocks: [], error: { status: 400, type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } });
    await assert.rejects(p.chat(request([userMsg("x")]), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "context_overflow");
    mock.push({ blocks: [], error: { status: 401, type: "authentication_error", message: "invalid x-api-key" } });
    await assert.rejects(p.chat(request([userMsg("x")]), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "auth" && !e.retryable);
  });

  it("retries once without thinking blocks after a signature rejection", async () => {
    const p = new AnthropicProvider({ id: "anthropic", apiKey: "k", baseURL: url });
    mock.push(
      { blocks: [], error: { status: 400, type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block." } },
      { blocks: [{ type: "text", text: "recovered" }] },
    );
    const history: Message[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        time: 0,
        provider: "anthropic",
        model: "claude-opus-5",
        parts: [{ type: "text", text: "hello" }],
        native: { format: "anthropic", content: [{ type: "thinking", thinking: "", signature: "bad" }, { type: "text", text: "hello" }] },
      },
      userMsg("again"),
    ];
    const events: StreamEvent[] = [];
    const res = await p.chat(request(history), (e) => events.push(e));
    assert.equal(res.parts[0]!.type === "text" && res.parts[0]!.text, "recovered");
    assert.ok(events.some((e) => e.type === "reset"));
    const retried = mock.requests.at(-1)!.body;
    assert.deepEqual(retried.messages[1].content, [{ type: "text", text: "hello" }]);
  });

  it("drops the declined partial before a fallback boundary", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s1" },
      { type: "text", text: "Partial " },
      { type: "tool_use", id: "t0", name: "read", input: {} },
      { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" }, trigger: null },
      { type: "text", text: "continued" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    ] as never;
    const out = sanitizeFallbackContent(content) as Array<{ type: string; id?: string }>;
    assert.deepEqual(
      out.map((b) => b.type + (b.id ? ":" + b.id : "")),
      ["text", "fallback", "text", "tool_use:t1"],
    );
  });

  it("describes models through the Models API", async () => {
    const p = new AnthropicProvider({ id: "anthropic", apiKey: "k", baseURL: url });
    const info = await p.describeModel("claude-new-model");
    assert.equal(info?.contextWindow, 123_456);
    assert.equal(info?.maxOutput, 32_000);
  });
});

describe("openai-compatible provider", () => {
  const mock = new MockLLM();
  let url = "";
  before(async () => {
    url = (await mock.start()) + "/v1";
  });
  after(() => mock.stop());

  const model: ModelInfo = {
    id: "gpt-test",
    provider: "openai",
    contextWindow: 128_000,
    maxOutput: 16_000,
    vision: true,
    thinking: "effort",
    effortLevels: ["low", "medium", "high"],
    editTool: "patch",
    source: "default",
  };

  it("streams text and parallel tool calls", async () => {
    mock.push({
      blocks: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Checking two files." },
        { type: "tool_use", name: "read", input: { path: "a" } },
        { type: "tool_use", name: "read", input: { path: "b" } },
      ],
      usage: { input: 40, output: 10, cacheRead: 60 },
    });
    const p = new OpenAICompatibleProvider({ id: "openai", apiKey: "k", baseURL: url, maxTokensField: "max_completion_tokens" });
    const res = await p.chat(request([userMsg("hi")], model), () => {});
    assert.equal(res.stopReason, "tool_use");
    const calls = res.parts.filter((x) => x.type === "tool_call");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => (c.type === "tool_call" ? c.input : null)), [{ path: "a" }, { path: "b" }]);
    assert.deepEqual(res.usage, { input: 40, output: 10, cacheRead: 60, cacheWrite: 0 });
    const req = mock.requests.at(-1)!.body;
    assert.equal(req.reasoning_effort, "high");
    assert.equal(req.max_completion_tokens, 16_000);
    assert.equal(req.messages[0].role, "system");
    assert.equal(req.tools[0].function.name, "read");
  });

  it("converts tool results into tool messages", async () => {
    mock.push({ blocks: [{ type: "text", text: "done" }] });
    const p = new OpenAICompatibleProvider({ id: "openai", apiKey: "k", baseURL: url });
    const history: Message[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        time: 0,
        provider: "anthropic",
        model: "claude-opus-5",
        parts: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "Reading." },
          { type: "tool_call", id: "toolu_9", name: "read", input: { path: "x" } },
        ],
      },
      { id: "u2", role: "user", time: 0, origin: "tool_results", parts: [{ type: "tool_result", callId: "toolu_9", name: "read", output: "data" }] },
    ];
    await p.chat(request(history, model), () => {});
    const msgs = mock.requests.at(-1)!.body.messages;
    assert.equal(msgs[2].role, "assistant");
    assert.equal(msgs[2].content, "Reading.");
    assert.equal(msgs[2].tool_calls[0].function.arguments, '{"path":"x"}');
    assert.equal(msgs[2].reasoning_content, undefined);
    assert.deepEqual(msgs[3], { role: "tool", tool_call_id: "toolu_9", content: "data" });
  });

  it("maps errors", async () => {
    const p = new OpenAICompatibleProvider({ id: "openai", apiKey: "k", baseURL: url });
    mock.push({ blocks: [], error: { status: 429, type: "rate_limit", message: "slow down" } });
    await assert.rejects(p.chat(request([userMsg("x")], model), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limit");
  });
});

describe("openai responses provider", () => {
  const mock = new MockLLM();
  let url = "";
  before(async () => {
    url = (await mock.start()) + "/v1";
  });
  after(() => mock.stop());

  const model: ModelInfo = {
    id: "gpt-test",
    provider: "openai",
    contextWindow: 400_000,
    maxOutput: 16_000,
    vision: true,
    thinking: "effort",
    effortLevels: ["low", "medium", "high"],
    defaultEffort: "medium",
    editTool: "patch",
    source: "default",
  };
  const provider = () => new OpenAIResponsesProvider({ id: "openai", apiKey: "k", baseURL: url });

  it("streams reasoning, text and parallel function calls statelessly", async () => {
    mock.push({
      blocks: [
        { type: "thinking", thinking: "Two files to read.", signature: "enc-secret" },
        { type: "text", text: "Checking two files." },
        { type: "tool_use", name: "read", input: { path: "a" }, id: "call_a" },
        { type: "tool_use", name: "read", input: { path: "b" }, id: "call_b" },
      ],
      usage: { input: 40, output: 10, cacheRead: 60, reasoning: 7 },
    });
    const events: StreamEvent[] = [];
    const res = await provider().chat(request([userMsg("hi")], model), (e) => events.push(e));
    assert.equal(res.stopReason, "tool_use");
    assert.deepEqual(res.parts[0], { type: "reasoning", text: "Two files to read." });
    assert.deepEqual(res.parts[1], { type: "text", text: "Checking two files." });
    const calls = res.parts.filter((x) => x.type === "tool_call");
    assert.deepEqual(calls.map((c) => (c.type === "tool_call" ? [c.id, c.input] : null)), [["call_a", { path: "a" }], ["call_b", { path: "b" }]]);
    assert.deepEqual(res.usage, { input: 40, output: 10, cacheRead: 60, cacheWrite: 0, reasoning: 7 });
    assert.equal(events.filter((e) => e.type === "reasoning").map((e) => (e.type === "reasoning" ? e.text : "")).join(""), "Two files to read.");
    assert.equal(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join(""), "Checking two files.");
    assert.deepEqual(events.filter((e) => e.type === "tool_call_start").map((e) => (e.type === "tool_call_start" ? e.id : "")), ["call_a", "call_b"]);
    const args = events.filter((e) => e.type === "tool_call_delta" && e.id === "call_b").map((e) => (e.type === "tool_call_delta" ? e.delta : "")).join("");
    assert.equal(args, '{"path":"b"}');
    const native = res.native as { format: string; content: { model: string; items: Array<Record<string, unknown>> } };
    assert.equal(native.format, "openai-responses");
    assert.equal(native.content.model, "gpt-test");
    assert.equal(native.content.items[0]!.encrypted_content, "enc-secret");
    assert.ok(native.content.items.every((i) => i.id === undefined));

    const req = mock.requests.at(-1)!;
    assert.equal(req.path, "/v1/responses");
    assert.equal(req.body.store, false);
    assert.equal(req.body.instructions, "You are a test.");
    assert.deepEqual(req.body.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(req.body.reasoning, { effort: "high", summary: "auto" });
    assert.equal(req.body.max_output_tokens, 16_000);
    assert.equal(req.body.prompt_cache_key, "ses_test");
    assert.deepEqual(req.body.tools[0], { type: "function", name: "read", description: "Read a file", parameters: request([]).tools[0]!.parameters, strict: false });
    assert.deepEqual(req.body.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });

  it("replays encrypted reasoning and tool results on the next request", async () => {
    mock.push({ blocks: [{ type: "thinking", thinking: "Need a file." }, { type: "tool_use", name: "read", input: { path: "x" }, id: "call_x" }] });
    const p = provider();
    const first = await p.chat(request([userMsg("hi")], model), () => {});
    const history: Message[] = [
      userMsg("hi"),
      { id: "a1", role: "assistant", time: 0, provider: "openai", model: first.model, parts: first.parts, native: first.native },
      { id: "u2", role: "user", time: 0, origin: "tool_results", parts: [{ type: "tool_result", callId: "call_x", name: "read", output: "data" }] },
    ];
    mock.push({ blocks: [{ type: "text", text: "Done." }] });
    const second = await p.chat(request(history, model), () => {});
    assert.equal(second.stopReason, "end_turn");
    const input = mock.requests.at(-1)!.body.input;
    assert.equal(input.length, 4);
    assert.equal(input[1].type, "reasoning");
    assert.match(input[1].encrypted_content, /^enc-/);
    assert.equal(input[1].id, undefined);
    assert.deepEqual(input[2], { type: "function_call", call_id: "call_x", name: "read", arguments: '{"path":"x"}' });
    assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_x", output: "data" });

    // Another model (or provider) cannot read the encrypted reasoning: it is dropped.
    const other = toResponsesInput(history, { provider: "openai", model: "gpt-other" });
    assert.ok(!other.some((i) => i.type === "reasoning"));
    assert.equal(other.length, 3);
    const elsewhere = toResponsesInput(history, { provider: "azure", model: "gpt-test" });
    assert.ok(!elsewhere.some((i) => i.type === "reasoning"));
  });

  it("converts history from other providers", async () => {
    const history: Message[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        time: 0,
        provider: "anthropic",
        model: "claude-opus-5",
        parts: [
          { type: "reasoning", text: "private" },
          { type: "text", text: "Reading." },
          { type: "tool_call", id: "toolu_9", name: "read", input: { path: "x" } },
        ],
        native: { format: "anthropic", content: [] },
      },
      {
        id: "u2",
        role: "user",
        time: 0,
        origin: "tool_results",
        parts: [{ type: "tool_result", callId: "toolu_9", name: "read", output: "img", images: [{ mediaType: "image/png", data: "AAAA" }] }],
      },
    ];
    const input = toResponsesInput(history, { provider: "openai", model: "gpt-test" });
    assert.deepEqual(input[1], { role: "assistant", content: "Reading." });
    assert.deepEqual(input[2], { type: "function_call", call_id: "toolu_9", name: "read", arguments: '{"path":"x"}' });
    assert.deepEqual(input[3], {
      type: "function_call_output",
      call_id: "toolu_9",
      output: [
        { type: "input_text", text: "img" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      ],
    });
    const blind = toResponsesInput(history, { provider: "openai", model: "gpt-test", vision: false });
    assert.equal((blind[3] as { output: unknown }).output, "img");
  });

  it("reports truncation, retries without rejected reasoning and maps errors", async () => {
    const p = provider();
    mock.push({ blocks: [{ type: "text", text: "partial" }], stopReason: "max_tokens" });
    const cut = await p.chat(request([userMsg("x")], model), () => {});
    assert.equal(cut.stopReason, "max_tokens");

    const history: Message[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        time: 0,
        provider: "openai",
        model: "gpt-test-2026-01-01",
        parts: [{ type: "text", text: "ok" }],
        native: {
          format: "openai-responses",
          content: { model: "gpt-test", items: [{ type: "reasoning", summary: [], encrypted_content: "stale" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] },
        },
      },
      userMsg("again"),
    ];
    mock.push(
      { blocks: [], error: { status: 400, type: "invalid_request_error", message: "The encrypted content for item rs_1 could not be verified." } },
      { blocks: [{ type: "text", text: "fine" }] },
    );
    const before = mock.requests.length;
    const res = await p.chat(request(history, model), () => {});
    assert.equal(res.parts[0]?.type === "text" && res.parts[0].text, "fine");
    assert.equal(mock.requests.length - before, 2);
    assert.ok(mock.requests.at(-2)!.body.input.some((i: { type?: string }) => i.type === "reasoning"));
    assert.ok(!mock.requests.at(-1)!.body.input.some((i: { type?: string }) => i.type === "reasoning"));

    mock.push({ blocks: [], error: { status: 429, type: "rate_limit", message: "slow down" } });
    await assert.rejects(p.chat(request([userMsg("x")], model), () => {}), (e: unknown) => e instanceof ProviderError && e.kind === "rate_limit");
    mock.push({ blocks: [{ type: "text", text: "half" }], midStreamError: { type: "server_error", message: "boom" } });
    await assert.rejects(p.chat(request([userMsg("x")], model), () => {}), (e: unknown) => e instanceof ProviderError && e.retryable && /boom/.test(e.message));
  });

  it("is selected by the registry for the openai preset", () => {
    const reg = new ProviderRegistry({ providers: { openai: { apiKey: "k" }, chatonly: { format: "openai", baseURL: "http://127.0.0.1:1/v1" } } });
    assert.ok(reg.get("openai") instanceof OpenAIResponsesProvider);
    assert.ok(reg.get("chatonly") instanceof OpenAICompatibleProvider);
    const chat = new ProviderRegistry({ providers: { openai: { apiKey: "k", options: { api: "chat" } } } });
    assert.ok(chat.get("openai") instanceof OpenAICompatibleProvider);
  });
});

describe("registry", () => {
  it("parses model references", () => {
    assert.deepEqual(parseModelRef("anthropic/claude-opus-5"), { provider: "anthropic", model: "claude-opus-5" });
    assert.deepEqual(parseModelRef("openrouter/anthropic/claude-opus-5"), { provider: "openrouter", model: "anthropic/claude-opus-5" });
    assert.deepEqual(parseModelRef("claude-sonnet-5"), { provider: "anthropic", model: "claude-sonnet-5" });
    assert.deepEqual(parseModelRef("gpt-5"), { provider: "openai", model: "gpt-5" });
    assert.throws(() => parseModelRef("mystery"));
  });

  it("resolves catalog models and config overrides", async () => {
    const reg = new ProviderRegistry({
      providers: { local: { format: "openai", baseURL: "http://127.0.0.1:1/v1", models: { "qwen3-coder": { contextWindow: 65_536, maxOutput: 8192 } } } },
    });
    const opus = await reg.resolveModel("anthropic/claude-opus-5", { live: false });
    assert.equal(opus.contextWindow, 1_000_000);
    assert.equal(opus.thinking, "adaptive");
    assert.equal(opus.fallbacks, true);
    const haiku = await reg.resolveModel("anthropic/claude-haiku-4-5-20251001", { live: false });
    assert.equal(haiku.thinking, "budget");
    assert.equal(haiku.contextWindow, 200_000);
    const local = await reg.resolveModel("local/qwen3-coder", { live: false });
    assert.equal(local.contextWindow, 65_536);
    assert.equal(local.source, "config");
    assert.ok(reg.hasCredentials("local"));
  });
});
