import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { LspConfig } from "../config/config.ts";
import { which } from "../util/shell.ts";
import { oneLine } from "../util/text.ts";
import { type Diagnostic, LspClient } from "./client.ts";

interface BuiltinServer {
  id: string;
  name: string;
  extensions: string[];
  /** Candidate commands; the first one found on PATH is used. */
  commands: string[][];
  /**
   * Started without being enabled in config. Only for servers that do not
   * run project code: rust-analyzer runs build scripts and proc macros, and
   * tsserver loads plugins from the project's node_modules.
   */
  auto: boolean;
  settings?: Record<string, unknown>;
}

export const BUILTIN_SERVERS: BuiltinServer[] = [
  {
    id: "python",
    name: "Pyright",
    extensions: [".py", ".pyi"],
    commands: [
      ["pyright-langserver", "--stdio"],
      ["basedpyright-langserver", "--stdio"],
    ],
    auto: true,
    settings: {
      python: { analysis: { diagnosticMode: "openFilesOnly" } },
      basedpyright: { analysis: { diagnosticMode: "openFilesOnly" } },
    },
  },
  { id: "go", name: "gopls", extensions: [".go"], commands: [["gopls"]], auto: true },
  { id: "clangd", name: "clangd", extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], commands: [["clangd"]], auto: true },
  {
    id: "typescript",
    name: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    commands: [["typescript-language-server", "--stdio"]],
    auto: false,
  },
  { id: "rust", name: "rust-analyzer", extensions: [".rs"], commands: [["rust-analyzer"]], auto: false },
];

interface Server {
  id: string;
  name: string;
  extensions: string[];
  /** Explicit command from config; otherwise looked up from `candidates`. */
  command?: string[];
  candidates: string[][];
  env?: Record<string, string>;
  initialization?: unknown;
  settings?: Record<string, unknown>;
  languageId?: string;
  missing?: boolean;
}

export interface DiagnosticsReport {
  /** Text appended to the tool result (empty when there is nothing new). */
  text: string;
  /** New errors across the files. */
  errors: number;
}

export interface LspStatus {
  id: string;
  name: string;
  state: "not started" | "not installed" | "starting" | "ready" | "failed" | "closed";
  command?: string;
  error?: string;
  documents: number;
}

/** First contact: the server starts and analyzes the project. */
const FIRST_TIMEOUT_MS = 15_000;
const TIMEOUT_MS = 5_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_ERRORS_PER_FILE = 20;
/** Files opened ahead of edits (on read) per server. */
const MAX_WARM_DOCUMENTS = 200;

function normExt(e: string): string {
  const x = e.trim().toLowerCase();
  return x.startsWith(".") ? x : "." + x;
}

