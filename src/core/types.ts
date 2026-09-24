/**
 * Provider-neutral conversation model. Every provider adapter converts to and
 * from these shapes; sessions persist them as-is.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface TextPart {
  type: "text";
  text: string;
  /** Injected by the harness (reminders, attachments) rather than typed by the user. */
  synthetic?: boolean;
}

export interface ImagePart {
  type: "image";
  mediaType: string;
  /** base64 data */
  data: string;
  name?: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  redacted?: boolean;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  /** Raw argument text when it could not be parsed as JSON. */
  invalidJson?: string;
}

export interface ToolResultPart {
  type: "tool_result";
  callId: string;
  name: string;
  output: string;
  isError?: boolean;
  images?: ImagePart[];
  /** Short human-readable title for UIs. */
  title?: string;
  /** Structured data for UIs (diffs, exit codes, ...). Never sent to the model. */
  metadata?: Record<string, unknown>;
}

export type UserPart = TextPart | ImagePart | ToolResultPart;
export type AssistantPart = TextPart | ReasoningPart | ToolCallPart;

export type UserOrigin = "prompt" | "tool_results" | "summary" | "shell" | "hook" | "notice";

export interface UserMessage {
  id: string;
  role: "user";
  time: number;
  origin: UserOrigin;
  parts: UserPart[];
  /** Snapshot of the workspace taken before this prompt ran (prompts only). */
  snapshot?: string;
  agent?: string;
  model?: string;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "stop_sequence"
  | "context_window"
  | "aborted"
  | "error"
  | "other";

export interface Usage {
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) || undefined,
  };
}

/** Total prompt size seen by the model for a request. */
export function contextSize(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  time: number;
  parts: AssistantPart[];
  /** Provider id from config (e.g. "anthropic", "openrouter"). */
  provider: string;
  /** Model that served the response. */
  model: string;
  usage?: Usage;
  cost?: number;
  stopReason?: StopReason;
  stopDetails?: { category?: string | null; explanation?: string | null };
  /**
   * Provider-native content for lossless replay to the same API format
   * (Anthropic content blocks with thinking signatures, fallback markers, ...).
   */
  native?: { format: string; content: unknown };
  interrupted?: boolean;
  durationMs?: number;
}

export type Message = UserMessage | AssistantMessage;

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  additions?: number;
  deletions?: number;
}

export function textOf(parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>, includeSynthetic = false): string {
  return parts
    .filter((p) => p.type === "text" && (includeSynthetic || !p.synthetic))
    .map((p) => p.text ?? "")
    .join("");
}
