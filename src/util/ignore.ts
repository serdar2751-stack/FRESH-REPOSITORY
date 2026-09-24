import fs from "node:fs/promises";
import path from "node:path";
import { globToRegExp } from "./glob.ts";

interface Rule {
  /** Directory (relative to root, posix, "" for root) the rule was declared in. */
  base: string;
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

/** Directories skipped even when no .gitignore mentions them. */
export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  ".DS_Store",
]);

export class IgnoreMatcher {
  private rules: Rule[] = [];

  add(content: string, base = ""): void {
    for (let raw of content.split(/\r?\n/)) {
      if (!raw || raw.startsWith("#")) continue;
      // Trailing spaces are ignored unless escaped.
      raw = raw.replace(/(?<!\\)\s+$/, "");
      if (!raw) continue;
      let negate = false;
      if (raw.startsWith("!")) {
        negate = true;
        raw = raw.slice(1);
      } else if (raw.startsWith("\\!") || raw.startsWith("\\#")) {
        raw = raw.slice(1);
      }
      let dirOnly = false;
      if (raw.endsWith("/")) {
        dirOnly = true;
        raw = raw.slice(0, -1);
      }
      if (!raw) continue;
      // A slash at the start or in the middle anchors the pattern to `base`.
      const anchored = raw.includes("/");
      if (raw.startsWith("/")) raw = raw.slice(1);
      const pattern = anchored ? raw : "**/" + raw;
      this.rules.push({ base, negate, dirOnly, re: globToRegExp(pattern) });
    }
  }

  /**
   * Whether `rel` (posix path relative to the root) is ignored. Parent
   * directories are not checked here - walkers prune ignored directories.
   */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      let sub = rel;
      if (rule.base) {
        if (!rel.startsWith(rule.base + "/")) continue;
        sub = rel.slice(rule.base.length + 1);
      }
      if (rule.re.test(sub)) ignored = !rule.negate;
    }
    return ignored;
  }

  get size(): number {
    return this.rules.length;
  }
}

export interface WalkOptions {
  /** Respect .gitignore / .ignore files (default true). */
  gitignore?: boolean;
  /** Include dot-files (default true, .git is always skipped). */
  hidden?: boolean;
  maxEntries?: number;
  signal?: AbortSignal;
  /** Extra directory names to skip. */
  skipDirs?: Iterable<string>;
  includeDirs?: boolean;
  maxDepth?: number;
}

export interface WalkEntry {
  rel: string;
  abs: string;
  isDir: boolean;
}

/** Recursive, gitignore-aware directory walk (breadth-first). */
export async function* walk(root: string, opts: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const useGitignore = opts.gitignore ?? true;
  const hidden = opts.hidden ?? true;
  const skip = new Set([...DEFAULT_IGNORED_DIRS, ...(opts.skipDirs ?? [])]);
  const matcher = new IgnoreMatcher();
  const maxEntries = opts.maxEntries ?? Infinity;
  let count = 0;
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length) {
    if (opts.signal?.aborted) return;
    const { dir, rel, depth } = queue.shift()!;
    if (useGitignore) {
      for (const name of [".gitignore", ".ignore"]) {
        try {
          matcher.add(await fs.readFile(path.join(dir, name), "utf8"), rel);
        } catch {
          // no ignore file here
        }
      }
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!hidden && e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(path.join(dir, e.name))).isDirectory();
        } catch {
          continue;
        }
        // Do not follow directory symlinks (cycles); list them as entries.
        if (isDir) {
          if (useGitignore && matcher.ignores(childRel, true)) continue;
          if (opts.includeDirs) {
            yield { rel: childRel, abs: path.join(dir, e.name), isDir: true };
            if (++count >= maxEntries) return;
          }
          continue;
        }
      }
      if (isDir && skip.has(e.name)) continue;
      if (useGitignore && matcher.ignores(childRel, isDir)) continue;
      if (isDir) {
        if (opts.includeDirs) {
          yield { rel: childRel, abs: path.join(dir, e.name), isDir: true };
          if (++count >= maxEntries) return;
        }
        if (opts.maxDepth === undefined || depth + 1 < opts.maxDepth) {
          queue.push({ dir: path.join(dir, e.name), rel: childRel, depth: depth + 1 });
        }
        continue;
      }
      yield { rel: childRel, abs: path.join(dir, e.name), isDir: false };
      if (++count >= maxEntries) return;
    }
  }
}
