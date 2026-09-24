import type { AgentEvent } from "../core/events.ts";
import type { FileChange, TodoItem, ToolResultPart } from "../core/types.ts";
import { formatCost, formatDuration, formatTokens, oneLine, stripAnsi } from "../util/text.ts";
import { hardWrapAnsi, stringWidth, truncateAnsi, wrapAnsi } from "../util/width.ts";
import { c, theme } from "./ansi.ts";
import { MarkdownStream } from "./markdown.ts";
import type { Screen } from "./screen.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BULLET = "●";

interface RunningTool {
  name: string;
  title: string;
  started: number;
  tail: string;
  sessionId: string;
}

interface Child {
  parentCallId: string;
  agent: string;
  description: string;
  activity: string[];
  tools: number;
}

/** Colored excerpt of a unified diff. */
export function renderDiff(diff: string, width: number, maxLines = 24): string[] {
  const out: string[] = [];
  let oldNo = 0;
  let newNo = 0;
  let shown = 0;
  let total = 0;
  const numW = 4;
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      if (shown > 0 && shown < maxLines) out.push(c.gray("    ⋮"));
      continue;
    }
    if (!line) continue;
    total++;
    if (shown >= maxLines) continue;
    const body = line.slice(1).replace(/\t/g, "  ");
    const room = Math.max(10, width - numW - 8);
    const text = stringWidth(body) > room ? truncateAnsi(body, room) : body;
    if (line[0] === "+") {
      out.push(`    ${c.gray(String(newNo).padStart(numW))} ${theme.addedBg(theme.added("+ " + text))}`);
      newNo++;
    } else if (line[0] === "-") {
      out.push(`    ${c.gray(String(oldNo).padStart(numW))} ${theme.removedBg(theme.removed("- " + text))}`);
      oldNo++;
    } else {
      out.push(`    ${c.gray(String(newNo).padStart(numW))}   ${c.gray(text)}`);
      oldNo++;
      newNo++;
    }
    shown++;
  }
  if (total > shown) out.push(c.gray(`    … ${total - shown} more lines`));
  return out;
}

export function renderTodos(todos: TodoItem[]): string[] {
  return todos.map((t) => {
    if (t.status === "completed") return `    ${c.green("☑")} ${c.gray(c.strike(t.content))}`;
    if (t.status === "in_progress") return `    ${theme.accent("◐")} ${c.bold(t.activeForm ?? t.content)}`;
    if (t.status === "cancelled") return `    ${c.gray("☒ " + t.content)}`;
    return `    ☐ ${t.content}`;
  });
}

