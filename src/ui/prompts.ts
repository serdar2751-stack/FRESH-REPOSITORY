import { stringWidth, truncateAnsi, wrapAnsi } from "../util/width.ts";
import { c, theme } from "./ansi.ts";
import { Editor } from "./editor.ts";
import type { Key } from "./keys.ts";

export interface SelectOption {
  label: string;
  hint?: string;
  value: string;
  /** Selecting this option asks for free text first. */
  input?: { prompt: string; optional?: boolean };
}

/** Bottom border with a right-aligned key hint that never overflows the width. */
function bottom(inner: number, help: string, accent: (s: string) => string): string {
  const helpW = stringWidth(help) + 2;
  const bar = Math.max(4, inner + 1 - helpW);
  return accent("╰" + "─".repeat(bar)) + c.gray(" " + help);
}

export interface Modal {
  handleKey(k: Key): void;
  render(width: number): { lines: string[]; cursor?: { row: number; col: number } };
}

/** Arrow-key list selection inside a bordered box, with optional free-text answers. */
export class SelectPrompt implements Modal {
  selected = 0;
  private input?: { option: SelectOption; editor: Editor };
  private readonly title: string;
  private readonly body: string[];
  private readonly options: SelectOption[];
  private readonly onDone: (value: string | undefined, text?: string) => void;
  private readonly cancelValue?: string;
  private readonly accent: (s: string) => string;
  private readonly maxVisible: number;
  private readonly filterable: boolean;
  private filter = "";
  onChange?: () => void;

  constructor(opts: {
    title: string;
    body?: string[];
    options: SelectOption[];
    onDone: (value: string | undefined, text?: string) => void;
    cancelValue?: string;
    accent?: (s: string) => string;
    initial?: number;
    maxVisible?: number;
    filterable?: boolean;
  }) {
    this.title = opts.title;
    this.body = opts.body ?? [];
    this.options = opts.options;
    this.onDone = opts.onDone;
    this.cancelValue = opts.cancelValue;
    this.accent = opts.accent ?? theme.accent;
    this.selected = opts.initial ?? 0;
    this.maxVisible = opts.maxVisible ?? 12;
    this.filterable = opts.filterable ?? false;
  }

  private visible(): Array<{ o: SelectOption; i: number }> {
    const f = this.filter.toLowerCase();
    return this.options.map((o, i) => ({ o, i })).filter(({ o }) => !f || o.label.toLowerCase().includes(f) || o.value.toLowerCase().includes(f));
  }

  private choose(index: number): void {
    const opt = this.options[index];
    if (!opt) return;
    if (opt.input) {
      const editor = new Editor();
      editor.prompt = "› ";
      editor.placeholder = opt.input.optional ? "(optional, Enter to skip)" : "";
      editor.onChange = () => this.onChange?.();
      editor.onSubmit = (text) => {
        if (!text.trim() && !opt.input!.optional) return;
        this.onDone(opt.value, text.trim() || undefined);
      };
      this.input = { option: opt, editor };
      this.onChange?.();
      return;
    }
    this.onDone(opt.value);
  }

  handleKey(k: Key): void {
    if (this.input) {
      if (k.name === "escape") {
        this.input = undefined;
        this.onChange?.();
        return;
      }
      if (k.ctrl && k.name === "c") {
        this.onDone(this.cancelValue);
        return;
      }
      if (k.name === "enter" && (k.ctrl || k.alt || k.shift)) return;
      this.input.editor.handleKey(k);
      return;
    }
    const vis = this.visible();
    const pos = Math.max(0, vis.findIndex((v) => v.i === this.selected));
    if (k.name === "up" || (k.ctrl && k.name === "p")) {
      if (vis.length) this.selected = vis[(pos - 1 + vis.length) % vis.length]!.i;
    } else if (k.name === "down" || (k.ctrl && k.name === "n") || (k.name === "tab" && !k.shift)) {
      if (vis.length) this.selected = vis[(pos + 1) % vis.length]!.i;
    } else if (k.name === "enter") {
      if (vis.length) this.choose(vis.some((v) => v.i === this.selected) ? this.selected : vis[0]!.i);
      return;
    } else if (k.name === "escape" || (k.ctrl && k.name === "c")) {
      if (this.filterable && this.filter && k.name === "escape") {
        this.filter = "";
      } else {
        this.onDone(this.cancelValue);
        return;
      }
    } else if (this.filterable && k.name === "backspace") {
      this.filter = this.filter.slice(0, -1);
    } else if (this.filterable && k.text && !k.ctrl && !k.alt) {
      this.filter += k.text;
      const v = this.visible();
      if (v.length && !v.some((x) => x.i === this.selected)) this.selected = v[0]!.i;
    } else if (!this.filterable && k.text && /^[1-9]$/.test(k.text)) {
      const idx = Number(k.text) - 1;
      if (idx < this.options.length) {
        this.selected = idx;
        this.choose(idx);
        return;
      }
    } else if (!this.filterable && k.text === "y" && this.options.length) {
      this.choose(0);
      return;
    } else if (!this.filterable && k.text === "n" && this.cancelValue !== undefined) {
      const idx = this.options.findIndex((o) => o.value === this.cancelValue);
      if (idx >= 0) this.choose(idx);
      else this.onDone(this.cancelValue);
      return;
    }
    this.onChange?.();
  }

