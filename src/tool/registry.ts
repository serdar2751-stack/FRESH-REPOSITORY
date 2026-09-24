import type { AgentInfo } from "../agent/agents.ts";
import type { Config } from "../config/config.ts";
import type { ModelInfo, ToolSpec } from "../provider/types.ts";
import { bashKillTool, bashOutputTool, bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { exitPlanModeTool, questionTool, skillTool, todoTool, webfetchTool } from "./misc.ts";
import { applyPatchTool } from "./patch.ts";
import { readTool } from "./read.ts";
import { globTool, grepTool, lsTool } from "./search.ts";
import { createTaskTool } from "./task.ts";
import type { Tool } from "./types.ts";
import { writeTool } from "./write.ts";

export interface ToolSetOptions {
  model: ModelInfo;
  agent: AgentInfo;
  config: Config;
  /** Sub-agents the task tool may launch (empty: no task tool). */
  subagents: Array<{ name: string; description: string }>;
  isSubagent: boolean;
  hasSkills: boolean;
  extraTools?: Tool[];
}

// biome-ignore lint: heterogeneous tool inputs
type AnyTool = Tool<any>;

export function buildToolSet(opts: ToolSetOptions): AnyTool[] {
  const editFamily = opts.model.editTool;
  const tools: AnyTool[] = [readTool];
  if (editFamily === "patch") tools.push(applyPatchTool);
  else tools.push(editTool, writeTool);
  tools.push(bashTool, bashOutputTool, bashKillTool, globTool, grepTool, lsTool, webfetchTool, todoTool, questionTool);
  if (!opts.isSubagent) tools.push(exitPlanModeTool);
  if (opts.hasSkills) tools.push(skillTool);
  if (!opts.isSubagent && opts.subagents.length) tools.push(createTaskTool(opts.subagents));
  tools.push(...(opts.extraTools ?? []));

  const toggles = opts.config.tools ?? {};
  const allow = opts.agent.tools ? new Set(opts.agent.tools) : undefined;
  const disabled = new Set(opts.agent.disabledTools ?? []);
  // An allow-list naming "edit" also admits the patch tool when that is the model's editor.
  if (allow?.has("edit")) {
    allow.add("apply_patch");
    allow.add("write");
  }
  if (allow?.has("bash")) {
    allow.add("bash_output");
    allow.add("bash_kill");
  }
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    if (toggles[t.name] === false) return false;
    if (disabled.has(t.name)) return false;
    if (allow && !allow.has(t.name) && !matchesAllow(allow, t.name)) return false;
    return true;
  });
}

function matchesAllow(allow: Set<string>, name: string): boolean {
  for (const a of allow) if (a.endsWith("*") && name.startsWith(a.slice(0, -1))) return true;
  return false;
}

const TITLE_TOOLS: AnyTool[] = [readTool, editTool, writeTool, applyPatchTool, bashTool, bashOutputTool, bashKillTool, globTool, grepTool, lsTool, webfetchTool, todoTool, questionTool, exitPlanModeTool, skillTool];

/** Display title for a recorded tool call (history replay, exports). */
export function toolTitle(name: string, input: unknown, cwd: string): string {
  const tool = TITLE_TOOLS.find((t) => t.name === name);
  try {
    const t = tool?.title?.(input as never, cwd);
    if (t) return t;
  } catch {
    // fall through
  }
  if (name === "task" && input && typeof input === "object") {
    const i = input as { subagent_type?: string; description?: string };
    return `${i.subagent_type ?? "agent"}: ${i.description ?? ""}`;
  }
  const json = JSON.stringify(input ?? {});
  return json.length > 120 ? json.slice(0, 117) + "…" : json;
}

export function toolSpecs(tools: AnyTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
