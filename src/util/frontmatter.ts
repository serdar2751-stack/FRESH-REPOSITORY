/**
 * Markdown frontmatter + a YAML subset parser (block/flow mappings and
 * sequences, quoted and plain scalars, `|` / `>` block scalars, comments).
 * Enough for agent, command and skill definition files.
 */

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const src = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const parsed = parseYaml(m[1]!);
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, body: src.slice(m[0].length) };
}

interface Line {
  indent: number;
  text: string;
  raw: string;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle && line[i - 1] !== "\\") inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

export function parseYaml(text: string): unknown {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const lines: Line[] = rawLines.map((raw) => {
    const indent = /^ */.exec(raw)![0].length;
    return { indent, text: stripComment(raw.slice(indent)), raw };
  });
  const [value] = parseBlock(lines, 0, nextIndent(lines, 0));
  return value;
}

function nextIndent(lines: Line[], from: number): number {
  for (let i = from; i < lines.length; i++) if (lines[i]!.text) return lines[i]!.indent;
  return 0;
}

function skipBlank(lines: Line[], i: number): number {
  while (i < lines.length && !lines[i]!.text) i++;
  return i;
}

function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  let i = skipBlank(lines, start);
  if (i >= lines.length) return [null, i];
  if (lines[i]!.text.startsWith("- ") || lines[i]!.text === "-") return parseSequence(lines, i, indent);
  return parseMapping(lines, i, indent);
}

function splitKey(text: string): { key: string; rest: string } | undefined {
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0]!;
    let j = 1;
    while (j < text.length && text[j] !== q) j += text[j] === "\\" && q === '"' ? 2 : 1;
    const after = text.slice(j + 1);
    const m = /^\s*:(\s+|$)/.exec(after);
    if (!m) return undefined;
    return { key: parseScalar(text.slice(0, j + 1)) as string, rest: after.slice(m[0].length) };
  }
  const m = /^([^:#{}[\],][^:]*?)\s*:(\s+|$)/.exec(text);
  if (!m) return undefined;
  return { key: m[1]!, rest: text.slice(m[0].length) };
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i++;
      continue;
    }
    const kv = splitKey(line.text);
    if (!kv) break;
    i++;
    const [value, next] = parseValue(lines, i, indent, kv.rest);
    obj[kv.key] = value;
    i = next;
  }
  return [obj, i];
}

function parseSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    i = skipBlank(lines, i);
    if (i >= lines.length) break;
    const line = lines[i]!;
    if (line.indent !== indent || !(line.text.startsWith("- ") || line.text === "-")) break;
    const content = line.text === "-" ? "" : line.text.slice(2).trimStart();
    i++;
    if (!content) {
      const childIndent = nextIndent(lines, i);
      if (childIndent > indent) {
        const [v, next] = parseBlock(lines, i, childIndent);
        arr.push(v);
        i = next;
      } else arr.push(null);
      continue;
    }
    const kv = splitKey(content);
    if (kv && !content.startsWith("[") && !content.startsWith("{")) {
      // "- key: value" starts a mapping whose other keys are indented further.
      const itemIndent = indent + 2 + (line.text.slice(2).length - content.length);
      const obj: Record<string, unknown> = {};
      const [first, next] = parseValue(lines, i, itemIndent, kv.rest);
      obj[kv.key] = first;
      i = next;
      if (skipBlank(lines, i) < lines.length && lines[skipBlank(lines, i)]!.indent === itemIndent) {
        const [rest, after] = parseMapping(lines, i, itemIndent);
        Object.assign(obj, rest);
        i = after;
      }
      arr.push(obj);
      continue;
    }
    arr.push(parseInline(content));
  }
  return [arr, i];
}

