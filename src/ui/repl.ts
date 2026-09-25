import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPrimary } from "../agent/agents.ts";
import { expandMentions } from "../agent/mentions.ts";
import { type CommandInfo, expandCommand } from "../commands/commands.ts";
import { paths } from "../config/paths.ts";
import { authStore, stateStore, trustStore } from "../config/store.ts";
import type { AgentEvent } from "../core/events.ts";
import { EFFORT_LEVELS, type Effort, type FileChange, textOf } from "../core/types.ts";
import type { Mode, PermissionRequest } from "../permission/permission.ts";
import { catalogModels } from "../provider/catalog.ts";
import { PRESETS, checkCredentials, parseModelRef } from "../provider/registry.ts";
import { Runtime } from "../runtime.ts";
import { exportMarkdown } from "../session/export.ts";
import { exportHtml } from "../session/html.ts";
import type { Session } from "../session/session.ts";
import { toolTitle } from "../tool/registry.ts";
import { listFiles } from "../tool/search.ts";
import { displayPath } from "../util/fs.ts";
import { runShell } from "../util/shell.ts";
import { clipOutput, formatCost, formatTokens, oneLine, truncateEnd } from "../util/text.ts";
import { stringWidth, truncateAnsi, wrapAnsi } from "../util/width.ts";
import { VERSION } from "../version.ts";
import { c, term, theme } from "./ansi.ts";
import { type CompletionItem, Editor } from "./editor.ts";
import { type Key, KeyParser } from "./keys.ts";
import { renderMarkdown } from "./markdown.ts";
import { type Modal, type SelectOption, SelectPrompt, TextPrompt } from "./prompts.ts";
import { Screen } from "./screen.ts";
import { ConversationView, renderDiff, renderTodos } from "./view.ts";

export interface ReplOptions {
  cwd: string;
  model?: string;
  agent?: string;
  continueLast?: boolean;
  session?: string;
  yolo?: boolean;
  prompt?: string;
  mode?: Mode;
  effort?: Effort;
}

interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  run(args: string): Promise<void> | void;
}

const MODES: Mode[] = ["normal", "auto-edit", "plan"];

/** Where to create an API key, shown when connecting a provider. */
const KEY_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  groq: "https://console.groq.com/keys",
  mistral: "https://console.mistral.ai/api-keys",
  xai: "https://console.x.ai",
};

function modeBadge(mode: Mode, yolo: boolean): string {
  if (yolo && mode !== "plan") return c.red("⚠ yolo");
  if (mode === "auto-edit") return c.yellow("⏵⏵ accept edits");
  if (mode === "plan") return c.cyan("⏸ plan mode");
  return c.gray("● normal");
}

function historyFile(): string {
  return path.join(paths.data, "history.jsonl");
}

function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return String((JSON.parse(l) as { text: string }).text);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .slice(-500);
  } catch {
    return [];
  }
}

function saveHistory(text: string, cwd: string): void {
  try {
    appendFileSync(historyFile(), JSON.stringify({ text, cwd, time: Date.now() }) + "\n");
  } catch {
    // history is best effort
  }
}

function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const p = candidate.toLowerCase();
  if (!q) return 3;
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (p.includes(q)) return 2;
  let i = 0;
  for (const ch of p) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
}