export function renderChanges(changes: FileChange[]): string {
  const add = changes.reduce((n, ch) => n + (ch.additions ?? 0), 0);
  const del = changes.reduce((n, ch) => n + (ch.deletions ?? 0), 0);
  const files = `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
  return add || del ? `${files} ${c.green(`+${add}`)} ${c.red(`-${del}`)}` : files;
}

function lastLines(text: string, n: number): string[] {
  const lines = stripAnsi(text).replace(/\r/g, "").trimEnd().split("\n");
  return lines.slice(-n);
}

/** Summary line(s) printed when a tool finishes. */
export function formatToolResult(name: string, title: string, r: ToolResultPart, width: number, verbose: boolean): string[] {
  const ok = !r.isError;
  const head = `${ok ? c.green(BULLET) : c.red(BULLET)} ${theme.tool(name)} ${truncateAnsi(title, Math.max(10, width - stringWidth(name) - 6))}`;
  const lines = [head];
  const md = r.metadata ?? {};
  const branch = (s: string) => `  ${c.gray("└")} ${s}`;
  const out = r.output ?? "";
  if (!ok) {
    const errLines = out.trim().split("\n");
    const show = verbose ? errLines : errLines.slice(0, 6);
    lines.push(branch(c.red(truncateAnsi(show[0] ?? "error", width - 6))));
    for (const l of show.slice(1)) lines.push("    " + c.red(truncateAnsi(l, width - 6)));
    if (errLines.length > show.length) lines.push(c.gray(`    … ${errLines.length - show.length} more lines`));
    return lines;
  }
  switch (name) {
    case "read":
      lines.push(branch(c.gray(r.images?.length ? "image" : `${md.lines ?? "?"} lines${md.total && md.total !== md.lines ? ` of ${md.total}` : ""}`)));
      break;
    case "write":
    case "edit":
    case "apply_patch": {
      const add = Number(md.additions ?? 0);
      const del = Number(md.deletions ?? 0);
      const verb = md.created ? "Created" : "Updated";
      lines.push(branch(c.gray(`${verb} · `) + c.green(`+${add}`) + " " + c.red(`-${del}`)));
      if (typeof md.diff === "string" && md.diff) lines.push(...renderDiff(md.diff, width, verbose ? 400 : md.created ? 8 : 24));
      break;
    }
    case "bash": {
      const outText = typeof md.output === "string" ? md.output : out;
      const tail = outText.trim() ? lastLines(outText, verbose ? 200 : 4) : [];
      const total = outText.trim() ? stripAnsi(outText).trimEnd().split("\n").length : 0;
      if (md.background) lines.push(branch(c.gray(`running in background as ${md.background}`)));
      else if (!tail.length) lines.push(branch(c.gray("(no output)")));
      else {
        if (total > tail.length) lines.push(branch(c.gray(`… ${total - tail.length} lines above`)));
        tail.forEach((l, i) => lines.push((i === 0 && total <= tail.length ? branch("") : "    ") + c.gray(truncateAnsi(l, width - 6))));
      }
      break;
    }
    case "todowrite":
      if (Array.isArray(md.todos)) lines.push(...renderTodos(md.todos as TodoItem[]));
      break;
    case "task":
      lines.push(branch(c.gray(oneLine(out).slice(0, Math.max(20, width - 8)))));
      break;
    case "question":
      lines.push(branch(`${c.gray("answer:")} ${String(md.answer ?? "")}`));
      break;
    case "exit_plan_mode":
      lines.push(branch(md.approved ? c.green("plan approved") : c.yellow("plan not approved")));
      break;
    default: {
      const first = out.trim().split("\n")[0] ?? "";
      if (r.title && r.title !== title) lines.push(branch(c.gray(r.title)));
      else if (first) lines.push(branch(c.gray(truncateAnsi(first, width - 6))));
      if (verbose && out.trim()) for (const l of out.trim().split("\n").slice(1, 200)) lines.push("    " + c.gray(truncateAnsi(l, width - 6)));
    }
  }
  return lines;
}

/**
 * Turns engine events into terminal output: permanent lines above the live
 * region, plus live activity (streaming text, running tools, spinner).
 */
export class ConversationView {
  private readonly screen: Screen;
  sessionId = "";
  verbose = false;
  private md?: MarkdownStream;
  private mdFirst = true;
  private reasoning = "";
  private reasoningStart = 0;
  private readonly tools = new Map<string, RunningTool>();
  private readonly preparing = new Map<string, { name: string; bytes: number }>();
  private readonly children = new Map<string, Child>();
  private status = "";
  busy = false;
  private turnStart = 0;
  private streamedChars = 0;
  private frame = 0;
  /** Called when live content changes. */
  onChange?: () => void;

  constructor(screen: Screen) {
    this.screen = screen;
  }

  tick(): void {
    this.frame = (this.frame + 1) % SPINNER.length;
  }

  private print(lines: string[]): void {
    if (lines.length) this.screen.print(lines.join("\n"));
  }

  private width(): number {
    return this.screen.width;
  }

  private ensureMd(): MarkdownStream {
    if (!this.md) {
      this.mdFirst = true;
      this.md = new MarkdownStream({
        width: () => this.width() - 2,
        emit: (lines) => {
          const out = lines.map((l) => {
            const prefix = this.mdFirst && l.trim() ? theme.accent(BULLET) + " " : "  ";
            if (l.trim()) this.mdFirst = false;
            return prefix + l;
          });
          this.print(out);
        },
      });
    }
    return this.md;
  }

  private endReasoning(): void {
    if (!this.reasoning) return;
    const secs = (Date.now() - this.reasoningStart) / 1000;
    const lines = [c.gray(c.italic(`✻ Thought for ${formatDuration(secs * 1000)}`))];
    if (this.verbose) {
      for (const l of wrapAnsi(this.reasoning.trim(), this.width() - 4)) lines.push(c.gray(c.italic("  " + l)));
    }
    this.print(lines);
    this.reasoning = "";
  }

  private endText(): void {
    if (this.md) {
      this.md.flush();
      this.md = undefined;
    }
  }

  /** Is this event for the session we display (or one of its sub-agents)? */
  private relevant(sessionId: string): "main" | "child" | undefined {
    if (sessionId === this.sessionId) return "main";
    if (this.children.has(sessionId)) return "child";
    return undefined;
  }

  handle(e: AgentEvent): void {
    if (e.type === "subagent.start" && e.parentSessionId === this.sessionId) {
      this.children.set(e.sessionId, { parentCallId: e.parentCallId, agent: e.agent, description: e.description, activity: [], tools: 0 });
      this.onChange?.();
      return;
    }
    if (e.type === "subagent.end") {
      this.children.delete(e.sessionId);
      this.onChange?.();
      return;
    }
    if (!("sessionId" in e)) return;
    const scope = this.relevant(e.sessionId);
    if (!scope) return;
    if (scope === "child") {
      this.handleChild(e);
      return;
    }
    switch (e.type) {
      case "turn.start":
        this.busy = true;
        this.turnStart = Date.now();
        this.streamedChars = 0;
        this.status = "Thinking";
        break;
      case "message.start":
        this.status = "Thinking";
        break;
      case "message.delta":
        this.streamedChars += e.text.length;
        if (e.kind === "reasoning") {
          if (!this.reasoning) this.reasoningStart = Date.now();
          this.reasoning += e.text;
          this.status = "Thinking";
        } else {
          this.endReasoning();
          this.ensureMd().push(e.text);
          this.status = "Writing";
        }
        break;
      case "message.tool_call":
        this.endReasoning();
        this.endText();
        this.preparing.set(e.callId, { name: e.name, bytes: 0 });
        this.status = `Preparing ${e.name}`;
        break;
      case "message.tool_input": {
        const p = this.preparing.get(e.callId);
        if (p) p.bytes = e.bytes;
        this.streamedChars += 0;
        break;
      }
      case "message.discarded":
        this.md = undefined;
        this.reasoning = "";
        this.preparing.clear();
        if (e.reason && e.reason !== "interrupted" && e.reason !== "refusal") this.print([c.gray(`  ↻ ${oneLine(e.reason).slice(0, 200)}`)]);
        break;
      case "message.end":
        this.endReasoning();
        this.endText();
        this.preparing.clear();
        break;
      case "tool.start":
        this.endText();
        this.tools.set(e.callId, { name: e.name, title: e.title, started: Date.now(), tail: "", sessionId: e.sessionId });
        this.status = "Working";
        break;
      case "tool.progress": {
        const t = this.tools.get(e.callId);
        if (t) t.tail = (t.tail + e.chunk).slice(-4000);
        break;
      }
      case "tool.end": {
        const t = this.tools.get(e.callId);
        this.tools.delete(e.callId);
        this.print(formatToolResult(e.name, t?.title ?? e.name, e.result, this.width(), this.verbose));
        if (!this.tools.size) this.status = "Thinking";
        break;
      }
      case "notice": {
        const icon = e.level === "error" ? c.red("✗") : e.level === "warn" ? c.yellow("!") : c.cyan("i");
        const color = e.level === "error" ? c.red : e.level === "warn" ? c.yellow : c.gray;
        this.endText();
        this.print(wrapAnsi(`${icon} ${color(e.message)}`, this.width() - 2, "  "));
        break;
      }
      case "retry":
        this.status = `Retrying in ${formatDuration(e.delayMs)} (attempt ${e.attempt})`;
        this.print([c.gray(`  ↻ ${truncateAnsi(oneLine(e.error), this.width() - 30)} · retrying in ${formatDuration(e.delayMs)}`)]);
        break;
      case "fallback":
        this.print([c.yellow(`  ↪ ${e.from} declined; ${e.to} continued`)]);
        break;
      case "server_tool":
        this.print([`${c.cyan(BULLET)} ${theme.tool(e.name)}${e.detail ? " " + c.gray(e.detail) : ""}`]);
        break;
      case "compaction":
        if (e.phase === "start") this.status = "Compacting conversation";
        else this.print([c.gray(`✻ Conversation compacted${e.tokensBefore ? ` (was ${formatTokens(e.tokensBefore)} tokens)` : ""}`)]);
        break;
      case "status":
        if (e.status === "compacting") this.status = "Compacting conversation";
        else if (e.status === "thinking" && !this.tools.size) this.status = "Thinking";
        break;
      case "turn.end":
        this.endReasoning();
        this.endText();
        this.tools.clear();
        this.preparing.clear();
        this.busy = false;
        this.printTurnEnd(e);
        break;
      default:
        break;
    }
    this.onChange?.();
  }

  private handleChild(e: AgentEvent): void {
    if (!("sessionId" in e)) return;
    const child = this.children.get(e.sessionId);
    if (!child) return;
    if (e.type === "tool.start") {
      child.tools++;
      child.activity.push(`${e.name} ${e.title}`);
      if (child.activity.length > 3) child.activity.shift();
      this.onChange?.();
    }
  }

  private printTurnEnd(e: Extract<AgentEvent, { type: "turn.end" }>): void {
    const parts: string[] = [];
    if (e.reason === "aborted") parts.push(c.yellow("⏹ Interrupted"));
    else if (e.reason === "max_steps") parts.push(c.yellow("Stopped at the step limit"));
    else if (e.reason === "error") parts.push(c.red("Stopped on error"));
    else if (e.reason === "refusal") parts.push(c.red("Declined"));
    else if (e.reason === "blocked") parts.push(c.red("Blocked by hook"));
    else parts.push(c.green("✓"));
    if (e.changes?.length) parts.push(renderChanges(e.changes));
    parts.push(formatDuration(e.durationMs));
    const tokens = e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
    if (tokens || e.usage.output) parts.push(`${formatTokens(tokens)} in · ${formatTokens(e.usage.output)} out`);
    if (e.cost !== undefined) parts.push(formatCost(e.cost));
    this.print([c.gray(parts.join(c.gray(" · "))), ""]);
  }

  /** Live activity lines (above the input box). */
  liveLines(width: number): string[] {
    const out: string[] = [];
    if (this.md) {
      for (const l of this.md.pendingLines()) out.push(...hardWrapAnsi((this.mdFirst ? theme.accent(BULLET) + " " : "  ") + l, width - 1));
    }
    if (this.reasoning && !this.md) {
      const tail = wrapAnsi(this.reasoning.replace(/\s+/g, " ").trim(), width - 6).slice(-2);
      for (const l of tail) out.push(c.gray(c.italic("  ✻ " + l)));
    }
    for (const [callId, t] of this.tools) {
      const secs = formatDuration(Date.now() - t.started);
      out.push(truncateAnsi(`${theme.accent(SPINNER[this.frame]!)} ${theme.tool(t.name)} ${t.title} ${c.gray(`(${secs})`)}`, width - 1));
      if (t.tail.trim()) {
        for (const l of lastLines(t.tail, 3)) out.push(c.gray(truncateAnsi(`    │ ${l}`, width - 1)));
      }
      for (const child of this.children.values()) {
        if (child.parentCallId !== callId) continue;
        for (const a of child.activity) out.push(c.gray(truncateAnsi(`    ⎿ ${a}`, width - 1)));
        out.push(c.gray(`    ⎿ ${child.tools} tool call${child.tools === 1 ? "" : "s"}`));
      }
    }
    if (this.busy) {
      const elapsed = formatDuration(Date.now() - this.turnStart);
      let detail = this.status;
      const prep = [...this.preparing.values()].at(-1);
      if (prep && !this.tools.size) detail = `Preparing ${prep.name}${prep.bytes ? ` · ${formatTokens(prep.bytes)} chars` : ""}`;
      const approx = this.streamedChars ? ` · ↓ ${formatTokens(this.streamedChars / 4)} tokens` : "";
      out.push(`${theme.accent(SPINNER[this.frame]!)} ${theme.accent(detail + "…")} ${c.gray(`(${elapsed}${approx} · esc to interrupt)`)}`);
    }
    return out;
  }
}
