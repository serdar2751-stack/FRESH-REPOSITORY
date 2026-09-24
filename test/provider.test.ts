import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Message } from "../src/core/types.ts";
import { AnthropicProvider, sanitizeFallbackContent } from "../src/provider/anthropic.ts";
import { catalogLookup } from "../src/provider/catalog.ts";
import { OpenAICompatibleProvider } from "../src/provider/openai.ts";
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
