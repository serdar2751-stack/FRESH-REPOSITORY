import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { projectDataDir } from "../config/paths.ts";
import type { Effort, Message, TodoItem, Usage } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Mode } from "../permission/permission.ts";
import { atomicWrite } from "../util/fs.ts";
import { newId } from "../util/ids.ts";

export interface SessionMeta {
  title: string;
  model: string;
  agent: string;
  effort?: Effort;
  mode: Mode;
  /** Frozen system prompt for the current context window. */
  system: string;
  /** Index of the first message sent to the model (after compaction). */
  contextStart: number;
  todos: TodoItem[];
  usage: Usage;
  cost: number;
  /** Prompt size (tokens) of the most recent request. */
  lastContextTokens: number;
  updated: number;
}

export interface SessionHeader {
  id: string;
  created: number;
  cwd: string;
  root: string;
  parentId?: string;
  version: 1;
}

export interface RedoEntry {
  messages: Message[];
  snapshot?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: string;
  agent: string;
  messages: number;
  parentId?: string;
  cost: number;
}

type Record_ =
  | ({ t: "header" } & SessionHeader)
  | ({ t: "meta" } & Partial<SessionMeta>)
  | { t: "msg"; m: Message }
  | { t: "truncate"; n: number }
  | { t: "prune"; ids: string[] };

/** Stand-in for a cleared tool output (the original stays in the session file). */
export function prunedOutput(tool: string): string {
  return `[Output of this ${tool} call was cleared to keep the context small. Run the tool again if you need it.]`;
}

export function projectId(root: string): string {
  const base = path.basename(root).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "root";
  return `${base}-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 10)}`;
}

export class Session {
  readonly header: SessionHeader;
  meta: SessionMeta;
  messages: Message[];
  /** Undo history (in memory only). */
  redo: RedoEntry[] = [];
  /** Tool calls whose outputs are no longer sent to the model. */
  readonly pruned: Set<string>;
  private readonly file: string;
  private readonly store: SessionStore;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(store: SessionStore, header: SessionHeader, meta: SessionMeta, messages: Message[], pruned: Iterable<string> = []) {
    this.store = store;
    this.header = header;
    this.meta = meta;
    this.messages = messages;
    this.pruned = new Set(pruned);
    this.file = store.fileFor(header.id);
  }

  get id(): string {
    return this.header.id;
  }

  get isSubagent(): boolean {
    return Boolean(this.header.parentId);
  }

  /** Messages in the current context window (since the last compaction). */
  get active(): Message[] {
    return this.messages.slice(this.meta.contextStart);
  }

  /** The active messages as sent to the model: pruned tool outputs replaced. */
  context(): Message[] {
    const active = this.active;
    if (!this.pruned.size) return active;
    return active.map((m) => {
      if (m.role !== "user" || !m.parts.some((p) => p.type === "tool_result" && this.pruned.has(p.callId))) return m;
      return {
        ...m,
        parts: m.parts.map((p) => {
          if (p.type !== "tool_result" || !this.pruned.has(p.callId)) return p;
          const { images: _images, ...rest } = p;
          return { ...rest, output: prunedOutput(p.name) };
        }),
      };
    });
  }

  /** Stop sending the outputs of these tool calls to the model. */
  async prune(callIds: string[]): Promise<void> {
    const fresh = callIds.filter((id) => !this.pruned.has(id));
    if (!fresh.length) return;
    for (const id of fresh) this.pruned.add(id);
    await this.append([{ t: "prune", ids: fresh }]);
  }

  /** Last persistence error, surfaced by UIs. */
  writeError?: Error;

  private append(records: Record_[]): Promise<void> {
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    this.writeChain = this.writeChain
      .then(() => fs.appendFile(this.file, text, "utf8"))
      .catch((err: Error) => {
        this.writeError = err;
      });
    return this.writeChain;
  }

  async add(message: Message): Promise<void> {
    this.messages.push(message);
    this.meta.updated = Date.now();
    await this.append([{ t: "msg", m: message }]);
  }

  async update(patch: Partial<SessionMeta>): Promise<void> {
    Object.assign(this.meta, patch);
    this.meta.updated = Date.now();
    await this.append([{ t: "meta", ...patch, updated: this.meta.updated }]);
    if (patch.title !== undefined || patch.cost !== undefined || patch.model !== undefined) await this.store.touchIndex(this);
  }

  async addUsage(usage: Usage, cost: number | undefined, contextTokens: number): Promise<void> {
    await this.update({
      usage: addUsage(this.meta.usage, usage),
      cost: this.meta.cost + (cost ?? 0),
      lastContextTokens: contextTokens,
    });
  }

  async truncate(n: number): Promise<void> {
    this.messages.length = Math.min(n, this.messages.length);
    if (this.meta.contextStart > this.messages.length) this.meta.contextStart = this.messages.length;
    await this.append([{ t: "truncate", n: this.messages.length }]);
    await this.update({ contextStart: this.meta.contextStart });
  }

