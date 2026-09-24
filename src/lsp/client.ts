import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killTree } from "../util/shell.ts";
import { VERSION } from "../version.ts";

/** LSP diagnostic (positions are 0-based). */
export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface Message {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LspClientOptions {
  id: string;
  command: string[];
  root: string;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  /** Answers to workspace/configuration requests, looked up by section. */
  settings?: Record<string, unknown>;
  /** Language id sent on didOpen (default: from the file extension). */
  languageId?: string;
}

const LANGUAGE_IDS: Record<string, string> = {
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".swift": "swift",
  ".lua": "lua",
  ".zig": "zig",
};

export function languageIdFor(file: string): string {
  return LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? "plaintext";
}

function section(settings: Record<string, unknown>, name: string): unknown {
  let cur: unknown = settings;
  for (const part of name.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}

interface Published {
  version?: number;
  items: Diagnostic[];
  seq: number;
}

/**
 * Minimal Language Server Protocol client: starts a server over stdio,
 * keeps documents in sync (full text) and collects published diagnostics.
 */
export class LspClient {
  readonly id: string;
  state: "idle" | "starting" | "ready" | "failed" | "closed" = "idle";
  error?: string;
  private readonly opts: LspClientOptions;
  private child?: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly docs = new Map<string, number>();
  private readonly published = new Map<string, Published>();
  private readonly listeners = new Set<(file: string) => void>();
  private publishSeq = 0;
  private started?: Promise<void>;
  private capabilities: Record<string, unknown> = {};
  private stderr = "";

  constructor(opts: LspClientOptions) {
    this.id = opts.id;
    this.opts = opts;
  }

  get openDocuments(): number {
    return this.docs.size;
  }

  start(): Promise<void> {
    this.started ??= this.launch().catch((err: Error) => {
      this.state = "failed";
      this.error = err.message;
      this.kill();
      throw err;
    });
    return this.started;
  }

  private async launch(): Promise<void> {
    this.state = "starting";
    const [cmd, ...args] = this.opts.command;
    if (!cmd) throw new Error("no command");
    const child = spawn(cmd, args, {
      cwd: this.opts.root,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (b: Buffer) => this.onData(b));
    child.stderr?.on("data", (b: Buffer) => {
      this.stderr = (this.stderr + b.toString("utf8")).slice(-4000);
    });
    child.stdin?.on("error", () => {});
    const exited = new Promise<never>((_, reject) => {
      child.on("error", (err) => {
        this.onExit(err.message);
        reject(err);
      });
      child.on("exit", (code, signal) => {
        const why = `exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-2).join(" | ")}` : ""}`;
        this.onExit(why);
        reject(new Error(why));
      });
    });
    exited.catch(() => {});
    const rootUri = pathToFileURL(this.opts.root).href;
    const init = this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "usta", version: VERSION },
        rootUri,
        rootPath: this.opts.root,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.opts.root) }],
        initializationOptions: this.opts.initializationOptions ?? {},
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] } },
          },
          workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
          window: { workDoneProgress: true },
          general: { positionEncodings: ["utf-16"] },
        },
      },
      60_000,
    );
    const res = (await Promise.race([init, exited])) as { capabilities?: Record<string, unknown> } | null;
    this.capabilities = res?.capabilities ?? {};
    this.notify("initialized", {});
    if (this.opts.settings) this.notify("workspace/didChangeConfiguration", { settings: this.opts.settings });
    this.state = "ready";
  }

  private onExit(reason: string): void {
    if (this.state !== "closed") {
      this.state = "failed";
      this.error ??= reason;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`language server ${reason}`));
    }
    this.pending.clear();
  }

  private write(msg: Message): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    stdin.write(body);
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Not a message header (stray log output): skip it.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number(m[1]);
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(start, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      try {
        this.dispatch(JSON.parse(body) as Message);
      } catch {
        // malformed message
      }
    }
  }

  private dispatch(msg: Message): void {
    if (msg.method) {
      if (msg.id !== undefined && msg.id !== null) this.onRequest(msg);
      else this.onNotification(msg);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  /** Requests from the server: answer the ones servers wait on, refuse the rest. */
  private onRequest(msg: Message): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    let result: unknown = null;
    switch (msg.method) {
      case "workspace/configuration": {
        const items = (params.items as Array<{ section?: string }> | undefined) ?? [];
        result = items.map((i) => (i.section && this.opts.settings ? section(this.opts.settings, i.section) : null));
        break;
      }
      case "workspace/workspaceFolders":
        result = [{ uri: pathToFileURL(this.opts.root).href, name: path.basename(this.opts.root) }];
        break;
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
        result = null;
        break;
      case "workspace/applyEdit":
        result = { applied: false, failureReason: "usta does not apply server edits" };
        break;
      default:
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Unsupported request ${msg.method}` } });
        return;
    }
    this.write({ jsonrpc: "2.0", id: msg.id, result });
  }

  private onNotification(msg: Message): void {
    if (msg.method !== "textDocument/publishDiagnostics") return;
    const p = msg.params as { uri: string; version?: number | null; diagnostics?: Diagnostic[] };
    let file: string;
    try {
      file = path.resolve(fileURLToPath(p.uri));
    } catch {
      return;
    }
    this.published.set(file, { version: typeof p.version === "number" ? p.version : undefined, items: p.diagnostics ?? [], seq: ++this.publishSeq });
    for (const fn of [...this.listeners]) fn(file);
  }

  private get wantsSave(): boolean {
    const sync = this.capabilities.textDocumentSync;
    return Boolean(sync && typeof sync === "object" && (sync as { save?: unknown }).save);
  }

  /**
   * Send the file's current text (didOpen the first time, then didChange).
   * Returns a marker to pass to waitForDiagnostics.
   */
  sync(file: string, text: string): { version: number; seq: number } {
    const uri = pathToFileURL(file).href;
    const seq = this.publishSeq;
    const prev = this.docs.get(file);
    if (prev === undefined) {
      this.docs.set(file, 1);
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.opts.languageId ?? languageIdFor(file), version: 1, text } });
      return { version: 1, seq };
    }
    const version = prev + 1;
    this.docs.set(file, version);
    this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    if (this.wantsSave) this.notify("textDocument/didSave", { textDocument: { uri } });
    return { version, seq };
  }

  closeDocument(file: string): void {
    if (!this.docs.delete(file)) return;
    this.published.delete(file);
    this.notify("textDocument/didClose", { textDocument: { uri: pathToFileURL(file).href } });
  }

  /**
   * Diagnostics published for the synced content: waits for a publish newer
   * than `marker` (matching its version when the server reports versions),
   * then lets staged publishes settle. Undefined on timeout.
   */
  async waitForDiagnostics(file: string, marker: { version: number; seq: number }, timeoutMs: number, settleMs = 300): Promise<Diagnostic[] | undefined> {
    const deadline = Date.now() + timeoutMs;
    const fresh = (after: number) => {
      const p = this.published.get(file);
      if (!p || p.seq <= after) return undefined;
      if (p.version !== undefined && p.version < marker.version) return undefined;
      return p;
    };
    let got = await this.waitFor(file, () => fresh(marker.seq), deadline);
    if (!got) return undefined;
    for (;;) {
      const seq: number = got.seq;
      const next: Published | undefined = await this.waitFor(file, () => fresh(seq), Math.min(deadline, Date.now() + settleMs));
      if (!next) break;
      got = next;
    }
    return got.items;
  }

  private waitFor(file: string, check: () => Published | undefined, deadline: number): Promise<Published | undefined> {
    const now = check();
    if (now || this.state === "failed" || this.state === "closed") return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (v: Published | undefined) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(v);
      };
      const listener = (f: string) => {
        if (f !== file) return;
        const v = check();
        if (v) done(v);
      };
      const timer = setTimeout(() => done(undefined), Math.max(0, deadline - Date.now()));
      this.listeners.add(listener);
    });
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    const wasReady = this.state === "ready";
    this.state = "closed";
    if (wasReady) {
      try {
        await this.request("shutdown", null, 1500);
        this.notify("exit", null);
      } catch {
        // unresponsive: killed below
      }
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.kill();
          resolve();
        }, 500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private kill(): void {
    if (this.child) killTree(this.child, "SIGKILL");
  }
}
