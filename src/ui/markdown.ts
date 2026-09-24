import { stringWidth, wrapAnsi } from "../util/width.ts";
import { c, theme } from "./ansi.ts";
import { highlightLine } from "./highlight.ts";

/** Inline Markdown: code spans, bold, italics, strikethrough, links. */
export function renderInline(text: string): string {
  // Code spans and links become placeholders first, so styling never runs
  // inside them and escape sequences are never mistaken for Markdown.
  const held: string[] = [];
  const hold = (s: string) => {
    held.push(s);
    return `\u0000${held.length - 1}\u0000`;
  };
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, body: string) => hold(theme.code(body)));
  s = s.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) =>
    hold(label === url ? theme.link(url) : `${theme.link(styleEmphasis(label))} ${c.gray(`(${url})`)}`),
  );
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s)>\]]+)/g, (_, pre: string, url: string) => pre + hold(theme.link(url)));
  s = styleEmphasis(s);
  for (let i = 0; i < 3 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => held[Number(n)]!);
  return s;
}

function styleEmphasis(input: string): string {
  let s = input.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, (_, t: string) => c.bold(c.italic(t)));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, t: string) => c.bold(t));
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_, pre: string, t: string) => pre + c.bold(t));
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, (_, pre: string, t: string) => pre + c.italic(t));
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, (_, pre: string, t: string) => pre + c.italic(t));
  return s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t: string) => c.strike(t));
}

interface State {
  fence?: { marker: string; lang?: string };
  table: string[];
}

function renderTable(rows: string[], width: number): string[] {
  const cells = rows
    .filter((r) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(r))
    .map((r) =>
      r
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split(/(?<!\\)\|/)
        .map((x) => renderInline(x.trim())),
    );
  if (!cells.length) return [];
  const cols = Math.max(...cells.map((r) => r.length));
  const widths = new Array<number>(cols).fill(0);
  for (const r of cells) r.forEach((cell, i) => (widths[i] = Math.max(widths[i]!, stringWidth(cell))));
  const total = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3 + 4;
  if (total > width) {
    // Too wide to align: fall back to "a | b | c" rows.
    return cells.flatMap((r, i) => wrapAnsi((i === 0 ? c.bold : (x: string) => x)(r.join(c.gray(" │ "))), width - 2, "  ").map((l) => "  " + l));
  }
  const line = (r: string[], bold: boolean) =>
    "  " +
    r
      .concat(new Array(cols - r.length).fill(""))
      .map((cell, i) => (bold ? c.bold(cell) : cell) + " ".repeat(widths[i]! - stringWidth(cell)))
      .join(c.gray(" │ "));
  const sep = "  " + widths.map((w) => c.gray("─".repeat(w))).join(c.gray("─┼─"));
  return [line(cells[0]!, true), sep, ...cells.slice(1).map((r) => line(r, false))];
}

/** Render one complete Markdown line; returns zero or more terminal lines. */
function renderLine(raw: string, st: State, width: number): string[] {
  const line = raw.replace(/\t/g, "    ");
  const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
  if (st.fence) {
    if (fence && fence[1]!.startsWith(st.fence.marker[0]!) && fence[1]!.length >= st.fence.marker.length && !fence[2]) {
      st.fence = undefined;
      return [];
    }
    return ["  " + highlightLine(line, st.fence.lang)];
  }
  if (fence) {
    st.fence = { marker: fence[1]!, lang: fence[2] || undefined };
    return fence[2] ? [c.gray(`  ${fence[2]}`)] : [];
  }
  if (/^\s*\|.*\|\s*$/.test(line) || (st.table.length && /^\s*\|/.test(line))) {
    st.table.push(line);
    return [];
  }
  const out: string[] = [];
  if (st.table.length) {
    out.push(...renderTable(st.table, width));
    st.table = [];
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1]!.length;
    const text = renderInline(heading[2]!.replace(/\s+#+\s*$/, ""));
    out.push(...wrapAnsi(level <= 2 ? theme.heading(level === 1 ? c.underline(text) : text) : c.bold(text), width));
    return out;
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    out.push(c.gray("─".repeat(Math.min(width - 2, 60))));
    return out;
  }
  const quote = /^(\s*)>\s?(.*)$/.exec(line);
  if (quote) {
    out.push(...wrapAnsi(c.italic(renderInline(quote[2]!)), width - 4, "").map((l) => quote[1] + c.gray("│ ") + l));
    return out;
  }
  const list = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (list) {
    const indent = list[1]!;
    const marker = /\d/.test(list[2]!) ? list[2]! : "•";
    const box = list[3] ? (list[3].toLowerCase().includes("x") ? c.green("☑ ") : "☐ ") : "";
    const prefix = `${indent}${/\d/.test(marker) ? marker : c.fg(173)(marker)} ${box}`;
    const hang = " ".repeat(stringWidth(prefix));
    const body = renderInline(list[4]!);
    const wrapped = wrapAnsi(prefix + body, width, hang);
    out.push(...wrapped);
    return out;
  }
  out.push(...wrapAnsi(renderInline(line), width));
  return out;
}

/**
 * Streaming Markdown renderer: text arrives in arbitrary chunks, complete
 * lines are rendered and emitted; the unfinished line stays pending.
 */
export class MarkdownStream {
  private buffer = "";
  private readonly state: State = { table: [] };
  private readonly emit: (lines: string[]) => void;
  private readonly width: () => number;
  private emittedAny = false;
  private blank = 0;

  constructor(opts: { width: () => number; emit: (lines: string[]) => void }) {
    this.emit = opts.emit;
    this.width = opts.width;
  }

  push(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.renderComplete(line);
    }
  }

  private renderComplete(line: string): void {
    if (!line.trim() && !this.state.fence) {
      // Collapse runs of blank lines and skip leading blanks.
      if (this.state.table.length) this.emitLines(renderTable(this.state.table, this.width() - 2));
      this.state.table = [];
      if (!this.emittedAny || this.blank >= 1) return;
      this.blank++;
      this.emit([""]);
      return;
    }
    this.emitLines(renderLine(line, this.state, this.width() - 2));
  }

  private emitLines(lines: string[]): void {
    if (!lines.length) return;
    this.blank = 0;
    this.emittedAny = true;
    this.emit(lines);
  }

  /** The unfinished line, rendered for the live region (wrapped). */
  pendingLines(): string[] {
    const w = this.width() - 2;
    if (!this.buffer) return [];
    if (this.state.fence) return wrapAnsi("  " + highlightLine(this.buffer, this.state.fence.lang), w);
    return wrapAnsi(renderInline(this.buffer), w);
  }

  /** Emit everything that is left (end of message). */
  flush(): void {
    if (this.buffer) {
      const rest = this.buffer;
      this.buffer = "";
      this.renderComplete(rest);
    }
    if (this.state.table.length) {
      this.emitLines(renderTable(this.state.table, this.width() - 2));
      this.state.table = [];
    }
    this.state.fence = undefined;
  }
}

/** Render a whole Markdown document at once. */
export function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = [];
  const md = new MarkdownStream({ width: () => width, emit: (l) => out.push(...l) });
  md.push(text);
  md.flush();
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
