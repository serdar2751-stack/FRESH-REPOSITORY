import type { Message } from "../core/types.ts";
import { clipOutput } from "../util/text.ts";
import type { Session } from "./session.ts";

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

function renderMessage(m: Message, opts: { tools: boolean }): string {
  if (m.role === "user") {
    if (m.origin === "tool_results") {
      if (!opts.tools) return "";
      return m.parts
        .map((p) => {
          if (p.type !== "tool_result") return "";
          const out = clipOutput(p.output, { maxBytes: 4000, maxLines: 80 }).text;
          return `<details><summary>${p.isError ? "❌" : "✅"} ${p.name}${p.title ? `: ${p.title}` : ""}</summary>\n\n${fence(out)}\n\n</details>`;
        })
        .filter(Boolean)
        .join("\n\n");
    }
    const text = m.parts
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    const label = m.origin === "summary" ? "Summary (compacted context)" : m.origin === "shell" ? "Shell" : m.origin === "hook" ? "Hook" : "User";
    return `## ${label}\n\n${text}`;
  }
  const parts: string[] = [];
  for (const p of m.parts) {
    if (p.type === "text" && p.text.trim()) parts.push(p.text.trim());
    else if (p.type === "tool_call" && opts.tools) parts.push(`**Tool call:** \`${p.name}\`\n\n${fence(JSON.stringify(p.input, null, 2))}`);
  }
  if (!parts.length) return "";
  return `## Assistant${m.model ? ` (${m.model})` : ""}\n\n${parts.join("\n\n")}`;
}

/** Markdown transcript of a session. */
export function exportMarkdown(session: Session, opts: { tools?: boolean } = {}): string {
  const header = [
    `# ${session.meta.title || "Session"}`,
    "",
    `- Session: \`${session.id}\``,
    `- Model: \`${session.meta.model}\``,
    `- Created: ${new Date(session.header.created).toISOString()}`,
    `- Directory: \`${session.header.cwd}\``,
    "",
  ].join("\n");
  const body = session.messages
    .map((m) => renderMessage(m, { tools: opts.tools ?? true }))
    .filter(Boolean)
    .join("\n\n");
  return `${header}\n${body}\n`;
}
