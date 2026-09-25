import { expandMentions } from "./agent/mentions.ts";
import type { Config, PermissionConfig } from "./config/config.ts";
import type { AgentEvent } from "./core/events.ts";
import type { Effort } from "./core/types.ts";
import type { Mode } from "./permission/permission.ts";
import { Runtime } from "./runtime.ts";
import type { Session } from "./session/session.ts";
import { detectColor } from "./ui/ansi.ts";
import { formatCost, formatDuration, formatTokens, oneLine, truncateEnd } from "./util/text.ts";

export interface HeadlessOptions {
  cwd: string;
  prompt: string;
  model?: string;
  agent?: string;
  continueLast?: boolean;
  session?: string;
  yolo?: boolean;
  trusted?: boolean;
  mode?: Mode;
  effort?: Effort;
  format: "text" | "json" | "quiet";
  maxSteps?: number;
  maxCost?: number;
  /** Extra allow rules, e.g. "edit", "bash:npm test*", "webfetch". */
  allow?: string[];
  files?: string[];
  verbose?: boolean;
}

function allowRules(allow: string[] | undefined): PermissionConfig | undefined {
  if (!allow?.length) return undefined;
  const cfg: PermissionConfig = {};
  for (const entry of allow) {
    const i = entry.indexOf(":");
    const perm = i === -1 ? entry : entry.slice(0, i);
    const pattern = i === -1 ? "*" : entry.slice(i + 1);
    const prev = cfg[perm];
    const map = typeof prev === "object" ? prev : typeof prev === "string" ? { "*": prev } : {};
    map[pattern] = "allow";
    cfg[perm] = map;
  }
  return cfg;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Non-interactive run: one prompt, streamed output, exit code by outcome. */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const piped = await readStdin();
  let text = opts.prompt.trim();
  if (!text && !piped.trim()) {
    process.stderr.write('usta run: provide a prompt, e.g. usta run "explain src/index.ts", or pipe input.\n');
    return 2;
  }
  if (!text) {
    text = piped;
  }
  const extra: Config = {};
  const perms = allowRules(opts.allow);
  if (perms) extra.permission = perms;
  if (opts.maxSteps) extra.maxSteps = opts.maxSteps;
  if (opts.maxCost !== undefined) extra.maxCost = opts.maxCost;
  let rt: Runtime;
  try {
    rt = await Runtime.create({ cwd: opts.cwd, model: opts.model, agent: opts.agent, yolo: opts.yolo, trusted: opts.trusted, interactive: false, config: extra });
  } catch (err) {
    process.stderr.write(`usta: ${(err as Error).message}\n`);
    return 1;
  }
  if (opts.format !== "json") for (const w of rt.loaded.warnings) process.stderr.write(`usta: warning: ${w}\n`);
  let session: Session;
  try {
    session = opts.session
      ? await rt.loadSession(opts.session)
      : opts.continueLast
        ? ((await rt.latestSession()) ?? (await rt.newSession()))
        : await rt.newSession({ mode: opts.mode });
    if (opts.effort) await session.update({ effort: opts.effort });
    if (opts.mode && session.meta.mode !== opts.mode) await rt.engine.setMode(session, opts.mode);
  } catch (err) {
    process.stderr.write(`usta: ${(err as Error).message}\n`);
    await rt.close();
    return 1;
  }

  const context: string[] = [];
  if (piped.trim() && opts.prompt.trim()) context.push(`<stdin>\n${piped}\n</stdin>`);
  for (const f of opts.files ?? []) text += ` @${f}`;
  const att = await expandMentions(text, rt.cwd);
  context.push(...att.context);

  const out = process.stdout;
  const err = process.stderr;
  const color = detectColor(err);
  const sgr = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = sgr(2);
  const red = sgr(31);
  const yellow = sgr(33);
  const isMain = (id: string) => id === session.id;
  let atLineStart = true;
  const write = (s: string) => {
    if (!s) return;
    out.write(s);
    atLineStart = s.endsWith("\n");
  };
  rt.bus.on((e: AgentEvent) => {
    if (opts.format === "json") {
      if (e.type === "tool.progress" && !opts.verbose) return;
      out.write(JSON.stringify(e) + "\n");
      return;
    }
    if (opts.format === "quiet") return;
    const sid = "sessionId" in e ? e.sessionId : undefined;
    if (sid && !isMain(sid)) return;
    switch (e.type) {
      case "message.delta":
        if (e.kind === "text") write(e.text);
        break;
      case "message.end":
        if (!atLineStart) write("\n");
        break;
      case "tool.start":
        err.write(dim(`● ${e.name} ${truncateEnd(oneLine(e.title), 160)}`) + "\n");
        break;
      case "tool.end":
        if (e.result.isError) err.write(red(`  └ ${truncateEnd(oneLine(e.result.output), 300)}`) + "\n");
        break;
      case "notice":
        err.write((e.level === "error" ? red(`✗ ${e.message}`) : e.level === "warn" ? yellow(`! ${e.message}`) : dim(`i ${e.message}`)) + "\n");
        break;
      case "retry":
        err.write(dim(`  ↻ retrying in ${formatDuration(e.delayMs)}: ${truncateEnd(oneLine(e.error), 200)}`) + "\n");
        break;
      default:
        break;
    }
  });

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      err.write("\n" + yellow("Interrupting… (press Ctrl+C again to force quit)") + "\n");
      controller.abort();
    } else process.exit(130);
  };
  process.on("SIGINT", onSigint);

  let code = 0;
  try {
    const res = await rt.engine.prompt(session, { text, images: att.images, context }, { signal: controller.signal });
    if (opts.format === "quiet") out.write(res.text + (res.text.endsWith("\n") ? "" : "\n"));
    if (opts.format === "text") {
      const tokens = res.usage.input + res.usage.cacheRead + res.usage.cacheWrite;
      err.write(
        dim(
          `${res.reason === "done" ? "✓" : res.reason} · ${res.steps} steps · ${formatTokens(tokens)} in · ${formatTokens(res.usage.output)} out${res.cost !== undefined ? ` · ${formatCost(res.cost)}` : ""}${res.changes?.length ? ` · ${res.changes.length} files changed` : ""} · session ${session.id}`,
        ) + "\n",
      );
    }
    code = res.reason === "done" ? 0 : res.reason === "aborted" ? 130 : res.reason === "max_steps" ? 3 : res.reason === "budget" ? 4 : 1;
  } catch (e) {
    err.write(`usta: ${(e as Error).message}\n`);
    code = 1;
  } finally {
    process.off("SIGINT", onSigint);
    await session.flush().catch(() => {});
    await rt.close();
  }
  return code;
}