function resolveServers(config: LspConfig | undefined): Server[] {
  if (config === false) return [];
  const all = config === true;
  const map = config && typeof config === "object" ? config : {};
  const out: Server[] = [];
  // Custom servers first so they can take over an extension from a built-in one.
  for (const [id, c] of Object.entries(map)) {
    if (BUILTIN_SERVERS.some((s) => s.id === id) || !c || typeof c !== "object" || c.disabled) continue;
    if (!c.command?.length || !c.extensions?.length) continue;
    out.push({
      id,
      name: id,
      extensions: c.extensions.map(normExt),
      command: c.command,
      candidates: [],
      env: c.env,
      initialization: c.initialization,
      settings: c.settings,
      languageId: c.languageId,
    });
  }
  for (const spec of BUILTIN_SERVERS) {
    const c = map[spec.id];
    if (c === false || (c && typeof c === "object" && c.disabled)) continue;
    if (!(all || spec.auto || c === true || (c && typeof c === "object"))) continue;
    const o = c && typeof c === "object" ? c : {};
    out.push({
      id: spec.id,
      name: spec.name,
      extensions: (o.extensions ?? spec.extensions).map(normExt),
      command: o.command,
      candidates: spec.commands,
      env: o.env,
      initialization: o.initialization,
      settings: o.settings ?? spec.settings,
      languageId: o.languageId,
    });
  }
  return out;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Synchronous read: the snapshot must be taken before any later edit can land. */
function readTextNow(file: string): string | undefined {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const isError = (d: Diagnostic) => (d.severity ?? 1) === 1;
const keyOf = (d: Diagnostic) => `${d.code ?? ""}|${d.message}`;

/**
 * Errors the change introduced: every error whose (code, message) occurs
 * more often than before. Line numbers shift with edits, so they are not
 * part of the comparison.
 */
export function newErrors(before: Diagnostic[], after: Diagnostic[]): { added: Diagnostic[]; preexisting: number } {
  const count = (list: Diagnostic[]) => {
    const m = new Map<string, number>();
    for (const d of list) if (isError(d)) m.set(keyOf(d), (m.get(keyOf(d)) ?? 0) + 1);
    return m;
  };
  const was = count(before);
  const now = count(after);
  const grown = new Set([...now].filter(([k, n]) => n > (was.get(k) ?? 0)).map(([k]) => k));
  const errors = after.filter(isError);
  const added = errors.filter((d) => grown.has(keyOf(d)));
  return { added, preexisting: errors.length - added.length };
}

export function formatDiagnostics(rel: string, added: Diagnostic[], preexisting: number): string {
  if (!added.length) return "";
  const sorted = [...added].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  const lines = sorted.slice(0, MAX_ERRORS_PER_FILE).map((d) => {
    const origin = [d.source, d.code].filter((x) => x !== undefined && x !== "").join(" ");
    const message = oneLine(d.message.trim().replace(/\s*\n\s*/g, "; "));
    return `ERROR [${d.range.start.line + 1}:${d.range.start.character + 1}] ${message}${origin ? ` (${origin})` : ""}`;
  });
  if (sorted.length > MAX_ERRORS_PER_FILE) lines.push(`… and ${sorted.length - MAX_ERRORS_PER_FILE} more`);
  let text = `<diagnostics file="${rel}">\n${lines.join("\n")}\n</diagnostics>`;
  if (preexisting) text += `\n(${preexisting} other error${preexisting === 1 ? "" : "s"} in this file predate your changes.)`;
  return text;
}

/**
 * Runs language servers for the project and reports the errors an edit
 * introduced. Files are opened when the agent reads them, so the errors
 * already present are known and left out of later reports.
 */
export class LspManager {
  private readonly root: string;
  private readonly servers: Server[];
  private readonly clients = new Map<string, LspClient>();
  private readonly baselines = new Map<string, Promise<Diagnostic[] | undefined>>();
  /** Per-file queue: a warm-up's sync always reaches the server before an edit's. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: { root: string; config?: LspConfig }) {
    this.root = opts.root;
    this.servers = resolveServers(opts.config);
  }

  get enabled(): boolean {
    return this.servers.length > 0;
  }

  private serverFor(file: string): Server | undefined {
    const ext = path.extname(file).toLowerCase();
    return ext ? this.servers.find((s) => s.extensions.includes(ext)) : undefined;
  }

  private clientFor(file: string): LspClient | undefined {
    const server = this.serverFor(file);
    if (!server || server.missing) return undefined;
    let client = this.clients.get(server.id);
    if (!client) {
      let command = server.command;
      if (!command) {
        const found = server.candidates.find((c) => which(c[0]!));
        if (!found) {
          server.missing = true;
          return undefined;
        }
        command = found;
      }
      client = new LspClient({
        id: server.id,
        command,
        root: this.root,
        env: server.env,
        initializationOptions: server.initialization,
        settings: server.settings,
        languageId: server.languageId,
      });
      this.clients.set(server.id, client);
    }
    return client.state === "failed" || client.state === "closed" ? undefined : client;
  }

  private serial<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(file) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(file, run.catch(() => undefined));
    return run;
  }

  /** Open a file the agent is looking at, recording the errors it already has. */
  touch(file: string): void {
    if (this.baselines.has(file)) return;
    const client = this.clientFor(file);
    if (!client || client.openDocuments >= MAX_WARM_DOCUMENTS) return;
    // Capture the content now: an edit may land before the server is up.
    const text = readTextNow(file);
    if (text === undefined) return;
    const snapshot = this.serial(file, async () => {
      await withTimeout(client.start(), FIRST_TIMEOUT_MS);
      if (client.state !== "ready") return undefined;
      return client.waitForDiagnostics(file, client.sync(file, text), TIMEOUT_MS * 2);
    }).catch(() => undefined);
    this.baselines.set(file, snapshot);
  }

  /** Sync changed files and report the errors the change introduced. */
  async diagnose(files: string[]): Promise<DiagnosticsReport | undefined> {
    const parts: string[] = [];
    let errors = 0;
    for (const file of [...new Set(files)]) {
      const client = this.clientFor(file);
      if (!client) continue;
      const found = await this.serial(file, async () => {
        const baseline = (await this.baselines.get(file)) ?? [];
        if (!this.baselines.has(file)) this.baselines.set(file, Promise.resolve(baseline));
        const text = await readText(file);
        if (text === undefined) {
          client.closeDocument(file);
          return undefined;
        }
        const timeout = client.state === "ready" ? TIMEOUT_MS : FIRST_TIMEOUT_MS;
        await withTimeout(client.start(), timeout);
        if (client.state !== "ready") return undefined;
        const after = await client.waitForDiagnostics(file, client.sync(file, text), timeout);
        return after && newErrors(baseline, after);
      }).catch(() => undefined);
      if (!found) continue;
      const rel = path.relative(this.root, file).split(path.sep).join("/") || path.basename(file);
      const block = formatDiagnostics(rel, found.added, found.preexisting);
      if (block) {
        parts.push(block);
        errors += found.added.length;
      }
    }
    return { text: parts.join("\n\n"), errors };
  }

  status(): LspStatus[] {
    return this.servers.map((s) => {
      const client = this.clients.get(s.id);
      const missing = s.missing || (!client && !s.command && !s.candidates.some((c) => which(c[0]!)));
      const state: LspStatus["state"] = missing ? "not installed" : !client || client.state === "idle" ? "not started" : client.state;
      return {
        id: s.id,
        name: s.name,
        state,
        ...(s.command ? { command: s.command.join(" ") } : {}),
        ...(client?.error ? { error: client.error } : {}),
        documents: client?.openDocuments ?? 0,
      };
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
  }
}
