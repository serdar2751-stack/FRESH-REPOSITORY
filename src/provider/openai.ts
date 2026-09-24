import { createHash, randomBytes } from "node:crypto";
import OpenAI from "openai";
import type { AssistantPart, Effort, Message, StopReason, ToolCallPart } from "../core/types.ts";
import { textOf } from "../core/types.ts";
import {
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type Provider,
  ProviderError,
  type RemoteModel,
  type StreamEvent,
  looksLikeContextOverflow,
  parseRetryAfter,
} from "./types.ts";

export interface OpenAIOptions {
  id: string;
  /** "chat" (Chat Completions, the default) or "responses" (OpenAI Responses API). */
  api?: "chat" | "responses";
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Which request field carries the output limit. */
  maxTokensField?: "max_tokens" | "max_completion_tokens" | "none";
  /** Send `reasoning_effort` for reasoning models (default true). */
  reasoningEffort?: boolean;
  /** Echo reasoning text back as `reasoning_content` (some providers require it). */
  sendReasoning?: boolean;
  /** Send `prompt_cache_key` (OpenAI only). */
  promptCacheKey?: boolean;
  /** Rewrite tool-call ids for providers with strict id formats (e.g. Mistral). */
  toolCallIdFormat?: "any" | "alnum9";
  /** Ask for usage in the final stream chunk (stream_options.include_usage; default true). */
  includeUsage?: boolean;
  /** Extra JSON merged into every request body. */
  extraBody?: Record<string, unknown>;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly format = "openai" as const;
  private readonly client: OpenAI;
  private readonly opts: OpenAIOptions;
  private modelListCache?: Promise<Array<Record<string, unknown>>>;

