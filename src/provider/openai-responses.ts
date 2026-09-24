import OpenAI from "openai";
import type { AssistantPart, Effort, Message, StopReason, ToolCallPart } from "../core/types.ts";
import { textOf } from "../core/types.ts";
import { mapOpenAIError, type OpenAIOptions } from "./openai.ts";
import { type ChatRequest, type ChatResponse, type Provider, ProviderError, type RemoteModel, type StreamEvent } from "./types.ts";

type InputItem = Record<string, unknown>;
type OutputItem = Record<string, unknown> & { type: string };

/** Native content kept on assistant messages produced through the Responses API. */
export interface ResponsesNative {
  /** Model id that was requested (served ids can be dated snapshots). */
  model: string;
  items: OutputItem[];
}

export const RESPONSES_FORMAT = "openai-responses";

function mapEffort(e: Effort | undefined): "low" | "medium" | "high" | undefined {
  if (!e) return undefined;
  if (e === "low" || e === "medium") return e;
  return "high";
}

function nativeOf(m: Message): ResponsesNative | undefined {
  if (m.role !== "assistant" || m.native?.format !== RESPONSES_FORMAT) return undefined;
  const c = m.native.content as ResponsesNative | undefined;
  return c && Array.isArray(c.items) ? c : undefined;
}

/**
 * Convert history to Responses API input items. Output items from earlier
 * Responses calls are replayed, including encrypted reasoning, so the model
 * keeps its chain of thought across tool calls without server-side storage.
 * Item ids are never sent: with `store: false` the server cannot look them up.
 */
