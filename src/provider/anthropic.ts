import type Anthropic from "@anthropic-ai/sdk";
import { loadAnthropic, loadedAnthropic } from "./sdk.ts";
import type { AssistantPart, Effort, Message, StopReason } from "../core/types.ts";
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

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type BetaImageBlockParam = Anthropic.Beta.Messages.BetaImageBlockParam;

export interface AnthropicOptions {
  id: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Server-side refusal fallbacks on models that support them (default: on for the official API). */
  fallbacks?: boolean;
  /** `eager_input_streaming` on client tools (default: official API only). */
  eagerToolStreaming?: boolean;
  /** "auto": explicit system breakpoint + top-level automatic caching. */
  caching?: "auto" | "explicit" | "off";
  cacheTtl?: "5m" | "1h";
  /** Anthropic's server-side web search tool. */
  webSearch?: boolean | { maxUses?: number; allowedDomains?: string[]; blockedDomains?: string[] };
  /** Thinking visibility for adaptive models. */
  thinkingDisplay?: "summarized" | "omitted";
  /** Budget for older models that use `budget_tokens` thinking. */
  thinkingBudget?: number;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const INVALID_JSON_MARKER = "Unable to parse tool parameter JSON";

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly format = "anthropic" as const;
  private sdkClient?: Anthropic;
  private readonly official: boolean;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.id = opts.id;
    this.opts = opts;
    const baseURL = opts.baseURL ?? process.env.ANTHROPIC_BASE_URL;
    this.official = !baseURL || /^https:\/\/api\.anthropic\.com\/?/.test(baseURL);
  }

  private async client(): Promise<Anthropic> {
    if (!this.sdkClient) {
      const Sdk = await loadAnthropic();
      const opts = this.opts;
      this.sdkClient = new Sdk({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.authToken ? { authToken: opts.authToken } : {}),
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        defaultHeaders: opts.headers,
        // Retries are owned by the engine so the UI can show them.
        maxRetries: 0,
        timeout: opts.timeoutMs ?? 15 * 60 * 1000,
      });
    }
    return this.sdkClient;
  }

  async chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse> {
    let stripThinking = false;
    let jsonRetries = 0;
    for (;;) {
      const params = this.buildParams(req, stripThinking);
      try {
        return await this.streamOnce(params, req, onEvent);
      } catch (err) {
        if (req.signal.aborted) throw new ProviderError("aborted", "Request aborted", { cause: err });
        const mapped = mapAnthropicError(err);
        // Earlier thinking blocks the API can no longer validate (history edited
        // outside this harness, or a signature from another endpoint): replay
        // without them once - the documented one-time recovery.
        if (
          mapped.kind === "invalid_request" &&
          !stripThinking &&
          /signature|thinking/i.test(mapped.message) &&
          hasThinking(req.messages)
        ) {
          stripThinking = true;
          onEvent({ type: "reset", reason: "retrying without earlier thinking blocks" });
          continue;
        }
        // Eager tool streaming hands malformed JSON to the client; re-issue the turn.
        const sdk = loadedAnthropic();
        if (sdk && err instanceof sdk.AnthropicError && !(err instanceof sdk.APIError) && String(err.message).includes(INVALID_JSON_MARKER) && jsonRetries < 2) {
          jsonRetries++;
          onEvent({ type: "reset", reason: "tool input was not valid JSON; re-issuing the request" });
          continue;
        }
        throw mapped;
      }
    }
  }

  private buildParams(req: ChatRequest, stripThinking: boolean): StreamParams & { betas?: string[] } {
    const model = req.model;
    const caching = this.opts.caching ?? (this.official ? "auto" : "explicit");
    const ttl = this.opts.cacheTtl === "1h" ? ({ type: "ephemeral", ttl: "1h" } as const) : ({ type: "ephemeral" } as const);
    const messages = toAnthropicMessages(req.messages, { stripThinking, vision: model.vision });
    if (caching === "explicit") markLastBlock(messages, ttl);

    let maxTokens = Math.min(req.maxOutputTokens ?? 64_000, model.maxOutput);
    const params: StreamParams & { betas?: string[] } = {
      model: model.id,
      max_tokens: maxTokens,
      system: [
        {
          type: "text",
          text: req.system,
          ...(caching !== "off" ? { cache_control: ttl } : {}),
        },
      ],
      messages,
    };
    if (caching === "auto") params.cache_control = ttl;

    const eager = this.opts.eagerToolStreaming ?? this.official;
    const tools: BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
      ...(eager ? { eager_input_streaming: true } : {}),
    }));
    const ws = this.opts.webSearch;
    if (ws) {
      const cfg = typeof ws === "object" ? ws : {};
      const legacy = model.thinking === "budget";
      tools.push({
        type: legacy ? "web_search_20250305" : "web_search_20260209",
        name: "web_search",
        ...(cfg.maxUses ? { max_uses: cfg.maxUses } : {}),
        ...(cfg.allowedDomains ? { allowed_domains: cfg.allowedDomains } : {}),
        ...(cfg.blockedDomains ? { blocked_domains: cfg.blockedDomains } : {}),
      } as BetaToolUnion);
    }
    if (tools.length) {
      params.tools = tools;
      if (req.toolChoice === "none") params.tool_choice = { type: "none" };
    }

    if (model.thinking === "adaptive") {
      const display = this.opts.thinkingDisplay ?? "summarized";
      params.thinking = model.summarizedThinkingByDefault && display === "summarized" ? { type: "adaptive" } : { type: "adaptive", display };
    } else if (model.thinking === "budget" && req.thinking) {
      const budget = Math.max(1024, this.opts.thinkingBudget ?? 16_000);
      if (maxTokens <= budget + 1024) maxTokens = Math.min(model.maxOutput, budget + 8192);
      params.max_tokens = maxTokens;
      params.thinking = { type: "enabled", budget_tokens: Math.min(budget, maxTokens - 1024) };
    }
    const effort = clampEffort(req.effort, model.effortLevels);
    if (effort) params.output_config = { effort };

    const betas: string[] = [];
    if (model.fallbacks && this.official && this.opts.fallbacks !== false) {
      params.fallbacks = "default";
      betas.push(FALLBACK_BETA);
    }
    if (betas.length) params.betas = betas;
    return params;
  }

  private async streamOnce(
    params: StreamParams & { betas?: string[] },
    req: ChatRequest,
    onEvent: (e: StreamEvent) => void,
  ): Promise<ChatResponse> {
    const stream = (await this.client()).beta.messages.stream(params, { signal: req.signal });
    const blocks = new Map<number, { type: string; id?: string; name?: string }>();
    for await (const ev of stream) {
      switch (ev.type) {
        case "message_start":
          if (ev.message.model && ev.message.model !== req.model.id) onEvent({ type: "model", model: ev.message.model });
          break;
        case "content_block_start": {
          const b = ev.content_block;
          const info: { type: string; id?: string; name?: string } = { type: b.type };
          if (b.type === "tool_use") {
            info.id = b.id;
            info.name = b.name;
            onEvent({ type: "tool_call_start", id: b.id, name: b.name });
          } else if (b.type === "server_tool_use") {
            info.id = b.id;
            info.name = b.name;
            onEvent({ type: "server_tool", name: b.name });
          } else if (b.type === "fallback") {
            onEvent({ type: "fallback", from: b.from.model, to: b.to.model });
          }
          blocks.set(ev.index, info);
          break;
        }
        case "content_block_delta": {
          const d = ev.delta;
          if (d.type === "text_delta") onEvent({ type: "text", text: d.text });
          else if (d.type === "thinking_delta") {
            if (d.thinking) onEvent({ type: "reasoning", text: d.thinking });
          } else if (d.type === "input_json_delta") {
            const b = blocks.get(ev.index);
            if (b?.type === "tool_use" && b.id) onEvent({ type: "tool_call_delta", id: b.id, delta: d.partial_json });
          }
          break;
        }
        default:
          break;
      }
    }
    const final = await stream.finalMessage();
    return convertResponse(final);
  }

  async listModels(signal?: AbortSignal): Promise<RemoteModel[]> {
    const out: RemoteModel[] = [];
    try {
      for await (const m of (await this.client()).models.list({ limit: 100 }, { signal })) {
        out.push({
          id: m.id,
          name: m.display_name,
          contextWindow: m.max_input_tokens ?? undefined,
          maxOutput: m.max_tokens ?? undefined,
        });
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }
    return out;
  }

  async describeModel(id: string, signal?: AbortSignal): Promise<Partial<ModelInfo> | undefined> {
    try {
      const m = await (await this.client()).models.retrieve(id, {}, { signal, timeout: 8000 });
      const caps = m.capabilities;
      const info: Partial<ModelInfo> = { name: m.display_name };
      if (m.max_input_tokens) info.contextWindow = m.max_input_tokens;
      if (m.max_tokens) info.maxOutput = m.max_tokens;
      if (caps) {
        info.vision = caps.image_input?.supported ?? true;
        info.thinking = caps.thinking?.types?.adaptive?.supported ? "adaptive" : caps.thinking?.supported ? "budget" : "none";
        const effort = caps.effort;
        info.effortLevels = effort?.supported
          ? (["low", "medium", "high", "xhigh", "max"] as const).filter((l) => effort[l]?.supported)
          : [];
      }
      return info;
    } catch {
      return undefined;
    }
  }
}

