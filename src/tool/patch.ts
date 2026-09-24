import fs from "node:fs/promises";
import path from "node:path";
import { directoryPattern } from "../permission/permission.ts";
import { diffText, formatUnifiedDiff } from "../util/diff.ts";
import { encodeTextFile, readTextFile, type TextFile } from "./fileops.ts";
import { checkExternal, relPath, resolvePath, type Tool, ToolError } from "./types.ts";

export interface PatchChunk {
  header?: string;
  oldLines: string[];
  newLines: string[];
  eof: boolean;
}

export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; chunks: PatchChunk[] };

/** Parse the "*** Begin Patch" format used by OpenAI models. */
export function parsePatch(text: string): PatchOp[] {
  let src = text.replace(/\r\n/g, "\n");
  // Tolerate wrappers: markdown fences, `apply_patch <<'EOF'` heredocs.
  const begin = src.indexOf("*** Begin Patch");
  if (begin !== -1) src = src.slice(begin + "*** Begin Patch".length);
  const end = src.lastIndexOf("*** End Patch");
  if (end !== -1) src = src.slice(0, end);
  const lines = src.split("\n");
  const ops: PatchOp[] = [];
  let i = 0;
  const fileHeader = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = fileHeader.exec(line.trim());
    if (!m) {
      if (line.trim() && !line.startsWith("```") && !/^\*\*\* End of File/.test(line.trim())) {
        throw new ToolError(`Unexpected line in patch (expected "*** Add/Update/Delete File:"): ${line}`);
      }
      i++;
      continue;
    }
    const kind = m[1]!;
    const file = m[2]!.trim();
    i++;
    if (kind === "Delete") {
      ops.push({ type: "delete", path: file });
      continue;
    }
    if (kind === "Add") {
      const content: string[] = [];
      while (i < lines.length && !fileHeader.test(lines[i]!.trim())) {
        const l = lines[i]!;
        if (l.startsWith("+")) content.push(l.slice(1));
        else if (l.trim() && !l.startsWith("```")) throw new ToolError(`Lines in an Add File section must start with "+": ${l}`);
        i++;
      }
      ops.push({ type: "add", path: file, content: content.length ? content.join("\n") + "\n" : "" });
      continue;
    }
    const op: Extract<PatchOp, { type: "update" }> = { type: "update", path: file, chunks: [] };
    if (i < lines.length && lines[i]!.trim().startsWith("*** Move to:")) {
      op.moveTo = lines[i]!.trim().slice("*** Move to:".length).trim();
      i++;
    }
    let chunk: PatchChunk | undefined;
    const flush = () => {
      if (chunk && (chunk.oldLines.length || chunk.newLines.length)) op.chunks.push(chunk);
      chunk = undefined;
    };
    while (i < lines.length && !fileHeader.test(lines[i]!.trim())) {
      const l = lines[i]!;
      if (l.startsWith("@@")) {
        flush();
        const header = l.replace(/^@@+/, "").replace(/@@+\s*$/, "").trim();
        chunk = { header: header || undefined, oldLines: [], newLines: [], eof: false };
      } else if (l.trim() === "*** End of File") {
        chunk ??= { oldLines: [], newLines: [], eof: false };
        chunk.eof = true;
      } else if (l.startsWith("```")) {
        // stray fence
      } else {
        chunk ??= { oldLines: [], newLines: [], eof: false };
        const tag = l[0];
        const body = l.slice(1);
        if (tag === "+") chunk.newLines.push(body);
        else if (tag === "-") chunk.oldLines.push(body);
        else if (tag === " ") {
          chunk.oldLines.push(body);
          chunk.newLines.push(body);
        } else if (l === "") {
          chunk.oldLines.push("");
          chunk.newLines.push("");
        } else {
          // Models sometimes drop the leading space on context lines.
          chunk.oldLines.push(l);
          chunk.newLines.push(l);
        }
      }
      i++;
    }
    flush();
    // Trailing blank context lines produced by the split are noise.
    for (const c of op.chunks) {
      while (c.oldLines.length && c.newLines.length && c.oldLines.at(-1) === "" && c.newLines.at(-1) === "") {
        c.oldLines.pop();
        c.newLines.pop();
      }
    }
    if (!op.chunks.length && !op.moveTo) throw new ToolError(`Update for ${file} contains no changes.`);
    ops.push(op);
  }
  if (!ops.length) throw new ToolError("The patch contains no file operations.");
  return ops;
}

