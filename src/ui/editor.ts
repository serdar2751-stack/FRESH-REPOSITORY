import { charWidth, stringWidth, truncateAnsi } from "../util/width.ts";
import { c, theme } from "./ansi.ts";
import type { Key } from "./keys.ts";

export interface CompletionItem {
  label: string;
  detail?: string;
  /** Text inserted in place of the token being completed. */
  value: string;
}

export interface CompletionResult {
  items: CompletionItem[];
  /** Range of `value` replaced when an item is accepted. */
  start: number;
  end: number;
}

export type CompletionProvider = (text: string, cursor: number) => CompletionResult | undefined;

const PASTE_PLACEHOLDER_MIN_CHARS = 1500;
const PASTE_PLACEHOLDER_MIN_LINES = 12;

function prevCodePoint(s: string, pos: number): number {
  if (pos <= 0) return 0;
  const lo = s.charCodeAt(pos - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && pos >= 2) {
    const hi = s.charCodeAt(pos - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return pos - 2;
  }
  return pos - 1;
}

function nextCodePoint(s: string, pos: number): number {
  if (pos >= s.length) return s.length;
  const hi = s.charCodeAt(pos);
  if (hi >= 0xd800 && hi <= 0xdbff && pos + 1 < s.length) return pos + 2;
  return pos + 1;
}

/** Split a line into chunks of at most `width` display columns. */
function chunk(line: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  let w = 0;
  for (const ch of line) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width && cur) {
      out.push(cur);
      cur = "";
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  out.push(cur);
  return out;
}

export class Editor {
  value = "";
  pos = 0;
  history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  private readonly pastes = new Map<number, string>();
  private pasteCounter = 0;
  completion?: CompletionResult & { selected: number };
  private suppressCompletion = false;
  completionProvider?: CompletionProvider;
  placeholder = "Ask anything · / for commands · @ to attach files";
  prompt = "› ";
  /** Called on Enter with the expanded text. */
  onSubmit?: (text: string) => void;
  /** Called whenever the content changes. */
  onChange?: () => void;

  setValue(v: string, cursorAtEnd = true): void {
    this.value = v;
    this.pos = cursorAtEnd ? v.length : Math.min(this.pos, v.length);
    this.changed();
  }

  clear(): void {
    this.value = "";
    this.pos = 0;
    this.historyIndex = this.history.length;
    this.completion = undefined;
    this.changed();
  }

  pushHistory(entry: string): void {
    if (entry.trim() && this.history[this.history.length - 1] !== entry) this.history.push(entry);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    this.historyIndex = this.history.length;
  }

  /** Text with paste placeholders expanded. */
  expanded(): string {
    return this.value.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (m, n: string) => this.pastes.get(Number(n)) ?? m);
  }

  private changed(): void {
    this.updateCompletion();
    this.onChange?.();
  }

  insert(s: string): void {
    this.value = this.value.slice(0, this.pos) + s + this.value.slice(this.pos);
    this.pos += s.length;
    this.suppressCompletion = false;
    this.changed();
  }

  private lineStart(pos = this.pos): number {
    return this.value.lastIndexOf("\n", pos - 1) + 1;
  }

  private lineEnd(pos = this.pos): number {
    const i = this.value.indexOf("\n", pos);
    return i === -1 ? this.value.length : i;
  }

  private moveVertical(dir: -1 | 1): boolean {
    const start = this.lineStart();
    const col = stringWidth(this.value.slice(start, this.pos));
    if (dir === -1) {
      if (start === 0) return false;
      const prevStart = this.lineStart(start - 1);
      this.pos = this.posAtColumn(prevStart, start - 1, col);
    } else {
      const end = this.lineEnd();
      if (end >= this.value.length) return false;
      const nextStart = end + 1;
      this.pos = this.posAtColumn(nextStart, this.lineEnd(nextStart), col);
    }
    return true;
  }

  private posAtColumn(start: number, end: number, col: number): number {
    let w = 0;
    let p = start;
    while (p < end) {
      const next = nextCodePoint(this.value, p);
      const cw = charWidth(this.value.codePointAt(p)!);
      if (w + cw > col) break;
      w += cw;
      p = next;
    }
    return p;
  }

  private wordLeft(): number {
    let p = this.pos;
    while (p > 0 && /\s/.test(this.value[p - 1]!)) p--;
    while (p > 0 && !/\s/.test(this.value[p - 1]!)) p--;
    return p;
  }

  private wordRight(): number {
    let p = this.pos;
    while (p < this.value.length && /\s/.test(this.value[p]!)) p++;
    while (p < this.value.length && !/\s/.test(this.value[p]!)) p++;
    return p;
  }

  private deleteRange(from: number, to: number): void {
    if (from >= to) return;
    this.value = this.value.slice(0, from) + this.value.slice(to);
    this.pos = from;
    this.suppressCompletion = false;
    this.changed();
  }

  private historyMove(dir: -1 | 1): void {
    if (!this.history.length) return;
    if (dir === -1) {
      if (this.historyIndex === this.history.length) this.draft = this.value;
      if (this.historyIndex <= 0) return;
      this.historyIndex--;
      this.setValue(this.history[this.historyIndex]!);
    } else {
      if (this.historyIndex >= this.history.length) return;
      this.historyIndex++;
      this.setValue(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]!);
    }
    this.suppressCompletion = true;
    this.completion = undefined;
  }

  updateCompletion(): void {
    if (this.suppressCompletion || !this.completionProvider) {
      this.completion = undefined;
      return;
    }
    const res = this.completionProvider(this.value, this.pos);
    if (!res || !res.items.length) {
      this.completion = undefined;
      return;
    }
    const prevLabel = this.completion?.items[this.completion.selected]?.label;
    const keep = prevLabel ? res.items.findIndex((i) => i.label === prevLabel) : -1;
    this.completion = { ...res, selected: keep >= 0 ? keep : 0 };
  }

  acceptCompletion(): boolean {
    const comp = this.completion;
    if (!comp) return false;
    const item = comp.items[comp.selected];
    if (!item) return false;
    this.value = this.value.slice(0, comp.start) + item.value + this.value.slice(comp.end);
    this.pos = comp.start + item.value.length;
    this.completion = undefined;
    this.suppressCompletion = true;
    this.onChange?.();
    return true;
  }

  closeCompletion(): boolean {
    if (!this.completion) return false;
    this.completion = undefined;
    this.suppressCompletion = true;
    this.onChange?.();
    return true;
  }

  submit(): void {
    const text = this.expanded();
    this.pushHistory(this.value);
    this.clear();
    this.pastes.clear();
    this.onSubmit?.(text);
  }

  /** Handle a key; returns false when the key is not an editing key. */
  handleKey(k: Key): boolean {
    const comp = this.completion;
    if (comp) {
      if (k.name === "up" || (k.ctrl && k.name === "p")) {
        comp.selected = (comp.selected - 1 + comp.items.length) % comp.items.length;
        this.onChange?.();
        return true;
      }
      if (k.name === "down" || (k.ctrl && k.name === "n")) {
        comp.selected = (comp.selected + 1) % comp.items.length;
        this.onChange?.();
        return true;
      }
      if (k.name === "tab" && !k.shift) return this.acceptCompletion();
      if (k.name === "enter" && !k.ctrl && !k.alt && !k.shift) {
        const item = comp.items[comp.selected];
        const exact = item && this.value.slice(comp.start, comp.end) === item.value.trimEnd();
        if (!exact) return this.acceptCompletion();
      }
      if (k.name === "escape") return this.closeCompletion();
    }

    if (k.name === "paste") {
      const text = (k.paste ?? "").replace(/\t/g, "    ");
      const lines = text.split("\n").length;
      if (text.length >= PASTE_PLACEHOLDER_MIN_CHARS || lines >= PASTE_PLACEHOLDER_MIN_LINES) {
        const id = ++this.pasteCounter;
        this.pastes.set(id, text);
        this.insert(`[Pasted text #${id} +${lines} lines]`);
      } else this.insert(text);
      return true;
    }
    if (k.name === "enter") {
      if (k.ctrl || k.alt || k.shift) {
        this.insert("\n");
        return true;
      }
      if (this.value[this.pos - 1] === "\\") {
        this.value = this.value.slice(0, this.pos - 1) + this.value.slice(this.pos);
        this.pos--;
        this.insert("\n");
        return true;
      }
      this.submit();
      return true;
    }
    if (k.ctrl) {
      switch (k.name) {
        case "a":
          this.pos = this.lineStart();
          this.onChange?.();
          return true;
        case "e":
          this.pos = this.lineEnd();
          this.onChange?.();
          return true;
        case "b":
          this.pos = prevCodePoint(this.value, this.pos);
          this.onChange?.();
          return true;
        case "f":
          this.pos = nextCodePoint(this.value, this.pos);
          this.onChange?.();
          return true;
        case "w":
          this.deleteRange(this.wordLeft(), this.pos);
          return true;
        case "u": {
          const start = this.lineStart();
          this.deleteRange(start === this.pos && start > 0 ? start - 1 : start, this.pos);
          return true;
        }
        case "k": {
          const end = this.lineEnd();
          this.deleteRange(this.pos, end === this.pos && end < this.value.length ? end + 1 : end);
          return true;
        }
        case "left":
          this.pos = this.wordLeft();
          this.onChange?.();
          return true;
        case "right":
          this.pos = this.wordRight();
          this.onChange?.();
          return true;
        case "p":
          if (!this.moveVertical(-1)) this.historyMove(-1);
          this.onChange?.();
          return true;
        case "n":
          if (!this.moveVertical(1)) this.historyMove(1);
          this.onChange?.();
          return true;
        case "h":
          this.deleteRange(prevCodePoint(this.value, this.pos), this.pos);
          return true;
        default:
          return false;
      }
    }
    if (k.alt) {
      switch (k.name) {
        case "b":
        case "left":
          this.pos = this.wordLeft();
          this.onChange?.();
          return true;
        case "f":
        case "right":
          this.pos = this.wordRight();
          this.onChange?.();
          return true;
        case "backspace":
          this.deleteRange(this.wordLeft(), this.pos);
          return true;
        case "d":
          this.deleteRange(this.pos, this.wordRight());
          return true;
        default:
          return false;
      }
    }
    switch (k.name) {
      case "backspace":
        this.deleteRange(prevCodePoint(this.value, this.pos), this.pos);
        return true;
      case "delete":
        this.deleteRange(this.pos, nextCodePoint(this.value, this.pos));
        return true;
      case "left":
        this.pos = prevCodePoint(this.value, this.pos);
        this.onChange?.();
        return true;
      case "right":
        this.pos = nextCodePoint(this.value, this.pos);
        this.onChange?.();
        return true;
      case "home":
        this.pos = this.lineStart();
        this.onChange?.();
        return true;
      case "end":
        this.pos = this.lineEnd();
        this.onChange?.();
        return true;
      case "up":
        if (!this.moveVertical(-1)) this.historyMove(-1);
        this.onChange?.();
        return true;
      case "down":
        if (!this.moveVertical(1)) this.historyMove(1);
        this.onChange?.();
        return true;
      case "tab":
        if (k.shift) return false;
        if (!this.completion && this.value.startsWith("/")) {
          this.suppressCompletion = false;
          this.updateCompletion();
          if (this.completion) {
            this.onChange?.();
            return true;
          }
        }
        return true;
      default:
        break;
    }
    if (k.text && !k.ctrl) {
      this.insert(k.text);
      return true;
    }
    return false;
  }

  /** Render the input box: wrapped lines plus the cursor position. */
  render(width: number, opts: { focused?: boolean; dimmed?: boolean } = {}): { lines: string[]; cursor: { row: number; col: number } } {
    const promptW = stringWidth(this.prompt);
    const avail = Math.max(10, width - promptW - 1);
    const out: string[] = [];
    let cursor = { row: 0, col: promptW };
    if (!this.value) {
      out.push(theme.accent(this.prompt) + c.gray(truncateAnsi(this.placeholder, avail)));
      return { lines: out, cursor };
    }
    const logical = this.value.split("\n");
    let offset = 0;
    logical.forEach((line, li) => {
      const chunks = chunk(line, avail);
      const lineStart = offset;
      const lineEnd = offset + line.length;
      if (this.pos >= lineStart && this.pos <= lineEnd) {
        const rel = this.pos - lineStart;
        let consumed = 0;
        for (let ci = 0; ci < chunks.length; ci++) {
          const ch = chunks[ci]!;
          const last = ci === chunks.length - 1;
          if (rel < consumed + ch.length || (last && rel === consumed + ch.length)) {
            const col = stringWidth(ch.slice(0, rel - consumed));
            if (col >= avail) {
              // End of a full row: the cursor starts a fresh row.
              chunks.push("");
              cursor = { row: out.length + ci + 1, col: promptW };
            } else cursor = { row: out.length + ci, col: promptW + col };
            break;
          }
          consumed += ch.length;
        }
      }
      chunks.forEach((ch, ci) => {
        const prefix = li === 0 && ci === 0 ? theme.accent(this.prompt) : " ".repeat(promptW);
        const body = ch.replace(/\[Pasted text #\d+[^\]]*\]/g, (m) => c.inverse(m));
        out.push(prefix + (opts.dimmed ? c.gray(body) : body));
      });
      offset = lineEnd + 1;
    });
    return { lines: out, cursor };
  }

  /** Completion menu lines (rendered below the input). */
  renderCompletion(width: number, max = 8): string[] {
    const comp = this.completion;
    if (!comp) return [];
    const total = comp.items.length;
    const start = Math.max(0, Math.min(comp.selected - Math.floor(max / 2), total - max));
    const slice = comp.items.slice(start, start + max);
    const labelW = Math.min(32, Math.max(...slice.map((i) => stringWidth(i.label))) + 2);
    const lines = slice.map((item, i) => {
      const selected = start + i === comp.selected;
      const label = item.label.padEnd(labelW);
      const detail = item.detail ? c.gray(item.detail) : "";
      const line = `  ${selected ? theme.accent("❯ " + label) : "  " + label}${detail}`;
      return truncateAnsi(line, width - 1);
    });
    if (total > max) lines.push(c.gray(`    … ${total} matches`));
    return lines;
  }
}
