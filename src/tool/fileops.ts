import fs from "node:fs/promises";
import path from "node:path";
import { directoryPattern } from "../permission/permission.ts";
import { diffText, formatUnifiedDiff } from "../util/diff.ts";
import { detectLineEnding, isBinaryBuffer } from "../util/fs.ts";
import { relPath, type ToolContext, ToolError } from "./types.ts";

export interface TextFile {
  exists: boolean;
  /** Content with LF line endings and no BOM. */
  text: string;
  bom: boolean;
  eol: "\n" | "\r\n";
}

export async function readTextFile(abs: string): Promise<TextFile> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "", bom: false, eol: "\n" };
    if ((err as NodeJS.ErrnoException).code === "EISDIR") throw new ToolError(`${abs} is a directory.`);
    throw err;
  }
  if (isBinaryBuffer(buf.subarray(0, 8192))) throw new ToolError(`${abs} is a binary file and cannot be edited as text.`);
  let text = buf.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = detectLineEnding(text);
  if (eol === "\r\n") text = text.replace(/\r\n/g, "\n");
  return { exists: true, text, bom, eol };
}

export function encodeTextFile(text: string, format: { bom: boolean; eol: "\n" | "\r\n" }): string {
  let out = format.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
  if (format.bom) out = "﻿" + out;
  return out;
}

export interface WriteOutcome {
  diff: string;
  additions: number;
  deletions: number;
  created: boolean;
}

/** Ask for permission (showing the diff), checkpoint, and write. */
export async function commitWrite(
  ctx: ToolContext,
  abs: string,
  before: TextFile,
  afterText: string,
  verb: string,
): Promise<WriteOutcome> {
  const rel = relPath(ctx.root, abs);
  const diff = formatUnifiedDiff(rel, before.text, afterText);
  const stats = diffText(before.text, afterText, 0);
  await ctx.permit({
    permission: "edit",
    patterns: [rel],
    always: [directoryPattern(ctx.root, abs)],
    title: `${verb} ${rel}`,
    detail: { path: abs, diff: diff || (before.exists ? "(no changes)" : `(new empty file)`) },
  });
  await ctx.checkpoint(abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, encodeTextFile(afterText, before.exists ? before : { bom: false, eol: "\n" }), "utf8");
  await ctx.files.markRead(abs);
  return { diff, additions: stats.additions, deletions: stats.deletions, created: !before.exists };
}

/** `cat -n` style excerpt around a changed region of the new content. */
export function snippet(text: string, startLine: number, endLine: number, context = 4, maxLines = 40): string {
  const lines = text.split("\n");
  const from = Math.max(1, startLine - context);
  const to = Math.min(lines.length, Math.max(endLine, startLine) + context, from + maxLines - 1);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${String(i).padStart(6)}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

export function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
