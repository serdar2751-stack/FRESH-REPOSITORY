import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../config/paths.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { runShell } from "../util/shell.ts";
import { clipOutput } from "../util/text.ts";

export interface CommandInfo {
  name: string;
  description: string;
  template: string;
  agent?: string;
  model?: string;
  argumentHint?: string;
  source: string;
  /** Global commands are the user's own; project commands need a trusted folder to run shell snippets. */
  scope: "global" | "project";
}

function loadDir(dir: string, source: string, scope: CommandInfo["scope"], prefix = ""): CommandInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CommandInfo[] = [];
  for (const e of entries) {
    const file = path.join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(file).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...loadDir(file, source, scope, `${prefix}${e}:`));
      continue;
    }
    if (!e.endsWith(".md")) continue;
    try {
      const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = prefix + e.slice(0, -3);
      const firstLine = body.trim().split("\n")[0] ?? "";
      out.push({
        name,
        description: typeof data.description === "string" ? data.description : firstLine.slice(0, 80),
        template: body,
        agent: typeof data.agent === "string" ? data.agent : undefined,
        model: typeof data.model === "string" ? data.model : undefined,
        argumentHint: typeof data["argument-hint"] === "string" ? (data["argument-hint"] as string) : undefined,
        source,
        scope,
      });
    } catch {
      // skip unreadable command
    }
  }
  return out;
}

export function loadCommands(root: string): CommandInfo[] {
  const map = new Map<string, CommandInfo>();
  const dirs: Array<[string, string, CommandInfo["scope"]]> = [
    [path.join(os.homedir(), ".claude", "commands"), "~/.claude/commands", "global"],
    [path.join(paths.config, "commands"), "global", "global"],
    [path.join(root, ".claude", "commands"), ".claude/commands", "project"],
    [path.join(root, ".usta", "commands"), ".usta/commands", "project"],
  ];
  for (const [dir, source, scope] of dirs) for (const c of loadDir(dir, source, scope)) map.set(c.name, c);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Split arguments like a shell would (quotes group words). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export async function expandCommand(
  cmd: CommandInfo,
  args: string,
  opts: { cwd: string; allowShell: boolean; signal?: AbortSignal },
): Promise<{ prompt: string; warnings: string[] }> {
  const warnings: string[] = [];
  const positional = splitArgs(args);
  let text = cmd.template;
  const usesArgs = /\$ARGUMENTS|\$\d/.test(text);
  text = text.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)/g, (_, d: string) => positional[Number(d) - 1] ?? "");
  // !`command` injects command output.
  const shellRe = /!`([^`]+)`/g;
  const matches = [...text.matchAll(shellRe)];
  for (const m of matches) {
    let replacement: string;
    if (!opts.allowShell) {
      replacement = `(shell snippet \`${m[1]}\` not run: trust this project to allow it)`;
      warnings.push(`Skipped shell snippet in /${cmd.name} (project not trusted): ${m[1]}`);
    } else {
      const res = await runShell(m[1]!, { cwd: opts.cwd, timeoutMs: 60_000, signal: opts.signal });
      replacement = clipOutput(res.output.trim(), { maxBytes: 20_000 }).text;
    }
    text = text.replace(m[0], () => replacement);
  }
  if (!usesArgs && args.trim()) text = `${text.trimEnd()}\n\n${args}`;
  return { prompt: text.trim(), warnings };
}
