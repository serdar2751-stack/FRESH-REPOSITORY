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

/** Commands that ship with usta; a user or project file with the same name replaces them. */
const BUILTIN: CommandInfo[] = [
  {
    name: "review",
    description: "Review uncommitted changes (or a ref) for bugs, security issues and missing tests",
    argumentHint: "[ref or focus]",
    source: "built-in",
    scope: "global",
    template: `Review code changes in this repository. Do not modify any files.

Scope: $ARGUMENTS
If no scope is given, review the uncommitted changes: \`git status\`, \`git diff\` and \`git diff --cached\`, including new untracked files. If a branch or ref is given, review \`git diff <ref>...HEAD\`. Otherwise treat the scope as what to focus on.

Look for, in order of importance:
1. Bugs: wrong logic, unhandled errors and edge cases, broken contracts with callers, concurrency problems.
2. Security problems: injection, leaked secrets, unsafe input handling, permission mistakes.
3. Missing or weak tests for the changed behavior.
4. Maintainability: unclear names, duplication, dead code, inconsistency with the surrounding code.

Read the surrounding code to confirm each finding; do not report guesses. Group findings by severity (critical, major, minor), each with file:line, what is wrong, why it matters and a concrete fix. End with a one-line verdict. If nothing significant turns up, say so briefly.`,
  },
  {
    name: "commit",
    description: "Commit the current changes with a message in the repository's style",
    argumentHint: "[message hint]",
    source: "built-in",
    scope: "global",
    template: `Create a git commit for the current changes.

1. Run \`git status\`, \`git diff\`, \`git diff --cached\` and \`git log --oneline -10\` to see the changes and the repository's commit message style.
2. Stage the files that belong to this change. Leave out unrelated changes, build output and anything that looks like a secret (.env files, keys, tokens), and say what you left out.
3. Write the message in the repository's style: a concise subject line, then a short body explaining why when that is not obvious from the diff.
4. Commit. Do not push, amend earlier commits or change git configuration. If there is nothing to commit, say so.

Guidance from the user (may be empty): $ARGUMENTS`,
  },
];

export function loadCommands(root: string): CommandInfo[] {
  const map = new Map<string, CommandInfo>(BUILTIN.map((c) => [c.name, c]));
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
