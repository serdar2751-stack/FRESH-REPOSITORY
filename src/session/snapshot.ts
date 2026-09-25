import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileChange } from "../core/types.ts";
import { runFile, which } from "../util/shell.ts";

/**
 * Workspace checkpoints. In git repositories a private "shadow" git
 * directory (separate from the project's .git) records a tree per turn, which
 * captures every change - including those made by shell commands - and makes
 * undo/redo exact. Elsewhere, originals of files touched by the edit tools
 * are kept in memory instead.
 */
export interface Snapshotter {
  readonly kind: "git" | "files";
  /** Record the current workspace state; returns an id. */
  track(): Promise<string>;
  /** Files changed since `id`. */
  changes(id: string): Promise<FileChange[]>;
  /** Unified diff since `id`. */
  diff(id: string): Promise<string>;
  /** Restore files changed since `id` to their state at `id`. */
  restore(id: string): Promise<FileChange[]>;
  /** Called by edit tools before modifying a file. */
  beforeWrite(file: string): Promise<void>;
}

export class GitSnapshotter implements Snapshotter {
  readonly kind = "git" as const;
  private readonly gitDir: string;
  private readonly root: string;
  private ready?: Promise<void>;

  constructor(root: string, dataDir: string) {
    this.root = root;
    this.gitDir = path.join(dataDir, "snapshots", createHash("sha256").update(root).digest("hex").slice(0, 16));
  }

  static available(root: string): boolean {
    return Boolean(which("git")) && existsSync(path.join(root, ".git"));
  }

