/**
 * Raw terminal input -> key events. Handles CSI/SS3 sequences with
 * modifiers, Alt-prefixed keys, bracketed paste and the kitty / xterm
 * "modifyOtherKeys" encodings of Shift+Enter.
 */

export interface Key {
  name: string;
  /** Printable text for character keys. */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Full pasted text for name === "paste". */
  paste?: string;
  sequence: string;
}

const CSI_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "tab",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const TILDE_NAMES: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

function modifiers(mod: number): Pick<Key, "shift" | "alt" | "ctrl"> {
  const m = mod - 1;
  return { shift: Boolean(m & 1), alt: Boolean(m & 2), ctrl: Boolean(m & 4) };
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export class KeyParser {
  private buffer = "";
  private pasting = false;
  private paste = "";
  private escTimer?: NodeJS.Timeout;
  private readonly onKey: (k: Key) => void;

  constructor(onKey: (k: Key) => void) {
    this.onKey = onKey;
  }

  feed(data: string): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    this.buffer += data;
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length) {
      if (this.pasting) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end === -1) {
          this.paste += this.buffer;
          this.buffer = "";
          return;
        }
        this.paste += this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.pasting = false;
        const text = this.paste.replace(/\r\n?/g, "\n");
        this.paste = "";
        this.onKey({ name: "paste", paste: text, sequence: text });
        continue;
      }
      if (this.buffer.startsWith(PASTE_START)) {
        this.buffer = this.buffer.slice(PASTE_START.length);
        this.pasting = true;
        continue;
      }
      const consumed = this.parseOne();
      if (consumed === 0) {
        // Incomplete escape sequence: wait briefly for the rest.
        this.escTimer = setTimeout(() => {
          this.escTimer = undefined;
          const pending = this.buffer;
          this.buffer = "";
          if (pending === "\x1b") this.onKey({ name: "escape", sequence: pending });
          else if (pending.startsWith("\x1b")) {
            this.onKey({ name: "escape", sequence: "\x1b" });
            this.feed(pending.slice(1));
          }
        }, 40);
        return;
      }
      this.buffer = this.buffer.slice(consumed);
    }
  }

  /** Parse one key from the buffer; returns characters consumed (0 = need more input). */
  private parseOne(): number {
    const s = this.buffer;
    const c = s[0]!;
    if (c === "\x1b") {
      if (s.length === 1) return 0;
      const n = s[1]!;
      if (n === "[") {
        // CSI: parameters then a final byte in @-~
        const m = /^\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])/.exec(s);
        if (!m) return s.length > 32 ? 1 : 0;
        const params = m[1]!;
        const final = m[3]!;
        this.emitCsi(params, final, m[0]);
        return m[0].length;
      }
      if (n === "O") {
        if (s.length < 3) return 0;
        const name = CSI_NAMES[s[2]!];
        this.onKey({ name: name ?? `ss3-${s[2]}`, sequence: s.slice(0, 3) });
        return 3;
      }
      if (n === "\x1b") {
        this.onKey({ name: "escape", sequence: "\x1b" });
        return 1;
      }
      // Alt + key
      const inner = this.basic(n);
      this.onKey({ ...inner, alt: true, sequence: s.slice(0, 2) });
      return 2;
    }
    const cp = s.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    this.onKey({ ...this.basic(ch), sequence: ch });
    return ch.length;
  }

  private basic(ch: string): Key {
    const code = ch.charCodeAt(0);
    if (ch === "\r") return { name: "enter", sequence: ch };
    if (ch === "\n") return { name: "enter", ctrl: true, sequence: ch }; // Ctrl+J
    if (ch === "\t") return { name: "tab", sequence: ch };
    if (ch === "\x7f" || ch === "\b") return { name: "backspace", sequence: ch };
    if (ch === "\x1b") return { name: "escape", sequence: ch };
    if (ch === " ") return { name: "space", text: " ", sequence: ch };
    if (code === 0) return { name: "space", ctrl: true, sequence: ch };
    if (code < 32) return { name: String.fromCharCode(code + 96), ctrl: true, sequence: ch };
    return { name: ch.toLowerCase(), text: ch, shift: ch !== ch.toLowerCase(), sequence: ch };
  }

  private emitCsi(params: string, final: string, seq: string): void {
    const parts = params.split(";");
    if (final === "~") {
      const code = parts[0]!;
      const mod = parts[1] ? modifiers(Number(parts[1])) : {};
      if (code === "27" && parts.length >= 3) {
        // xterm modifyOtherKeys: CSI 27;mod;code ~
        const keyCode = Number(parts[2]);
        const m = modifiers(Number(parts[1]));
        this.onKey({ ...this.basic(String.fromCharCode(keyCode)), ...m, sequence: seq });
        return;
      }
      this.onKey({ name: TILDE_NAMES[code] ?? `unknown-${code}`, ...mod, sequence: seq });
      return;
    }
    if (final === "u") {
      // kitty keyboard protocol: CSI code;mod u
      const keyCode = Number(parts[0]!.split(":")[0]);
      const m = parts[1] ? modifiers(Number(parts[1].split(":")[0])) : {};
      const base = keyCode === 13 ? { name: "enter", sequence: seq } : keyCode === 27 ? { name: "escape", sequence: seq } : this.basic(String.fromCodePoint(keyCode));
      this.onKey({ ...base, ...m, sequence: seq });
      return;
    }
    if (final === "I" || final === "O") {
      this.onKey({ name: final === "I" ? "focus-in" : "focus-out", sequence: seq });
      return;
    }
    const name = CSI_NAMES[final];
    const mod = parts.length >= 2 && parts[1] ? modifiers(Number(parts[1])) : {};
    if (final === "Z") {
      this.onKey({ name: "tab", shift: true, sequence: seq });
      return;
    }
    this.onKey({ name: name ?? `csi-${final}`, ...mod, sequence: seq });
  }

  dispose(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
  }
}
