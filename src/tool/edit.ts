import { commitWrite, lineOf, readTextFile, snippet } from "./fileops.ts";
import { closestLine, findMatches } from "./fuzzy.ts";
import { checkExternal, relPath, resolvePath, type Tool, ToolError } from "./types.ts";

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editTool: Tool<EditInput> = {
  name: "edit",
  description: [
    "Replace text in a file (exact string replacement).",
    "- Read the file first; the edit fails otherwise.",
    "- old_string must match the file exactly, including indentation. Never include the line-number prefix from read output (the number and tab) in old_string or new_string.",
    "- The edit fails when old_string is missing or matches more than once: add surrounding lines to make it unique, or set replace_all to change every occurrence (e.g. renaming a variable).",
    "- To create a new file, pass an empty old_string and the full content as new_string.",
    "- Keep each edit focused; make several edit calls for separate regions.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file to modify" },
      old_string: { type: "string", description: "The text to replace" },
      new_string: { type: "string", description: "The replacement text (must differ from old_string)" },
      replace_all: { type: "boolean", description: "Replace every occurrence of old_string (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  title: (input, cwd) => relPath(cwd, resolvePath({ cwd }, input.file_path)),
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    await checkExternal(ctx, abs, "write");
    const oldString = input.old_string.replace(/\r\n/g, "\n");
    const newString = input.new_string.replace(/\r\n/g, "\n");
    const before = await readTextFile(abs);
    const rel = relPath(ctx.root, abs);

    if (!before.exists) {
      if (oldString !== "") throw new ToolError(`File not found: ${abs}. To create it, use an empty old_string (or the write tool).`);
      const res = await commitWrite(ctx, abs, before, newString, "Create");
      return {
        output: `Created ${rel}.`,
        title: rel,
        metadata: { diff: res.diff, additions: res.additions, deletions: res.deletions, created: true, path: rel },
      };
    }
    await ctx.files.assertFresh(abs);
    if (oldString === newString) throw new ToolError("old_string and new_string are identical; nothing to change.");
    if (oldString === "") {
      if (before.text.trim() !== "") throw new ToolError("old_string is empty but the file has content. Provide the text to replace.");
      const res = await commitWrite(ctx, abs, before, newString, "Write");
      return { output: `Wrote ${rel}.`, title: rel, metadata: { diff: res.diff, additions: res.additions, deletions: res.deletions, path: rel } };
    }

    const found = findMatches(before.text, oldString);
    if (!found.matches.length) {
      const near = closestLine(before.text, oldString);
      throw new ToolError(
        `old_string was not found in ${rel}. It must match the file exactly (whitespace included).` +
          (near ? `\nThe closest line is ${near.line}: ${near.text.trim()}\nRead the file again around that line and retry.` : " Read the file again and retry."),
      );
    }
    if (found.matches.length > 1 && !input.replace_all) {
      const lines = found.matches.map((m) => lineOf(before.text, m.start));
      throw new ToolError(
        `old_string matches ${found.matches.length} places in ${rel} (lines ${lines.slice(0, 10).join(", ")}). Include more surrounding context to make it unique, or set replace_all: true.`,
      );
    }
    let out = "";
    let last = 0;
    const targets = input.replace_all ? found.matches : [found.matches[0]!];
    for (const m of targets) {
      out += before.text.slice(last, m.start);
      out += found.replacement ? found.replacement(m.text, newString) : newString;
      last = m.end;
    }
    out += before.text.slice(last);

    const res = await commitWrite(ctx, abs, before, out, "Edit");
    const firstStart = targets[0]!.start;
    const startLine = lineOf(out, firstStart);
    const endLine = startLine + newString.split("\n").length - 1;
    const note = found.strategy !== "exact" ? ` (matched with ${found.strategy}-tolerant comparison)` : "";
    const count = targets.length > 1 ? ` ${targets.length} occurrences replaced.` : "";
    return {
      output: `Edited ${rel}${note}.${count} Snippet of the result:\n${snippet(out, startLine, endLine)}`,
      title: rel,
      metadata: { diff: res.diff, additions: res.additions, deletions: res.deletions, path: rel, strategy: found.strategy },
    };
  },
};