  async flush(): Promise<void> {
    await this.writeChain;
    await this.store.touchIndex(this);
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      title: this.meta.title,
      created: this.header.created,
      updated: this.meta.updated,
      model: this.meta.model,
      agent: this.meta.agent,
      messages: this.messages.length,
      parentId: this.header.parentId,
      cost: this.meta.cost,
    };
  }
}

export class SessionStore {
  readonly dir: string;
  private indexCache?: Record<string, SessionSummary>;
  private indexChain: Promise<void> = Promise.resolve();

  constructor(root: string, dataDir?: string) {
    this.dir = dataDir ?? path.join(projectDataDir(projectId(root)), "sessions");
  }

  fileFor(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return path.join(this.dir, `${id}.jsonl`);
  }

  private indexFile(): string {
    return path.join(this.dir, "index.json");
  }

  async create(init: { cwd: string; root: string; model: string; agent: string; parentId?: string; title?: string; effort?: Effort; mode?: Mode }): Promise<Session> {
    await fs.mkdir(this.dir, { recursive: true });
    const header: SessionHeader = { id: newId("ses"), created: Date.now(), cwd: init.cwd, root: init.root, version: 1, ...(init.parentId ? { parentId: init.parentId } : {}) };
    const meta: SessionMeta = {
      title: init.title ?? "",
      model: init.model,
      agent: init.agent,
      effort: init.effort,
      mode: init.mode ?? "normal",
      system: "",
      contextStart: 0,
      todos: [],
      usage: emptyUsage(),
      cost: 0,
      lastContextTokens: 0,
      updated: header.created,
    };
    const lines = [JSON.stringify({ t: "header", ...header }), JSON.stringify({ t: "meta", ...meta })].join("\n") + "\n";
    await fs.writeFile(this.fileFor(header.id), lines, "utf8");
    const s = new Session(this, header, meta, []);
    await this.touchIndex(s);
    return s;
  }

  async load(id: string): Promise<Session> {
    const file = this.fileFor(id);
    let header: SessionHeader | undefined;
    const meta: Partial<SessionMeta> = {};
    const messages: Message[] = [];
    const pruned: string[] = [];
    const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: Record_;
      try {
        rec = JSON.parse(line) as Record_;
      } catch {
        continue; // torn write at the end of the file
      }
      if (rec.t === "header") {
        const { t: _t, ...h } = rec;
        header = h as SessionHeader;
      } else if (rec.t === "meta") {
        const { t: _t, ...m } = rec;
        Object.assign(meta, m);
      } else if (rec.t === "msg") messages.push(rec.m);
      else if (rec.t === "truncate") messages.length = Math.min(rec.n, messages.length);
      else if (rec.t === "prune") pruned.push(...rec.ids);
    }
    if (!header) throw new Error(`Session ${id} is corrupt (no header).`);
    const full: SessionMeta = {
      title: "",
      model: "",
      agent: "build",
      mode: "normal",
      system: "",
      contextStart: 0,
      todos: [],
      usage: emptyUsage(),
      cost: 0,
      lastContextTokens: 0,
      updated: header.created,
      ...meta,
    };
    if (full.contextStart > messages.length) full.contextStart = messages.length;
    return new Session(this, header, full, messages, pruned);
  }

  async exists(id: string): Promise<boolean> {
    try {
      await fs.access(this.fileFor(id));
      return true;
    } catch {
      return false;
    }
  }

  private async readIndex(): Promise<Record<string, SessionSummary>> {
    if (this.indexCache) return this.indexCache;
    try {
      this.indexCache = JSON.parse(await fs.readFile(this.indexFile(), "utf8")) as Record<string, SessionSummary>;
    } catch {
      this.indexCache = {};
    }
    return this.indexCache;
  }

  touchIndex(s: Session): Promise<void> {
    this.indexChain = this.indexChain
      .then(async () => {
        const idx = await this.readIndex();
        idx[s.id] = s.summary();
        await atomicWrite(this.indexFile(), JSON.stringify(idx));
      })
      .catch(() => {});
    return this.indexChain;
  }

  /** Sessions, newest first. Sub-agent sessions are hidden unless requested. */
  async list(opts: { includeSubagents?: boolean } = {}): Promise<SessionSummary[]> {
    await this.indexChain;
    const idx = await this.readIndex();
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const f of files) {
      const id = f.slice(0, -6);
      let s = idx[id];
      if (!s) {
        try {
          const loaded = await this.load(id);
          s = loaded.summary();
          idx[id] = s;
        } catch {
          continue;
        }
      }
      if (!opts.includeSubagents && s.parentId) continue;
      out.push(s);
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async latest(): Promise<SessionSummary | undefined> {
    return (await this.list())[0];
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true });
    const idx = await this.readIndex();
    delete idx[id];
    await atomicWrite(this.indexFile(), JSON.stringify(idx));
  }
}