  constructor(opts: OpenAIOptions) {
    this.id = opts.id;
    this.opts = opts;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "not-needed",
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      defaultHeaders: opts.headers,
      maxRetries: 0,
      timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    });
  }

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model.id,
      messages: toOpenAIMessages(req.system, req.messages, {
        vision: req.model.vision,
        sendReasoning: this.opts.sendReasoning ?? false,
        idFormat: this.opts.toolCallIdFormat ?? "any",
      }),
      stream: true,
      ...(this.opts.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = req.toolChoice ?? "auto";
    }
    const maxTokens = Math.min(req.maxOutputTokens ?? req.model.maxOutput, req.model.maxOutput);
    const field = this.opts.maxTokensField ?? "max_tokens";
    if (field !== "none") body[field] = maxTokens;
    if (req.model.thinking === "effort" && req.effort && this.opts.reasoningEffort !== false) {
      body.reasoning_effort = mapEffort(req.effort);
    }
    if (this.opts.promptCacheKey) body.prompt_cache_key = req.sessionId;
    if (this.opts.extraBody) Object.assign(body, this.opts.extraBody);

    try {
      const stream = (await this.client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: req.signal },
      )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      return await this.consume(stream, req, onEvent);
    } catch (err) {
      if (req.signal.aborted) throw new ProviderError("aborted", "Request aborted", { cause: err });
      throw mapOpenAIError(err);
    }
  }

  private async consume(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
  ): Promise<ChatResponse> {
    let text = "";
    let reasoning = "";
    let finish: string | null = null;
    let model = req.model.id;
    let usage: Record<string, unknown> | undefined;
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
    let lastIndex = -1;

    for await (const chunk of stream) {
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage as unknown as Record<string, unknown>;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, unknown> & OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta;
      const r = delta.reasoning_content ?? delta.reasoning;
      if (typeof r === "string" && r) {
        reasoning += r;
        onEvent({ type: "reasoning", text: r });
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        onEvent({ type: "text", text: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        let idx = tc.index;
        if (idx === undefined || idx === null) {
          const known = [...calls.entries()].find(([, c]) => tc.id && c.id === tc.id);
          idx = known ? known[0] : (tc.id || lastIndex < 0) ? calls.size : lastIndex;
        }
        lastIndex = idx;
        let acc = calls.get(idx);
        if (!acc) {
          acc = { id: tc.id || `call_${randomBytes(6).toString("hex")}`, name: "", args: "", started: false };
          calls.set(idx, acc);
        } else if (tc.id && !acc.started) acc.id = tc.id;
        if (tc.function?.name && !acc.name) acc.name = tc.function.name;
        if (!acc.started && acc.name) {
          acc.started = true;
          onEvent({ type: "tool_call_start", id: acc.id, name: acc.name });
        }
        if (tc.function?.arguments) {
          acc.args += tc.function.arguments;
          if (acc.started) onEvent({ type: "tool_call_delta", id: acc.id, delta: tc.function.arguments });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const parts: AssistantPart[] = [];
    if (reasoning) parts.push({ type: "reasoning", text: reasoning });
    if (text) parts.push({ type: "text", text });
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue;
      const part: ToolCallPart = { type: "tool_call", id: c.id, name: c.name, input: {} };
      const raw = c.args.trim();
      if (raw) {
        try {
          part.input = JSON.parse(raw);
        } catch {
          part.invalidJson = c.args;
        }
      }
      parts.push(part);
    }
    const hasCalls = parts.some((p) => p.type === "tool_call");
    return {
      parts,
      usage: mapUsage(usage),
      stopReason: mapFinish(finish, hasCalls),
      model,
    };
  }

  private listRaw(signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    this.modelListCache ??= (async () => {
      const out: Array<Record<string, unknown>> = [];
      for await (const m of this.client.models.list({ signal })) out.push(m as unknown as Record<string, unknown>);
      return out;
    })().catch((err) => {
      this.modelListCache = undefined;
      throw mapOpenAIError(err);
    });
    return this.modelListCache;
  }

  async listModels(signal?: AbortSignal): Promise<RemoteModel[]> {
    const raw = await this.listRaw(signal);
    return raw.map((m) => ({
      id: String(m.id),
      name: typeof m.name === "string" ? m.name : undefined,
      contextWindow: typeof m.context_length === "number" ? m.context_length : undefined,
      maxOutput: maxOutputOf(m),
    }));
  }

  /** Providers such as OpenRouter publish context length and pricing in /models. */
  async describeModel(id: string, signal?: AbortSignal): Promise<Partial<ModelInfo> | undefined> {
    let raw: Array<Record<string, unknown>>;
    try {
      raw = await this.listRaw(signal);
    } catch {
      return undefined;
    }
    const m = raw.find((x) => x.id === id);
    if (!m) return undefined;
    const info: Partial<ModelInfo> = {};
    if (typeof m.name === "string") info.name = m.name;
    if (typeof m.context_length === "number") info.contextWindow = m.context_length;
    const out = maxOutputOf(m);
    if (out) info.maxOutput = out;
    const pricing = m.pricing as Record<string, unknown> | undefined;
    if (pricing && pricing.prompt !== undefined && pricing.completion !== undefined) {
      const perM = (v: unknown) => Number(v) * 1_000_000;
      info.pricing = {
        input: perM(pricing.prompt),
        output: perM(pricing.completion),
        ...(pricing.input_cache_read !== undefined ? { cacheRead: perM(pricing.input_cache_read) } : {}),
        ...(pricing.input_cache_write !== undefined ? { cacheWrite: perM(pricing.input_cache_write) } : {}),
      };
    }
    const params = m.supported_parameters;
    if (Array.isArray(params)) {
      if (params.includes("reasoning") || params.includes("include_reasoning")) {
        info.thinking = "effort";
        info.effortLevels = ["low", "medium", "high"];
      }
    }
    const modality = (m.architecture as Record<string, unknown> | undefined)?.input_modalities;
    if (Array.isArray(modality)) info.vision = modality.includes("image");
    return info;
  }
}

function maxOutputOf(m: Record<string, unknown>): number | undefined {
  const top = m.top_provider as Record<string, unknown> | undefined;
  const v = top?.max_completion_tokens ?? m.max_completion_tokens ?? m.max_output_tokens;
  return typeof v === "number" && v > 0 ? v : undefined;
}

function mapEffort(e: Effort): "low" | "medium" | "high" {
  if (e === "low" || e === "medium") return e;
  return "high";
}

function mapFinish(reason: string | null, hasCalls: boolean): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
    case null:
      return hasCalls ? "tool_use" : "end_turn";
    default:
      return hasCalls ? "tool_use" : "other";
  }
}

function mapUsage(u: Record<string, unknown> | undefined) {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const prompt = num(u.prompt_tokens);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  // OpenAI reports cached tokens in prompt_tokens_details; DeepSeek uses prompt_cache_hit_tokens.
  const cached = num(details.cached_tokens) || num(u.prompt_cache_hit_tokens);
  const out = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const reasoning = num(out.reasoning_tokens);
  return {
    input: Math.max(0, prompt - cached),
    output: num(u.completion_tokens),
    cacheRead: cached,
    cacheWrite: 0,
    ...(reasoning ? { reasoning } : {}),
  };
}

function normalizeId(id: string, format: "any" | "alnum9"): string {
  if (format === "any") return id;
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  return createHash("sha1").update(id).digest("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 9).padEnd(9, "0");
}

export function toOpenAIMessages(
  system: string,
  messages: Message[],
  opts: { vision?: boolean; sendReasoning?: boolean; idFormat?: "any" | "alnum9" } = {},
): ChatMessage[] {
  const idf = opts.idFormat ?? "any";
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = textOf(m.parts, true);
      const toolCalls = m.parts
        .filter((p): p is ToolCallPart => p.type === "tool_call")
        .map((c) => ({
          id: normalizeId(c.id, idf),
          type: "function" as const,
          function: { name: c.name, arguments: c.invalidJson ?? JSON.stringify(c.input ?? {}) },
        }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || (toolCalls.length ? null : "(no content)") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (opts.sendReasoning) {
        const r = m.parts
          .filter((p) => p.type === "reasoning")
          .map((p) => (p.type === "reasoning" ? p.text : ""))
          .join("");
        if (r) msg.reasoning_content = r;
      }
      out.push(msg as unknown as ChatMessage);
      continue;
    }
    const images: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const p of m.parts) {
      if (p.type !== "tool_result") continue;
      out.push({ role: "tool", tool_call_id: normalizeId(p.callId, idf), content: p.output || (p.isError ? "Error" : "(no output)") });
      if (opts.vision !== false) {
        for (const img of p.images ?? []) {
          images.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
        }
      }
    }
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (images.length) content.push({ type: "text", text: "(Images returned by the tool calls above.)" }, ...images);
    for (const p of m.parts) {
      if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      else if (p.type === "image") {
        if (opts.vision !== false) content.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
        else content.push({ type: "text", text: `[image${p.name ? " " + p.name : ""} omitted: the model does not accept images]` });
      }
    }
    if (!content.length) continue;
    const allText = content.every((c) => c.type === "text");
    out.push({
      role: "user",
      content: allText ? content.map((c) => (c.type === "text" ? c.text : "")).join("\n\n") : content,
    });
  }
  return out;
}

export function mapOpenAIError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError("aborted", "Request aborted", { cause: err });
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError("network", `Connection error: ${err.message}`, { cause: err });
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    const body = err.error as { message?: string; code?: string; type?: string } | undefined;
    const msg = body?.message ?? err.message;
    const code = (err.code ?? body?.code ?? "") as string;
    const o = { status, retryAfterMs: parseRetryAfter(err.headers as Headers | undefined), cause: err };
    if (code === "context_length_exceeded" || looksLikeContextOverflow(msg)) return new ProviderError("context_overflow", msg, o);
    if (status === 429 || code === "rate_limit_exceeded") {
      if (code === "insufficient_quota") return new ProviderError("permission", `Quota exceeded: ${msg}`, { status });
      return new ProviderError("rate_limit", `Rate limited: ${msg}`, o);
    }
    if (status === 401) return new ProviderError("auth", `Authentication failed: ${msg}`, o);
    if (status === 403) return new ProviderError("permission", `Permission denied: ${msg}`, o);
    if (status === 404) return new ProviderError("not_found", `Not found: ${msg}`, o);
    if (status === 400 || status === 422) return new ProviderError("invalid_request", msg, o);
    if (status === 503 || status === 529) return new ProviderError("overloaded", `Service overloaded: ${msg}`, o);
    return new ProviderError("server", `API error${status ? ` ${status}` : ""}: ${msg}`, o);
  }
  const e = err as Error;
  if (e?.name === "AbortError") return new ProviderError("aborted", "Request aborted", { cause: err });
  if (e instanceof OpenAI.OpenAIError) return new ProviderError("network", e.message, { cause: err });
  return new ProviderError("unknown", e?.message ?? String(err), { cause: err });
}
