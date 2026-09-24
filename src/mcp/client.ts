import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "../config/config.ts";
import { resolveSecret } from "../config/config.ts";
import type { ImagePart } from "../core/types.ts";
import type { Tool, ToolResult } from "../tool/types.ts";
import { ToolError } from "../tool/types.ts";
import type { JSONSchema } from "../util/schema.ts";
import { killTree } from "../util/shell.ts";
import { VERSION } from "../version.ts";

const PROTOCOL_VERSION = "2025-11-25";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

interface Transport {
  send(msg: JsonRpcMessage): Promise<void>;
  onMessage: (msg: JsonRpcMessage) => void;
  onClose: (reason: string) => void;
  close(): Promise<void>;
}

class StdioTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private readonly child: ChildProcess;
  private buffer = "";
  stderr = "";

  constructor(cfg: McpServerConfig, cwd: string) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = resolveSecret(v) ?? "";
    this.child = spawn(cfg.command!, cfg.args ?? [], {
      cwd: cfg.cwd ?? cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // servers sometimes log to stdout; ignore non-JSON lines
        }
      }
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-4000);
    });
    this.child.on("error", (err) => this.onClose(err.message));
    this.child.on("close", (code) => this.onClose(`process exited with code ${code}${this.stderr ? `: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`));
    this.child.stdin?.on("error", () => {});
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.child.stdin?.writable) throw new Error("MCP server stdin is closed");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    killTree(this.child, "SIGTERM");
  }
}

class HttpTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private sessionId?: string;
  protocolVersion?: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(cfg: McpServerConfig) {
    this.url = cfg.url!;
    this.headers = {};
    for (const [k, v] of Object.entries(cfg.headers ?? {})) this.headers[k] = resolveSecret(v) ?? "";
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(msg) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (msg.id !== undefined) this.onMessage({ jsonrpc: "2.0", id: msg.id, error: { code: res.status, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } });
      return;
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream") && res.body) {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let idx: number;
        while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
          const data = raw
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[];
            for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(m);
          } catch {
            // ignore malformed event
          }
        }
      }
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(m);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.url, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...this.headers } }).catch(() => {});
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export class McpClient {
  readonly name: string;
  private readonly cfg: McpServerConfig;
  private readonly cwd: string;
  private transport?: Transport;
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  closedReason?: string;

  constructor(name: string, cfg: McpServerConfig, cwd: string) {
    this.name = name;
    this.cfg = cfg;
    this.cwd = cwd;
  }

  async connect(timeoutMs = 30_000): Promise<void> {
    const type = this.cfg.type ?? (this.cfg.url ? "http" : "stdio");
    if (type === "stdio" && !this.cfg.command) throw new Error("stdio MCP server needs a command");
    if (type === "http" && !this.cfg.url) throw new Error("http MCP server needs a url");
    const t: Transport = type === "http" ? new HttpTransport(this.cfg) : new StdioTransport(this.cfg, this.cwd);
    t.onMessage = (m) => this.handle(m);
    t.onClose = (reason) => {
      this.closedReason = reason;
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" closed: ${reason}`));
      this.pending.clear();
    };
    this.transport = t;
    const init = (await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: "usta", version: VERSION } },
      { timeoutMs },
    )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string };
    this.serverInfo = init.serverInfo;
    this.instructions = init.instructions;
    if (t instanceof HttpTransport) t.protocolVersion = init.protocolVersion ?? PROTOCOL_VERSION;
    await this.notify("notifications/initialized");
  }

  private handle(m: JsonRpcMessage): void {
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined) && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message} (code ${m.error.code})`));
      else p.resolve(m.result);
      return;
    }
    if (m.method && m.id !== undefined) {
      // Server -> client requests.
      let result: unknown;
      if (m.method === "ping") result = {};
      else if (m.method === "roots/list") result = { roots: [{ uri: pathToFileURL(this.cwd).href, name: "project" }] };
      if (result !== undefined) void this.transport?.send({ jsonrpc: "2.0", id: m.id, result }).catch(() => {});
      else void this.transport?.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not supported: ${m.method}` } }).catch(() => {});
    }
  }

  request(method: string, params?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const t = this.transport;
    if (!t) return Promise.reject(new Error("not connected"));
    if (this.closedReason) return Promise.reject(new Error(`MCP server "${this.name}" is not running: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = opts.timeoutMs ?? this.cfg.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        void this.notify("notifications/cancelled", { requestId: id, reason: "aborted" }).catch(() => {});
        reject(new Error("aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      t.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }).catch((err: Error) => {
        this.pending.get(id)?.reject(err);
        this.pending.delete(id);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.transport?.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      out.push(...(res.tools ?? []));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const res = (await this.request("tools/call", { name, arguments: args ?? {} }, { signal })) as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
      structuredContent?: unknown;
    };
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const c of res.content ?? []) {
      switch (c.type) {
        case "text":
          texts.push(String(c.text ?? ""));
          break;
        case "image":
          if (typeof c.data === "string") images.push({ type: "image", mediaType: String(c.mimeType ?? "image/png"), data: c.data });
          break;
        case "resource": {
          const r = c.resource as Record<string, unknown> | undefined;
          texts.push(typeof r?.text === "string" ? r.text : `[resource ${String(r?.uri ?? "")}]`);
          break;
        }
        case "resource_link":
          texts.push(`[resource link: ${String(c.name ?? "")} ${String(c.uri ?? "")}]`);
          break;
        default:
          texts.push(`[${String(c.type)} content omitted]`);
      }
    }
    if (!texts.length && res.structuredContent !== undefined) texts.push(JSON.stringify(res.structuredContent, null, 2));
    return { output: texts.join("\n") || "(no output)", images: images.length ? images : undefined, isError: res.isError };
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
  }
}

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
  tools: number;
  error?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Connects the configured MCP servers and exposes their tools. */
export class McpManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolList: Tool[] = [];
  readonly statuses = new Map<string, McpServerStatus>();
  private readonly servers: Record<string, McpServerConfig>;
  private readonly cwd: string;

  constructor(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
    this.servers = servers ?? {};
    this.cwd = cwd;
  }

  async start(): Promise<void> {
    await Promise.all(
      Object.entries(this.servers).map(async ([name, cfg]) => {
        if (cfg.disabled) {
          this.statuses.set(name, { name, status: "disabled", tools: 0 });
          return;
        }
        this.statuses.set(name, { name, status: "connecting", tools: 0 });
        const client = new McpClient(name, cfg, this.cwd);
        try {
          await client.connect();
          const tools = await client.listTools();
          this.clients.set(name, client);
          for (const t of tools) this.toolList.push(this.wrap(name, client, t));
          this.statuses.set(name, { name, status: "connected", tools: tools.length });
        } catch (err) {
          await client.close();
          this.statuses.set(name, { name, status: "failed", tools: 0, error: (err as Error).message });
        }
      }),
    );
    // Deterministic order keeps the tool list (and the prompt cache) stable.
    this.toolList.sort((a, b) => a.name.localeCompare(b.name));
  }

  private wrap(server: string, client: McpClient, info: McpToolInfo): Tool {
    const name = `mcp__${sanitize(server)}__${sanitize(info.name)}`.slice(0, 64);
    const schema: JSONSchema = info.inputSchema && typeof info.inputSchema === "object" ? { ...info.inputSchema } : { type: "object", properties: {} };
    if (!schema.type) schema.type = "object";
    return {
      name,
      description: `${info.description ?? info.annotations?.title ?? info.name} (MCP server "${server}")`.slice(0, 4000),
      parameters: schema,
      readOnly: info.annotations?.readOnlyHint === true,
      title: () => `${server}: ${info.name}`,
      async execute(input, ctx) {
        await ctx.permit({ permission: name, patterns: ["*"], always: ["*"], title: `MCP ${server}: ${info.name}`, detail: { preview: JSON.stringify(input, null, 2).slice(0, 2000) } });
        try {
          return await client.callTool(info.name, input, ctx.signal);
        } catch (err) {
          throw new ToolError(`MCP tool failed: ${(err as Error).message}`);
        }
      },
    };
  }

  tools(): Tool[] {
    return this.toolList;
  }

  instructions(): string {
    return [...this.clients.values()]
      .filter((c) => c.instructions)
      .map((c) => `## MCP server "${c.name}"\n${c.instructions}`)
      .join("\n\n");
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
