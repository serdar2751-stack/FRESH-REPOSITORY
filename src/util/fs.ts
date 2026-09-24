import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWrite(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, data, mode !== undefined ? { mode } : undefined);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Heuristic binary detection on the first bytes of a file. */
export function isBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.3;
}

export function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.indexOf("\r\n");
  if (crlf === -1) return "\n";
  const lf = text.indexOf("\n");
  return lf === crlf + 1 ? "\r\n" : "\n";
}

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMediaType(file: string): string | undefined {
  return IMAGE_TYPES[path.extname(file).toLowerCase()];
}

/** Returns true when `child` is `parent` or inside it (lexically). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Find the nearest ancestor (including `start`) containing `marker`. */
export function findUp(start: string, marker: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Shorten an absolute path for display: relative to cwd, or ~-prefixed. */
export function displayPath(p: string, cwd: string): string {
  if (!p) return p;
  const abs = path.resolve(cwd, p);
  if (isWithin(cwd, abs)) {
    const rel = path.relative(cwd, abs);
    return rel || ".";
  }
  const home = os.homedir();
  if (isWithin(home, abs)) return "~" + path.sep + path.relative(home, abs);
  return abs;
}
