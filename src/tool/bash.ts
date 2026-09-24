import path from "node:path";
import { commandPrefix, parseShell } from "../permission/bash.ts";
import { runShell } from "../util/shell.ts";
import { clipOutput, formatDuration, oneLine, stripAnsi, truncateEnd } from "../util/text.ts";
import { checkExternal, resolvePath, type Tool, type ToolContext, ToolError } from "./types.ts";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  workdir?: string;
  run_in_background?: boolean;
}

/** Permission patterns for a command line: one per simple command. */
export function commandPatterns(command: string): { patterns: string[]; always: string[] } {
  const parsed = parseShell(command);
  if (parsed.complex || !parsed.commands.length) {
    const flat = oneLine(command);
    return { patterns: [flat], always: [flat] };
  }
  const patterns = parsed.commands.map((c) => c.text + c.writes.map((w) => ` > ${w}`).join(""));
  const always = [...new Set(parsed.commands.map((c) => commandPrefix(c.argv)))];
  return { patterns, always };
}

async function permitCommand(ctx: ToolContext, command: string, cwd: string, description?: string): Promise<void> {
  const { patterns, always } = commandPatterns(command);
  await ctx.permit({
    permission: "bash",
    patterns,
    always,
    title: description ? `${description}: ${truncateEnd(oneLine(command), 200)}` : `Run: ${truncateEnd(oneLine(command), 200)}`,
    detail: { command, path: cwd },
  });
}

export const bashTool: Tool<BashInput> = {
  name: "bash",
  description: [
    "Run a shell command (bash) and return its combined stdout and stderr.",
    "- Each call starts a fresh shell in the working directory; use `cd dir && cmd` or the workdir parameter to run elsewhere. Quote paths that contain spaces.",
    `- Commands time out after ${DEFAULT_TIMEOUT / 1000}s by default (timeout in ms, up to ${MAX_TIMEOUT / 1000}s). Long output is truncated, keeping the beginning and the end.`,
    "- The shell is non-interactive: never run commands that wait for input or open an editor or pager. Pass flags such as --yes, -y or --no-edit.",
    "- For servers, watchers and other long-running processes set run_in_background: true, then use bash_output to read their output and bash_kill to stop them.",
    "- Prefer the dedicated tools over shell equivalents: read instead of cat/head/tail, edit or write instead of sed/awk/echo redirection, glob instead of find, grep instead of grep/rg.",
    "- Chain dependent commands with &&. Independent commands can be separate tool calls in the same response.",
    "- Do not commit, push, rewrite git history or change git config unless the user asks. Never use interactive flags such as git rebase -i.",
    "- Give a short description (5-10 words) of what the command does.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "integer", description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` },
      description: { type: "string", description: "Short description of what the command does" },
      workdir: { type: "string", description: "Directory to run in (default: the working directory)" },
      run_in_background: { type: "boolean", description: "Start the command in the background and return immediately" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  title: (input) => truncateEnd(oneLine(input.command ?? ""), 120),
  async execute(input, ctx) {
    const command = input.command;
    if (!command?.trim()) throw new ToolError("command is empty");
    let cwd = ctx.cwd;
    if (input.workdir) {
      cwd = resolvePath(ctx, input.workdir);
      await checkExternal(ctx, path.join(cwd, "."), "read");
    }
    await permitCommand(ctx, command, cwd, input.description);

    if (input.run_in_background) {
      const p = ctx.processes.start(command, cwd);
      return {
        output: `Started in the background with id ${p.id}. Use bash_output with this id to read its output and bash_kill to stop it.`,
        title: truncateEnd(oneLine(command), 120),
        metadata: { background: p.id, command },
      };
    }

    const timeout = Math.min(Math.max(1000, input.timeout ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
    const res = await runShell(command, {
      cwd,
      timeoutMs: timeout,
      signal: ctx.signal,
      onData: (chunk) => ctx.progress(chunk),
    });
    const clean = stripAnsi(res.output).replace(/\r(?!\n)/g, "\n");
    const clipped = clipOutput(clean.trimEnd(), { maxBytes: 30_000, maxLines: 1500 });
    const notes: string[] = [];
    if (res.timedOut) notes.push(`Command timed out after ${formatDuration(timeout)} and was stopped. Consider run_in_background for long-running processes.`);
    if (res.aborted) notes.push("Command was interrupted by the user.");
    if (!res.timedOut && !res.aborted && res.exitCode !== 0) {
      notes.push(res.exitCode === null ? `Terminated by signal ${res.signal}.` : `Exit code ${res.exitCode}.`);
    }
    const body = clipped.text || "(no output)";
    return {
      output: body + (notes.length ? `\n\n[${notes.join(" ")}]` : ""),
      title: truncateEnd(oneLine(input.description || command), 120),
      isError: res.timedOut || res.aborted || (res.exitCode !== 0 && res.exitCode !== null) || false,
      metadata: {
        command,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        durationMs: res.durationMs,
        output: truncateEnd(clean, 20_000),
      },
    };
  },
};

export const bashOutputTool: Tool<{ id: string }> = {
  name: "bash_output",
  description: "Read new output from a background command started with run_in_background, and whether it is still running.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The background process id (e.g. bg_1)" } },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: true,
  title: (input) => input.id,
  async execute(input, ctx) {
    const p = ctx.processes.get(input.id);
    const fresh = ctx.processes.readNew(input.id);
    if (!p || !fresh) {
      const ids = ctx.processes.list().map((x) => x.id);
      throw new ToolError(`No background process ${input.id}.${ids.length ? ` Known: ${ids.join(", ")}` : ""}`);
    }
    const status = p.running ? "running" : `exited with code ${p.exitCode ?? p.signal}`;
    const text = clipOutput(fresh.text.trimEnd(), { maxBytes: 30_000, maxLines: 1000 }).text;
    return {
      output: `[${input.id}: ${status}]${fresh.skipped ? ` (${fresh.skipped} older characters were discarded)` : ""}\n${text || "(no new output)"}`,
      title: `${input.id} (${p.running ? "running" : "exited"})`,
      metadata: { running: p.running, exitCode: p.exitCode },
    };
  },
};

export const bashKillTool: Tool<{ id: string }> = {
  name: "bash_kill",
  description: "Stop a background command started with run_in_background.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The background process id" } },
    required: ["id"],
    additionalProperties: false,
  },
  title: (input) => input.id,
  async execute(input, ctx) {
    const p = ctx.processes.get(input.id);
    if (!p) throw new ToolError(`No background process ${input.id}.`);
    if (!p.running) return { output: `${input.id} had already exited (code ${p.exitCode ?? p.signal}).` };
    ctx.processes.kill(input.id);
    return { output: `Stopped ${input.id}.` };
  },
};
