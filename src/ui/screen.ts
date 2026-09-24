import { stringWidth, truncateAnsi } from "../util/width.ts";
import { cursor, term } from "./ansi.ts";

export interface LiveContent {
  lines: string[];
  /** Terminal cursor position inside the live region (hidden when absent). */
  cursor?: { row: number; col: number };
}

/**
 * Inline terminal renderer: permanent output scrolls normally, while a small
 * "live region" at the bottom (spinner, running tools, input box, prompts) is
 * erased and redrawn in place. Every live line is pre-wrapped to fit the
 * terminal width, so the number of rows to erase is always known.
 */
export class Screen {
  private readonly out: NodeJS.WriteStream;
  private rendered = 0;
  private cursorRow = 0;
  private content: LiveContent = { lines: [] };
  private pending?: NodeJS.Immediate;
  private disposed = false;
  readonly tty: boolean;

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
    this.tty = Boolean(out.isTTY);
    if (this.tty) out.on("resize", this.onResize);
  }

  get width(): number {
    return Math.max(20, this.out.columns || 80);
  }

  get height(): number {
    return Math.max(8, this.out.rows || 24);
  }

  private onResize = () => {
    // Reflow may have changed how many rows the old region occupies; clear
    // generously from the region's top and redraw.
    this.render();
  };

  /** Print permanent output above the live region. */
  print(text: string): void {
    if (this.disposed) return;
    if (!this.tty) {
      this.out.write(text + "\n");
      return;
    }
    const body = text.replace(/\r?\n/g, "\r\n") + "\r\n";
    this.out.write(term.syncStart + this.eraseSeq() + body + this.drawSeq() + term.syncEnd);
  }

  /** Replace the live region (coalesced to one redraw per tick). */
  setLive(content: LiveContent): void {
    this.content = content;
    if (!this.tty || this.disposed) return;
    if (this.pending) return;
    this.pending = setImmediate(() => {
      this.pending = undefined;
      this.render();
    });
  }

  /** Redraw immediately. */
  render(): void {
    if (!this.tty || this.disposed) return;
    if (this.pending) {
      clearImmediate(this.pending);
      this.pending = undefined;
    }
    this.out.write(term.syncStart + this.eraseSeq() + this.drawSeq() + term.syncEnd);
  }

  /** Remove the live region, leaving the cursor at its start. */
  clearLive(): void {
    this.content = { lines: [] };
    if (!this.tty) return;
    if (this.pending) {
      clearImmediate(this.pending);
      this.pending = undefined;
    }
    this.out.write(this.eraseSeq() + cursor.show);
  }

  private eraseSeq(): string {
    if (!this.rendered) return "";
    const s = cursor.up(this.cursorRow) + "\r" + cursor.clearDown;
    this.rendered = 0;
    this.cursorRow = 0;
    return s;
  }

  private drawSeq(): string {
    const w = this.width;
    let lines = this.content.lines.map((l) => (stringWidth(l) > w - 1 ? truncateAnsi(l, w - 1) : l));
    let cur = this.content.cursor;
    // Never exceed the viewport: rows scrolled off the top could not be erased.
    const max = this.height - 1;
    if (lines.length > max) {
      const drop = lines.length - max;
      lines = lines.slice(drop);
      if (cur) cur = { row: Math.max(0, cur.row - drop), col: cur.col };
    }
    if (!lines.length) return cursor.hide;
    let s = cursor.hide + lines.map((l) => l + "\x1b[0m").join("\r\n");
    this.rendered = lines.length;
    const last = lines.length - 1;
    if (cur) {
      const row = Math.min(cur.row, last);
      s += cursor.up(last - row) + cursor.column(cur.col + 1) + cursor.show;
      this.cursorRow = row;
    } else {
      this.cursorRow = last;
    }
    return s;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearLive();
    this.disposed = true;
    if (this.tty) this.out.off("resize", this.onResize);
  }
}
