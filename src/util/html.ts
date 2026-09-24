const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  times: "×",
  divide: "÷",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  para: "¶",
  sect: "§",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

const DROP_ELEMENTS = ["script", "style", "noscript", "svg", "head", "template", "iframe", "canvas", "object", "select"];
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "fieldset",
  "figure", "figcaption", "address", "details", "summary", "dl", "dt", "dd", "center",
]);

interface Token {
  kind: "text" | "open" | "close";
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
  selfClosing?: boolean;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) tokens.push({ kind: "text", text: html.slice(last, m.index) });
    last = re.lastIndex;
    if (!m[1]) continue; // comment / doctype
    const name = m[1].toLowerCase();
    if (m[0][1] === "/") {
      tokens.push({ kind: "close", name });
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a: RegExpExecArray | null;
    const rawAttrs = m[2] ?? "";
    while ((a = attrRe.exec(rawAttrs))) {
      attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    tokens.push({ kind: "open", name, attrs, selfClosing: /\/\s*$/.test(rawAttrs) });
  }
  if (last < html.length) tokens.push({ kind: "text", text: html.slice(last) });
  return tokens;
}

function resolveUrl(href: string, base?: string): string {
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Convert an HTML document into readable Markdown. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let src = html;
  for (const el of DROP_ELEMENTS) {
    src = src.replace(new RegExp(`<${el}\\b[\\s\\S]*?<\\/${el}\\s*>`, "gi"), "");
  }
  // Prefer the main content when the page marks it.
  const main = /<main\b[\s\S]*?<\/main\s*>/i.exec(src) ?? /<article\b[\s\S]*?<\/article\s*>/i.exec(src);
  if (main && main[0].length > 500) src = main[0];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  const tokens = tokenize(src);
  let out = "";
  const listStack: Array<{ ordered: boolean; n: number }> = [];
  let pre = 0;
  let linkHref: string | undefined;
  let linkText = "";
  let inLink = false;
  let quote = 0;
  let cellCount = 0;
  let rowIndex = 0;
  let headerRowDone = false;

  const emit = (s: string) => {
    if (inLink) linkText += s;
    else out += s;
  };
  const ensureBreak = (n: number) => {
    if (inLink) return;
    const trailing = /\n*$/.exec(out)![0].length;
    if (out.length === 0) return;
    if (trailing < n) out += "\n".repeat(n - trailing);
  };
  const quotePrefix = () => (quote ? "> ".repeat(quote) : "");

  for (const t of tokens) {
    if (t.kind === "text") {
      let text = decodeEntities(t.text!);
      if (!pre) {
        text = text.replace(/\s+/g, " ");
        if (/\n$/.test(out) && text.startsWith(" ")) text = text.slice(1);
        if (!text) continue;
        if (quote && /\n$/.test(out)) text = quotePrefix() + text;
      }
      emit(text);
      continue;
    }
    const name = t.name!;
    const open = t.kind === "open";
    switch (name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        if (open) {
          ensureBreak(2);
          emit("#".repeat(Number(name[1])) + " ");
        } else ensureBreak(2);
        break;
      case "br":
        emit("\n" + quotePrefix());
        break;
      case "hr":
        ensureBreak(2);
        emit("---");
        ensureBreak(2);
        break;
      case "pre":
        if (open) {
          pre++;
          ensureBreak(2);
          emit("```\n");
        } else if (pre > 0) {
          pre--;
          if (!out.endsWith("\n")) emit("\n");
          emit("```");
          ensureBreak(2);
        }
        break;
      case "code":
        if (!pre) emit("`");
        break;
      case "strong":
      case "b":
        emit("**");
        break;
      case "em":
      case "i":
        emit("*");
        break;
      case "a":
        if (open) {
          inLink = true;
          linkText = "";
          linkHref = t.attrs?.href;
        } else if (inLink) {
          inLink = false;
          const text = linkText.trim();
          if (linkHref && !linkHref.startsWith("javascript:") && text) {
            out += linkHref.startsWith("#") ? text : `[${text}](${resolveUrl(linkHref, baseUrl)})`;
          } else out += text;
        }
        break;
      case "img": {
        const alt = t.attrs?.alt?.trim();
        const s = t.attrs?.src;
        if (s && alt) emit(`![${alt}](${resolveUrl(s, baseUrl)})`);
        break;
      }
      case "ul":
      case "ol":
        if (open) {
          ensureBreak(listStack.length ? 1 : 2);
          listStack.push({ ordered: name === "ol", n: 0 });
        } else {
          listStack.pop();
          ensureBreak(listStack.length ? 1 : 2);
        }
        break;
      case "li":
        if (open) {
          ensureBreak(1);
          const top = listStack[listStack.length - 1];
          const depth = Math.max(0, listStack.length - 1);
          if (top) top.n++;
          emit(quotePrefix() + "  ".repeat(depth) + (top?.ordered ? `${top.n}. ` : "- "));
        } else ensureBreak(1);
        break;
      case "blockquote":
        if (open) {
          ensureBreak(2);
          quote++;
          emit(quotePrefix());
        } else {
          quote = Math.max(0, quote - 1);
          ensureBreak(2);
        }
        break;
      case "table":
        if (open) {
          ensureBreak(2);
          rowIndex = 0;
          headerRowDone = false;
        } else ensureBreak(2);
        break;
      case "tr":
        if (open) {
          ensureBreak(1);
          cellCount = 0;
        } else {
          emit(" |");
          if (rowIndex === 0 && !headerRowDone) {
            emit("\n" + "| --- ".repeat(Math.max(1, cellCount)) + "|");
            headerRowDone = true;
          }
          rowIndex++;
          ensureBreak(1);
        }
        break;
      case "td":
      case "th":
        if (open) {
          emit(cellCount === 0 ? "| " : " | ");
          cellCount++;
        }
        break;
      default:
        if (BLOCK.has(name)) ensureBreak(open ? 2 : 2);
    }
  }
  let md = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\*\*\s*\*\*/g, "")
    .trim();
  if (title && !md.startsWith("# ")) md = `# ${decodeEntities(title.trim())}\n\n${md}`;
  return md;
}

export function htmlToText(html: string): string {
  return htmlToMarkdown(html)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`#>]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