const PUNCT: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  " ": " ",
};
const normPunct = (s: string) => s.replace(/[‘’“”–— ]/g, (c) => PUNCT[c] ?? c);

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (!pattern.length) return start;
  const comparators: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normPunct(a.trim()) === normPunct(b.trim()),
  ];
  for (const eq of comparators) {
    const tryAt = (i: number) => pattern.every((p, j) => i + j < lines.length && eq(lines[i + j]!, p));
    if (eof) {
      const i = lines.length - pattern.length;
      if (i >= start && tryAt(i)) return i;
    }
    for (let i = start; i + pattern.length <= lines.length; i++) if (tryAt(i)) return i;
  }
  return -1;
}

export function applyChunks(original: string, chunks: PatchChunk[], file: string): string {
  const lines = original.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const replacements: Array<{ start: number; remove: number; insert: string[] }> = [];
  let pos = 0;
  for (const chunk of chunks) {
    if (chunk.header) {
      const h = seek(lines, [chunk.header], pos, false);
      if (h !== -1) pos = h + 1;
      else {
        // The header may itself be the first context line.
        const alt = lines.findIndex((l, idx) => idx >= pos && l.includes(chunk.header!));
        if (alt !== -1) pos = alt + 1;
      }
    }
    if (!chunk.oldLines.length) {
      const at = chunk.header ? pos : lines.length;
      replacements.push({ start: at, remove: 0, insert: chunk.newLines });
      continue;
    }
    let old = chunk.oldLines;
    let neu = chunk.newLines;
    const overlaps = (start: number, len: number) => replacements.some((r) => start < r.start + Math.max(r.remove, 1) && r.start < start + len);
    const locate = (pattern: string[]) => {
      const found = seek(lines, pattern, pos, chunk.eof);
      if (found !== -1) return found;
      // Hunks for one file may arrive out of order; search from the top.
      const again = seek(lines, pattern, 0, chunk.eof);
      return again !== -1 && !overlaps(again, pattern.length) ? again : -1;
    };
    let at = locate(old);
    if (at === -1 && old.at(-1) === "") {
      old = old.slice(0, -1);
      if (neu.at(-1) === "") neu = neu.slice(0, -1);
      at = locate(old);
    }
    if (at === -1) {
      throw new ToolError(
        `Could not find the lines to change in ${file}:\n${old.slice(0, 8).join("\n")}${old.length > 8 ? "\n…" : ""}\nRead the file again and make sure the context lines match exactly.`,
      );
    }
    replacements.push({ start: at, remove: old.length, insert: neu });
    pos = at + old.length;
  }
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) lines.splice(r.start, r.remove, ...r.insert);
  return lines.length ? lines.join("\n") + "\n" : "";
}

interface PlannedChange {
  abs: string;
  rel: string;
  kind: "add" | "delete" | "update" | "move";
  before: TextFile;
  after?: string;
  moveTo?: { abs: string; rel: string };
}