function clampEffort(effort: Effort | undefined, levels: Effort[]): Effort | undefined {
  if (!effort || !levels.length) return undefined;
  if (levels.includes(effort)) return effort;
  const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  const idx = order.indexOf(effort);
  for (let i = idx; i >= 0; i--) if (levels.includes(order[i]!)) return order[i];
  return levels[0];
}

function hasThinking(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      m.role === "assistant" &&
      m.native?.format === "anthropic" &&
      Array.isArray(m.native.content) &&
      (m.native.content as Array<{ type: string }>).some((b) => b.type === "thinking" || b.type === "redacted_thinking"),
  );
}

/**
 * After a mid-output fallback the declined model's partial output must not be
 * replayed: keep text, paired server-tool blocks and the fallback markers
 * before the last boundary; everything after it is echoed normally.
 */
export function sanitizeFallbackContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") boundary = i;
  });
  if (boundary < 0) return content;
  const before = content.slice(0, boundary);
  const resultIds = new Set<string>();
  for (const b of before) {
    const id = (b as { tool_use_id?: unknown }).tool_use_id;
    if (typeof id === "string") resultIds.add(id);
  }
  const keptServerUses = new Set<string>();
  for (const b of before) if (b.type === "server_tool_use" && resultIds.has(b.id)) keptServerUses.add(b.id);
  const kept = before.filter((b) => {
    if (b.type === "text" || b.type === "fallback") return true;
    if (b.type === "server_tool_use") return keptServerUses.has(b.id);
    const id = (b as { tool_use_id?: unknown }).tool_use_id;
    return typeof id === "string" && keptServerUses.has(id);
  });
  return [...kept, ...content.slice(boundary)];
}

