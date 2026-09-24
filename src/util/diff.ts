export type DiffOp = { type: "equal" | "insert" | "delete"; line: string };

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines prefixed with " ", "-" or "+". */
  lines: string[];
}

const MAX_EDIT_DISTANCE = 6000;

/** Line diff (Myers O(ND)) with common prefix/suffix trimming. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "equal", line: a[i]! });
  for (const op of myers(a.slice(start, endA), b.slice(start, endB))) ops.push(op);
  for (let i = endA; i < a.length; i++) ops.push({ type: "equal", line: a[i]! });
  return ops;
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: "insert" as const, line }));
  if (m === 0) return a.map((line) => ({ type: "delete" as const, line }));
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) break;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  if (found < 0) {
    // Too different to diff cheaply: replace wholesale.
    return [
      ...a.map((line) => ({ type: "delete" as const, line })),
      ...b.map((line) => ({ type: "insert" as const, line })),
    ];
  }
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const vd = trace[d]!;
    const get = (k: number) => vd[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "insert", line: b[y - 1]! });
      else ops.push({ type: "delete", line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function buildHunks(ops: DiffOp[], context = 3): Hunk[] {
  const changes: number[] = [];
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let nw = 1;
  ops.forEach((op, i) => {
    oldNo.push(o);
    newNo.push(nw);
    if (op.type !== "insert") o++;
    if (op.type !== "delete") nw++;
    if (op.type !== "equal") changes.push(i);
  });
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < changes.length) {
    const start = Math.max(0, changes[i]! - context);
    let last = changes[i]!;
    let j = i;
    // Merge changes separated by at most 2*context unchanged lines.
    while (j + 1 < changes.length && changes[j + 1]! - last - 1 <= 2 * context) {
      j++;
      last = changes[j]!;
    }
    const end = Math.min(ops.length - 1, last + context);
    const h: Hunk = { oldStart: oldNo[start]!, newStart: newNo[start]!, oldLines: 0, newLines: 0, lines: [] };
    for (let k = start; k <= end; k++) {
      const op = ops[k]!;
      if (op.type === "equal") {
        h.lines.push(" " + op.line);
        h.oldLines++;
        h.newLines++;
      } else if (op.type === "delete") {
        h.lines.push("-" + op.line);
        h.oldLines++;
      } else {
        h.lines.push("+" + op.line);
        h.newLines++;
      }
    }
    // Unified diff convention: an empty side starts at the line before.
    if (h.oldLines === 0) h.oldStart = Math.max(0, h.oldStart - 1);
    if (h.newLines === 0) h.newStart = Math.max(0, h.newStart - 1);
    hunks.push(h);
    i = j + 1;
  }
  return hunks;
}

export interface DiffResult {
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

export function diffText(oldText: string, newText: string, context = 3): DiffResult {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "insert") additions++;
    else if (op.type === "delete") deletions++;
  }
  return { hunks: buildHunks(ops, context), additions, deletions };
}

export function formatUnifiedDiff(file: string, oldText: string, newText: string, context = 3): string {
  const { hunks } = diffText(oldText, newText, context);
  if (!hunks.length) return "";
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.join("\n");
}
