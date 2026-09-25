import path from "node:path";
import type { Config } from "../config/config.ts";
import type { Bus } from "../core/bus.ts";
import type { AgentEvent, TurnEndReason } from "../core/events.ts";
import {
  type AssistantMessage,
  contextSize,
  emptyUsage,
  type FileChange,
  type ImagePart,
  type Message,
  textOf,
  type ToolCallPart,
  type ToolResultPart,
  type Usage,
  type UserMessage,
  type UserPart,
} from "../core/types.ts";
import type { HookRunner } from "../hooks/hooks.ts";
import { type Mode, PermissionDeniedError, type PermissionManager, type Rule, rulesFromConfig } from "../permission/permission.ts";
import { computeCost } from "../provider/catalog.ts";
import type { ProviderRegistry } from "../provider/registry.ts";
import { type ChatRequest, type ChatResponse, type ModelInfo, ProviderError, type StreamEvent } from "../provider/types.ts";
import type { Session, SessionStore } from "../session/session.ts";
import type { Snapshotter } from "../session/snapshot.ts";
import type { ProcessManager } from "../tool/processes.ts";
import { buildToolSet, toolSpecs } from "../tool/registry.ts";
import { FileTracker, type QuestionRequest, type Tool, type ToolContext, ToolError, type ToolResult } from "../tool/types.ts";
import { newId } from "../util/ids.ts";
import { validateInput } from "../util/schema.ts";
import { clipOutput, estimateTokens, oneLine, stableStringify, truncateEnd } from "../util/text.ts";
import { type AgentInfo, isSubagent } from "./agents.ts";
import type { InstructionFile, Skill } from "./context.ts";
import { buildSystemPrompt, type EnvironmentInfo, PLAN_MODE_EXITED, PLAN_MODE_REMINDER } from "./prompt.ts";

// biome-ignore lint: heterogeneous tool inputs
type AnyTool = Tool<any>;

export interface PromptInput {
  text: string;
  images?: ImagePart[];
  /** Additional context blocks (attached files, shell output) sent with the prompt. */
  context?: string[];
}

export interface TurnOptions {
  signal: AbortSignal;
  maxSteps?: number;
  /** Mode inherited from the parent session (sub-agents). */
  inheritedMode?: Mode;
}

export interface TurnResult {
  reason: TurnEndReason;
  error?: string;
  /** Final assistant text of the turn. */
  text: string;
  usage: Usage;
  cost?: number;
  changes?: FileChange[];
  steps: number;
}

export interface PlanReview {
  approved: boolean;
  feedback?: string;
  /** Mode to switch to after approval (normal or auto-edit). */
  mode?: Mode;
}

export interface EngineOptions {
  cwd: string;
  root: string;
  config: Config;
  registry: ProviderRegistry;
  permissions: PermissionManager;
  bus: Bus<AgentEvent>;
  agents: AgentInfo[];
  skills: Map<string, Skill>;
  instructions: InstructionFile[];
  environment: () => Promise<EnvironmentInfo>;
  processes: ProcessManager;
  snapshotter: Snapshotter;
  hooks: HookRunner;
  store: SessionStore;
  /** MCP and other external tools. */
  extraTools?: () => AnyTool[];
  /** Whether a user is present to answer questions and review plans. */
  interactive?: () => boolean;
  /** Extra system prompt text (e.g. MCP server instructions). */
  promptExtra?: () => string;
  /** Language servers: files are opened on read, new errors are reported after edits. */
  lsp?: {
    touch(file: string): void;
    diagnose(files: string[]): Promise<{ text: string; errors: number } | undefined>;
  };
}

const MAX_RETRIES = 8;
const MAX_STOP_HOOK_CONTINUATIONS = 5;
const TOOL_OUTPUT_CAP = 60_000;
/** Most recent tool output (tokens) that is never pruned. */
const PRUNE_PROTECT = 40_000;
/** Prune only when at least this much (tokens) can be cleared at once, to keep cache hits. */
const PRUNE_MINIMUM = 20_000;
/** Tool results that carry decisions or instructions rather than re-fetchable data. */
const KEEP_OUTPUT = new Set(["question", "exit_plan_mode", "task", "skill", "todowrite"]);

export const COMPACTION_PROMPT = `Your task now is to write a detailed summary of this conversation. It will replace the conversation as the only context for continuing the work in a fresh context window, so capture everything needed to carry on without re-reading it:

1. The user's requests and intent: every explicit request, with the constraints and preferences they stated (quote important wording).
2. Key technical context: technologies, conventions and decisions that were made.
3. Files examined, created or modified: why each matters, and the specific details that will be needed again (function names, signatures, short snippets).
4. Errors encountered and how they were resolved, and approaches that failed and should not be retried.
5. The current state of the work: what is done and verified, and what is in progress.
6. Pending tasks and the exact next step, quoting the most recent messages to show where things stand.

Write the summary in Markdown. Be thorough about details that would be expensive to rediscover and brief about everything else. Reply with the summary only; do not call any tools.`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
  });
}

function retryDelay(err: ProviderError, attempt: number): number {
  if (err.retryAfterMs !== undefined) return Math.min(Math.max(err.retryAfterMs, 500), 5 * 60_000);
  const base = Math.min(60_000, 2000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      const t = textOf(m.parts).trim();
      if (t) return t;
    }
  }
  return "";
}