function mapStopReason(r: string | null): StopReason {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "pause_turn":
      return "pause_turn";
    case "refusal":
      return "refusal";
    case "model_context_window_exceeded":
      return "context_window";
    default:
      return "other";
  }
}

function convertResponse(msg: BetaMessage): ChatResponse {
  const content = sanitizeFallbackContent(msg.content);
  const parts: AssistantPart[] = [];
  for (const b of content) {
    if (b.type === "text") {
      if (b.text) parts.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      if (b.thinking) parts.push({ type: "reasoning", text: b.thinking });
    } else if (b.type === "redacted_thinking") {
      parts.push({ type: "reasoning", text: "", redacted: true });
    } else if (b.type === "tool_use") {
      parts.push({ type: "tool_call", id: b.id, name: b.name, input: b.input ?? {} });
    }
  }
  const u = msg.usage;
  return {
    parts,
    native: { format: "anthropic", content },
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
    stopReason: mapStopReason(msg.stop_reason),
    stopDetails: msg.stop_details
      ? { category: msg.stop_details.category ?? null, explanation: msg.stop_details.explanation ?? null }
      : undefined,
    model: msg.model,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toAnthropicMessages(
  messages: Message[],
  opts: { stripThinking?: boolean; vision?: boolean } = {},
): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      let content: BetaContentBlockParam[];
      if (m.native?.format === "anthropic" && Array.isArray(m.native.content)) {
        content = (m.native.content as BetaContentBlockParam[]).filter(
          (b) => !opts.stripThinking || (b.type !== "thinking" && b.type !== "redacted_thinking"),
        );
      } else {
        content = [];
        for (const p of m.parts) {
          if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
          else if (p.type === "tool_call") {
            content.push({ type: "tool_use", id: p.id, name: p.name, input: isRecord(p.input) ? p.input : {} });
          }
        }
      }
      if (!content.length) content = [{ type: "text", text: "(no content)" }];
      out.push({ role: "assistant", content });
      continue;
    }
    const results: BetaContentBlockParam[] = [];
    const rest: BetaContentBlockParam[] = [];
    for (const p of m.parts) {
      if (p.type === "text") {
        if (p.text) rest.push({ type: "text", text: p.text });
      } else if (p.type === "image") {
        if (opts.vision !== false) {
          rest.push({ type: "image", source: { type: "base64", media_type: p.mediaType as "image/png", data: p.data } });
        } else rest.push({ type: "text", text: `[image${p.name ? " " + p.name : ""} omitted: the model does not accept images]` });
      } else if (p.type === "tool_result") {
        const text = p.output || (p.isError ? "Error" : "(no output)");
        const images = opts.vision !== false ? (p.images ?? []) : [];
        const inner: Array<BetaTextBlockParam | BetaImageBlockParam> = [{ type: "text", text }];
        for (const img of images) {
          inner.push({ type: "image", source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data } });
        }
        results.push({
          type: "tool_result",
          tool_use_id: p.callId,
          content: inner.length === 1 ? text : inner,
          ...(p.isError ? { is_error: true } : {}),
        });
      }
    }
    // tool_result blocks must lead the user turn.
    const content = [...results, ...rest];
    if (!content.length) content.push({ type: "text", text: "(empty)" });
    out.push({ role: "user", content });
  }
  return out;
}

