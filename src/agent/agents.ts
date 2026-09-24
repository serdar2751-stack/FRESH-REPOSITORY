import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, Config, PermissionConfig } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import type { Effort } from "../core/types.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";

export interface AgentInfo {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  /** Extra system prompt text appended to the base prompt. */
  prompt?: string;
  model?: string;
  effort?: Effort;
  /** Tool allow-list; undefined means every tool. */
  tools?: string[];
  /** Tools explicitly disabled. */
  disabledTools?: string[];
  permission?: PermissionConfig;
  maxSteps?: number;
  source: string;
}

const READ_ONLY_TOOLS = ["read", "glob", "grep", "ls", "bash", "webfetch", "skill"];

export const BUILTIN_AGENTS: AgentInfo[] = [
  {
    name: "build",
    description: "The default agent: plans, edits files and runs commands to complete coding tasks.",
    mode: "primary",
    source: "built-in",
  },
  {
    name: "explore",
    description:
      "Fast, read-only codebase exploration: finding files, searching code and answering questions about how things work. Cannot modify files. Returns a concise report with file paths and line numbers.",
    mode: "subagent",
    tools: READ_ONLY_TOOLS,
    permission: { edit: "deny", bash: { "*": "deny", "@readonly": "allow" } },
    prompt: [
      "You are a read-only exploration sub-agent. Search and read the codebase to answer the task you were given.",
      "- Do not modify files. Only run read-only shell commands (ls, git log, git diff, ...).",
      "- Be efficient: use grep and glob to find candidates, read only what you need, and run independent searches in parallel.",
      "- Finish with a concise report: the answer first, then the evidence as `path:line` references. Include only what the requester needs.",
    ].join("\n"),
    source: "built-in",
  },
  {
    name: "general",
    description:
      "General-purpose sub-agent for multi-step tasks that need both research and changes, such as implementing a well-specified change in one area of the code.",
    mode: "subagent",
    disabledTools: ["task", "question", "exit_plan_mode"],
    prompt: [
      "You are a sub-agent working on one delegated task. The requester cannot see your tool calls; they will only read your final message.",
      "- Complete the task fully within its scope; do not expand it.",
      "- Finish with a concise report: what you did, the files you changed, how you verified it, and anything left open.",
    ].join("\n"),
    source: "built-in",
  },
];

/** Claude Code tool names -> usta tool names (for .claude/agents compatibility). */
const CLAUDE_TOOL_MAP: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
  Glob: "glob",
  Grep: "grep",
  LS: "ls",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Task: "task",
  NotebookEdit: "edit",
};

function toolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value.map(String) : String(value).split(/[,\s]+/);
  const out = list
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => CLAUDE_TOOL_MAP[t] ?? t);
  return out.length ? [...new Set(out)] : undefined;
}

function modelAlias(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value === "inherit") return undefined;
  const alias: Record<string, string> = {
    opus: "anthropic/claude-opus-5",
    sonnet: "anthropic/claude-sonnet-5",
    haiku: "anthropic/claude-haiku-4-5",
    fable: "anthropic/claude-fable-5-1",
  };
  return alias[value] ?? value;
}

function fromConfig(name: string, c: AgentConfig, source: string): AgentInfo {
  let tools: string[] | undefined;
  let disabled: string[] | undefined;
  if (Array.isArray(c.tools)) tools = toolList(c.tools);
  else if (c.tools && typeof c.tools === "object") {
    const entries = Object.entries(c.tools);
    disabled = entries.filter(([, v]) => v === false).map(([k]) => k);
    const enabled = entries.filter(([, v]) => v === true).map(([k]) => k);
    if (enabled.length && !disabled.length) tools = enabled;
  }
  return {
    name,
    description: c.description ?? `Custom agent ${name}`,
    mode: c.mode ?? "all",
    prompt: c.prompt,
    model: modelAlias(c.model),
    effort: c.effort,
    tools,
    disabledTools: disabled,
    permission: c.permission,
    maxSteps: c.maxSteps,
    source,
  };
}

function loadDir(dir: string, source: string): AgentInfo[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = typeof data.name === "string" && data.name ? data.name : f.slice(0, -3);
      const agent = fromConfig(
        name,
        {
          description: typeof data.description === "string" ? data.description : undefined,
          prompt: body.trim() || undefined,
          model: typeof data.model === "string" ? data.model : undefined,
          effort: typeof data.effort === "string" ? (data.effort as Effort) : undefined,
          mode: data.mode === "primary" || data.mode === "subagent" || data.mode === "all" ? data.mode : source.includes(".claude") ? "subagent" : "all",
          tools: (data.tools as AgentConfig["tools"]) ?? undefined,
          permission: data.permission as PermissionConfig | undefined,
          maxSteps: typeof data.maxSteps === "number" ? data.maxSteps : undefined,
        },
        file,
      );
      if (Array.isArray(data.tools) || typeof data.tools === "string") agent.tools = toolList(data.tools);
      out.push(agent);
    } catch {
      // skip unreadable agent files
    }
  }
  return out;
}

export function agentDirs(root: string): Array<{ dir: string; source: string }> {
  return [
    { dir: path.join(os.homedir(), ".claude", "agents"), source: "~/.claude/agents" },
    { dir: path.join(paths.config, "agents"), source: "global" },
    { dir: path.join(root, ".claude", "agents"), source: ".claude/agents" },
    { dir: path.join(root, ".usta", "agents"), source: ".usta/agents" },
  ];
}

/** Built-in agents, then markdown agents, then config agents (later wins). */
export function loadAgents(root: string, config: Config): AgentInfo[] {
  const map = new Map<string, AgentInfo>();
  for (const a of BUILTIN_AGENTS) map.set(a.name, a);
  for (const { dir, source } of agentDirs(root)) for (const a of loadDir(dir, source)) map.set(a.name, a);
  for (const [name, c] of Object.entries(config.agents ?? {})) {
    if (c.disabled) {
      map.delete(name);
      continue;
    }
    const prev = map.get(name);
    const next = fromConfig(name, c, "config");
    map.set(name, prev ? { ...prev, ...stripUndefined(next), source: "config" } : next);
  }
  return [...map.values()];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function isPrimary(a: AgentInfo): boolean {
  return a.mode === "primary" || a.mode === "all";
}

export function isSubagent(a: AgentInfo): boolean {
  return a.mode === "subagent" || a.mode === "all";
}