/** Human wording for what an "always allow" answer covers. */
function describeScope(req: PermissionRequest): string {
  const pats = req.always.length ? req.always : req.patterns;
  const list = (items: string[]) => truncateEnd(items.join(", "), 60);
  switch (req.permission) {
    case "edit":
      return pats.includes("*") ? "edits to all files" : `edits in ${list(pats.map((p) => p.replace(/\/\*$/, "/")))}`;
    case "bash":
      return list(pats.map((p) => `\`${p}\``));
    case "webfetch":
      return `fetching ${list(pats.map((p) => p.replace(/\/\*$/, "")))}`;
    case "external_directory":
      return `access to ${list(pats.map((p) => p.replace(/[\\/]\*$/, "")))}`;
    case "read":
      return `reading ${list(pats)}`;
    default:
      return pats.every((p) => p === "*") ? `the ${req.tool} tool` : list(pats.map((p) => `\`${p}\``));
  }
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write('Interactive mode needs a terminal. Use `usta run "prompt"` for scripts and pipes.\n');
    return 2;
  }
  const screen = new Screen(stdout);
  const view = new ConversationView(screen);
  const editor = new Editor();
  editor.history = loadHistory();
  editor.pushHistory("");
  editor.history = editor.history.filter(Boolean);
  let modal: Modal | undefined;
  const modalQueue: Array<() => Modal> = [];
  let exitResolve!: (code: number) => void;
  const exited = new Promise<number>((r) => (exitResolve = r));
  let lastCtrlC = 0;
  let lastEsc = 0;
  let hint = "";
  let hintTimer: NodeJS.Timeout | undefined;

  const redraw = () => screen.setLive(compose());
  view.onChange = redraw;
  editor.onChange = redraw;

  const flashHint = (text: string, ms = 2500) => {
    hint = text;
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint = "";
      redraw();
    }, ms);
    redraw();
  };

  // ----- keyboard -----
  const onKeyRef: { fn: (k: Key) => void } = { fn: () => {} };
  const parser = new KeyParser((k) => onKeyRef.fn(k));
  const onData = (d: string) => parser.feed(d);
  const enableInput = () => {
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
    stdout.write(term.bracketedPasteOn);
  };
  const disableInput = () => {
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(term.bracketedPasteOff + "\x1b[?25h");
  };
  enableInput();

  const openModal = (factory: () => Modal) => {
    if (modal) {
      modalQueue.push(factory);
      return;
    }
    modal = factory();
    const m = modal as Modal & { onChange?: () => void };
    m.onChange = redraw;
    redraw();
  };
  const closeModal = () => {
    modal = undefined;
    const next = modalQueue.shift();
    if (next) openModal(next);
    else redraw();
  };

  // ----- trust -----
  const needTrust = Runtime.trustNeeded(opts.cwd);
  let trusted = false;
  if (needTrust.length) {
    trusted = await new Promise<boolean>((resolve) => {
      onKeyRef.fn = (k) => modal?.handleKey(k);
      openModal(
        () =>
          new SelectPrompt({
            title: "Trust this folder?",
            body: [
              `${c.bold(displayPath(Runtime.findRoot(opts.cwd), os.homedir()))} has project settings that can run commands or change permissions:`,
              ...needTrust.map((f) => c.gray("  " + displayPath(f, opts.cwd))),
              "Only trust folders whose code you trust. Without trust, hooks, MCP servers, permission rules and provider settings from the project are ignored.",
            ],
            options: [
              { label: "Yes, trust this folder", value: "yes" },
              { label: "No, continue without project settings", value: "no" },
            ],
            cancelValue: "no",
            onDone: (v) => {
              closeModal();
              resolve(v === "yes");
            },
          }),
      );
    });
    if (trusted) await trustStore.trust(Runtime.findRoot(opts.cwd));
  }

  // ----- runtime -----
  let rt: Runtime;
  try {
    rt = await Runtime.create({ cwd: opts.cwd, model: opts.model, agent: opts.agent, yolo: opts.yolo, interactive: true, trusted: trusted || undefined });
  } catch (err) {
    screen.dispose();
    disableInput();
    process.stderr.write(c.red(`Failed to start: ${(err as Error).message}\n`));
    return 1;
  }

  let session: Session | undefined;
  const draft: { model?: string; agent: string; mode: Mode; effort?: Effort } = {
    model: opts.model,
    agent: rt.defaultAgent(),
    mode: opts.mode ?? "normal",
    effort: opts.effort,
  };
  const currentModel = () => session?.meta.model ?? draft.model ?? rt.config.model ?? rt.registry.defaultModelRef();
  const currentMode = (): Mode => session?.meta.mode ?? draft.mode;
  const currentAgent = () => session?.meta.agent ?? draft.agent;
  let modelInfo: Awaited<ReturnType<typeof rt.registry.resolveModel>> | undefined;
  const refreshModelInfo = () => {
    const ref = currentModel();
    if (!ref) return;
    rt.registry
      .resolveModel(ref)
      .then((m) => {
        modelInfo = m;
        redraw();
      })
      .catch(() => {});
  };

  async function ensureSession(): Promise<Session> {
    if (session) return session;
    const s = await rt.newSession({ model: draft.model, agent: draft.agent });
    if (draft.effort) await s.update({ effort: draft.effort });
    if (draft.mode !== "normal") await rt.engine.setMode(s, draft.mode);
    session = s;
    view.sessionId = s.id;
    return s;
  }

  if (opts.session) {
    try {
      session = await rt.loadSession(opts.session);
    } catch (err) {
      screen.print(c.red(`Could not open session ${opts.session}: ${(err as Error).message}`));
    }
  } else if (opts.continueLast) {
    session = await rt.latestSession();
  }
  if (session) view.sessionId = session.id;
  refreshModelInfo();

  // ----- file list for @ completion -----
  let files: string[] = [];
  const refreshFiles = () => {
    listFiles(rt.cwd, { limit: 50_000 })
      .then((f) => (files = f))
      .catch(() => {});
  };
  refreshFiles();

  // ----- output helpers -----
  const print = (text: string) => screen.print(text);
  const printUser = (text: string) => {
    const w = screen.width;
    const lines = wrapAnsi(text, w - 4);
    screen.print(lines.map((l, i) => (i === 0 ? theme.accent("› ") : "  ") + theme.user(l)).join("\n"));
  };

  function printHistory(s: Session, maxTurns = 4): void {
    const msgs = s.active;
    let turns = 0;
    let start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role === "user" && (m.origin === "prompt" || m.origin === "summary")) {
        turns++;
        start = i;
        if (turns >= maxTurns) break;
      }
    }
    if (start > 0) print(c.gray(`  … ${start} earlier messages`));
    for (const m of msgs.slice(start)) {
      if (m.role === "user") {
        if (m.origin === "prompt") printUser(textOf(m.parts));
        else if (m.origin === "summary") print(c.gray("✻ (conversation summary from compaction)"));
        continue;
      }
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) {
          const lines = renderMarkdown(p.text, screen.width - 2);
          print(lines.map((l, i) => (i === 0 ? theme.accent("● ") : "  ") + l).join("\n"));
        } else if (p.type === "tool_call") {
          print(c.gray(`${c.green("●")} ${p.name} ${truncateEnd(oneLine(toolTitle(p.name, p.input, rt.cwd)), screen.width - p.name.length - 8)}`));
        }
      }
    }
    print("");
  }

  // ----- banner -----
  const banner = () => {
    const ref = currentModel() ?? c.red("no model — /login to connect a provider");
    print(`${theme.brand("✻ usta")} ${c.gray(VERSION)}  ${c.bold(String(ref))} ${c.gray("· " + currentAgent())}`);
    const git = rt.root !== rt.cwd ? ` (project ${displayPath(rt.root, os.homedir())})` : "";
    print(c.gray(`  ${displayPath(rt.cwd, os.homedir())}${git}`));
    print(c.gray("  /help commands · @ attach files · ! shell · ⇧⇥ modes · esc interrupt · ctrl+c twice to exit"));
    for (const w of rt.loaded.withheld) print(c.yellow(`  ! Ignored ${w.keys.join(", ")} from ${displayPath(w.path, rt.cwd)} (folder not trusted)`));
    for (const st of rt.mcp.statuses.values()) {
      if (st.status === "failed") print(c.yellow(`  ! MCP server "${st.name}" failed: ${truncateEnd(st.error ?? "", 160)}`));
    }
    if (rt.instructions.length) print(c.gray(`  instructions: ${rt.instructions.map((f) => displayPath(f.path, rt.cwd)).join(", ")}`));
    print("");
    if (session) {
      print(c.gray(`  Resumed "${session.meta.title || session.id}" (${session.messages.length} messages)`));
      printHistory(session);
    }
  };
  banner();

  // ----- status line & composition -----
  const statusLine = (w: number): string => {
    const parts: string[] = [modeBadge(currentMode(), rt.permissions.yolo), currentAgent()];
    const ref = currentModel();
    if (ref) parts.push(ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref);
    const effort = session?.meta.effort ?? draft.effort;
    if (effort) parts.push(`effort ${effort}`);
    if (session && modelInfo && session.meta.lastContextTokens) {
      const ratio = (session.meta.lastContextTokens / modelInfo.contextWindow) * 100;
      const pct = Math.round(ratio);
      parts.push(pct >= 70 ? c.yellow(`ctx ${pct}%`) : `ctx ${ratio < 1 ? "<1" : pct}%`);
    }
    if (session && session.meta.cost > 0) parts.push(formatCost(session.meta.cost));
    const left = "  " + parts.join(c.gray(" · "));
    const right = hint || (busy ? "esc interrupt · enter queues" : "⇧⇥ mode · /help");
    const pad = w - 1 - stringWidth(left) - stringWidth(right);
    return pad > 1 ? c.gray(left) + " ".repeat(pad) + c.gray(right) : c.gray(truncateAnsi(left, w - 1));
  };

  const queue: string[] = [];
  let busy = false;
  let controller: AbortController | undefined;

  function compose() {
    const w = screen.width;
    const lines: string[] = [...view.liveLines(w)];
    if (modal) {
      if (lines.length) lines.push("");
      // Give the modal the rows below the live view (the view is clipped first when space runs out).
      const r = modal.render(w, Math.max(Math.min(12, screen.height - 1), screen.height - 1 - lines.length));
      const row0 = lines.length;
      lines.push(...r.lines);
      return { lines, cursor: r.cursor ? { row: row0 + r.cursor.row, col: r.cursor.col } : undefined };
    }
    for (const q of queue) lines.push(c.gray(truncateAnsi(`  ⧗ queued: ${oneLine(q)}`, w - 1)));
    lines.push(c.gray("─".repeat(Math.max(10, w - 1))));
    const ed = editor.render(w);
    const row0 = lines.length;
    lines.push(...ed.lines);
    lines.push(...editor.renderCompletion(w));
    lines.push(statusLine(w));
    return { lines, cursor: { row: row0 + ed.cursor.row, col: ed.cursor.col } };
  }

  const spinner = setInterval(() => {
    if (view.busy) {
      view.tick();
      redraw();
    }
  }, 100);

  // ----- modals for engine requests -----
  function permissionModal(req: PermissionRequest): Modal {
    const d0 = req.detail ?? {};
    const heading = req.permission === "bash" && d0.command ? (req.title.includes(": ") && !req.title.startsWith("Run: ") ? req.title.slice(0, req.title.indexOf(": ")) : "Run a shell command") : req.title;
    const body: string[] = [c.bold(heading)];
    if (req.agent && req.agent !== currentAgent()) body.push(c.gray(`requested by the ${req.agent} agent`));
    const d = req.detail ?? {};
    if (req.permission === "bash" && d.command) {
      for (const l of d.command.split("\n").slice(0, 12)) body.push("  " + theme.code(l));
      if (d.path && d.path !== rt.cwd) body.push(c.gray(`  in ${displayPath(d.path, rt.cwd)}`));
    } else if (d.diff) {
      body.push(...renderDiff(d.diff, screen.width - 6, 30));
    } else if (d.url) body.push("  " + theme.link(d.url));
    else if (d.preview) for (const l of d.preview.split("\n").slice(0, 12)) body.push(c.gray("  " + l));
    const scope = describeScope(req);
    const options = [
      { label: "Yes", value: "once" },
      { label: `Yes, and allow ${scope} for this session`, value: "session" },
      { label: `Yes, and always allow ${scope} in this project`, value: "always" },
    ];
    if (req.permission === "edit") options.splice(1, 0, { label: "Yes, and auto-accept edits from now on", value: "auto-edit" });
    options.push({ label: "No, and tell usta what to do differently", value: "deny" });
    const opts2 = options.map((o) => (o.value === "deny" ? { ...o, input: { prompt: "What should usta do instead? (Enter to just stop)", optional: true } } : o));
    return new SelectPrompt({
      title: `Permission · ${req.tool}`,
      body,
      options: opts2,
      cancelValue: "deny",
      accent: c.yellow,
      onDone: (value, text) => {
        closeModal();
        if (value === "auto-edit") {
          if (session) void rt.engine.setMode(session, "auto-edit").then(redraw);
          rt.replyPermission(req.id, { decision: "once" });
          return;
        }
        const decision = (value ?? "deny") as "once" | "session" | "always" | "deny";
        rt.replyPermission(req.id, { decision, feedback: text });
        if (decision === "deny" && !text) {
          // A plain "no" stops the turn so the user can redirect.
          controller?.abort();
        }
      },
    });
  }

  rt.bus.on((e: AgentEvent) => {
    view.handle(e);
    if (e.type === "permission.request") openModal(() => permissionModal(e.request));
    else if (e.type === "question.request") {
      const q = e.request;
      openModal(
        () =>
          new SelectPrompt({
            title: "Question",
            body: [c.bold(q.question)],
            options: [
              ...(q.options ?? []).map((o) => ({ label: o.label, hint: o.description, value: o.label })),
              { label: q.options?.length ? "Other (type an answer)" : "Type your answer", value: "__other", input: { prompt: "Your answer:" } },
            ],
            cancelValue: "__skip",
            onDone: (value, text) => {
              closeModal();
              const answer = value === "__skip" || value === undefined ? "(The user skipped this question; use your best judgment.)" : value === "__other" ? (text ?? "") : value;
              rt.engine.answerQuestion(e.id, answer);
            },
          }),
      );
    } else if (e.type === "plan.review") {
      const lines = renderMarkdown(e.plan, screen.width - 4);
      print([c.cyan("╭─ Plan " + "─".repeat(Math.max(0, screen.width - 10))), ...lines.map((l) => c.cyan("│ ") + l), c.cyan("╰" + "─".repeat(Math.max(0, screen.width - 3)))].join("\n"));
      openModal(
        () =>
          new SelectPrompt({
            title: "Ready to implement?",
            options: [
              { label: "Yes, and auto-accept edits", value: "auto" },
              { label: "Yes, and approve each edit", value: "manual" },
              { label: "No, keep planning", value: "no", input: { prompt: "What should change in the plan? (optional)", optional: true } },
            ],
            cancelValue: "no",
            accent: c.cyan,
            onDone: (value, text) => {
              closeModal();
              if (value === "auto" || value === "manual") rt.engine.resolvePlan(e.id, { approved: true, mode: value === "auto" ? "auto-edit" : "normal" });
              else rt.engine.resolvePlan(e.id, { approved: false, feedback: text });
            },
          }),
      );
    } else if (e.type === "mode") redraw();
  });

  // ----- turns -----
  async function processQueue(): Promise<void> {
    while (queue.length && !busy) {
      const next = queue.shift()!;
      await startTurn(next);
    }
  }

  async function startTurn(text: string, display?: string, override?: { agent?: string; model?: string }): Promise<void> {
    let s: Session;
    try {
      s = await ensureSession();
    } catch (err) {
      print(c.red(`✗ ${(err as Error).message}`));
      return;
    }
    printUser(display ?? text);
    const att = await expandMentions(text, rt.cwd).catch(() => ({ context: [], images: [], files: [], missing: [] }));
    if (att.files.length) print(c.gray(`  ⎿ attached ${att.files.join(", ")}`));
    const prevAgent = s.meta.agent;
    const prevModel = s.meta.model;
    if (override?.agent && override.agent !== prevAgent) await rt.engine.setAgent(s, override.agent);
    if (override?.model) await s.update({ model: override.model });
    busy = true;
    controller = new AbortController();
    const started = Date.now();
    redraw();
    try {
      await rt.engine.prompt(s, { text, images: att.images, context: att.context }, { signal: controller.signal });
    } catch (err) {
      print(c.red(`✗ ${(err as Error).message}`));
    } finally {
      busy = false;
      controller = undefined;
      rt.denyPending();
      if (override?.agent && override.agent !== prevAgent) await rt.engine.setAgent(s, prevAgent);
      if (override?.model) await s.update({ model: prevModel });
      if (s.writeError) print(c.yellow(`! Session could not be saved: ${s.writeError.message}`));
      if (rt.config.notify !== false && Date.now() - started > 30_000) stdout.write(term.notify(`usta: ${s.meta.title || "turn"} finished`));
      refreshFiles();
      redraw();
    }
    await processQueue();
  }

  async function runShellCommand(cmd: string): Promise<void> {
    if (!cmd.trim()) return;
    print(`${c.magenta("!")} ${theme.code(cmd)}`);
    busy = true;
    controller = new AbortController();
    redraw();
    const res = await runShell(cmd, { cwd: rt.cwd, timeoutMs: 10 * 60_000, signal: controller.signal });
    busy = false;
    controller = undefined;
    const out = clipOutput(res.output.trimEnd(), { maxBytes: 20_000, maxLines: 400 }).text;
    const shown = out.split("\n").slice(-40);
    for (const l of shown) print(c.gray("  " + l));
    if (res.exitCode !== 0) print(c.red(`  exit ${res.exitCode ?? res.signal}`));
    try {
      const s = await ensureSession();
      await s.add({
        id: `msg_shell_${Date.now()}`,
        role: "user",
        time: Date.now(),
        origin: "shell",
        parts: [{ type: "text", text: `<shell-command>${cmd}</shell-command>\n<shell-output exit="${res.exitCode}">\n${out}\n</shell-output>\n(The user ran this command themselves; the output is for your reference.)` }],
      });
    } catch {
      // no model configured; output was still shown
    }
    redraw();
  }

  // ----- slash commands -----
  const pickModel = async () => {
    const options: SelectOption[] = [];
    for (const id of rt.registry.providerIds()) {
      if (!rt.registry.hasCredentials(id)) continue;
      const family = PRESETS[id]?.catalog;
      const models = new Map<string, string | undefined>();
      for (const m of family ? catalogModels(family) : []) models.set(m.id, m.name);
      for (const m of Object.keys(rt.registry.providerConfig(id).models ?? {})) models.set(m, undefined);
      for (const [m, name] of models) options.push({ label: `${id}/${m}`, hint: name, value: `${id}/${m}` });
    }
    const cur = currentModel();
    if (cur && !options.some((o) => o.value === cur)) options.unshift({ label: cur, hint: "current", value: cur });
    if (!options.length) {
      connectProvider();
      return;
    }
    options.push(
      { label: "Other model…", hint: "any provider/model id", value: "\0other", input: { prompt: "Model reference, e.g. openrouter/<vendor>/<model> or ollama/<model>" } },
      { label: "Connect another provider…", hint: "save an API key", value: "\0connect" },
    );
    openModal(
      () =>
        new SelectPrompt({
          title: "Model",
          options,
          initial: Math.max(0, options.findIndex((o) => o.value === cur)),
          filterable: true,
          onDone: (v, text) => {
            closeModal();
            if (v === "\0connect") connectProvider();
            else if (v === "\0other") {
              if (text) void setModel(text);
            } else if (v) void setModel(v);
          },
        }),
    );
  };

  /** Choose a provider, then enter its API key. */
  const connectProvider = (provider?: string) => {
    if (provider) return askKey(provider);
    const ids = Object.keys(PRESETS).filter((id) => !PRESETS[id]!.keyless);
    openModal(
      () =>
        new SelectPrompt({
          title: "Connect a model provider",
          body: [
            "usta calls model APIs directly with your own key. Pick a provider to enter its key.",
            c.gray("Local models (Ollama, LM Studio) need no key: add them under \"providers\" in the config."),
          ],
          options: [
            ...ids.map((id) => ({
              label: PRESETS[id]!.name,
              hint: `${rt.registry.hasCredentials(id) ? "connected · " : ""}${PRESETS[id]!.env[0] ?? ""}`,
              value: id,
            })),
            { label: "Skip for now", hint: "/login later", value: "" },
          ],
          cancelValue: "",
          onDone: (v) => {
            closeModal();
            if (v) askKey(v);
            else if (!currentModel()) print(c.gray("  No model yet. Use /login to connect a provider, or set an API key environment variable."));
          },
        }),
    );
  };

  const askKey = (id: string) => {
    const preset = PRESETS[id];
    if (!preset && !rt.registry.providerConfig(id).format) {
      print(c.red(`✗ Unknown provider "${id}". Known: ${Object.keys(PRESETS).join(", ")}`));
      return;
    }
    const name = rt.registry.name(id);
    const env = preset?.env[0];
    openModal(
      () =>
        new TextPrompt({
          title: `API key · ${name}`,
          body: [
            ...(KEY_URLS[id] ? [`Create one at ${theme.link(KEY_URLS[id]!)}`] : []),
            c.gray(`Stored in ${displayPath(authStore.file(), os.homedir())}, readable only by you.${env ? ` Setting ${env} works too.` : ""}`),
          ],
          mask: true,
          placeholder: "paste the key",
          onDone: (key) => {
            closeModal();
            const k = key?.replace(/\s+/g, "");
            if (k) {
              saveKey(id, k).catch((err: unknown) => {
                print(c.red(`✗ Could not save the key: ${(err as Error).message}`));
                redraw();
              });
            }
          },
        }),
    );
  };

  const saveKey = async (id: string, key: string) => {
    const name = rt.registry.name(id);
    // A quick authenticated call catches typos before the first prompt.
    flashHint(`checking the ${name} key…`, 10_000);
    const check = await checkCredentials(rt.registry, id, key);
    flashHint("", 1);
    if (check.status === "rejected") {
      print(c.red(`✗ ${name} rejected the key: ${truncateEnd(oneLine(check.message ?? ""), 160)}`));
      print(c.gray(`  Nothing was saved. Try again with /login ${id}.`));
      redraw();
      return;
    }
    await authStore.set(id, key);
    rt.registry.reset(id);
    print(`${c.green("✓")} Connected ${name}.${check.status === "unknown" ? c.gray(" (could not verify the key now)") : ""}`);
    const override = rt.registry.keyOverride(id);
    if (override) print(c.yellow(`  ! ${override === "config" ? "The key in your config" : override} takes precedence over the saved key.`));
    // Keep a model the user chose explicitly; otherwise switch to the new provider.
    const chosen = session?.meta.model ?? draft.model ?? rt.config.model;
    let usable = false;
    try {
      usable = Boolean(chosen && rt.registry.hasCredentials(parseModelRef(chosen).provider));
    } catch {
      // unparsable model reference
    }
    if (chosen && usable) {
      print(c.gray(`  Still using ${chosen}. /model switches models.`));
      redraw();
      return;
    }
    const def = PRESETS[id]?.defaultModel;
    if (def) {
      await setModel(`${id}/${def}`);
      return;
    }
    openModal(
      () =>
        new TextPrompt({
          title: `Model on ${name}`,
          body: [c.gray(`List the models with: usta models ${id} --remote`)],
          placeholder: "model id",
          onDone: (m) => {
            closeModal();
            if (m?.trim()) void setModel(`${id}/${m.trim()}`);
          },
        }),
    );
  };

  const setModel = async (ref: string) => {
    try {
      parseModelRef(ref);
      const info = await rt.registry.resolveModel(ref);
      if (session) await session.update({ model: ref });
      else draft.model = ref;
      modelInfo = info;
      void stateStore.setLastModel(ref).catch(() => {});
      print(c.gray(`  model → ${ref} (${formatTokens(info.contextWindow)} context${info.source === "default" ? ", unknown model: defaults assumed" : ""})`));
    } catch (err) {
      print(c.red(`✗ ${(err as Error).message}`));
    }
    redraw();
  };

  const setMode = async (mode: Mode) => {
    if (session) await rt.engine.setMode(session, mode);
    else draft.mode = mode;
    redraw();
  };

  /** "reverted a.ts, b.ts and 3 more" */
  const reverted = (changes: FileChange[]) => {
    if (!changes.length) return "";
    const names = changes.map((ch) => ch.path);
    return ` · reverted ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  };

  const ago = (ms: number) => {
    const m = Math.round(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };

  /** Pick an earlier prompt and go back to just before it (Esc Esc on an empty prompt). */
  const openRewind = () => {
    if (!session) return print(c.gray("  Nothing to rewind."));
    if (busy) return flashHint("wait for the current turn to finish");
    const points = rt.engine.rewindPoints(session);
    if (!points.length) return print(c.gray("  Nothing to rewind."));
    const now = Date.now();
    openModal(
      () =>
        new SelectPrompt({
          title: "Rewind to before…",
          body: [c.gray("Pick a prompt to go back to. /redo brings everything back.")],
          options: [...points].reverse().map((p) => ({
            label: truncateEnd(oneLine(p.text) || "(empty prompt)", Math.max(20, screen.width - 34)),
            hint: `${ago(now - p.time)}${p.hasSnapshot ? "" : " · no file snapshot"}`,
            value: p.id,
          })),
          filterable: true,
          onDone: (id) => {
            closeModal();
            const point = points.find((p) => p.id === id);
            if (!point) return;
            openModal(
              () =>
                new SelectPrompt({
                  title: "Rewind",
                  body: [`Before: ${c.bold(truncateEnd(oneLine(point.text), 80))}`],
                  options: [
                    ...(point.hasSnapshot ? [{ label: "Restore code and conversation", value: "both" }] : []),
                    { label: "Conversation only", hint: "keep the files as they are", value: "conversation" },
                    ...(point.hasSnapshot ? [{ label: "Code only", hint: "keep the conversation", value: "code" }] : []),
                    { label: "Cancel", value: "" },
                  ],
                  cancelValue: "",
                  onDone: (how) => {
                    closeModal();
                    if (how) void doRewind(point.id, how);
                  },
                }),
            );
          },
        }),
    );
  };

  const doRewind = async (id: string, how: string) => {
    if (!session) return;
    try {
      const r = await rt.engine.rewind(session, id, { code: how !== "conversation", conversation: how !== "code" });
      const what = how === "both" ? "code and conversation" : how;
      print(c.gray(`  ↶ Rewound ${what} to before "${truncateEnd(oneLine(r.prompt), 60)}"${reverted(r.restored)}`));
      if (how === "code") {
        rt.engine.remind(session.id, `<system-reminder>The user restored the files to their state before the prompt "${truncateEnd(oneLine(r.prompt), 200)}". Changes you made after that point were reverted; read files again before editing them.</system-reminder>`);
      } else {
        if (how === "conversation") {
          rt.engine.remind(session.id, "<system-reminder>The user rewound the conversation but kept the files: they may contain changes from the removed part. Read files again before editing them.</system-reminder>");
        }
        editor.setValue(r.prompt);
      }
    } catch (err) {
      print(c.red(`✗ ${(err as Error).message}`));
    }
    redraw();
  };

  const customCommands = (): CommandInfo[] => rt.commands;

  const builtins: SlashCommand[] = [
    {
      name: "help",
      aliases: ["?"],
      description: "Show commands and keys",
      run: () => {
        const rows = [...builtins.map((b) => [`/${b.name}${b.args ? " " + b.args : ""}`, b.description]), ...customCommands().map((cc) => [`/${cc.name}${cc.argumentHint ? " " + cc.argumentHint : ""}`, `${cc.description} ${c.gray(`(${cc.source})`)}`])];
        const w = Math.min(28, Math.max(...rows.map((r) => r[0]!.length)) + 2);
        print(c.bold("Commands"));
        for (const [a, b] of rows) print(`  ${theme.accent(a!.padEnd(w))}${c.gray(b!)}`);
        print(c.bold("Keys"));
        const keys = [
          ["enter", "send (queues while busy)"],
          ["ctrl+j / alt+enter / \\ enter", "new line"],
          ["shift+tab", "cycle mode: normal → accept edits → plan"],
          ["esc", "interrupt the agent · close menus"],
          ["ctrl+c", "clear input · twice to exit"],
          ["ctrl+o", "toggle verbose output (thinking, full tool output)"],
          ["ctrl+g", "write the prompt in $VISUAL / $EDITOR"],
          ["esc esc", "clear the input · on an empty prompt: rewind"],
          ["ctrl+l", "redraw the screen"],
          ["↑ ↓", "history"],
          ["@path", "attach a file, image or directory (@file:10-20 for lines)"],
          ["!cmd", "run a shell command and share its output"],
        ];
        for (const [a, b] of keys) print(`  ${theme.accent(a!.padEnd(30))}${c.gray(b!)}`);
      },
    },
    {
      name: "new",
      aliases: ["clear"],
      description: "Start a new session",
      run: () => {
        session = undefined;
        view.sessionId = "";
        draft.mode = "normal";
        print(c.gray("  New session."));
      },
    },
    {
      name: "sessions",
      aliases: ["resume"],
      args: "[id]",
      description: "List and switch sessions",
      run: async (args) => {
        if (args.trim()) {
          await switchSession(args.trim());
          return;
        }
        const list = await rt.store.list();
        if (!list.length) {
          print(c.gray("  No sessions yet."));
          return;
        }
        openModal(
          () =>
            new SelectPrompt({
              title: "Sessions",
              options: list.slice(0, 200).map((s) => ({
                label: truncateEnd(s.title || "(untitled)", 60),
                hint: `${new Date(s.updated).toLocaleString()} · ${s.messages} msgs${s.cost ? " · " + formatCost(s.cost) : ""}`,
                value: s.id,
              })),
              filterable: true,
              onDone: (v) => {
                closeModal();
                if (v) void switchSession(v);
              },
            }),
        );
      },
    },
    { name: "model", args: "[provider/model]", description: "Pick or set the model", run: (a) => (a.trim() ? setModel(a.trim()) : pickModel()) },
    {
      name: "agent",
      args: "[name]",
      description: "Pick or set the primary agent",
      run: async (a) => {
        const primaries = rt.agents.filter(isPrimary);
        const apply = async (name: string) => {
          if (session) await rt.engine.setAgent(session, name);
          else draft.agent = name;
          print(c.gray(`  agent → ${name}`));
          redraw();
        };
        if (a.trim()) {
          if (!primaries.some((p) => p.name === a.trim())) print(c.red(`✗ Unknown agent "${a.trim()}". Available: ${primaries.map((p) => p.name).join(", ")}`));
          else await apply(a.trim());
          return;
        }
        openModal(
          () =>
            new SelectPrompt({
              title: "Agent",
              options: primaries.map((p) => ({ label: p.name, hint: truncateEnd(p.description, 70), value: p.name })),
              onDone: (v) => {
                closeModal();
                if (v) void apply(v);
              },
            }),
        );
      },
    },
    {
      name: "mode",
      args: "[normal|auto-edit|plan]",
      description: "Set the permission mode",
      run: async (a) => {
        const m = a.trim() as Mode;
        if (MODES.includes(m)) await setMode(m);
        else print(c.gray(`  mode: ${currentMode()} (options: ${MODES.join(", ")})`));
      },
    },
    { name: "plan", description: "Toggle plan mode (research and plan before editing)", run: () => setMode(currentMode() === "plan" ? "normal" : "plan") },
    {
      name: "effort",
      args: "[low|medium|high|xhigh|max]",
      description: "Set reasoning effort",
      run: async (a) => {
        const lvl = a.trim() as Effort;
        if (!EFFORT_LEVELS.includes(lvl)) {
          print(c.gray(`  effort: ${session?.meta.effort ?? draft.effort ?? "model default"} (options: ${EFFORT_LEVELS.join(", ")})`));
          return;
        }
        if (session) await session.update({ effort: lvl });
        else draft.effort = lvl;
        if (modelInfo && !modelInfo.effortLevels.length) print(c.yellow(`  ${modelInfo.id} does not support effort; the setting is ignored.`));
        else print(c.gray(`  effort → ${lvl}`));
        redraw();
      },
    },
    {
      name: "compact",
      args: "[instructions]",
      description: "Summarize the conversation to free context",
      run: async (a) => {
        if (!session || !session.active.length) {
          print(c.gray("  Nothing to compact."));
          return;
        }
        busy = true;
        controller = new AbortController();
        view.busy = true;
        redraw();
        try {
          await rt.engine.compact(session, { signal: controller.signal, instructions: a.trim() || undefined });
        } catch (err) {
          print(c.red(`✗ ${(err as Error).message}`));
        } finally {
          busy = false;
          view.busy = false;
          controller = undefined;
          redraw();
        }
      },
    },
    {
      name: "undo",
      description: "Undo the last turn (files and conversation)",
      run: async () => {
        if (!session) return print(c.gray("  Nothing to undo."));
        try {
          const r = await rt.engine.undo(session);
          if (!r) return print(c.gray("  Nothing to undo."));
          print(c.gray(`  ↶ Undid "${truncateEnd(oneLine(r.prompt), 60)}"${reverted(r.restored)}`));
          editor.setValue(r.prompt);
        } catch (err) {
          print(c.red(`✗ ${(err as Error).message}`));
        }
      },
    },
    {
      name: "rewind",
      description: "Go back to an earlier prompt (code and/or conversation)",
      run: () => openRewind(),
    },
    {
      name: "redo",
      description: "Redo the last undone turn or rewind",
      run: async () => {
        if (!session) return;
        const r = await rt.engine.redo(session);
        if (!r) return print(c.gray("  Nothing to redo."));
        print(c.gray(r.prompt ? `  ↷ Redid "${truncateEnd(oneLine(r.prompt), 60)}"` : "  ↷ Restored the file changes"));
        editor.clear();
      },
    },
    {
      name: "diff",
      args: "[all]",
      description: "Show file changes of the last turn (or the whole session)",
      run: async (a) => {
        if (!session) return print(c.gray("  No changes."));
        const prompts = session.messages.filter((m) => m.role === "user" && m.origin === "prompt" && m.snapshot);
        const from = a.trim() === "all" ? prompts[0] : prompts.at(-1);
        if (!from || from.role !== "user" || !from.snapshot) return print(c.gray("  No snapshot available."));
        const diff = await rt.snapshotter.diff(from.snapshot);
        if (!diff.trim()) return print(c.gray("  No changes."));
        for (const block of diff.split(/(?=^diff --git )/m)) {
          const file = /^diff --git a\/(.*?) b\//.exec(block)?.[1] ?? /^--- a\/(.*)$/m.exec(block)?.[1] ?? "";
          print(c.bold(file));
          print(renderDiff(block, screen.width, 200).join("\n"));
        }
      },
    },
    {
      name: "cost",
      description: "Show token usage and cost",
      run: () => {
        if (!session) return print(c.gray("  No usage yet."));
        const u = session.meta.usage;
        print(`  input ${formatTokens(u.input)} · cache read ${formatTokens(u.cacheRead)} · cache write ${formatTokens(u.cacheWrite)} · output ${formatTokens(u.output)}`);
        print(`  cost ${formatCost(session.meta.cost)}${modelInfo?.pricing ? "" : c.gray(" (no pricing data for this model)")}`);
        if (modelInfo) print(`  context ${formatTokens(session.meta.lastContextTokens)} / ${formatTokens(modelInfo.contextWindow)}`);
      },
    },
    {
      name: "status",
      description: "Show model, config, MCP, language server and permission status",
      run: async () => {
        const ref = currentModel();
        print(`  ${c.bold("model")}     ${ref ?? "(none)"}${modelInfo ? c.gray(` · ${formatTokens(modelInfo.contextWindow)} ctx · ${modelInfo.source}`) : ""}`);
        print(`  ${c.bold("agent")}     ${currentAgent()} · mode ${currentMode()}${rt.permissions.yolo ? c.red(" · yolo") : ""}`);
        print(`  ${c.bold("session")}   ${session ? `${session.id} · ${session.messages.length} messages` : "(not started)"}`);
        print(`  ${c.bold("project")}   ${rt.root}${rt.trusted ? c.green(" · trusted") : c.gray(" · not trusted")}`);
        print(`  ${c.bold("config")}    ${rt.loaded.sources.map((s) => displayPath(s.path, rt.cwd)).join(", ") || "(defaults)"}`);
        print(`  ${c.bold("snapshots")} ${rt.snapshotter.kind === "git" ? "git (full undo)" : "files (edits made by tools only)"}`);
        const providers = rt.registry.providerIds().filter((p) => rt.registry.hasCredentials(p));
        print(`  ${c.bold("providers")} ${providers.join(", ") || c.yellow("none configured")}`);
        for (const st of rt.mcp.statuses.values()) print(`  ${c.bold("mcp")}       ${st.name}: ${st.status}${st.tools ? ` (${st.tools} tools)` : ""}${st.error ? c.red(" " + truncateEnd(st.error, 100)) : ""}`);
        if (rt.skills.size) print(`  ${c.bold("skills")}    ${[...rt.skills.keys()].join(", ")}`);
        const servers = rt.lsp.status();
        if (!servers.length) print(`  ${c.bold("lsp")}       ${c.gray("off")}`);
        for (const st of servers) {
          const color = st.state === "ready" ? c.green : st.state === "failed" ? c.red : c.gray;
          const docs = st.documents ? c.gray(` · ${st.documents} open`) : "";
          print(`  ${c.bold("lsp")}       ${st.name}: ${color(st.state)}${docs}${st.error ? c.red(" " + truncateEnd(oneLine(st.error), 100)) : ""}`);
        }
      },
    },
    {
      name: "init",
      description: "Create or improve AGENTS.md for this project",
      run: () =>
        startTurn(
          "Analyze this codebase and create an AGENTS.md file at the project root (or improve the existing one) for future coding agents working here. Include: the commands to build, lint, type-check and test (especially how to run a single test), and the code style guidelines that matter here (imports, formatting, types, naming, error handling), plus any non-obvious architecture notes. If there are Cursor rules (.cursor/rules/ or .cursorrules), Copilot instructions (.github/copilot-instructions.md) or a CLAUDE.md, fold their important parts in. Keep it concise - roughly 20 to 50 lines - and don't invent anything you haven't verified.",
          "/init",
        ),
    },
    {
      name: "export",
      args: "[file.md|file.html|html]",
      description: "Export the session as Markdown or a self-contained HTML page",
      run: async (a) => {
        if (!session) return print(c.gray("  Nothing to export."));
        const arg = a.trim();
        const file = path.resolve(rt.cwd, arg === "html" ? `usta-${session.id}.html` : arg || `usta-${session.id}.md`);
        const html = /\.html?$/i.test(file);
        await fs.writeFile(file, html ? exportHtml(session) : exportMarkdown(session));
        print(c.gray(`  Exported to ${displayPath(file, rt.cwd)}`));
      },
    },
    {
      name: "copy",
      description: "Copy the last response to the clipboard",
      run: () => {
        const text = session ? [...session.active].reverse().find((m) => m.role === "assistant" && textOf(m.parts).trim()) : undefined;
        if (!text || text.role !== "assistant") return print(c.gray("  Nothing to copy."));
        stdout.write(term.clipboard(textOf(text.parts)));
        print(c.gray("  Copied (via terminal clipboard)."));
      },
    },
    {
      name: "todos",
      description: "Show the task list",
      run: () => {
        const todos = session?.meta.todos ?? [];
        print(todos.length ? renderTodos(todos).join("\n") : c.gray("  No tasks."));
      },
    },
    {
      name: "mcp",
      description: "Show MCP servers and tools",
      run: () => {
        if (!rt.mcp.statuses.size) return print(c.gray('  No MCP servers configured (add them under "mcp" in config).'));
        for (const st of rt.mcp.statuses.values()) print(`  ${st.status === "connected" ? c.green("●") : c.red("●")} ${st.name} ${c.gray(st.status)}${st.error ? " " + c.red(truncateEnd(st.error, 120)) : ""}`);
        for (const t of rt.mcp.tools()) print(c.gray(`    ${t.name}`));
      },
    },
    {
      name: "permissions",
      description: "Show permission rules granted in this project",
      run: () => {
        const rules = rt.permissions.persistedRules();
        if (!rules.length) print(c.gray("  No saved \"always allow\" rules for this project."));
        for (const r of rules) print(`  ${c.green(r.action)} ${r.permission} ${theme.code(r.pattern)}`);
        print(c.gray(`  Mode: ${currentMode()}. Configure rules under "permission" in config.`));
      },
    },
    {
      name: "title",
      args: "<title>",
      description: "Rename the session",
      run: async (a) => {
        if (!session) return print(c.gray("  Start a session first."));
        if (a.trim()) {
          await session.update({ title: a.trim() });
          return;
        }
        openModal(
          () =>
            new TextPrompt({
              title: "Session title",
              initial: session!.meta.title,
              onDone: (t) => {
                closeModal();
                if (t?.trim()) void session!.update({ title: t.trim() });
              },
            }),
        );
      },
    },
    {
      name: "login",
      args: "[provider]",
      description: "Connect a provider (save its API key)",
      run: (a) => connectProvider(a.trim() || undefined),
    },
    { name: "verbose", description: "Toggle verbose output", run: () => toggleVerbose() },
    { name: "exit", aliases: ["quit", "q"], description: "Exit", run: () => exitResolve(0) },
  ];

  const toggleVerbose = () => {
    view.verbose = !view.verbose;
    flashHint(view.verbose ? "verbose on" : "verbose off");
  };

  async function switchSession(id: string): Promise<void> {
    try {
      const s = await rt.loadSession(id);
      session = s;
      view.sessionId = s.id;
      refreshModelInfo();
      print(c.gray(`  Switched to "${s.meta.title || s.id}"`));
      printHistory(s);
    } catch (err) {
      print(c.red(`✗ ${(err as Error).message}`));
    }
  }

  async function runCommand(text: string): Promise<void> {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    if (!m) return;
    const name = m[1]!;
    const args = m[2] ?? "";
    const b = builtins.find((x) => x.name === name || x.aliases?.includes(name));
    if (b) {
      if (busy && !["help", "cost", "status", "todos", "mcp", "verbose", "diff", "permissions", "copy", "mode", "plan", "exit"].includes(b.name)) {
        print(c.yellow(`  /${b.name} is not available while the agent is working.`));
        return;
      }
      await b.run(args);
      redraw();
      return;
    }
    const custom = customCommands().find((x) => x.name === name);
    if (custom) {
      const { prompt, warnings } = await expandCommand(custom, args, { cwd: rt.cwd, allowShell: custom.scope === "global" || rt.trusted });
      for (const w of warnings) print(c.yellow(`  ! ${w}`));
      if (busy) {
        queue.push(prompt);
        redraw();
        return;
      }
      await startTurn(prompt, text, { agent: custom.agent, model: custom.model });
      return;
    }
    print(c.red(`✗ Unknown command /${name}. Type /help for the list.`));
  }

  // ----- completion -----
  editor.completionProvider = (text, pos) => {
    const before = text.slice(0, pos);
    if (/^\/[\w:.-]*$/.test(before) && pos === text.length) {
      const q = before.slice(1).toLowerCase();
      const items: CompletionItem[] = [];
      for (const b of builtins) {
        const names = [b.name, ...(b.aliases ?? [])];
        if (names.some((n) => n.startsWith(q))) items.push({ label: "/" + b.name, detail: b.description, value: "/" + b.name + (b.args ? " " : "") });
      }
      for (const cc of customCommands()) {
        if (cc.name.toLowerCase().includes(q)) items.push({ label: "/" + cc.name, detail: cc.description, value: "/" + cc.name + " " });
      }
      return { items, start: 0, end: pos };
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      const q = at[2]!;
      const scored = files
        .map((f) => ({ f, s: fuzzyScore(q, f) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.f.length - b.f.length)
        .slice(0, 30);
      return { items: scored.map(({ f }) => ({ label: f, value: "@" + f + " " })), start: pos - q.length - 1, end: pos };
    }
    return undefined;
  };

  editor.onSubmit = (raw) => {
    const text = raw.trim();
    if (!text) return;
    saveHistory(raw, rt.cwd);
    if (text.startsWith("/") && !text.startsWith("//")) {
      void runCommand(text);
      return;
    }
    if (text.startsWith("!") && text.length > 1) {
      if (busy) {
        flashHint("wait for the agent to finish before running shell commands");
        return;
      }
      void runShellCommand(text.slice(1));
      return;
    }
    const prompt = text.startsWith("//") ? text.slice(1) : raw;
    if (busy) {
      queue.push(prompt);
      redraw();
      return;
    }
    void startTurn(prompt);
  };

  // ----- global keys -----
  const suspend = () => {
    screen.clearLive();
    disableInput();
    process.once("SIGCONT", () => {
      enableInput();
      redraw();
    });
    process.kill(process.pid, "SIGTSTP");
  };

  /** Compose the prompt in $VISUAL / $EDITOR (Ctrl+G). */
  const openExternalEditor = () => {
    const editorCmd = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
    const file = path.join(os.tmpdir(), `usta-prompt-${process.pid}-${Date.now()}.md`);
    try {
      writeFileSync(file, editor.expanded(), { mode: 0o600 });
    } catch (err) {
      flashHint(`could not open the editor: ${(err as Error).message}`);
      return;
    }
    screen.clearLive();
    disableInput();
    stdout.write("\x1b[?25h");
    // Through the shell so values like "code --wait" work.
    const res =
      process.platform === "win32"
        ? spawnSync(editorCmd, [file], { stdio: "inherit", shell: true })
        : spawnSync("/bin/sh", ["-c", `${editorCmd} "$1"`, "sh", file], { stdio: "inherit" });
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
      unlinkSync(file);
    } catch {
      // editor removed the file
    }
    enableInput();
    if (res.error || (res.status !== 0 && res.status !== null)) flashHint(`${editorCmd} exited with ${res.error?.message ?? `code ${res.status}`}`);
    if (text !== undefined) editor.setValue(text.replace(/\s+$/, ""));
    redraw();
  };

  onKeyRef.fn = (k: Key) => {
    if (modal) {
      modal.handleKey(k);
      redraw();
      return;
    }
    if (k.ctrl && k.name === "g") {
      openExternalEditor();
      return;
    }
    if (k.ctrl && k.name === "c") {
      if (busy) {
        controller?.abort();
        rt.denyPending();
        return;
      }
      if (editor.value) {
        editor.clear();
        return;
      }
      if (Date.now() - lastCtrlC < 1500) {
        exitResolve(0);
        return;
      }
      lastCtrlC = Date.now();
      flashHint("press ctrl+c again to exit", 1500);
      return;
    }
    if (k.ctrl && k.name === "d" && !editor.value) {
      exitResolve(0);
      return;
    }
    if (k.ctrl && k.name === "z") {
      suspend();
      return;
    }
    if (k.ctrl && k.name === "l") {
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      screen.render();
      return;
    }
    if (k.ctrl && k.name === "o") {
      toggleVerbose();
      return;
    }
    if (k.name === "tab" && k.shift) {
      const i = MODES.indexOf(currentMode());
      void setMode(MODES[(i + 1) % MODES.length]!);
      return;
    }
    if (k.name === "escape" && !editor.completion) {
      if (busy) {
        controller?.abort();
        rt.denyPending();
        return;
      }
      if (Date.now() - lastEsc < 600) {
        lastEsc = 0;
        if (editor.value) editor.clear();
        else openRewind();
        return;
      }
      lastEsc = Date.now();
      return;
    }
    editor.handleKey(k);
  };

  redraw();
  if (!currentModel()) {
    // First run: connect a provider before anything else; keep the prompt for later.
    if (opts.prompt) editor.setValue(opts.prompt);
    connectProvider();
  } else if (opts.prompt) void startTurn(opts.prompt);

  const onTerm = () => exitResolve(130);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);

  const code = await exited;
  // ----- shutdown -----
  controller?.abort();
  clearInterval(spinner);
  if (hintTimer) clearTimeout(hintTimer);
  process.off("SIGTERM", onTerm);
  process.off("SIGHUP", onTerm);
  screen.dispose();
  parser.dispose();
  disableInput();
  if (session) {
    await session.flush().catch(() => {});
    if (session.messages.length) stdout.write(c.gray(`Session saved. Resume with: usta --session ${session.id}\n`));
  }
  await rt.close();
  return code;
}