  render(width: number): { lines: string[]; cursor?: { row: number; col: number } } {
    const inner = Math.max(20, width - 4);
    const bar = this.accent("│ ");
    const titleText = ` ${this.title} `;
    const lines: string[] = [this.accent("╭─" + truncateAnsi(titleText, inner) + "─".repeat(Math.max(0, inner - stringWidth(titleText))))];
    for (const b of this.body) for (const l of wrapAnsi(b, inner)) lines.push(bar + l);
    if (this.body.length) lines.push(bar);
    if (this.input) {
      lines.push(bar + c.bold(this.input.option.label));
      lines.push(bar + c.gray(this.input.option.input!.prompt));
      const r = this.input.editor.render(inner);
      const row0 = lines.length;
      for (const l of r.lines) lines.push(bar + l);
      lines.push(bottom(inner, "enter submit · esc back", this.accent));
      return { lines, cursor: { row: row0 + r.cursor.row, col: r.cursor.col + 2 } };
    }
    if (this.filterable) lines.push(bar + c.gray("filter: ") + (this.filter || c.gray("type to filter")));
    const vis = this.visible();
    const pos = Math.max(0, vis.findIndex((v) => v.i === this.selected));
    const start = Math.max(0, Math.min(pos - Math.floor(this.maxVisible / 2), vis.length - this.maxVisible));
    const shown = vis.slice(start, start + this.maxVisible);
    shown.forEach(({ o, i }) => {
      const sel = i === this.selected;
      const num = this.filterable ? "" : `${i + 1}. `;
      const label = sel ? this.accent(c.bold(`❯ ${num}${o.label}`)) : `  ${num}${o.label}`;
      const hint = o.hint ? "  " + c.gray(o.hint) : "";
      lines.push(bar + truncateAnsi(label + hint, inner));
    });
    if (!vis.length) lines.push(bar + c.gray("  no matches"));
    if (vis.length > shown.length) lines.push(bar + c.gray(`  … ${vis.length - shown.length} more`));
    lines.push(bottom(inner, this.filterable ? "type to filter · ↑↓ · enter · esc" : "↑↓ select · enter choose · esc cancel", this.accent));
    return { lines };
  }
}

/** Single-line text entry in a box (e.g. naming a session). */
export class TextPrompt implements Modal {
  private readonly editor = new Editor();
  private readonly title: string;
  onChange?: () => void;

  constructor(opts: { title: string; initial?: string; onDone: (text: string | undefined) => void }) {
    this.title = opts.title;
    this.editor.placeholder = "";
    if (opts.initial) this.editor.setValue(opts.initial);
    this.editor.onChange = () => this.onChange?.();
    this.editor.onSubmit = (t) => opts.onDone(t);
    this.done = opts.onDone;
  }

  private readonly done: (text: string | undefined) => void;

  handleKey(k: Key): void {
    if (k.name === "escape" || (k.ctrl && k.name === "c")) {
      this.done(undefined);
      return;
    }
    if (k.name === "enter" && (k.ctrl || k.alt || k.shift)) return;
    this.editor.handleKey(k);
  }

  render(width: number): { lines: string[]; cursor?: { row: number; col: number } } {
    const inner = Math.max(20, width - 4);
    const lines = [theme.accent("╭─ " + this.title + " " + "─".repeat(Math.max(0, inner - stringWidth(this.title) - 2)))];
    const r = this.editor.render(inner);
    const row0 = lines.length;
    for (const l of r.lines) lines.push(theme.accent("│ ") + l);
    lines.push(bottom(inner, "enter save · esc cancel", theme.accent));
    return { lines, cursor: { row: row0 + r.cursor.row, col: r.cursor.col + 2 } };
  }
}
