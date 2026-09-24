import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config/config.ts";
import { paths } from "../config/paths.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { createGlobMatcher, hasGlobChars } from "../util/glob.ts";

export interface InstructionFile {
  path: string;
  content: string;
  scope: "global" | "project" | "config";
}

const MAX_INSTRUCTION_BYTES = 60_000;

function readSmall(file: string, limit = MAX_INSTRUCTION_BYTES): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile()) return undefined;
    const text = readFileSync(file, "utf8");
    return text.length > limit ? text.slice(0, limit) + "\n\n[... truncated ...]" : text;
  } catch {
    return undefined;
  }
}

/**
 * Instruction files for the system prompt: global AGENTS.md (and Claude
 * Code's ~/.claude/CLAUDE.md), then AGENTS.md/CLAUDE.md from the project root
 * down to the working directory, then files listed in config.instructions.
 */
export function loadInstructions(root: string, cwd: string, config: Config): InstructionFile[] {
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const add = (file: string, scope: InstructionFile["scope"]) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    const content = readSmall(abs);
    if (content === undefined || !content.trim()) return;
    // Identical content (AGENTS.md symlinked or copied to CLAUDE.md) is included once.
    if (out.some((o) => o.content.trim() === content.trim())) return;
    seen.add(abs);
    out.push({ path: abs, content, scope });
  };
  add(path.join(paths.config, "AGENTS.md"), "global");
  add(path.join(os.homedir(), ".claude", "CLAUDE.md"), "global");

  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  const stop = path.resolve(root);
  for (;;) {
    dirs.unshift(dir);
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const d of dirs) {
    for (const name of ["AGENTS.md", "CLAUDE.md", path.join(".usta", "AGENTS.md"), "AGENTS.local.md", "CLAUDE.local.md"]) {
      add(path.join(d, name), "project");
    }
  }
  for (const entry of config.instructions ?? []) {
    const p = entry.startsWith("~") ? path.join(os.homedir(), entry.slice(1)) : path.resolve(root, entry);
    if (hasGlobChars(entry)) {
      const base = root;
      const match = createGlobMatcher(path.relative(base, p).split(path.sep).join("/"));
      walkShallow(base, 4, (rel) => {
        if (match(rel)) add(path.join(base, rel), "config");
      });
    } else add(p, "config");
  }
  return out;
}

function walkShallow(base: string, depth: number, visit: (rel: string) => void, rel = ""): void {
  if (depth < 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkShallow(base, depth - 1, visit, r);
    else visit(r);
  }
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  body: string;
  source: string;
}

/** Skills: folders containing SKILL.md (usta and Claude Code locations). */
export function loadSkills(root: string): Map<string, Skill> {
  const dirs = [
    { dir: path.join(os.homedir(), ".claude", "skills"), source: "~/.claude/skills" },
    { dir: path.join(paths.config, "skills"), source: "global" },
    { dir: path.join(root, ".claude", "skills"), source: ".claude/skills" },
    { dir: path.join(root, ".usta", "skills"), source: ".usta/skills" },
  ];
  const skills = new Map<string, Skill>();
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const file = path.join(dir, e, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readSmall(file, 200_000);
      if (!text) continue;
      const { data, body } = parseFrontmatter(text);
      const name = typeof data.name === "string" && data.name ? data.name : e;
      const description = typeof data.description === "string" ? data.description : body.trim().split("\n")[0] ?? "";
      skills.set(name, { name, description: description.slice(0, 1024), path: path.join(dir, e), body, source });
    }
  }
  return skills;
}
