import fs from "node:fs/promises";
import path from "node:path";
import type { ImagePart } from "../core/types.ts";
import { expandHome, imageMediaType, isBinaryBuffer } from "../util/fs.ts";

export interface Attachments {
  context: string[];
  images: ImagePart[];
  files: string[];
  missing: string[];
}

const MENTION_RE = /(^|\s)@("[^"]+"|[^\s,;()`'"]+)/g;
const MAX_FILE_CHARS = 100_000;

/** Resolve `@path` mentions into attached file contents, directory listings and images. */
export async function expandMentions(text: string, cwd: string): Promise<Attachments> {
  const out: Attachments = { context: [], images: [], files: [], missing: [] };
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    let raw = m[2]!;
    if (raw.startsWith('"')) raw = raw.slice(1, -1);
    raw = raw.replace(/[.:!?]+$/, "");
    // Line ranges: @file.ts:10-20
    const range = /^(.*?):(\d+)(?:-(\d+))?$/.exec(raw);
    const file = range ? range[1]! : raw;
    const abs = path.resolve(cwd, expandHome(file));
    if (seen.has(abs + (range ? raw : ""))) continue;
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      // Not a path (an email address, a decorator, ...): leave it alone.
      if (/[/\\.]/.test(file)) out.missing.push(file);
      continue;
    }
    seen.add(abs + (range ? raw : ""));
    const rel = path.relative(cwd, abs) || ".";
    if (st.isDirectory()) {
      const entries = (await fs.readdir(abs, { withFileTypes: true }))
        .filter((e) => e.name !== ".git" && e.name !== "node_modules")
        .slice(0, 200)
        .map((e) => e.name + (e.isDirectory() ? "/" : ""));
      out.context.push(`<directory path="${rel}">\n${entries.join("\n")}\n</directory>`);
      out.files.push(rel + "/");
      continue;
    }
    const media = imageMediaType(abs);
    if (media) {
      if (st.size <= 5 * 1024 * 1024) {
        out.images.push({ type: "image", mediaType: media, data: (await fs.readFile(abs)).toString("base64"), name: rel });
        out.files.push(rel);
      }
      continue;
    }
    const buf = await fs.readFile(abs);
    if (isBinaryBuffer(buf.subarray(0, 8192))) {
      out.context.push(`<file path="${rel}">(binary file, ${st.size} bytes, not included)</file>`);
      continue;
    }
    let content = buf.toString("utf8");
    let label = rel;
    if (range) {
      const lines = content.split(/\r?\n/);
      const from = Math.max(1, Number(range[2]));
      const to = Math.min(lines.length, Number(range[3] ?? range[2]));
      content = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
        .join("\n");
      label = `${rel}:${from}-${to}`;
    }
    if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS) + "\n[... truncated; use the read tool for the rest ...]";
    out.context.push(`<file path="${label}">\n${content}\n</file>`);
    out.files.push(label);
  }
  return out;
}
