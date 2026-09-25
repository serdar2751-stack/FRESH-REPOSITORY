import type { PermissionDecision, PermissionRequest } from "../permission/permission.ts";
import type { QuestionRequest } from "../tool/types.ts";
import type { AssistantMessage, FileChange, TodoItem, ToolResultPart, Usage, UserMessage } from "./types.ts";

export type TurnEndReason = "done" | "aborted" | "error" | "refusal" | "max_steps" | "max_tokens" | "blocked" | "budget";

export type AgentEvent =
  | { type: "turn.start"; sessionId: string; turnId: string; message: UserMessage }
  | { type: "message.start"; sessionId: string; messageId: string; model: string; provider: string }
  | { type: "message.delta"; sessionId: string; messageId: string; kind: "text" | "reasoning"; text: string }
  | { type: "message.tool_call"; sessionId: string; messageId: string; callId: string; name: string }
  | { type: "message.tool_input"; sessionId: string; messageId: string; callId: string; bytes: number }
  | { type: "message.discarded"; sessionId: string; messageId: string; reason: string }
  | { type: "message.end"; sessionId: string; message: AssistantMessage }
  | { type: "tool.start"; sessionId: string; callId: string; name: string; input: unknown; title: string }
  | { type: "tool.progress"; sessionId: string; callId: string; chunk: string }
  | { type: "tool.end"; sessionId: string; callId: string; name: string; result: ToolResultPart; durationMs: number }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "permission.resolved"; id: string; decision: PermissionDecision }
  | { type: "question.request"; id: string; sessionId: string; request: QuestionRequest }
  | { type: "question.resolved"; id: string }
  | { type: "plan.review"; id: string; sessionId: string; plan: string }
  | { type: "plan.resolved"; id: string; approved: boolean }
  | { type: "todos"; sessionId: string; todos: TodoItem[] }
  | { type: "status"; sessionId: string; status: "thinking" | "streaming" | "tools" | "compacting" | "retrying" | "idle"; detail?: string }
  | { type: "notice"; sessionId: string; level: "info" | "warn" | "error"; message: string }
  | { type: "retry"; sessionId: string; attempt: number; delayMs: number; error: string }
  | { type: "fallback"; sessionId: string; from: string; to: string }
  | { type: "server_tool"; sessionId: string; name: string; detail?: string }
  | { type: "compaction"; sessionId: string; phase: "start" | "end"; tokensBefore?: number; summary?: string }
  | { type: "subagent.start"; sessionId: string; parentSessionId: string; parentCallId: string; agent: string; description: string }
  | { type: "subagent.end"; sessionId: string; parentSessionId: string; parentCallId: string }
  | { type: "mode"; sessionId: string; mode: string }
  | {
      type: "turn.end";
      sessionId: string;
      turnId: string;
      reason: TurnEndReason;
      error?: string;
      usage: Usage;
      cost?: number;
      steps: number;
      durationMs: number;
      changes?: FileChange[];
    };