function markLastBlock(messages: BetaMessageParam[], cc: { type: "ephemeral"; ttl?: "1h" }): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return;
  const idx = last.content.length - 1;
  const block = last.content[idx] as BetaContentBlockParam & { cache_control?: unknown };
  if (block.type === "thinking" || block.type === "redacted_thinking") return;
  last.content[idx] = { ...block, cache_control: cc } as BetaContentBlockParam;
}

function errorMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: string } } | undefined;
  return body?.error?.message ?? err.message;
}

export function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const Anthropic = loadedAnthropic();
  if (!Anthropic) return mapGenericError(err);
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError("aborted", "Request aborted", { cause: err });
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", `Connection error: ${err.message}`, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const type: string | undefined = err.type ?? undefined;
    const msg = errorMessage(err);
    const retryAfterMs = parseRetryAfter(err.headers as Headers | undefined);
    const o = { status, retryAfterMs, cause: err };
    if (type === "overloaded_error" || status === 529) return new ProviderError("overloaded", `Anthropic API overloaded: ${msg}`, o);
    if (status === 429 || type === "rate_limit_error") return new ProviderError("rate_limit", `Rate limited: ${msg}`, o);
    if (status === 401 || type === "authentication_error") return new ProviderError("auth", `Authentication failed: ${msg}`, o);
    if (status === 403 || type === "permission_error") return new ProviderError("permission", `Permission denied: ${msg}`, o);
    if (status === 404 || type === "not_found_error") return new ProviderError("not_found", `Not found: ${msg}`, o);
    if (status === 413 || type === "request_too_large") return new ProviderError("context_overflow", msg, o);
    if (status === 400 || type === "invalid_request_error") {
      return new ProviderError(looksLikeContextOverflow(msg) ? "context_overflow" : "invalid_request", msg, o);
    }
    return new ProviderError("server", `Anthropic API error${status ? ` ${status}` : ""}: ${msg}`, o);
  }
  if (err instanceof Anthropic.AnthropicError) return new ProviderError("network", err.message, { cause: err });
  return mapGenericError(err);
}

function mapGenericError(err: unknown): ProviderError {
  const e = err as Error;
  if (e?.name === "AbortError") return new ProviderError("aborted", "Request aborted", { cause: err });
  return new ProviderError("unknown", e?.message ?? String(err), { cause: err });
}
