import type { Message, ToolResultPart } from "../core/types.ts";
import { clipOutput, formatCost, formatTokens } from "../util/text.ts";
import type { Session } from "./session.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Inline Markdown on already-escaped text: code, emphasis, http(s) links. */
function inline(s: string): string {
  const held: string[] = [];
  const hold = (h: string) => `\u0000${held.push(h) - 1}\u0000`;
  let t = esc(s.replace(/\u0000/g, "")).replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => hold(`<a href="${url}" rel="noopener noreferrer">${label}</a>`));
  t = t
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]!);
}

/** Small, safe Markdown renderer: everything is escaped before markup is added. */
export function markdownToHtml(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r/g, "").split("\n");
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let table: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table
      .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
      .map((r) =>
        r
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/)
          .map((cell) => inline(cell.trim())),
      );
    out.push(`<table>${rows.map((r, i) => `<tr>${r.map((cell) => (i ? `<td>${cell}</td>` : `<th>${cell}</th>`)).join("")}</tr>`).join("")}</table>`);
    table = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushTable();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(fence[1]!)) body.push(lines[j++]!);
      out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      i = j;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const level = Math.min(6, h[1]!.length + 2);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const tag = li[2] ? "ol" : "ul";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(inline(li[3]!));
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushAll();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return out.join("\n");
}

function diffHtml(diff: string): string {
  const rows = diff
    .split("\n")
    .filter((l) => !l.startsWith("---") && !l.startsWith("+++"))
    .map((l) => {
      const cls = l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
      return `<span class="${cls}">${esc(l) || " "}</span>`;
    });
  return `<pre class="diff">${rows.join("\n")}</pre>`;
}

function toolHtml(name: string, input: unknown, result: ToolResultPart | undefined): string {
  const title = result?.title ?? "";
  const status = !result ? "pending" : result.isError ? "error" : "ok";
  const md = result?.metadata ?? {};
  const body: string[] = [];
  const shownInput = JSON.stringify(input, null, 2);
  if (shownInput && shownInput !== "{}") body.push(`<div class="label">Input</div><pre>${esc(clipOutput(shownInput, { maxBytes: 20_000, maxLines: 400 }).text)}</pre>`);
  if (typeof md.diff === "string" && md.diff) body.push(`<div class="label">Changes</div>${diffHtml(md.diff)}`);
  if (result) body.push(`<div class="label">Output</div><pre>${esc(clipOutput(result.output, { maxBytes: 20_000, maxLines: 400 }).text) || "(no output)"}</pre>`);
  return `<details class="tool ${status}"><summary><span class="dot"></span><b>${esc(name)}</b> <span class="muted">${esc(title)}</span></summary>${body.join("")}</details>`;
}

function messageHtml(m: Message, results: Map<string, ToolResultPart>, opts: { tools: boolean; reasoning: boolean }): string {
  if (m.role === "user") {
    if (m.origin === "tool_results") return "";
    const text = m.parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    const images = m.parts.filter((p) => p.type === "image").length;
    if (m.origin === "summary") return `<section class="summary"><div class="role">Context summary (compaction)</div>${markdownToHtml(text)}</section>`;
    const label = m.origin === "shell" ? "Shell" : m.origin === "hook" ? "Hook" : "You";
    return `<section class="user"><div class="role">${label}</div><div class="text">${esc(text)}</div>${images ? `<div class="muted">${images} image${images === 1 ? "" : "s"} attached</div>` : ""}</section>`;
  }
  const parts: string[] = [];
  for (const p of m.parts) {
    if (p.type === "reasoning" && opts.reasoning && p.text.trim()) parts.push(`<details class="thinking"><summary>Thinking</summary>${markdownToHtml(p.text)}</details>`);
    else if (p.type === "text" && p.text.trim()) parts.push(markdownToHtml(p.text));
    else if (p.type === "tool_call" && opts.tools) parts.push(toolHtml(p.name, p.input, results.get(p.id)));
  }
  if (!parts.length) return "";
  return `<section class="assistant"><div class="role">Assistant <span class="muted">${esc(m.model)}</span></div>${parts.join("\n")}</section>`;
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e4e3de;--accent:#c2562f;--code:#f1f0ec;--add:#e6f4ea;--del:#fce8e6;--addfg:#1e6b34;--delfg:#a3261a}
@media (prefers-color-scheme:dark){:root{--bg:#171716;--fg:#e8e6e0;--muted:#9a978f;--card:#201f1d;--line:#34332f;--accent:#e07a52;--code:#2a2926;--add:#1c3325;--del:#3d201d;--addfg:#8fd6a5;--delfg:#f2a097}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
header h1{font-size:24px;margin:0 0 6px}header .meta{color:var(--muted);font-size:13px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
section.user{border-left:3px solid var(--accent)}section.summary{border-style:dashed}
.role{font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.user .text{white-space:pre-wrap;word-wrap:break-word}.muted{color:var(--muted);font-weight:400}.role .muted{text-transform:none;letter-spacing:0}
pre{background:var(--code);border-radius:6px;padding:10px 12px;overflow-x:auto;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:4px}pre code{background:none;padding:0}
table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left}
blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--line);color:var(--muted)}a{color:var(--accent)}
details.tool{border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:6px 10px}details.tool summary{cursor:pointer;list-style:none}
details.tool .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#3a9a5b}details.tool.error .dot{background:#d0443a}details.tool.pending .dot{background:#b8b3a7}
details.thinking{color:var(--muted);font-size:14px;margin:6px 0}details.thinking summary{cursor:pointer}
.label{font-size:11px;text-transform:uppercase;color:var(--muted);margin:8px 0 2px}
.diff .a{background:var(--add);color:var(--addfg);display:inline-block;width:100%}.diff .d{background:var(--del);color:var(--delfg);display:inline-block;width:100%}.diff .h{color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:32px}
`;

/** Self-contained HTML transcript (no scripts), safe to share or open offline. */
export function exportHtml(session: Session, opts: { tools?: boolean; reasoning?: boolean } = {}): string {
  const results = new Map<string, ToolResultPart>();
  for (const m of session.messages) {
    if (m.role === "user") for (const p of m.parts) if (p.type === "tool_result") results.set(p.callId, p);
  }
  const o = { tools: opts.tools ?? true, reasoning: opts.reasoning ?? true };
  const body = session.messages.map((m) => messageHtml(m, results, o)).filter(Boolean).join("\n");
  const u = session.meta.usage;
  const tokens = u.input + u.cacheRead + u.cacheWrite;
  const title = session.meta.title || "Session";
  const meta = [
    esc(session.meta.model),
    new Date(session.header.created).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
    `${formatTokens(tokens)} in · ${formatTokens(u.output)} out`,
    ...(session.meta.cost ? [formatCost(session.meta.cost)] : []),
  ].join(" · ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)} · usta</title><style>${STYLE}</style></head>
<body><main><header><h1>${esc(title)}</h1><div class="meta">${meta}</div></header>
${body}
<footer>Exported from usta · session ${esc(session.id)}</footer></main></body></html>
`;
}