export const applyPatchTool: Tool<{ patch: string }> = {
  name: "apply_patch",
  description: [
    "Create, update, move or delete files by applying a patch in this format:",
    "",
    "*** Begin Patch",
    "*** Add File: path/to/new_file.py",
    "+first line",
    "+second line",
    "*** Update File: path/to/existing.py",
    "*** Move to: path/to/renamed.py",
    "@@ def function_containing_the_change():",
    " unchanged context line",
    "-line to remove",
    "+line to add",
    " unchanged context line",
    "*** Delete File: path/to/obsolete.py",
    "*** End Patch",
    "",
    "Rules:",
    "- Paths are relative to the working directory (absolute paths also work). *** Move to is optional.",
    "- Every hunk line starts with ' ' (context), '-' (remove) or '+' (add). Include about 3 lines of unchanged context before and after each change; add an @@ line naming the enclosing class or function when the context alone is ambiguous.",
    "- Several hunks and several files can go in one patch. All changes are applied together or not at all.",
    "- Read files before changing them so the context lines match.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The full patch text, from *** Begin Patch to *** End Patch" },
    },
    required: ["patch"],
    additionalProperties: false,
  },
  title: (input) => {
    try {
      return parsePatch(input.patch)
        .map((o) => o.path)
        .join(", ");
    } catch {
      return "patch";
    }
  },
  async execute(input, ctx) {
    const ops = parsePatch(input.patch);
    const plan: PlannedChange[] = [];
    for (const op of ops) {
      const abs = resolvePath(ctx, op.path);
      await checkExternal(ctx, abs, "write");
      const rel = relPath(ctx.root, abs);
      const before = await readTextFile(abs);
      if (op.type === "add") {
        if (before.exists) throw new ToolError(`Cannot add ${rel}: it already exists. Use *** Update File instead.`);
        plan.push({ abs, rel, kind: "add", before, after: op.content });
      } else if (op.type === "delete") {
        if (!before.exists) throw new ToolError(`Cannot delete ${rel}: file not found.`);
        plan.push({ abs, rel, kind: "delete", before });
      } else {
        if (!before.exists) throw new ToolError(`Cannot update ${rel}: file not found. Use *** Add File to create it.`);
        const after = op.chunks.length ? applyChunks(before.text, op.chunks, rel) : before.text;
        let moveTo: PlannedChange["moveTo"];
        if (op.moveTo) {
          const target = resolvePath(ctx, op.moveTo);
          await checkExternal(ctx, target, "write");
          moveTo = { abs: target, rel: relPath(ctx.root, target) };
        }
        plan.push({ abs, rel, kind: op.moveTo ? "move" : "update", before, after, moveTo });
      }
    }

    const diffs: string[] = [];
    let additions = 0;
    let deletions = 0;
    const summary: string[] = [];
    for (const c of plan) {
      const after = c.kind === "delete" ? "" : (c.after ?? "");
      const target = c.moveTo?.rel ?? c.rel;
      const d = formatUnifiedDiff(target, c.before.text, after);
      if (d) diffs.push(d);
      const s = diffText(c.before.text, after, 0);
      additions += s.additions;
      deletions += s.deletions;
      summary.push(
        c.kind === "add" ? `A ${c.rel}` : c.kind === "delete" ? `D ${c.rel}` : c.kind === "move" ? `R ${c.rel} -> ${c.moveTo!.rel}` : `M ${c.rel}`,
      );
    }
    const allPaths = [...new Set(plan.flatMap((c) => [c.rel, ...(c.moveTo ? [c.moveTo.rel] : [])]))];
    await ctx.permit({
      permission: "edit",
      patterns: allPaths,
      always: [...new Set(plan.map((c) => directoryPattern(ctx.root, c.abs)))],
      title: `Apply patch (${summary.join(", ")})`,
      detail: { diff: diffs.join("\n") },
    });
    for (const c of plan) {
      await ctx.checkpoint(c.abs);
      if (c.moveTo) await ctx.checkpoint(c.moveTo.abs);
      if (c.kind === "delete") {
        await fs.rm(c.abs, { force: true });
        ctx.files.forget(c.abs);
        continue;
      }
      const dest = c.moveTo?.abs ?? c.abs;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, encodeTextFile(c.after ?? "", c.before.exists ? c.before : { bom: false, eol: "\n" }), "utf8");
      if (c.moveTo && c.moveTo.abs !== c.abs) {
        await fs.rm(c.abs, { force: true });
        ctx.files.forget(c.abs);
      }
      await ctx.files.markRead(dest);
    }
    return {
      output: `Applied patch:\n${summary.join("\n")}`,
      title: summary.join(", "),
      metadata: { diff: diffs.join("\n"), additions, deletions, files: allPaths },
    };
  },
};
