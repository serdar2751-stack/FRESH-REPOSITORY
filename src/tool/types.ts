import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/config.ts";
import type { ImagePart, TodoItem } from "../core/types.ts";
import type { PermissionRequest } from "../permission/permission.ts";
import type { ModelInfo } from "../provider/types.ts";
import { expandHome, isWithin } from "../util/fs.ts";
import type { JSONSchema } from "../util/schema.ts";
import type { ProcessManager } from "./processes.ts";

export interface ToolResult {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  images?: ImagePart[];
  isError?: boolean;
}

export type PermitRequest = Omit<PermissionRequest, "id" | "sessionId" | "tool" | "callId" | "agent">;

export interface QuestionRequest {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface SubagentRequest {
  agent: string;
  description: string;
  prompt: string;
}

export interface ToolContext {
  cwd: string;
  root: string;
  sessionId: string;
  callId: string;
  agent: string;
  signal: AbortSignal;
  config: Config;
  model: ModelInfo;
  /** Resolves when allowed; throws PermissionDeniedError otherwise. */
  permit(req: PermitRequest): Promise<void>;
  files: FileTracker;
  /** Record a file's content before it is modified (undo without git). */
  checkpoint(file: string): Promise<void>;
  /** Stream live output to UIs (e.g. a running command). */
  progress(chunk: string): void;
  todos: { get(): TodoItem[]; set(items: TodoItem[]): void };
  processes: ProcessManager;
  runSubagent?(req: SubagentRequest): Promise<{ output: string; sessionId: string }>;
  ask?(req: QuestionRequest): Promise<string>;
  /** Plan mode control for exit_plan_mode. */
  planMode?: { active(): boolean; exit(plan: string): Promise<{ approved: boolean; feedback?: string }> };
  skills?: Map<string, { name: string; description: string; path: string; body: string }>;
}

export interface Tool<I = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Safe to run concurrently with other read-only calls. */
  readOnly?: boolean;
  /** One-line label shown before and while the tool runs. */
  title?(input: I, cwd: string): string;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Resolve a model-supplied path against the working directory. */
export function resolvePath(ctx: { cwd: string }, p: string): string {
  if (typeof p !== "string" || !p.trim()) throw new ToolError("A file path is required.");
  let s = p.trim();
  if (s.startsWith("file://")) s = decodeURIComponent(new URL(s).pathname);
  return path.resolve(ctx.cwd, expandHome(s));
}

/** Path relative to the project root with forward slashes (for rules and display). */
export function relPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return (rel || ".").split(path.sep).join("/");
}

/**
 * Ask for "external_directory" permission when a path leaves the project root.
 * Symlinks are resolved so a link inside the project cannot escape silently.
 */
export async function checkExternal(ctx: ToolContext, abs: string, action: "read" | "write"): Promise<void> {
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch {
    // New file: check its closest existing parent.
    let dir = path.dirname(abs);
    for (;;) {
      try {
        real = path.join(await fs.realpath(dir), path.relative(dir, abs));
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  let rootReal = ctx.root;
  try {
    rootReal = await fs.realpath(ctx.root);
  } catch {
    // keep lexical root
  }
  if (isWithin(rootReal, real)) return;
  const dir = path.dirname(real);
  await ctx.permit({
    permission: "external_directory",
    patterns: [real],
    always: [dir + path.sep + "*"],
    title: `${action === "read" ? "Read" : "Write"} outside the project: ${real}`,
    detail: { path: real },
  });
}

/**
 * Tracks when files were last read so writes can refuse to clobber changes
 * the model has not seen.
 */
export class FileTracker {
  private readonly reads = new Map<string, number>();

  async markRead(abs: string): Promise<void> {
    try {
      const st = await fs.stat(abs);
      this.reads.set(abs, st.mtimeMs);
    } catch {
      this.reads.delete(abs);
    }
  }

  wasRead(abs: string): boolean {
    return this.reads.has(abs);
  }

  /** Throws when an existing file was not read or changed after the last read. */
  async assertFresh(abs: string): Promise<void> {
    let mtime: number;
    try {
      mtime = (await fs.stat(abs)).mtimeMs;
    } catch {
      return; // new file
    }
    const seen = this.reads.get(abs);
    if (seen === undefined) {
      throw new ToolError(`You must read ${abs} before modifying it. Use the read tool first.`);
    }
    if (mtime > seen + 1) {
      throw new ToolError(`${abs} was modified since you last read it (by the user or another process). Read it again before editing.`);
    }
  }

  forget(abs: string): void {
    this.reads.delete(abs);
  }
}
