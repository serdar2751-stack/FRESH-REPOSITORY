import { stripAnsi } from "./text.ts";

// Code point ranges rendered as two columns by most terminals
// (East Asian Wide/Fullwidth plus the common emoji blocks).
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200b || // zero width space
    cp === 0x200c ||
    cp === 0x200d || // ZWJ
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) || // skin tone modifiers
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Display width of a string in terminal columns (ANSI escapes ignored). */
export function stringWidth(s: string): number {
  const plain = s.includes("\u001b") ? stripAnsi(s) : s;
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/**
 * Cut a plain (ANSI-free) string so that it fits in `width` columns.
 */
export function sliceByWidth(s: string, width: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/**
 * Truncate a string that may contain ANSI escapes to `width` columns,
 * preserving escape sequences and appending `ellipsis` when cut.
 */
export function truncateAnsi(s: string, width: number, ellipsis = "…"): string {
  if (stringWidth(s) <= width) return s;
  const target = Math.max(0, width - stringWidth(ellipsis));
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      const m = /^\u001b\[[0-9;?]*[ -/]*[@-~]|^\u001b\][^\u0007]*(\u0007|\u001b\\)/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ellipsis + "\u001b[0m";
}

/**
 * Word-wrap plain text to `width` columns. Long words are hard-broken.
 * Returns the wrapped lines (without trailing newlines).
 */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  for (const para of text.split("\n")) {
    if (stringWidth(para) <= w) {
      out.push(para);
      continue;
    }
    const leading = /^\s*/.exec(para)![0];
    const words = para.slice(leading.length).split(/(\s+)/);
    let line = leading;
    let lineW = stringWidth(leading);
    for (const token of words) {
      if (!token) continue;
      const tw = stringWidth(token);
      if (/^\s+$/.test(token)) {
        if (lineW + tw <= w) {
          line += token;
          lineW += tw;
        }
        continue;
      }
      if (lineW + tw <= w) {
        line += token;
        lineW += tw;
        continue;
      }
      if (line.trim().length) {
        out.push(line.trimEnd());
        line = "";
        lineW = 0;
      }
      let rest = token;
      while (stringWidth(rest) > w) {
        const part = sliceByWidth(rest, w);
        out.push(part);
        rest = rest.slice(part.length);
      }
      line = rest;
      lineW = stringWidth(rest);
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Hard-wrap a string that may contain ANSI escapes into chunks of at most
 * `width` columns. Escape sequences are kept with the following character.
 */
export function hardWrapAnsi(s: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      const m = /^\u001b\[[0-9;?]*[ -/]*[@-~]|^\u001b\][^\u0007]*(\u0007|\u001b\\)/.exec(s.slice(i));
      if (m) {
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (curW + cw > w) {
      rows.push(cur);
      cur = "";
      curW = 0;
    }
    cur += ch;
    curW += cw;
    i += ch.length;
  }
  rows.push(cur);
  return rows;
}

const ESC_RE = /^\u001b\[[0-9;?]*[ -/]*[@-~]|^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/;

/** Tracks which SGR attributes are active so they can be re-opened after a line break. */
class SgrState {
  private readonly slots = new Map<string, string>();

  apply(seq: string): void {
    const body = seq.slice(2, -1);
    const codes = body === "" ? ["0"] : body.split(";");
    for (let i = 0; i < codes.length; i++) {
      const n = Number(codes[i]);
      if (n === 0) this.slots.clear();
      else if (n === 1) this.slots.set("bold", "1");
      else if (n === 2) this.slots.set("dim", "2");
      else if (n === 22) {
        this.slots.delete("bold");
        this.slots.delete("dim");
      } else if (n === 3) this.slots.set("italic", "3");
      else if (n === 23) this.slots.delete("italic");
      else if (n === 4) this.slots.set("underline", "4");
      else if (n === 24) this.slots.delete("underline");
      else if (n === 7) this.slots.set("inverse", "7");
      else if (n === 27) this.slots.delete("inverse");
      else if (n === 9) this.slots.set("strike", "9");
      else if (n === 29) this.slots.delete("strike");
      else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.slots.set("fg", String(n));
      else if (n === 39) this.slots.delete("fg");
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) this.slots.set("bg", String(n));
      else if (n === 49) this.slots.delete("bg");
      else if (n === 38 || n === 48) {
        const slot = n === 38 ? "fg" : "bg";
        if (codes[i + 1] === "5") {
          this.slots.set(slot, `${n};5;${codes[i + 2]}`);
          i += 2;
        } else if (codes[i + 1] === "2") {
          this.slots.set(slot, `${n};2;${codes[i + 2]};${codes[i + 3]};${codes[i + 4]}`);
          i += 4;
        }
      }
    }
  }

  get open(): string {
    return this.slots.size ? `\u001b[${[...this.slots.values()].join(";")}m` : "";
  }
}

/**
 * Word-wrap a line containing ANSI escapes to `width` columns. Active SGR
 * styles are closed at each break and re-opened on the next line, so every
 * output line is self-contained. Continuation lines get `hang` as a prefix.
 */
export function wrapAnsi(text: string, width: number, hang = ""): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (stringWidth(para) <= width) {
      out.push(para);
      continue;
    }
    const hangW = stringWidth(hang);
    let limit = Math.max(4, width);
    const sgr = new SgrState();
    let active = "";
    let cur = "";
    let curW = 0;
    let breakAt = -1;
    let activeAtBreak = "";
    let i = 0;
    const newLine = (content: string, contentW: number) => {
      cur = hang + content;
      curW = hangW + contentW;
      limit = Math.max(hangW + 4, width);
    };
    while (i < para.length) {
      if (para[i] === "\u001b") {
        const m = ESC_RE.exec(para.slice(i));
        if (m) {
          cur += m[0];
          if (m[0].endsWith("m") && m[0].startsWith("\u001b[")) {
            sgr.apply(m[0]);
            active = sgr.open;
          }
          i += m[0].length;
          continue;
        }
      }
      const cp = para.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = charWidth(cp);
      if (curW + w > limit && ch !== " ") {
        if (breakAt > 0) {
          const first = cur.slice(0, breakAt).trimEnd();
          const rest = cur.slice(breakAt);
          out.push(first + (activeAtBreak ? "\u001b[0m" : ""));
          newLine(activeAtBreak + rest, stringWidth(rest));
        } else {
          out.push(cur + (active ? "\u001b[0m" : ""));
          newLine(active, 0);
        }
        breakAt = -1;
      }
      if (ch === " " && curW + w > limit) {
        // Drop spaces that would overflow; they become the line break.
        i += 1;
        breakAt = cur.length;
        activeAtBreak = active;
        continue;
      }
      cur += ch;
      curW += w;
      if (ch === " ") {
        breakAt = cur.length;
        activeAtBreak = active;
      }
      i += ch.length;
    }
    out.push(cur);
  }
  return out;
}