  private git(args: string[], input?: string) {
    return runFile("git", ["--git-dir", this.gitDir, "--work-tree", this.root, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args], {
      cwd: this.root,
      timeoutMs: 120_000,
      input,
      env: { ...process.env, GIT_INDEX_FILE: path.join(this.gitDir, "index"), GIT_TERMINAL_PROMPT: "0" },
    });
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      if (!existsSync(path.join(this.gitDir, "HEAD"))) {
        await fs.mkdir(this.gitDir, { recursive: true });
        const res = await runFile("git", ["init", "--quiet", "--bare", this.gitDir], { cwd: this.root });
        if (res.code !== 0) throw new Error(`snapshot init failed: ${res.stderr}`);
        await this.git(["config", "core.bare", "false"]);
        await this.git(["config", "gc.auto", "0"]);
      }
      // Heavy dependency folders are not worth snapshotting even when not ignored.
      await fs.mkdir(path.join(this.gitDir, "info"), { recursive: true });
      await fs.writeFile(path.join(this.gitDir, "info", "exclude"), ".git/\nnode_modules/\n.venv/\n__pycache__/\n");
    })();
    return this.ready;
  }

  async track(): Promise<string> {
    await this.init();
    const add = await this.git(["add", "--all", "--", "."]);
    if (add.code !== 0) throw new Error(`snapshot add failed: ${add.stderr.trim()}`);
    const tree = await this.git(["write-tree"]);
    if (tree.code !== 0) throw new Error(`snapshot write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  }

  async changes(id: string): Promise<FileChange[]> {
    const current = await this.track();
    if (current === id) return [];
    const [status, numstat] = await Promise.all([
      this.git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", id, current]),
      this.git(["diff-tree", "-r", "--no-renames", "--numstat", "-z", id, current]),
    ]);
    const stats = new Map<string, { add?: number; del?: number }>();
    const ns = numstat.stdout.split("\0");
    for (const entry of ns) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
      if (m) stats.set(m[3]!, { add: m[1] === "-" ? undefined : Number(m[1]), del: m[2] === "-" ? undefined : Number(m[2]) });
    }
    const parts = status.stdout.split("\0").filter(Boolean);
    const out: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]!;
      const file = parts[i + 1]!;
      const s = stats.get(file);
      out.push({
        path: file,
        status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
        additions: s?.add,
        deletions: s?.del,
      });
    }
    return out;
  }

  async diff(id: string): Promise<string> {
    const current = await this.track();
    const res = await this.git(["diff-tree", "-r", "-p", "--no-renames", "--no-color", id, current]);
    return res.stdout;
  }

  async restore(id: string): Promise<FileChange[]> {
    const changed = await this.changes(id);
    const added = changed.filter((c) => c.status === "added").map((c) => c.path);
    const others = changed.filter((c) => c.status !== "added").map((c) => c.path);
    for (const rel of added) await fs.rm(path.join(this.root, rel), { force: true });
    // Directories the turn created and that are now empty go too.
    const dirs = [...new Set(added.map((rel) => path.dirname(rel)).filter((d) => d !== "."))].sort((a, b) => b.length - a.length);
    for (const d of dirs) await removeEmptyDirs(this.root, d);
    if (others.length) {
      // checkout restores content, the executable bit and symlinks exactly.
      const res = await this.git(["--literal-pathspecs", "checkout", id, "--pathspec-from-file=-", "--pathspec-file-nul"], others.join("\0"));
      if (res.code !== 0) await this.restoreContents(id, others);
    }
    await this.track();
    return changed;
  }

  /** Fallback for old git versions: write the recorded contents back. */
  private async restoreContents(id: string, files: string[]): Promise<void> {
    for (const rel of files) {
      const abs = path.join(this.root, rel);
      const blob = await this.git(["rev-parse", `${id}:${rel}`]);
      const hash = blob.stdout.trim();
      if (!hash) continue;
      const raw = await this.catRaw(hash);
      if (!raw) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, raw);
    }
  }

  private async catRaw(hash: string): Promise<Buffer | undefined> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn("git", ["--git-dir", this.gitDir, "cat-file", "blob", hash], { stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("error", () => resolve(undefined));
      child.on("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
    });
  }

  async beforeWrite(): Promise<void> {
    // The per-turn tree already captures everything.
  }
}

/** Remove `rel` and its parents (below root) while they are empty directories. */
async function removeEmptyDirs(root: string, rel: string): Promise<void> {
  let dir = rel;
  while (dir && dir !== "." && dir !== "/") {
    try {
      await fs.rmdir(path.join(root, dir));
    } catch {
      return; // not empty or already gone
    }
    dir = path.dirname(dir);
  }
}

/** Fallback when git is unavailable: remember originals of files the tools modify. */
export class FileSnapshotter implements Snapshotter {
  readonly kind = "files" as const;
  private readonly root: string;
  private counter = 0;
  /** snapshot id -> (path -> original content or null when absent) */
  private readonly saves = new Map<string, Map<string, Buffer | null>>();
  private current?: string;

  constructor(root: string) {
    this.root = root;
  }

  async track(): Promise<string> {
    const id = `files-${++this.counter}-${Date.now()}`;
    // Capture the current state of every file the tools have touched so far,
    // so restoring this snapshot (e.g. for redo) is exact for those files.
    const known = new Set<string>();
    for (const map of this.saves.values()) for (const f of map.keys()) known.add(f);
    const map = new Map<string, Buffer | null>();
    for (const f of known) {
      try {
        map.set(f, await fs.readFile(f));
      } catch {
        map.set(f, null);
      }
    }
    this.saves.set(id, map);
    this.current = id;
    while (this.saves.size > 60) this.saves.delete(this.saves.keys().next().value!);
    return id;
  }

  async beforeWrite(file: string): Promise<void> {
    if (!this.current) await this.track();
    // Record the original for every open snapshot that has not seen this file yet.
    for (const [, map] of this.saves) {
      if (map.has(file)) continue;
      try {
        map.set(file, await fs.readFile(file));
      } catch {
        map.set(file, null);
      }
    }
  }

  async changes(id: string): Promise<FileChange[]> {
    const map = this.saves.get(id);
    if (!map) return [];
    const out: FileChange[] = [];
    for (const [file, original] of map) {
      let now: Buffer | null = null;
      try {
        now = await fs.readFile(file);
      } catch {
        now = null;
      }
      if (original === null && now === null) continue;
      if (original && now && original.equals(now)) continue;
      out.push({
        path: path.relative(this.root, file).split(path.sep).join("/"),
        status: original === null ? "added" : now === null ? "deleted" : "modified",
      });
    }
    return out;
  }

  async diff(id: string): Promise<string> {
    const { formatUnifiedDiff } = await import("../util/diff.ts");
    const map = this.saves.get(id);
    if (!map) return "";
    const parts: string[] = [];
    for (const [file, original] of map) {
      let now = "";
      try {
        now = await fs.readFile(file, "utf8");
      } catch {
        now = "";
      }
      const d = formatUnifiedDiff(path.relative(this.root, file), original?.toString("utf8") ?? "", now);
      if (d) parts.push(d);
    }
    return parts.join("\n");
  }

  async restore(id: string): Promise<FileChange[]> {
    const changed = await this.changes(id);
    const map = this.saves.get(id);
    if (!map) return [];
    for (const [file, original] of map) {
      if (original === null) await fs.rm(file, { force: true });
      else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, original);
      }
    }
    return changed;
  }
}

export function createSnapshotter(root: string, dataDir: string, enabled = true): Snapshotter {
  if (enabled && GitSnapshotter.available(root)) return new GitSnapshotter(root, dataDir);
  return new FileSnapshotter(root);
}
