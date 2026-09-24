/** ANSI styling with NO_COLOR / FORCE_COLOR support. */

function detectColor(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

export let colorEnabled = detectColor();

export function setColor(on: boolean): void {
  colorEnabled = on;
}

const wrap = (open: string, close: string) => (s: string) => (colorEnabled && s ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  reset: "\x1b[0m",
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),
  inverse: wrap("7", "27"),
  strike: wrap("9", "29"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  white: wrap("37", "39"),
  gray: wrap("90", "39"),
  brightRed: wrap("91", "39"),
  brightGreen: wrap("92", "39"),
  brightYellow: wrap("93", "39"),
  brightBlue: wrap("94", "39"),
  brightMagenta: wrap("95", "39"),
  brightCyan: wrap("96", "39"),
  bgRed: wrap("41", "49"),
  bgGreen: wrap("42", "49"),
  /** 256-color foreground. */
  fg: (n: number) => wrap(`38;5;${n}`, "39"),
  /** 256-color background. */
  bg: (n: number) => wrap(`48;5;${n}`, "49"),
};

/** Theme roles used across the UI. */
export const theme = {
  accent: (s: string) => c.fg(173)(s), // warm orange
  brand: (s: string) => c.bold(c.fg(173)(s)),
  muted: (s: string) => c.gray(s),
  code: (s: string) => c.fg(110)(s),
  heading: (s: string) => c.bold(c.fg(173)(s)),
  success: (s: string) => c.green(s),
  error: (s: string) => c.red(s),
  warn: (s: string) => c.yellow(s),
  info: (s: string) => c.cyan(s),
  added: (s: string) => c.green(s),
  removed: (s: string) => c.red(s),
  addedBg: (s: string) => (colorEnabled ? `\x1b[48;5;22m${s}\x1b[49m` : s),
  removedBg: (s: string) => (colorEnabled ? `\x1b[48;5;52m${s}\x1b[49m` : s),
  tool: (s: string) => c.bold(s),
  user: (s: string) => c.fg(252)(s),
  link: (s: string) => c.underline(c.fg(75)(s)),
};

export const cursor = {
  up: (n = 1) => (n > 0 ? `\x1b[${n}A` : ""),
  down: (n = 1) => (n > 0 ? `\x1b[${n}B` : ""),
  column: (n: number) => `\x1b[${Math.max(1, n)}G`,
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  clearDown: "\x1b[J",
  clearLine: "\x1b[2K",
  save: "\x1b7",
  restore: "\x1b8",
};

export const term = {
  bracketedPasteOn: "\x1b[?2004h",
  bracketedPasteOff: "\x1b[?2004l",
  syncStart: "\x1b[?2026h",
  syncEnd: "\x1b[?2026l",
  /** Desktop notification (iTerm2, kitty, WezTerm, Windows Terminal) + bell. */
  notify: (msg: string) => `\x1b]9;${msg.replace(/[\x00-\x1f\x07]/g, " ")}\x07\x07`,
  /** Copy to the system clipboard through the terminal (OSC 52). */
  clipboard: (text: string) => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
  title: (t: string) => `\x1b]0;${t.replace(/[\x00-\x1f]/g, " ")}\x07`,
};