export class Engine {
  readonly opts: EngineOptions;
  private readonly trackers = new Map<string, FileTracker>();
  private readonly questions = new Map<string, (answer: string) => void>();
  private readonly plans = new Map<string, (r: PlanReview) => void>();
  /** Sessions with a turn in progress. */
  private readonly running = new Set<string>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  get bus(): Bus<AgentEvent> {
    return this.opts.bus;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  agent(name: string): AgentInfo {
    const a = this.opts.agents.find((x) => x.name === name);
    if (!a) throw new Error(`Unknown agent "${name}". Available: ${this.opts.agents.map((x) => x.name).join(", ")}`);
    return a;
  }

  private tracker(sessionId: string): FileTracker {
    let t = this.trackers.get(sessionId);
    if (!t) {
      t = new FileTracker();
      this.trackers.set(sessionId, t);
    }
    return t;
  }

  private emit(e: AgentEvent): void {
    this.opts.bus.emit(e);
  }

  // ----- interactive replies (questions, plan reviews) -----

  answerQuestion(id: string, answer: string): boolean {
    const fn = this.questions.get(id);
    if (!fn) return false;
    this.questions.delete(id);
    fn(answer);
    this.emit({ type: "question.resolved", id });
    return true;
  }

  resolvePlan(id: string, review: PlanReview): boolean {
    const fn = this.plans.get(id);
    if (!fn) return false;
    this.plans.delete(id);
    fn(review);
    this.emit({ type: "plan.resolved", id, approved: review.approved });
    return true;
  }

  private interactive(): boolean {
    return this.opts.interactive?.() ?? false;
  }

  // ----- model / tools / prompt -----

  async resolveModel(session: Session): Promise<ModelInfo> {
    return this.opts.registry.resolveModel(session.meta.model);
  }

  subagents(): AgentInfo[] {
    return this.opts.agents.filter(isSubagent);
  }

  tools(session: Session, agent: AgentInfo, model: ModelInfo): AnyTool[] {
    return buildToolSet({
      model,
      agent,
      config: this.opts.config,
      subagents: this.subagents().map((a) => ({ name: a.name, description: a.description })),
      isSubagent: session.isSubagent,
      hasSkills: this.opts.skills.size > 0,
      extraTools: this.opts.extraTools?.() ?? [],
    });
  }

  async buildSystem(session: Session, agent: AgentInfo, model: ModelInfo): Promise<string> {
    return buildSystemPrompt({
      agent,
      env: await this.opts.environment(),
      instructions: this.opts.instructions,
      skills: this.opts.skills,
      editTool: model.editTool,
      isSubagent: session.isSubagent,
      extra: this.opts.promptExtra?.() || undefined,
    });
  }

  private effort(session: Session, agent: AgentInfo, model: ModelInfo) {
    return session.meta.effort ?? agent.effort ?? this.opts.config.effort ?? model.defaultEffort;
  }

  // ----- the turn -----

  async prompt(session: Session, input: PromptInput, opts: TurnOptions): Promise<TurnResult> {
    if (this.running.has(session.id)) throw new Error("A turn is already running in this session.");
    this.running.add(session.id);
    try {
      return await this.runTurn(session, input, opts);
    } finally {
      this.running.delete(session.id);
      await session.flush().catch(() => {});
    }
  }

  private async runTurn(session: Session, input: PromptInput, opts: TurnOptions): Promise<TurnResult> {
    const { signal } = opts;
    const turnId = newId("turn");
    const started = Date.now();
    // Turn totals are deltas of the session totals, so sub-agent and compaction costs are included.
    const usageAtStart = { ...session.meta.usage };
    const costAtStart = session.meta.cost;
    let turnUsage = emptyUsage();
    let steps = 0;
    const agent = this.agent(session.meta.agent);
    let model = await this.resolveModel(session);
    const mode = (): Mode => opts.inheritedMode ?? session.meta.mode;

    if (!session.meta.system) await session.update({ system: await this.buildSystem(session, agent, model) });

    // UserPromptSubmit hooks may block the prompt or add context.
    const parts: UserPart[] = [];
    if (!session.isSubagent && this.opts.hooks.has("UserPromptSubmit")) {
      const hook = await this.opts.hooks.run("UserPromptSubmit", { session_id: session.id, prompt: input.text }, { signal });
      for (const e of hook.errors) this.emit({ type: "notice", sessionId: session.id, level: "warn", message: e });
      if (hook.blocked) {
        this.emit({ type: "notice", sessionId: session.id, level: "error", message: `Prompt blocked by hook: ${hook.message}` });
        const res: TurnResult = { reason: "blocked", error: hook.message, text: "", usage: turnUsage, steps: 0 };
        this.emit({ type: "turn.end", sessionId: session.id, turnId, reason: "blocked", error: hook.message, usage: turnUsage, steps: 0, durationMs: 0 });
        return res;
      }
      if (hook.context) parts.push({ type: "text", text: `<hook-context>\n${hook.context}\n</hook-context>`, synthetic: true });
    }
    for (const c of input.context ?? []) parts.push({ type: "text", text: c, synthetic: true });
    for (const img of input.images ?? []) parts.push(img);
    parts.push({ type: "text", text: input.text });
    const reminder = this.consumeReminder(session);
    if (reminder) parts.push({ type: "text", text: reminder, synthetic: true });

    let snapshot: string | undefined;
    if (!session.isSubagent && this.opts.config.snapshots !== false) {
      try {
        snapshot = await this.opts.snapshotter.track();
      } catch (err) {
        this.emit({ type: "notice", sessionId: session.id, level: "warn", message: `Snapshot failed (undo unavailable for this turn): ${(err as Error).message}` });
      }
    }

    // Compact before adding a prompt that would overflow the window.
    await this.pruneToolOutputs(session, model);
    if (this.needsCompaction(session, model, estimateTokens(input.text))) {
      await this.compact(session, { signal, auto: true }).catch((err) => {
        this.emit({ type: "notice", sessionId: session.id, level: "warn", message: `Compaction failed: ${(err as Error).message}` });
      });
    }

    const userMsg: UserMessage = {
      id: newId("msg"),
      role: "user",
      time: Date.now(),
      origin: "prompt",
      parts,
      snapshot,
      agent: agent.name,
      model: session.meta.model,
    };
    const firstPrompt = !session.messages.some((m) => m.role === "user" && m.origin === "prompt");
    await session.add(userMsg);
    session.redo = [];
    if (!session.meta.title) await session.update({ title: truncateEnd(oneLine(input.text), 70) || "Untitled" });
    if (firstPrompt && !session.isSubagent && this.opts.config.smallModel) void this.generateTitle(session, input.text);
    this.emit({ type: "turn.start", sessionId: session.id, turnId, message: userMsg });

    const maxSteps = opts.maxSteps ?? agent.maxSteps ?? this.opts.config.maxSteps ?? (session.isSubagent ? 200 : 500);
    const recentCalls: string[] = [];
    let stopHookRuns = 0;
    let reason: TurnEndReason = "done";
    let error: string | undefined;

    try {
      while (true) {
        if (signal.aborted) {
          reason = "aborted";
          break;
        }
        if (steps >= maxSteps) {
          reason = "max_steps";
          this.emit({ type: "notice", sessionId: session.id, level: "warn", message: `Stopped after ${maxSteps} steps (maxSteps).` });
          break;
        }
        steps++;
        model = await this.resolveModel(session);
        const tools = this.tools(session, agent, model);
        const outcome = await this.step(session, agent, model, tools, signal);
        if (outcome.kind === "error") {
          reason = signal.aborted ? "aborted" : "error";
          error = outcome.error;
          break;
        }
        if (outcome.kind === "aborted") {
          reason = "aborted";
          break;
        }
        if (outcome.kind === "refusal") {
          reason = "refusal";
          break;
        }
        const msg = outcome.message!;
        const calls = msg.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
        if (msg.stopReason === "pause_turn") continue;

        if (!calls.length) {
          if (msg.stopReason === "max_tokens") {
            reason = "max_tokens";
            this.emit({ type: "notice", sessionId: session.id, level: "warn", message: "The response hit the output token limit and was cut off. Say \"continue\" to resume." });
            break;
          }
          if (msg.stopReason === "context_window") {
            await this.compact(session, { signal, auto: true });
            continue;
          }
          // Stop hooks can send the agent back to work (exit code 2).
          if (!session.isSubagent && this.opts.hooks.has("Stop") && stopHookRuns < MAX_STOP_HOOK_CONTINUATIONS) {
            const hook = await this.opts.hooks.run("Stop", { session_id: session.id, last_message: textOf(msg.parts) }, { signal });
            for (const e of hook.errors) this.emit({ type: "notice", sessionId: session.id, level: "warn", message: e });
            if (hook.blocked && hook.message) {
              stopHookRuns++;
              await session.add({
                id: newId("msg"),
                role: "user",
                time: Date.now(),
                origin: "hook",
                parts: [{ type: "text", text: `<stop-hook-feedback>\n${hook.message}\n</stop-hook-feedback>\nAddress this feedback, then finish.` }],
              });
              this.emit({ type: "notice", sessionId: session.id, level: "info", message: `Stop hook asked to continue: ${truncateEnd(oneLine(hook.message), 200)}` });
              continue;
            }
          }
          reason = "done";
          break;
        }

        let results: ToolResultPart[];
        if (msg.stopReason === "max_tokens" || msg.stopReason === "context_window") {
          // Inputs may be truncated: never run them.
          results = calls.map((c) => ({
            type: "tool_result",
            callId: c.id,
            name: c.name,
            isError: true,
            output:
              "Not executed: your response reached the output limit, so this tool call's input may be incomplete. Retry with a smaller step, for example writing a large file in several edits.",
          }));
        } else {
          results = await this.runTools(session, agent, model, calls, signal, recentCalls, mode);
        }
        const resultMsg: UserMessage = {
          id: newId("msg"),
          role: "user",
          time: Date.now(),
          origin: "tool_results",
          parts: results,
        };
        const pending = this.consumeReminder(session);
        if (pending) resultMsg.parts.push({ type: "text", text: pending, synthetic: true });
        await session.add(resultMsg);
        if (signal.aborted) {
          reason = "aborted";
          break;
        }
        await this.pruneToolOutputs(session, model);
        if (msg.stopReason === "context_window" || this.needsCompaction(session, model, 0)) {
          await this.compact(session, { signal, auto: true }).catch((err) => {
            this.emit({ type: "notice", sessionId: session.id, level: "warn", message: `Compaction failed: ${(err as Error).message}` });
          });
        }
      }
    } catch (err) {
      reason = signal.aborted ? "aborted" : "error";
      error = (err as Error).message;
      if (reason === "error") this.emit({ type: "notice", sessionId: session.id, level: "error", message: error });
    }

    const u = session.meta.usage;
    turnUsage = {
      input: u.input - usageAtStart.input,
      output: u.output - usageAtStart.output,
      cacheRead: u.cacheRead - usageAtStart.cacheRead,
      cacheWrite: u.cacheWrite - usageAtStart.cacheWrite,
    };
    const spent = session.meta.cost - costAtStart;
    const turnCost = spent > 0 ? spent : model.pricing ? 0 : undefined;
    let changes: FileChange[] | undefined;
    if (snapshot) {
      try {
        changes = await this.opts.snapshotter.changes(snapshot);
      } catch {
        // ignore
      }
    }
    const result: TurnResult = { reason, error, text: lastAssistantText(session.active), usage: turnUsage, cost: turnCost, changes, steps };
    this.emit({
      type: "turn.end",
      sessionId: session.id,
      turnId,
      reason,
      error,
      usage: turnUsage,
      cost: turnCost,
      steps,
      durationMs: Date.now() - started,
      changes,
    });
    return result;
  }

  /** One model request, with retries, recovery and persistence. */
  private async step(
    session: Session,
    agent: AgentInfo,
    model: ModelInfo,
    tools: AnyTool[],
    signal: AbortSignal,
  ): Promise<{ kind: "ok" | "error" | "aborted" | "refusal"; message?: AssistantMessage; error?: string; usage?: Usage; cost?: number }> {
    const provider = this.opts.registry.get(model.provider);
    let compacted = false;
    for (let attempt = 0; ; attempt++) {
      const messageId = newId("msg");
      const req: ChatRequest = {
        model,
        system: session.meta.system,
        messages: session.context(),
        tools: toolSpecs(tools),
        maxOutputTokens: this.opts.config.maxOutputTokens,
        effort: this.effort(session, agent, model),
        thinking: this.opts.config.thinking,
        signal,
        sessionId: session.header.parentId ?? session.id,
      };
      this.emit({ type: "message.start", sessionId: session.id, messageId, model: model.id, provider: model.provider });
      this.emit({ type: "status", sessionId: session.id, status: "thinking" });
      let partialText = "";
      const inputBytes = new Map<string, number>();
      const started = Date.now();
      const onEvent = (e: StreamEvent) => {
        switch (e.type) {
          case "text":
            partialText += e.text;
            this.emit({ type: "message.delta", sessionId: session.id, messageId, kind: "text", text: e.text });
            break;
          case "reasoning":
            this.emit({ type: "message.delta", sessionId: session.id, messageId, kind: "reasoning", text: e.text });
            break;
          case "tool_call_start":
            this.emit({ type: "message.tool_call", sessionId: session.id, messageId, callId: e.id, name: e.name });
            break;
          case "tool_call_delta": {
            const n = (inputBytes.get(e.id) ?? 0) + e.delta.length;
            inputBytes.set(e.id, n);
            this.emit({ type: "message.tool_input", sessionId: session.id, messageId, callId: e.id, bytes: n });
            break;
          }
          case "server_tool":
            this.emit({ type: "server_tool", sessionId: session.id, name: e.name, detail: e.detail });
            break;
          case "fallback":
            this.emit({ type: "fallback", sessionId: session.id, from: e.from, to: e.to });
            break;
          case "reset":
            partialText = "";
            this.emit({ type: "message.discarded", sessionId: session.id, messageId, reason: e.reason });
            break;
          default:
            break;
        }
      };
      let res: ChatResponse;
      try {
        res = await provider.chat(req, onEvent);
      } catch (err) {
        const perr = err instanceof ProviderError ? err : new ProviderError("unknown", (err as Error).message, { cause: err });
        if (signal.aborted || perr.kind === "aborted") {
          if (partialText.trim()) {
            await session.add({
              id: messageId,
              role: "assistant",
              time: Date.now(),
              parts: [{ type: "text", text: partialText }],
              provider: model.provider,
              model: model.id,
              interrupted: true,
              stopReason: "aborted",
            });
          }
          this.emit({ type: "message.discarded", sessionId: session.id, messageId, reason: "interrupted" });
          return { kind: "aborted" };
        }
        this.emit({ type: "message.discarded", sessionId: session.id, messageId, reason: perr.message });
        if (perr.kind === "context_overflow" && !compacted) {
          compacted = true;
          this.emit({ type: "notice", sessionId: session.id, level: "warn", message: "The conversation exceeded the model's context window; compacting and retrying." });
          await this.compact(session, { signal, auto: true });
          continue;
        }
        if (perr.retryable && attempt < MAX_RETRIES) {
          const delay = retryDelay(perr, attempt);
          this.emit({ type: "retry", sessionId: session.id, attempt: attempt + 1, delayMs: delay, error: perr.message });
          this.emit({ type: "status", sessionId: session.id, status: "retrying", detail: perr.message });
          await sleep(delay, signal);
          if (signal.aborted) return { kind: "aborted" };
          continue;
        }
        const hint =
          perr.kind === "auth"
            ? ` Check the API key for provider "${model.provider}" (usta auth login ${model.provider}, or the provider's environment variable).`
            : perr.kind === "not_found"
              ? ` Check the model id "${model.id}" (usta models ${model.provider}).`
              : "";
        const message = `${perr.message}${hint}`;
        this.emit({ type: "notice", sessionId: session.id, level: "error", message });
        return { kind: "error", error: message };
      }

      const cost = computeCost(model.pricing, res.usage);
      const msg: AssistantMessage = {
        id: messageId,
        role: "assistant",
        time: Date.now(),
        parts: res.parts,
        provider: model.provider,
        model: res.model || model.id,
        usage: res.usage,
        cost,
        stopReason: res.stopReason,
        stopDetails: res.stopDetails,
        native: res.native,
        durationMs: Date.now() - started,
      };
      await session.addUsage(res.usage, cost, contextSize(res.usage) + res.usage.output);
      if (res.stopReason === "refusal") {
        // A declined response is discarded rather than kept as a normal turn.
        const cat = res.stopDetails?.category ? ` (category: ${res.stopDetails.category})` : "";
        this.emit({ type: "message.discarded", sessionId: session.id, messageId, reason: "refusal" });
        this.emit({
          type: "notice",
          sessionId: session.id,
          level: "error",
          message: `The model declined this request${cat}.${res.stopDetails?.explanation ? " " + res.stopDetails.explanation : ""} Rephrase the request or switch models with /model.`,
        });
        return { kind: "refusal", usage: res.usage, cost };
      }
      await session.add(msg);
      this.emit({ type: "message.end", sessionId: session.id, message: msg });
      return { kind: "ok", message: msg, usage: res.usage, cost };
    }
  }

  private toolContext(
    session: Session,
    agent: AgentInfo,
    model: ModelInfo,
    call: ToolCallPart,
    signal: AbortSignal,
    mode: () => Mode,
  ): ToolContext {
    const agentRules: Rule[] = rulesFromConfig(agent.permission, `agent:${agent.name}`);
    const grantScope = session.header.parentId ?? session.id;
    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      root: this.opts.root,
      sessionId: session.id,
      callId: call.id,
      agent: agent.name,
      signal,
      config: this.opts.config,
      model,
      permit: (req) =>
        this.opts.permissions.check(
          { ...req, sessionId: grantScope, tool: call.name, callId: call.id, agent: agent.name },
          { agentRules, mode: mode() },
        ),
      files: this.tracker(session.id),
      checkpoint: (file) => this.opts.snapshotter.beforeWrite(file),
      progress: (chunk) => this.emit({ type: "tool.progress", sessionId: session.id, callId: call.id, chunk }),
      todos: {
        get: () => session.meta.todos,
        set: (todos) => {
          void session.update({ todos });
          this.emit({ type: "todos", sessionId: session.id, todos });
        },
      },
      processes: this.opts.processes,
      skills: this.opts.skills,
    };
    if (!session.isSubagent) {
      ctx.runSubagent = (req) => this.runSubagent(session, req, call.id, signal);
      ctx.planMode = {
        active: () => session.meta.mode === "plan",
        exit: (plan) => this.reviewPlan(session, plan),
      };
    }
    if (this.interactive()) ctx.ask = (q) => this.askQuestion(session, q);
    return ctx;
  }

