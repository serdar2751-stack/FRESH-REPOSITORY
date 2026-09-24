import fs from "node:fs/promises";
import path from "node:path";
import { createGlobMatcher } from "../util/glob.ts";
import { DEFAULT_IGNORED_DIRS, IgnoreMatcher, walk } from "../util/ignore.ts";
import { runFile, which } from "../util/shell.ts";
import { clipOutput } from "../util/text.ts";
import { checkExternal, relPath, resolvePath, type Tool, ToolError } from "./types.ts";

let rgPath: string | null | undefined;
export function ripgrep(): string | undefined {
  if (rgPath === undefined) rgPath = process.env.USTA_NO_RG ? null : (which("rg") ?? null);
  return rgPath ?? undefined;
}

/** List files under `dir` (relative paths), gitignore-aware. */
export async function listFiles(dir: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<string[]> {
  const rg = ripgrep();
  if (rg) {
    const res = await runFile(rg, ["--files", "--hidden", "--no-config", "--no-require-git", "--glob", "!.git", "--glob", "!node_modules"], {
      cwd: dir,
      signal: opts.signal,
      timeoutMs: 60_000,
    });
    if (res.code === 0 || res.code === 1) {
      const files = res.stdout.split("\n").filter(Boolean).map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
      return opts.limit ? files.slice(0, opts.limit) : files;
    }
  }
  const out: string[] = [];
  for await (const e of walk(dir, { signal: opts.signal, maxEntries: opts.limit ?? 200_000 })) out.push(e.rel);
  return out;
}

async function sortByMtime(base: string, files: string[], limit: number): Promise<Array<{ rel: string; mtime: number }>> {
  const stats = await Promise.all(
    files.slice(0, 5000).map(async (rel) => {
      try {
        return { rel, mtime: (await fs.stat(path.join(base, rel))).mtimeMs };
      } catch {
        return { rel, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
  return stats.slice(0, limit);
}

export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: "glob",
  description: [
    'Find files by glob pattern, such as "**/*.ts", "src/**/test_*.py" or "*.json".',
    "- A pattern without a slash matches file names at any depth.",
    "- Respects .gitignore. Results are sorted by modification time, newest first (at most 200).",
    "- Use this instead of find or ls -R. Run several searches in parallel when useful.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Directory to search (default: working directory)" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  readOnly: true,
  title: (input) => input.pattern + (input.path ? ` in ${input.path}` : ""),
  async execute(input, ctx) {
    const dir = input.path ? resolvePath(ctx, input.path) : ctx.cwd;
    await checkExternal(ctx, dir, "read");
    let st;
    try {
      st = await fs.stat(dir);
    } catch {
      throw new ToolError(`Directory not found: ${dir}`);
    }
    if (!st.isDirectory()) throw new ToolError(`${dir} is not a directory.`);
    let pattern = input.pattern.trim();
    // Absolute pattern inside the search dir -> relative.
    if (path.isAbsolute(pattern) && pattern.startsWith(dir)) pattern = pattern.slice(dir.length).replace(/^[/\\]+/, "");
    const match = createGlobMatcher(pattern);
    const files = (await listFiles(dir, { signal: ctx.signal })).filter((f) => match(f));
    const sorted = await sortByMtime(dir, files, 200);
    if (!sorted.length) return { output: `No files match ${input.pattern}.`, metadata: { count: 0 } };
    const shown = sorted.map((f) => relPath(ctx.cwd, path.join(dir, f.rel)));
    const more = files.length > sorted.length ? `\n(${files.length - sorted.length} more matches not shown; narrow the pattern.)` : "";
    return { output: shown.join("\n") + more, title: `${files.length} match${files.length === 1 ? "" : "es"}`, metadata: { count: files.length } };
  },
};

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "files_with_matches" | "content" | "count";
  case_insensitive?: boolean;
  context?: number;
  fixed_strings?: boolean;
  multiline?: boolean;
  head_limit?: number;
}

const TYPE_EXT: Record<string, string[]> = {
  js: ["js", "jsx", "mjs", "cjs"],
  ts: ["ts", "tsx", "mts", "cts"],
  py: ["py", "pyi"],
  go: ["go"],
  rust: ["rs"],
  java: ["java"],
  ruby: ["rb"],
  php: ["php"],
  c: ["c", "h"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "h"],
  cs: ["cs"],
  swift: ["swift"],
  kotlin: ["kt", "kts"],
  md: ["md", "markdown"],
  json: ["json"],
  yaml: ["yaml", "yml"],
  html: ["html", "htm"],
  css: ["css", "scss", "sass", "less"],
  sh: ["sh", "bash", "zsh"],
};

async function grepFallback(input: GrepInput, base: string, isFile: boolean, signal: AbortSignal): Promise<{ lines: string[]; files: Map<string, number> }> {
  let re: RegExp;
  try {
    const src = input.fixed_strings ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
    re = new RegExp(src, (input.case_insensitive ? "i" : "") + (input.multiline ? "gms" : "g"));
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
  }
  const globMatch = input.glob ? createGlobMatcher(input.glob) : undefined;
  const exts = input.type ? TYPE_EXT[input.type] : undefined;
  const candidates = isFile ? [path.basename(base)] : await listFiles(base, { signal });
  const root = isFile ? path.dirname(base) : base;
  const files = new Map<string, number>();
  const lines: string[] = [];
  const ctxN = input.context ?? 0;
  for (const rel of candidates) {
    if (signal.aborted) break;
    if (globMatch && !globMatch(rel)) continue;
    if (exts && !exts.includes(path.extname(rel).slice(1))) continue;
    let text: string;
    try {
      const abs = path.join(root, rel);
      const st = await fs.stat(abs);
      if (st.size > 5_000_000) continue;
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    if (input.multiline) {
      const matches = text.match(re);
      if (matches?.length) {
        files.set(rel, matches.length);
        if (input.output_mode === "content") for (const m of matches) lines.push(`${rel}: ${m}`);
      }
      continue;
    }
    const fileLines = text.split(/\r?\n/);
    let count = 0;
    const show = new Set<number>();
    fileLines.forEach((l, i) => {
      re.lastIndex = 0;
      if (re.test(l)) {
        count++;
        for (let k = Math.max(0, i - ctxN); k <= Math.min(fileLines.length - 1, i + ctxN); k++) show.add(k);
      }
    });
    if (!count) continue;
    files.set(rel, count);
    if (input.output_mode === "content") {
      let prev = -2;
      for (const k of [...show].sort((a, b) => a - b)) {
        if (ctxN && prev >= 0 && k > prev + 1) lines.push("--");
        lines.push(`${rel}:${k + 1}:${fileLines[k]}`);
        prev = k;
      }
    }
  }
  return { lines, files };
}

export const grepTool: Tool<GrepInput> = {
  name: "grep",
  description: [
    "Search file contents with a regular expression (ripgrep syntax); respects .gitignore.",
    '- output_mode "files_with_matches" (default) lists matching files; "content" shows matching lines as path:line:text (add context for surrounding lines); "count" shows matches per file.',
    '- Narrow the search with path, glob (e.g. "*.ts", "src/**/*.py") or type (e.g. "py", "ts", "go").',
    '- Escape regex metacharacters for literal text, or set fixed_strings: true. Use multiline: true for patterns that span lines.',
    "- Use this instead of running grep or rg through bash.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "File or directory to search (default: working directory)" },
      glob: { type: "string", description: "Only search files matching this glob" },
      type: { type: "string", description: "File type filter (rg --type), e.g. js, ts, py, go, rust" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
      case_insensitive: { type: "boolean" },
      context: { type: "integer", description: "Lines of context around matches (content mode)", minimum: 0 },
      fixed_strings: { type: "boolean", description: "Treat the pattern as a literal string" },
      multiline: { type: "boolean", description: "Allow the pattern to match across lines" },
      head_limit: { type: "integer", description: "Maximum results to return (default 200 lines / 100 files)", minimum: 1 },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  readOnly: true,
  title: (input) => `"${input.pattern}"` + (input.path ? ` in ${input.path}` : "") + (input.glob ? ` (${input.glob})` : ""),
  async execute(input, ctx) {
    const target = input.path ? resolvePath(ctx, input.path) : ctx.cwd;
    await checkExternal(ctx, target, "read");
    let isFile = false;
    try {
      isFile = (await fs.stat(target)).isFile();
    } catch {
      throw new ToolError(`Path not found: ${target}`);
    }
    const mode = input.output_mode ?? "files_with_matches";
    const limit = input.head_limit ?? (mode === "content" ? 200 : 100);
    const rg = ripgrep();
    let files = new Map<string, number>();
    let lines: string[] = [];
    const cwdForOutput = isFile ? path.dirname(target) : target;
    if (rg) {
      const args = ["--no-config", "--hidden", "--no-require-git", "--glob", "!.git", "--glob", "!node_modules", "--color", "never", "--max-columns", "400", "--max-columns-preview"];
      if (input.case_insensitive) args.push("-i");
      if (input.fixed_strings) args.push("-F");
      if (input.multiline) args.push("-U", "--multiline-dotall");
      if (input.glob) args.push("--glob", input.glob);
      if (input.type) args.push("--type", input.type);
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      else {
        args.push("-n", "--no-heading", "--with-filename");
        if (input.context) args.push("-C", String(input.context));
      }
      args.push("-e", input.pattern, "--", isFile ? path.basename(target) : ".");
      const res = await runFile(rg, args, { cwd: cwdForOutput, signal: ctx.signal, timeoutMs: 120_000 });
      if (res.code === 2 && !res.stdout) throw new ToolError(`grep failed: ${res.stderr.trim().split("\n").slice(0, 5).join("\n")}`);
      const out = res.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""));
      if (mode === "files_with_matches") for (const f of out) files.set(f, 1);
      else if (mode === "count") {
        for (const l of out) {
          const i = l.lastIndexOf(":");
          if (i > 0) files.set(isFile ? path.basename(target) : l.slice(0, i), Number(l.slice(i + 1)));
        }
      } else lines = out;
    } else {
      ({ lines, files } = await grepFallback({ ...input, output_mode: mode }, target, isFile, ctx.signal));
    }

    const toDisplay = (rel: string) => relPath(ctx.cwd, path.join(cwdForOutput, rel));
    if (mode === "content") {
      if (!lines.length) return { output: "No matches found.", metadata: { count: 0 } };
      const shown = lines.slice(0, limit).map((l) => {
        const m = /^(.*?)([:-])(\d+)([:-])/.exec(l);
        return m ? toDisplay(m[1]!) + l.slice(m[1]!.length) : l;
      });
      const clipped = clipOutput(shown.join("\n"), { maxBytes: 40_000, maxLines: limit + 10 });
      const more = lines.length > limit ? `\n(${lines.length - limit} more lines not shown; narrow the search or raise head_limit.)` : "";
      return { output: clipped.text + more, title: `${lines.length} line${lines.length === 1 ? "" : "s"}`, metadata: { count: lines.length } };
    }
    if (!files.size) return { output: "No matches found.", metadata: { count: 0 } };
    if (mode === "count") {
      const entries = [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      const total = [...files.values()].reduce((a, b) => a + b, 0);
      return {
        output: entries.map(([f, n]) => `${toDisplay(f)}: ${n}`).join("\n") + `\n\n(${total} matches in ${files.size} files)`,
        title: `${total} matches`,
        metadata: { count: total },
      };
    }
    const sorted = await sortByMtime(cwdForOutput, [...files.keys()], limit);
    const more = files.size > sorted.length ? `\n(${files.size - sorted.length} more files not shown.)` : "";
    return {
      output: sorted.map((f) => toDisplay(f.rel)).join("\n") + more,
      title: `${files.size} file${files.size === 1 ? "" : "s"}`,
      metadata: { count: files.size },
    };
  },
};

export const lsTool: Tool<{ path?: string; ignore?: string[]; depth?: number }> = {
  name: "ls",
  description: [
    "List a directory as a tree (directories first), respecting .gitignore and skipping dependency folders such as node_modules.",
    "- Use it to get oriented in unfamiliar directories; prefer glob or grep when you know what you are looking for.",
    "- depth limits recursion (default 3); ignore takes extra glob patterns to skip.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: working directory)" },
      ignore: { type: "array", items: { type: "string" }, description: "Glob patterns to skip" },
      depth: { type: "integer", description: "Maximum depth (default 3)", minimum: 1 },
    },
    additionalProperties: false,
  },
  readOnly: true,
  title: (input) => input.path ?? ".",
  async execute(input, ctx) {
    const dir = input.path ? resolvePath(ctx, input.path) : ctx.cwd;
    await checkExternal(ctx, dir, "read");
    try {
      if (!(await fs.stat(dir)).isDirectory()) throw new ToolError(`${dir} is not a directory. Use read for files.`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Directory not found: ${dir}`);
    }
    const extra = new IgnoreMatcher();
    if (input.ignore?.length) extra.add(input.ignore.join("\n"));
    const LIMIT = 400;
    const entries: Array<{ rel: string; isDir: boolean }> = [];
    let truncated = false;
    for await (const e of walk(dir, { includeDirs: true, maxDepth: input.depth ?? 3, signal: ctx.signal, maxEntries: LIMIT + 1 })) {
      if (extra.size && extra.ignores(e.rel, e.isDir)) continue;
      if (entries.length >= LIMIT) {
        truncated = true;
        break;
      }
      entries.push({ rel: e.rel, isDir: e.isDir });
    }
    // Build a tree.
    interface Node {
      name: string;
      dir: boolean;
      children: Map<string, Node>;
    }
    const rootNode: Node = { name: "", dir: true, children: new Map() };
    for (const e of entries) {
      const parts = e.rel.split("/");
      let node = rootNode;
      parts.forEach((part, i) => {
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, dir: i < parts.length - 1 || e.isDir, children: new Map() };
          node.children.set(part, child);
        }
        node = child;
      });
    }
    const lines: string[] = [relPath(ctx.cwd, dir) + "/"];
    const render = (node: Node, indent: string) => {
      const kids = [...node.children.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      for (const k of kids) {
        lines.push(`${indent}${k.name}${k.dir ? "/" : ""}`);
        if (k.dir) render(k, indent + "  ");
      }
    };
    render(rootNode, "  ");
    const skipped = [...DEFAULT_IGNORED_DIRS].slice(0, 4).join(", ");
    return {
      output:
        lines.join("\n") +
        (truncated ? `\n\n(Listing truncated at ${LIMIT} entries; list a subdirectory or use glob.)` : "") +
        `\n(Ignored: .gitignore entries and folders such as ${skipped}.)`,
      title: relPath(ctx.cwd, dir),
      metadata: { count: entries.length },
    };
  },
};