export function toResponsesInput(
  messages: Message[],
  opts: { provider: string; model: string; vision?: boolean; replayReasoning?: boolean },
): InputItem[] {
  const items: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const native = nativeOf(m);
      if (native) {
        // Encrypted reasoning only makes sense to the model (and account) that produced it.
        const sameModel = opts.replayReasoning !== false && m.provider === opts.provider && native.model === opts.model;
        for (const item of native.items) {
          if (item.type === "reasoning") {
            if (sameModel && item.encrypted_content) {
              items.push({ type: "reasoning", summary: item.summary ?? [], encrypted_content: item.encrypted_content });
            }
          } else if (item.type === "message") {
            const text = ((item.content as Array<{ type: string; text?: string }>) ?? [])
              .filter((c) => c.type === "output_text")
              .map((c) => c.text ?? "")
              .join("");
            if (text) items.push({ role: "assistant", content: text });
          } else if (item.type === "function_call") {
            items.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments || "{}" });
          }
        }
        continue;
      }
      const text = textOf(m.parts, true);
      if (text) items.push({ role: "assistant", content: text });
      for (const p of m.parts) {
        if (p.type === "tool_call") items.push({ type: "function_call", call_id: p.id, name: p.name, arguments: p.invalidJson ?? JSON.stringify(p.input ?? {}) });
      }
      continue;
    }
    const content: InputItem[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        const out = p.output || (p.isError ? "Error" : "(no output)");
        const imgs = opts.vision !== false ? (p.images ?? []) : [];
        items.push({
          type: "function_call_output",
          call_id: p.callId,
          output: imgs.length
            ? [{ type: "input_text", text: out }, ...imgs.map((i) => ({ type: "input_image", image_url: `data:${i.mediaType};base64,${i.data}`, detail: "auto" }))]
            : out,
        });
      } else if (p.type === "text") {
        if (p.text) content.push({ type: "input_text", text: p.text });
      } else if (p.type === "image") {
        if (opts.vision !== false) content.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}`, detail: "auto" });
        else content.push({ type: "input_text", text: `[image${p.name ? " " + p.name : ""} omitted: the model does not accept images]` });
      }
    }
    if (content.length) items.push({ role: "user", content });
  }
  return items;
}

/** Rejected encrypted reasoning (key rotation, account change): retry without it. */
const BAD_REASONING_RE = /encrypted[ _]content|reasoning item|could not be (?:verified|decrypted)/i;

/**
 * OpenAI Responses API. Stateless: `store: false`, with reasoning carried
 * between requests as encrypted content.
 */
export class OpenAIResponsesProvider implements Provider {
  readonly id: string;
  readonly format = "openai" as const;
  private readonly client: OpenAI;
  private readonly opts: OpenAIOptions;

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
    try {
      return await this.run(req, onEvent, true);
    } catch (err) {
      const replayed = err instanceof ProviderError && err.kind === "invalid_request" && BAD_REASONING_RE.test(err.message);
      if (!replayed || req.signal.aborted) throw err;
      return this.run(req, onEvent, false);
    }
  }

  private async run(req: ChatRequest, onEvent: (e: StreamEvent) => void, replayReasoning: boolean): Promise<ChatResponse> {
    const reasoning = req.model.thinking === "effort" && this.opts.reasoningEffort !== false;
    const body: Record<string, unknown> = {
      model: req.model.id,
      instructions: req.system,
      input: toResponsesInput(req.messages, { provider: this.id, model: req.model.id, vision: req.model.vision, replayReasoning }),
      stream: true,
      store: false,
      max_output_tokens: Math.min(req.maxOutputTokens ?? req.model.maxOutput, req.model.maxOutput),
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      body.tool_choice = req.toolChoice ?? "auto";
      body.parallel_tool_calls = true;
    }
    if (reasoning) {
      body.reasoning = { effort: mapEffort(req.effort ?? req.model.defaultEffort) ?? "medium", summary: "auto" };
      body.include = ["reasoning.encrypted_content"];
    }
    if (this.opts.promptCacheKey !== false) body.prompt_cache_key = req.sessionId;
    if (this.opts.extraBody) Object.assign(body, this.opts.extraBody);

    let final: Record<string, unknown> | undefined;
    const callIds = new Map<string, string>();
    try {
      const stream = (await this.client.responses.create(body as never, { signal: req.signal })) as unknown as AsyncIterable<Record<string, unknown> & { type: string }>;
      for await (const ev of stream) {
        switch (ev.type) {
          case "response.output_text.delta":
          case "response.refusal.delta":
            onEvent({ type: "text", text: String(ev.delta ?? "") });
            break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            onEvent({ type: "reasoning", text: String(ev.delta ?? "") });
            break;
          case "response.reasoning_summary_part.added":
            if (Number(ev.summary_index) > 0) onEvent({ type: "reasoning", text: "\n\n" });
            break;
          case "response.output_item.added": {
            const item = ev.item as OutputItem | undefined;
            if (item?.type === "function_call") {
              const callId = String(item.call_id ?? item.id);
              callIds.set(String(item.id), callId);
              onEvent({ type: "tool_call_start", id: callId, name: String(item.name) });
            } else if (item?.type === "web_search_call") {
              onEvent({ type: "server_tool", name: "web_search" });
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            const id = callIds.get(String(ev.item_id));
            if (id) onEvent({ type: "tool_call_delta", id, delta: String(ev.delta ?? "") });
            break;
          }
          case "response.completed":
          case "response.incomplete":
            final = ev.response as Record<string, unknown>;
            break;
          case "response.failed": {
            const r = ev.response as { error?: { message?: string; code?: string } | null };
            throw classifyFailure(r.error?.code, r.error?.message ?? "The response failed.");
          }
          case "error":
            throw classifyFailure(ev.code as string | undefined, String(ev.message ?? "stream error"));
          default:
            break;
        }
      }
    } catch (err) {
      if (req.signal.aborted) throw new ProviderError("aborted", "Request aborted", { cause: err });
      throw mapOpenAIError(err);
    }
    if (!final) throw new ProviderError("network", "The stream ended before the response completed.");
    return convertResponse(final, req.model.id);
  }

  async listModels(signal?: AbortSignal): Promise<RemoteModel[]> {
    const out: RemoteModel[] = [];
    try {
      for await (const m of this.client.models.list({ signal })) out.push({ id: m.id });
    } catch (err) {
      throw mapOpenAIError(err);
    }
    return out;
  }
}

function classifyFailure(code: string | undefined, message: string): ProviderError {
  switch (code) {
    case "rate_limit_exceeded":
      return new ProviderError("rate_limit", message);
    case "context_length_exceeded":
      return new ProviderError("context_overflow", message);
    case "invalid_prompt":
    case "invalid_request_error":
    case "invalid_image":
    case "invalid_image_format":
      return new ProviderError("invalid_request", message);
    case "server_is_overloaded":
    case "slow_down":
      return new ProviderError("overloaded", message);
    default:
      return new ProviderError("server", message);
  }
}

export function convertResponse(res: Record<string, unknown>, requestedModel: string): ChatResponse {
  const output = (res.output as OutputItem[] | undefined) ?? [];
  const parts: AssistantPart[] = [];
  const kept: OutputItem[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      const summary = ((item.summary as Array<{ text?: string }>) ?? []).map((s) => s.text ?? "").join("\n\n");
      if (summary) parts.push({ type: "reasoning", text: summary });
      if (item.encrypted_content) kept.push({ type: "reasoning", summary: item.summary ?? [], encrypted_content: item.encrypted_content });
    } else if (item.type === "message") {
      const text = ((item.content as Array<{ type: string; text?: string; refusal?: string }>) ?? [])
        .map((c) => (c.type === "output_text" ? (c.text ?? "") : c.type === "refusal" ? (c.refusal ?? "") : ""))
        .join("");
      if (text) parts.push({ type: "text", text });
      kept.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    } else if (item.type === "function_call") {
      const part: ToolCallPart = { type: "tool_call", id: String(item.call_id), name: String(item.name), input: {} };
      const raw = String(item.arguments ?? "").trim();
      if (raw) {
        try {
          part.input = JSON.parse(raw);
        } catch {
          part.invalidJson = String(item.arguments);
        }
      }
      parts.push(part);
      kept.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments ?? "" });
    }
  }
  const usage = (res.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const hasCalls = parts.some((p) => p.type === "tool_call");
  let stop: StopReason = hasCalls ? "tool_use" : "end_turn";
  if (res.status === "incomplete") {
    const reason = (res.incomplete_details as { reason?: string } | null | undefined)?.reason;
    stop = reason === "content_filter" ? "refusal" : "max_tokens";
  }
  const native: ResponsesNative = { model: requestedModel, items: kept };
  return {
    parts,
    native: { format: RESPONSES_FORMAT, content: native },
    usage: {
      input: Math.max(0, (usage.input_tokens ?? 0) - cached),
      output: usage.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
      ...(usage.output_tokens_details?.reasoning_tokens ? { reasoning: usage.output_tokens_details.reasoning_tokens } : {}),
    },
    stopReason: stop,
    model: typeof res.model === "string" && res.model ? res.model : requestedModel,
  };
}