  private async runTools(
    session: Session,
    agent: AgentInfo,
    model: ModelInfo,
    calls: ToolCallPart[],
    signal: AbortSignal,
    recentCalls: string[],
    mode: () => Mode,
  ): Promise<ToolResultPart[]> {
    const tools = this.tools(session, agent, model);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const results: ToolResultPart[] = new Array(calls.length);
    this.emit({ type: "status", sessionId: session.id, status: "tools" });
    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        for (let k = i; k < calls.length; k++) {
          results[k] = { type: "tool_result", callId: calls[k]!.id, name: calls[k]!.name, isError: true, output: "Interrupted by the user before this tool ran." };
        }
        break;
      }
      const tool = byName.get(calls[i]!.name);
      if (tool?.readOnly) {
        let j = i;
        while (j < calls.length && byName.get(calls[j]!.name)?.readOnly) j++;
        const batch = calls.slice(i, j);
        const out = await Promise.all(batch.map((c) => this.runTool(session, agent, model, c, byName, signal, recentCalls, mode)));
        out.forEach((r, k) => (results[i + k] = r));
        i = j;
      } else {
        results[i] = await this.runTool(session, agent, model, calls[i]!, byName, signal, recentCalls, mode);
        i++;
      }
    }
    return results;
  }

  private async runTool(
    session: Session,
    agent: AgentInfo,
    model: ModelInfo,
    call: ToolCallPart,
    byName: Map<string, AnyTool>,
    signal: AbortSignal,
    recentCalls: string[],
    mode: () => Mode,
  ): Promise<ToolResultPart> {
    const started = Date.now();
    const tool = byName.get(call.name);
    let title = call.name;
    try {
      title = tool?.title?.(call.input as never, this.opts.cwd) ?? call.name;
    } catch {
      // title is cosmetic
    }
    this.emit({ type: "tool.start", sessionId: session.id, callId: call.id, name: call.name, input: call.input, title });
    const finish = (r: ToolResult): ToolResultPart => {
      let output = r.output ?? "";
      if (output.length > TOOL_OUTPUT_CAP) output = clipOutput(output, { maxBytes: TOOL_OUTPUT_CAP, maxLines: 4000 }).text;
      const part: ToolResultPart = {
        type: "tool_result",
        callId: call.id,
        name: call.name,
        output,
        ...(r.isError ? { isError: true } : {}),
        ...(r.images?.length ? { images: r.images } : {}),
        ...(r.title ? { title: r.title } : {}),
        ...(r.metadata ? { metadata: r.metadata } : {}),
      };
      this.emit({ type: "tool.end", sessionId: session.id, callId: call.id, name: call.name, result: part, durationMs: Date.now() - started });
      return part;
    };

    if (!tool) {
      return finish({ isError: true, output: `Unknown tool "${call.name}". Available tools: ${[...byName.keys()].join(", ")}` });
    }
    if (call.invalidJson !== undefined) {
      return finish({ isError: true, output: `The arguments were not valid JSON, so the tool did not run: ${JSON.stringify({ INVALID_JSON: truncateEnd(call.invalidJson, 2000) })}` });
    }
    const valid = validateInput(call.input, tool.parameters);
    if (!valid.ok) {
      return finish({ isError: true, output: `Invalid arguments for ${call.name}:\n- ${valid.errors.join("\n- ")}\nFix the arguments and try again.` });
    }
    const key = call.name + ":" + stableStringify(valid.value);
    const repeats = recentCalls.slice(-2).filter((k) => k === key).length;
    recentCalls.push(key);
    if (repeats >= 2 && !tool.readOnly) {
      this.emit({ type: "notice", sessionId: session.id, level: "warn", message: `Blocked a repeated identical ${call.name} call (possible loop).` });
      return finish({
        isError: true,
        output: `This exact ${call.name} call was already made twice in a row; repeating it will not change the result. Step back and try a different approach, or ask the user if you are stuck.`,
      });
    }

    const file = typeof (valid.value as { file_path?: unknown }).file_path === "string" ? String((valid.value as { file_path: string }).file_path) : undefined;
    if (this.opts.hooks.has("PreToolUse")) {
      const hook = await this.opts.hooks.run("PreToolUse", { session_id: session.id, tool_name: call.name, tool_input: valid.value }, { toolName: call.name, signal, file });
      for (const e of hook.errors) this.emit({ type: "notice", sessionId: session.id, level: "warn", message: e });
      if (hook.blocked) return finish({ isError: true, output: `Blocked by a PreToolUse hook: ${hook.message}` });
    }

    let result: ToolResult;
    try {
      result = await tool.execute(valid.value as never, this.toolContext(session, agent, model, call, signal, mode));
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        result = { isError: true, output: err.message, metadata: { denied: true } };
      } else if (err instanceof ToolError) {
        result = { isError: true, output: err.message };
      } else if (signal.aborted) {
        result = { isError: true, output: "Interrupted by the user." };
      } else {
        result = { isError: true, output: `Tool ${call.name} failed: ${(err as Error).message ?? String(err)}` };
      }
    }

    if (this.opts.hooks.has("PostToolUse") && !result.metadata?.denied) {
      const hook = await this.opts.hooks.run(
        "PostToolUse",
        { session_id: session.id, tool_name: call.name, tool_input: valid.value, tool_output: truncateEnd(result.output, 20_000), is_error: Boolean(result.isError) },
        { toolName: call.name, signal, file },
      );
      for (const e of hook.errors) this.emit({ type: "notice", sessionId: session.id, level: "warn", message: e });
      if (hook.blocked && hook.message) result = { ...result, output: `${result.output}\n\n<hook-feedback>\n${hook.message}\n</hook-feedback>` };
    }
    if (this.opts.lsp && !result.isError && result.metadata && !signal.aborted) result = await this.withDiagnostics(tool, result, signal);
    return finish(result);
  }

  /** Open files the agent reads; append errors introduced by edits (after hooks, e.g. formatters, ran). */
  private async withDiagnostics(tool: AnyTool, result: ToolResult, signal: AbortSignal): Promise<ToolResult> {
    const lsp = this.opts.lsp!;
    const md = result.metadata!;
    const rels = [...(typeof md.path === "string" ? [md.path] : []), ...(Array.isArray(md.files) ? md.files.filter((f): f is string => typeof f === "string") : [])];
    if (!rels.length) return result;
    const files = rels.map((r) => path.resolve(this.opts.root, r));
    if (tool.readOnly) {
      for (const f of files) lsp.touch(f);
      return result;
    }
    let onAbort = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let report: { text: string; errors: number } | undefined;
    try {
      report = await Promise.race([lsp.diagnose(files).catch(() => undefined), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (!report?.text) return result;
    return { ...result, output: `${result.output}\n\n${report.text}`, metadata: { ...md, diagnostics: report.errors } };
  }

  // ----- reminders (plan mode, agent switches) -----

  private readonly reminders = new Map<string, string[]>();

  /** Queue harness context for the next message sent in this session. */
  remind(sessionId: string, text: string): void {
    const list = this.reminders.get(sessionId) ?? [];
    list.push(text);
    this.reminders.set(sessionId, list);
  }

  private consumeReminder(session: Session): string | undefined {
    const list = this.reminders.get(session.id);
    if (!list?.length) return undefined;
    this.reminders.delete(session.id);
    return list.join("\n");
  }

  async setMode(session: Session, mode: Mode): Promise<void> {
    const prev = session.meta.mode;
    if (prev === mode) return;
    await session.update({ mode });
    if (mode === "plan") this.remind(session.id, PLAN_MODE_REMINDER);
    else if (prev === "plan") this.remind(session.id, PLAN_MODE_EXITED);
    this.emit({ type: "mode", sessionId: session.id, mode });
  }

  async setAgent(session: Session, name: string): Promise<void> {
    const agent = this.agent(name);
    if (session.meta.agent === name) return;
    await session.update({ agent: name });
    if (session.messages.length) {
      this.remind(
        session.id,
        `<system-reminder>The user switched to the "${agent.name}" agent: ${agent.description}${agent.prompt ? `\nInstructions for this agent:\n${agent.prompt}` : ""}</system-reminder>`,
      );
    } else {
      // Nothing sent yet: the system prompt can still change freely.
      await session.update({ system: "" });
    }
  }

  private async askQuestion(session: Session, q: QuestionRequest): Promise<string> {
    const id = newId("q");
    return new Promise((resolve) => {
      this.questions.set(id, resolve);
      this.emit({ type: "question.request", id, sessionId: session.id, request: q });
    });
  }

  private async reviewPlan(session: Session, plan: string): Promise<{ approved: boolean; feedback?: string }> {
    if (!this.interactive()) {
      return { approved: false, feedback: "The user is not available to review plans in this non-interactive run. Present the plan as your final answer and stop." };
    }
    const id = newId("plan");
    const review = await new Promise<PlanReview>((resolve) => {
      this.plans.set(id, resolve);
      this.emit({ type: "plan.review", id, sessionId: session.id, plan });
    });
    if (review.approved) {
      await session.update({ mode: review.mode ?? "normal" });
      this.emit({ type: "mode", sessionId: session.id, mode: review.mode ?? "normal" });
    }
    return { approved: review.approved, feedback: review.feedback };
  }

  // ----- sub-agents -----

  private async runSubagent(parent: Session, req: { agent: string; description: string; prompt: string }, parentCallId: string, signal: AbortSignal) {
    const agent = this.agent(req.agent);
    const child = await this.opts.store.create({
      cwd: this.opts.cwd,
      root: this.opts.root,
      model: agent.model ?? parent.meta.model,
      agent: agent.name,
      parentId: parent.id,
      title: req.description,
      effort: agent.effort ?? parent.meta.effort,
    });
    this.emit({ type: "subagent.start", sessionId: child.id, parentSessionId: parent.id, parentCallId, agent: agent.name, description: req.description });
    try {
      const res = await this.prompt(child, { text: req.prompt }, { signal, inheritedMode: parent.meta.mode });
      await parent.addUsage(res.usage, res.cost, parent.meta.lastContextTokens);
      const calls = child.messages.reduce((n, m) => n + (m.role === "assistant" ? m.parts.filter((p) => p.type === "tool_call").length : 0), 0);
      const status = res.reason === "done" ? "" : `\n\n(The sub-agent stopped early: ${res.reason}${res.error ? ` - ${res.error}` : ""}.)`;
      return { output: `${res.text || "(no report)"}${status}\n\n(sub-agent ${agent.name}: ${calls} tool calls)`, sessionId: child.id };
    } finally {
      this.emit({ type: "subagent.end", sessionId: child.id, parentSessionId: parent.id, parentCallId });
    }
  }

  /** Ask the configured small model for a short session title (best effort). */
  private async generateTitle(session: Session, text: string): Promise<void> {
    try {
      const model = await this.opts.registry.resolveModel(this.opts.config.smallModel!);
      const provider = this.opts.registry.get(model.provider);
      const res = await provider.chat(
        {
          model,
          system:
            "You write short titles for coding-assistant conversations. Reply with the title only: at most 6 words, no quotes or trailing punctuation, in the same language as the user's message.",
          messages: [{ id: newId("msg"), role: "user", time: Date.now(), origin: "prompt", parts: [{ type: "text", text: truncateEnd(text, 2000) }] }],
          tools: [],
          maxOutputTokens: 1024,
          effort: model.effortLevels.includes("low") ? "low" : undefined,
          signal: AbortSignal.timeout(30_000),
          sessionId: session.id,
        },
        () => {},
      );
      const title = oneLine(textOf(res.parts)).replace(/^["'`]|["'`.]$/g, "");
      await session.addUsage(res.usage, computeCost(model.pricing, res.usage), session.meta.lastContextTokens);
      if (title) await session.update({ title: truncateEnd(title, 80) });
    } catch {
      // keep the prompt-derived title
    }
  }

  // ----- context management -----

  /**
   * Once the context grows, replace old tool outputs (file reads, command
   * output) with a short note. The most recent outputs are kept, and pruning
   * happens in large batches so prompt caches stay warm in between.
   */
  async pruneToolOutputs(session: Session, model: ModelInfo): Promise<number> {
    if (this.opts.config.compaction?.prune === false) return 0;
    const start = Math.max(40_000, Math.min(120_000, this.compactionThreshold(model) * 0.4));
    if (session.meta.lastContextTokens < start) return 0;
    const active = session.active;
    let recent = 0;
    const ids: string[] = [];
    let freed = 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const m = active[i]!;
      if (m.role !== "user") continue;
      for (let k = m.parts.length - 1; k >= 0; k--) {
        const p = m.parts[k]!;
        if (p.type !== "tool_result" || session.pruned.has(p.callId)) continue;
        const tokens = estimateTokens(p.output) + (p.images?.length ?? 0) * 1500;
        if (recent < PRUNE_PROTECT) {
          recent += tokens;
          continue;
        }
        if (KEEP_OUTPUT.has(p.name) || tokens < 100) continue;
        ids.push(p.callId);
        freed += tokens;
      }
    }
    if (freed < PRUNE_MINIMUM) return 0;
    await session.prune(ids);
    await session.update({ lastContextTokens: Math.max(0, session.meta.lastContextTokens - freed) });
    this.emit({
      type: "notice",
      sessionId: session.id,
      level: "info",
      message: `Cleared ${ids.length} old tool output${ids.length === 1 ? "" : "s"} (~${Math.round(freed / 1000)}k tokens) to keep the context lean.`,
    });
    return freed;
  }

  compactionThreshold(model: ModelInfo): number {
    const c = this.opts.config.compaction ?? {};
    const ratio = c.threshold ?? 0.8;
    const reserve = Math.min(model.maxOutput, 32_000);
    let limit = Math.max(8000, Math.min(model.contextWindow * ratio, model.contextWindow - reserve));
    if (c.maxContextTokens) limit = Math.min(limit, c.maxContextTokens);
    return limit;
  }

  needsCompaction(session: Session, model: ModelInfo, extra: number): boolean {
    if (this.opts.config.compaction?.auto === false) return false;
    if (session.active.length < 2) return false;
    return session.meta.lastContextTokens + extra > this.compactionThreshold(model);
  }

  /** Summarize the active context into a single message and continue from it. */
  async compact(session: Session, opts: { signal: AbortSignal; instructions?: string; auto?: boolean }): Promise<string> {
    const active = session.active;
    if (!active.length) throw new Error("Nothing to compact yet.");
    const agent = this.agent(session.meta.agent);
    const modelRef = this.opts.config.compaction?.model ?? session.meta.model;
    const model = await this.opts.registry.resolveModel(modelRef);
    const provider = this.opts.registry.get(model.provider);
    const before = session.meta.lastContextTokens;
    this.emit({ type: "compaction", sessionId: session.id, phase: "start", tokensBefore: before });
    this.emit({ type: "status", sessionId: session.id, status: "compacting" });
    const request = (history: Message[]): ChatRequest => ({
      model,
      system: session.meta.system,
      messages: [
        ...history,
        {
          id: newId("msg"),
          role: "user",
          time: Date.now(),
          origin: "notice",
          parts: [{ type: "text", text: COMPACTION_PROMPT + (opts.instructions ? `\n\nAdditional instructions from the user: ${opts.instructions}` : "") }],
        },
      ],
      tools: toolSpecs(this.tools(session, agent, model)),
      toolChoice: "none",
      maxOutputTokens: 20_000,
      effort: model.effortLevels.includes("medium") ? "medium" : undefined,
      signal: opts.signal,
      sessionId: session.id,
    });
    let res: ChatResponse;
    const context = session.context();
    try {
      res = await provider.chat(request(context), () => {});
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== "context_overflow") throw err;
      // Too large even to summarize: keep the most recent part that fits.
      const budget = model.contextWindow * 0.5 * 4;
      let size = 0;
      let start = context.length;
      while (start > 0 && size < budget) size += JSON.stringify(context[--start]).length;
      while (start < context.length && !(context[start]!.role === "user" && (context[start] as UserMessage).origin !== "tool_results")) start++;
      res = await provider.chat(request(context.slice(start)), () => {});
    }
    const summary = textOf(res.parts).trim();
    if (!summary) throw new Error("The model returned an empty summary.");
    const cost = computeCost(model.pricing, res.usage);
    await session.addUsage(res.usage, cost, estimateTokens(summary));
    const summaryMsg: UserMessage = {
      id: newId("msg"),
      role: "user",
      time: Date.now(),
      origin: "summary",
      parts: [
        {
          type: "text",
          text: `<summary>\n${summary}\n</summary>\n\nThis conversation was compacted: the summary above replaces the earlier messages. Continue from where it left off. If a task was in progress, carry on with it without asking the user to repeat anything.`,
        },
      ],
    };
    const index = session.messages.length;
    await session.add(summaryMsg);
    const system = await this.buildSystem(session, agent, model);
    await session.update({ contextStart: index, system, lastContextTokens: estimateTokens(summary) + estimateTokens(system) });
    this.emit({ type: "compaction", sessionId: session.id, phase: "end", tokensBefore: before, summary });
    if (session.meta.mode === "plan") this.remind(session.id, PLAN_MODE_REMINDER);
    return summary;
  }

  // ----- undo / redo -----

  async undo(session: Session): Promise<{ prompt: string; restored: FileChange[] } | undefined> {
    const idx = session.messages.findLastIndex((m) => m.role === "user" && m.origin === "prompt");
    if (idx < 0) return undefined;
    if (idx < session.meta.contextStart) throw new Error("Cannot undo past a compaction.");
    const prompt = session.messages[idx] as UserMessage;
    let redoSnapshot: string | undefined;
    let restored: FileChange[] = [];
    if (prompt.snapshot) {
      redoSnapshot = await this.opts.snapshotter.track();
      restored = await this.opts.snapshotter.restore(prompt.snapshot);
    }
    const removed = session.messages.slice(idx);
    await session.truncate(idx);
    session.redo.push({ messages: removed, snapshot: redoSnapshot });
    this.trackers.delete(session.id);
    return { prompt: textOf(prompt.parts), restored };
  }

  async redo(session: Session): Promise<{ prompt: string; restored: FileChange[] } | undefined> {
    const entry = session.redo.pop();
    if (!entry) return undefined;
    let restored: FileChange[] = [];
    if (entry.snapshot) restored = await this.opts.snapshotter.restore(entry.snapshot);
    for (const m of entry.messages) await session.add(m);
    const prompt = entry.messages.find((m) => m.role === "user") as UserMessage | undefined;
    return { prompt: prompt ? textOf(prompt.parts) : "", restored };
  }
}
