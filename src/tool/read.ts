import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { imageMediaType, isBinaryBuffer } from "../util/fs.ts";
import { levenshtein } from "../util/text.ts";
import { checkExternal, relPath, resolvePath, type Tool, ToolError } from "./types.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

async function readRange(file: string, offset: number, limit: number): Promise<{ lines: string[]; total: number }> {
  const lines: string[] = [];
  let n = 0;
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    n++;
    if (n >= offset && lines.length < limit) lines.push(line);
  }
  return { lines, total: n };
}

async function suggest(abs: string): Promise<string> {
  const dir = path.dirname(abs);
  const base = path.basename(abs).toLowerCase();
  try {
    const entries = await fs.readdir(dir);
    const close = entries
      .map((e) => ({ e, d: levenshtein(e.toLowerCase(), base) }))
      .filter(({ e, d }) => d <= Math.max(2, Math.floor(base.length / 4)) || e.toLowerCase().startsWith(base.split(".")[0]!))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(({ e }) => path.join(dir, e));
    return close.length ? `\nDid you mean one of these?\n${close.join("\n")}` : "";
  } catch {
    return "";
  }
}

export const readTool: Tool<ReadInput> = {
  name: "read",
  description: [
    "Read a file from the local filesystem.",
    "- file_path may be absolute or relative to the working directory.",
    `- Reads up to ${DEFAULT_LIMIT} lines from the start by default; pass offset (1-based line number) and limit to page through long files.`,
    `- Output is in cat -n format: line number, a tab, then the line. Lines longer than ${MAX_LINE} characters are cut.`,
    "- Images (png, jpg, gif, webp) are returned as images for models that support vision.",
    "- Always read a file before editing it. Read several files in parallel when you need them.",
    "- Use the ls tool for directories.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file to read" },
      offset: { type: "integer", description: "1-based line number to start reading from", minimum: 1 },
      limit: { type: "integer", description: "Maximum number of lines to read", minimum: 1 },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  readOnly: true,
  title: (input, cwd) => relPath(cwd, resolvePath({ cwd }, input.file_path)),
  async execute(input, ctx) {
    const abs = resolvePath(ctx, input.file_path);
    await checkExternal(ctx, abs, "read");
    const rel = relPath(ctx.root, abs);
    await ctx.permit({
      permission: "read",
      patterns: [rel],
      always: [rel],
      title: `Read ${rel}`,
      detail: { path: abs },
    });
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new ToolError(`File not found: ${abs}${await suggest(abs)}`);
    }
    if (st.isDirectory()) throw new ToolError(`${abs} is a directory. Use the ls tool to list it.`);

    const media = imageMediaType(abs);
    if (media) {
      if (!ctx.model.vision) throw new ToolError(`${abs} is an image and the current model does not accept images.`);
      if (st.size > MAX_IMAGE_BYTES) throw new ToolError(`Image is too large (${Math.round(st.size / 1024)} KB, limit 5 MB).`);
      const data = await fs.readFile(abs);
      await ctx.files.markRead(abs);
      return {
        output: `Image ${rel} (${media}, ${Math.round(st.size / 1024)} KB)`,
        title: rel,
        images: [{ type: "image", mediaType: media, data: data.toString("base64"), name: path.basename(abs) }],
      };
    }

    const handle = await fs.open(abs, "r");
    try {
      const head = Buffer.alloc(Math.min(8192, st.size));
      if (head.length) await handle.read(head, 0, head.length, 0);
      if (isBinaryBuffer(head)) {
        const ext = path.extname(abs).toLowerCase();
        const hint = ext === ".pdf" ? " For PDFs try `pdftotext file.pdf -` via bash if it is installed." : "";
        throw new ToolError(`${abs} appears to be a binary file and cannot be read as text.${hint}`);
      }
    } finally {
      await handle.close();
    }

    const offset = Math.max(1, Math.floor(input.offset ?? 1));
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    let lines: string[];
    let total: number;
    if (st.size > 2 * 1024 * 1024) {
      ({ lines, total } = await readRange(abs, offset, limit));
    } else {
      let text = await fs.readFile(abs, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const all = text.split(/\r?\n/);
      if (all.length && all[all.length - 1] === "") all.pop();
      total = all.length;
      lines = all.slice(offset - 1, offset - 1 + limit);
    }
    await ctx.files.markRead(abs);

    if (total === 0) {
      return { output: `<system-reminder>${rel} exists but is empty.</system-reminder>`, title: rel, metadata: { lines: 0 } };
    }
    if (offset > total) {
      throw new ToolError(`offset ${offset} is past the end of the file (${total} lines).`);
    }
    let cut = 0;
    const body = lines
      .map((line, i) => {
        let l = line;
        if (l.length > MAX_LINE) {
          l = l.slice(0, MAX_LINE) + " … [line truncated]";
          cut++;
        }
        return `${String(offset + i).padStart(6)}\t${l}`;
      })
      .join("\n");
    const last = offset + lines.length - 1;
    const notes: string[] = [];
    if (last < total || offset > 1) notes.push(`Showing lines ${offset}-${last} of ${total}.${last < total ? ` Use offset=${last + 1} to continue.` : ""}`);
    if (cut) notes.push(`${cut} long line(s) were truncated.`);
    return {
      output: body + (notes.length ? `\n\n(${notes.join(" ")})` : ""),
      title: rel,
      metadata: { lines: lines.length, total, offset, path: rel },
    };
  },
};
