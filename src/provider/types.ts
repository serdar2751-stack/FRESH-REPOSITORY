import type { AssistantPart, Effort, Message, StopReason, Usage } from "../core/types.ts";
import type { JSONSchema } from "../util/schema.ts";

export type ApiFormat = "anthropic" | "openai";

export interface Pricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  /** Model id sent to the API. */
  id: string;
  /** Provider id from config/presets. */
  provider: string;
  name?: string;
  contextWindow: number;
  maxOutput: number;
  pricing?: Pricing;
  vision: boolean;
  /**
   * Anthropic thinking mode: "adaptive" (4.6+), "budget" (older, opt-in),
   * "none". For OpenAI-format models: "effort" means reasoning_effort works.
   */
  thinking: "adaptive" | "budget" | "effort" | "none";
  /** Thinking cannot be disabled (Fable 5.x, Opus 5.5). */
  thinkingAlwaysOn?: boolean;
  /** Adaptive thinking text is summarized by default (4.6 models): no `display` needed. */
  summarizedThinkingByDefault?: boolean;
  /** Supported effort levels; empty when effort is not configurable. */
  effortLevels: Effort[];
  defaultEffort?: Effort;
  /** Anthropic server-side refusal fallbacks (`fallbacks: "default"`). */
  fallbacks?: boolean;
  /** Preferred file-editing tool family. */
  editTool: "edit" | "patch";
  /** Whether the entry came from the built-in catalog, config or live lookup. */
  source: "catalog" | "config" | "live" | "default";
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ChatRequest {
  model: ModelInfo;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  effort?: Effort;
  /** Opt-in thinking for budget-style models. */
  thinking?: boolean;
  toolChoice?: "auto" | "none";
  signal: AbortSignal;
  sessionId: string;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "server_tool"; name: string; detail?: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "model"; model: string }
  /** Partial output so far must be discarded (a retry follows). */
  | { type: "reset"; reason: string }
  | { type: "retry"; attempt: number; delayMs: number; error: string };

export interface ChatResponse {
  parts: AssistantPart[];
  native?: { format: string; content: unknown };
  usage: Usage;
  stopReason: StopReason;
  stopDetails?: { category?: string | null; explanation?: string | null };
  /** Model that actually served the response. */
  model: string;
}

export interface RemoteModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface Provider {
  readonly id: string;
  readonly format: ApiFormat;
  chat(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<ChatResponse>;
  listModels?(signal?: AbortSignal): Promise<RemoteModel[]>;
  /** Live capability lookup (context window, output cap, thinking support). */
  describeModel?(id: string, signal?: AbortSignal): Promise<Partial<ModelInfo> | undefined>;
}

export type ProviderErrorKind =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "context_overflow"
  | "invalid_request"
  | "network"
  | "server"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "overloaded" || this.kind === "network" || this.kind === "server";
  }
}

const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context(?:[ _-]length|[ _-]window)|maximum context|too many tokens|reduce the length|input (?:is )?too long|exceeds? the (?:model'?s? )?(?:maximum|context)/i;

export function looksLikeContextOverflow(message: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(message);
}

export function parseRetryAfter(headers: { get(name: string): string | null } | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = headers.get("retry-after");
  if (!s) return undefined;
  if (Number.isFinite(Number(s))) return Number(s) * 1000;
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
