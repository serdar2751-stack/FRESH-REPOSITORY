import { countLines } from "../util/text.ts";
import { commitWrite, readTextFile } from "./fileops.ts";
import { checkExternal, relPath, resolvePath, type Tool } from "./types.ts";

interface WriteInput {
  file_path: string;
  content: string;
}

export const writeTool: Tool<WriteInput> = {
  name: "write",
  description: [
    "Write a file to the local filesystem, replacing its contents if it exists.",
    "- If the file already exists you must read it first; the write fails otherwise.",
    "- Prefer the edit tool for changing existing files; use write for new files or complete rewrites.",
    "- Parent directories are created automatically.",
    "- Do not create documentation or README files unless the user asks for them.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file to write (absolute or relative to the working directory)" },
      content: { type: "string", description: "The complete file content" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  title: (input, cwd) => relPath(cwd, resolvePath({ cwd }, input.file_path)),
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    await checkExternal(ctx, abs, "write");
    const before = await readTextFile(abs);
    if (before.exists) await ctx.files.assertFresh(abs);
    const content = input.content.replace(/\r\n/g, "\n");
    const res = await commitWrite(ctx, abs, before, content, before.exists ? "Overwrite" : "Create");
    const rel = relPath(ctx.root, abs);
    return {
      output: res.created
        ? `Created ${rel} (${countLines(content)} lines).`
        : `Overwrote ${rel} (${countLines(content)} lines, +${res.additions} -${res.deletions}).`,
      title: rel,
      metadata: { diff: res.diff, additions: res.additions, deletions: res.deletions, created: res.created, path: rel },
    };
  },
};
