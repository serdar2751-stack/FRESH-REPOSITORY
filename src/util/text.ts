const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return "$?";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return "$" + usd.toFixed(2);
  return "$" + Math.round(usd);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m${rest ? ` ${rest}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Truncate to `max` characters, keeping the start and end. */
export function truncateMiddle(s: string, max: number, marker = " … "): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - marker.length);
  const head = Math.ceil(keep / 2);
  return s.slice(0, head) + marker + s.slice(s.length - (keep - head));
}

export function truncateEnd(s: string, max: number, marker = "…"): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Collapse whitespace to single spaces and trim - for one-line titles. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => (l.length ? prefix + l : l))
    .join("\n");
}

/** Very rough token estimate used only when the provider has not reported usage yet. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  if (s.endsWith("\n")) n--;
  return n;
}

/**
 * Keep the head and tail of a long multi-line output, dropping the middle.
 * Returns the (possibly) shortened text and whether anything was removed.
 */
export function clipOutput(
  text: string,
  opts: { maxBytes?: number; maxLines?: number } = {},
): { text: string; truncated: boolean; omittedLines: number } {
  const maxBytes = opts.maxBytes ?? 30_000;
  const maxLines = opts.maxLines ?? 2000;
  const lines = text.split("\n");
  if (text.length <= maxBytes && lines.length <= maxLines) {
    return { text, truncated: false, omittedLines: 0 };
  }
  const headBudget = Math.floor(maxBytes * 0.4);
  const tailBudget = maxBytes - headBudget;
  const maxHeadLines = Math.floor(maxLines * 0.4);
  const maxTailLines = maxLines - maxHeadLines;
  const head: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (head.length >= maxHeadLines || size + line.length + 1 > headBudget) break;
    head.push(line);
    size += line.length + 1;
  }
  const tail: string[] = [];
  size = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    if (tail.length >= maxTailLines || size + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    size += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  if (head.length === 0 && tail.length === 0) {
    // A single enormous line: fall back to byte clipping.
    const clipped = text.slice(0, headBudget) + `\n… [${text.length - maxBytes} characters omitted] …\n` + text.slice(-tailBudget);
    return { text: clipped, truncated: true, omittedLines: 0 };
  }
  return {
    text: [...head, `… [${omitted} lines omitted] …`, ...tail].join("\n"),
    truncated: true,
    omittedLines: omitted,
  };
}

export function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Deterministic JSON (sorted keys) - used for comparing tool calls. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}