function parseValue(lines: Line[], i: number, indent: number, rest: string): [unknown, number] {
  const r = rest.trim();
  if (/^[|>][-+]?\d*$/.test(r)) return parseBlockScalar(lines, i, indent, r);
  if (r) return [parseInline(r), i];
  const childIndent = nextIndent(lines, i);
  const j = skipBlank(lines, i);
  if (j < lines.length && childIndent > indent) return parseBlock(lines, i, childIndent);
  // A sequence may sit at the same indentation as its key.
  if (j < lines.length && childIndent === indent && lines[j]!.text.startsWith("- ")) return parseSequence(lines, j, indent);
  return [null, i];
}

function parseBlockScalar(lines: Line[], start: number, indent: number, header: string): [string, number] {
  const folded = header.startsWith(">");
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  let i = start;
  const collected: string[] = [];
  let blockIndent = -1;
  while (i < lines.length) {
    const raw = lines[i]!.raw;
    if (!raw.trim()) {
      collected.push("");
      i++;
      continue;
    }
    const ind = /^ */.exec(raw)![0].length;
    if (ind <= indent) break;
    if (blockIndent < 0) blockIndent = ind;
    if (ind < blockIndent) break;
    collected.push(raw.slice(blockIndent));
    i++;
  }
  let trailing = 0;
  while (collected.length && collected[collected.length - 1] === "") {
    collected.pop();
    trailing++;
  }
  let text: string;
  if (folded) {
    text = "";
    for (let k = 0; k < collected.length; k++) {
      const l = collected[k]!;
      if (l === "") text += "\n";
      else if (k > 0 && collected[k - 1] !== "" && !/^\s/.test(l)) text += " " + l;
      else text += (k > 0 && !text.endsWith("\n") ? "\n" : "") + l;
    }
  } else text = collected.join("\n");
  if (chomp === "clip") text += "\n";
  else if (chomp === "keep") text += "\n".repeat(trailing + 1);
  return [text, i];
}

export function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t.replace(/\\'/g, "'"));
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Parse a flow value: scalar, `[...]` or `{...}`. */
export function parseInline(s: string): unknown {
  const t = s.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return parseScalar(t);
  const p = { s: t, i: 0 };
  try {
    const v = parseFlow(p);
    return v;
  } catch {
    return t;
  }
}

function parseFlow(p: { s: string; i: number }): unknown {
  skipWs(p);
  const c = p.s[p.i];
  if (c === "[") {
    p.i++;
    const arr: unknown[] = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === "]") {
        p.i++;
        return arr;
      }
      arr.push(parseFlow(p));
      skipWs(p);
      if (p.s[p.i] === ",") p.i++;
      else if (p.s[p.i] === "]") {
        p.i++;
        return arr;
      } else throw new Error("bad flow sequence");
    }
  }
  if (c === "{") {
    p.i++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === "}") {
        p.i++;
        return obj;
      }
      const key = String(readFlowScalar(p, true));
      skipWs(p);
      if (p.s[p.i] !== ":") throw new Error("bad flow mapping");
      p.i++;
      obj[key] = parseFlow(p);
      skipWs(p);
      if (p.s[p.i] === ",") p.i++;
      else if (p.s[p.i] === "}") {
        p.i++;
        return obj;
      } else throw new Error("bad flow mapping");
    }
  }
  return readFlowScalar(p, false);
}

function skipWs(p: { s: string; i: number }): void {
  while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i++;
}

function readFlowScalar(p: { s: string; i: number }, isKey: boolean): unknown {
  skipWs(p);
  const q = p.s[p.i];
  if (q === '"' || q === "'") {
    let j = p.i + 1;
    while (j < p.s.length && p.s[j] !== q) j += p.s[j] === "\\" && q === '"' ? 2 : 1;
    const raw = p.s.slice(p.i, j + 1);
    p.i = j + 1;
    return parseScalar(raw);
  }
  let j = p.i;
  const stop = isKey ? /[:,}\]]/ : /[,}\]]/;
  while (j < p.s.length && !stop.test(p.s[j]!)) j++;
  const raw = p.s.slice(p.i, j);
  p.i = j;
  return parseScalar(raw);
}
