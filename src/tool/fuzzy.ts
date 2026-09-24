/**
 * Locate `find` inside `content` for string replacement. Exact matches are
 * preferred; otherwise progressively looser strategies tolerate the common
 * ways models misquote code (indentation, trailing whitespace, escapes).
 */

export interface MatchResult {
  /** Exact substrings of `content` that should be replaced. */
  matches: Array<{ start: number; end: number; text: string }>;
  strategy: string;
  /** Replacement to use (re-indented for indentation-flexible matches). */
  replacement?: (original: string, newString: string) => string;
}

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Find blocks of whole lines whose normalized form equals the normalized find lines. */
function lineBlockMatches(content: string, find: string, norm: (line: string) => string): Array<{ start: number; end: number; text: string }> {
  const findLines = find.split("\n");
  while (findLines.length > 1 && findLines[findLines.length - 1]!.trim() === "") findLines.pop();
  while (findLines.length > 1 && findLines[0]!.trim() === "") findLines.shift();
  if (!findLines.length || findLines.every((l) => !l.trim())) return [];
  const lines = content.split("\n");
  const starts = lineStarts(content);
  const target = findLines.map(norm);
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(lines[i + j]!) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = starts[i]!;
    const lastLine = i + target.length - 1;
    const end = starts[lastLine]! + lines[lastLine]!.length;
    out.push({ start, end, text: content.slice(start, end) });
    i += target.length - 1;
  }
  return out;
}

function commonIndent(lines: string[]): string {
  let indent: string | undefined;
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = /^[ \t]*/.exec(l)![0];
    if (indent === undefined || m.length < indent.length) indent = m;
  }
  return indent ?? "";
}

function reindent(original: string, oldString: string, newString: string): string {
  const origIndent = commonIndent(original.split("\n"));
  const oldIndent = commonIndent(oldString.split("\n"));
  if (origIndent === oldIndent) return newString;
  return newString
    .split("\n")
    .map((l) => {
      if (!l.trim()) return l;
      if (l.startsWith(oldIndent)) return origIndent + l.slice(oldIndent.length);
      return origIndent + l.trimStart();
    })
    .join("\n");
}

function unescape(s: string): string {
  return s.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
}

export function findMatches(content: string, find: string): MatchResult {
  const exact = allIndexes(content, find);
  if (exact.length) {
    return { strategy: "exact", matches: exact.map((start) => ({ start, end: start + find.length, text: find })) };
  }
  const strategies: Array<{ name: string; run: () => Array<{ start: number; end: number; text: string }>; reindent?: boolean }> = [
    { name: "trailing-whitespace", run: () => lineBlockMatches(content, find, (l) => l.trimEnd()) },
    { name: "indentation", run: () => lineBlockMatches(content, find, (l) => l.trim()), reindent: true },
    { name: "whitespace", run: () => lineBlockMatches(content, find, (l) => l.replace(/\s+/g, " ").trim()), reindent: true },
    {
      name: "escapes",
      run: () => {
        const u = unescape(find);
        if (u === find) return [];
        return allIndexes(content, u).map((start) => ({ start, end: start + u.length, text: u }));
      },
    },
    {
      name: "trimmed",
      run: () => {
        const t = find.trim();
        if (!t || t === find) return [];
        return allIndexes(content, t).map((start) => ({ start, end: start + t.length, text: t }));
      },
    },
  ];
  for (const s of strategies) {
    const matches = s.run();
    if (matches.length) {
      return {
        strategy: s.name,
        matches,
        replacement: s.reindent ? (original, newString) => reindent(original, find, newString) : undefined,
      };
    }
  }
  return { strategy: "none", matches: [] };
}

/** Closest line to help the model fix a failed match. */
export function closestLine(content: string, find: string): { line: number; text: string } | undefined {
  const first = find.split("\n").find((l) => l.trim())?.trim();
  if (!first) return undefined;
  const lines = content.split("\n");
  let best: { line: number; score: number; text: string } | undefined;
  const words = new Set(first.split(/\W+/).filter(Boolean));
  if (!words.size) return undefined;
  lines.forEach((l, i) => {
    const lw = l.split(/\W+/).filter(Boolean);
    let score = 0;
    for (const w of lw) if (words.has(w)) score++;
    if (score && (!best || score > best.score)) best = { line: i + 1, score, text: l };
  });
  return best && best.score >= Math.min(2, words.size) ? { line: best.line, text: best.text } : undefined;
}
