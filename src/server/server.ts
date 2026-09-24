import http from "node:http";
import type { AddressInfo } from "node:net";
import { expandMentions } from "../agent/mentions.ts";
import type { AgentEvent } from "../core/events.ts";
import { EFFORT_LEVELS, type Effort, type ImagePart } from "../core/types.ts";
import type { Mode, PermissionDecision } from "../permission/permission.ts";
import { catalogModels } from "../provider/catalog.ts";
import { PRESETS, parseModelRef } from "../provider/registry.ts";
import { Runtime } from "../runtime.ts";
import type { Session } from "../session/session.ts";
import { randomToken } from "../util/ids.ts";
import { VERSION } from "../version.ts";
import { WEB_UI } from "./webui.ts";

export interface ServerOptions {
  cwd: string;
  port: number;
  host: string;
  token?: string;
  noAuth?: boolean;
  model?: string;
  yolo?: boolean;
  trusted?: boolean;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_BODY = 20 * 1024 * 1024;

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object");
    return v as Record<string, unknown>;
  } catch (err) {
    throw new HttpError(400, `invalid JSON: ${(err as Error).message}`);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

export interface ServerHandle {
  url: string;
  token?: string;
  server: http.Server;
  runtime: Runtime;
  close(): Promise<void>;
}

/** Start the API server (used by `usta serve` and tests). */
export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const rt = await Runtime.create({ cwd: opts.cwd, model: opts.model, yolo: opts.yolo, trusted: opts.trusted, interactive: false });
  const token = opts.noAuth ? undefined : (opts.token ?? randomToken());
  const loopbackBind = LOOPBACK.has(opts.host);
  if (!loopbackBind && !token) throw new Error("Refusing to serve on a non-loopback address without a token.");

  const sessions = new Map<string, Session>();
  const running = new Map<string, AbortController>();
  const clients = new Set<{ res: http.ServerResponse; session?: string }>();
  // Child session -> root session, so sub-agent events reach the right stream.
  const parents = new Map<string, string>();

  const syncInteractive = () => {
    rt.interactive = clients.size > 0;
  };

  rt.bus.on((e: AgentEvent) => {
    if (e.type === "subagent.start") parents.set(e.sessionId, e.parentSessionId);
    const sid = "sessionId" in e ? e.sessionId : e.type === "permission.request" ? e.request.sessionId : undefined;
    let root = sid;
    for (let i = 0; root && parents.has(root) && i < 5; i++) root = parents.get(root);
    const data = `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) {
      if (c.session && sid && c.session !== sid && c.session !== root) continue;
      c.res.write(data);
    }
  });

  const getSession = async (id: string): Promise<Session> => {
    let s = sessions.get(id);
    if (!s) {
      if (!(await rt.store.exists(id))) throw new HttpError(404, `no session ${id}`);
      s = await rt.loadSession(id);
      sessions.set(id, s);
    }
    return s;
  };

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // DNS-rebinding defense: a page on another origin must not reach us by name.
    if (loopbackBind) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!LOOPBACK.has(host)) throw new HttpError(403, "forbidden host");
    }
    const origin = req.headers.origin;
    if (origin) {
      const o = new URL(origin);
      if (loopbackBind && !LOOPBACK.has(o.hostname)) throw new HttpError(403, "forbidden origin");
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        "x-frame-options": "DENY",
      });
      res.end(WEB_UI);
      return;
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "not found");
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, version: VERSION });
    if (!authorized(req, url)) throw new HttpError(401, "missing or invalid token");

    const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
    const [resource, id, action] = parts;
    const method = req.method ?? "GET";

    if (resource === "info" && method === "GET") {
      return send(res, 200, {
        version: VERSION,
        cwd: rt.cwd,
        root: rt.root,
        trusted: rt.trusted,
        model: rt.config.model ?? rt.registry.defaultModelRef() ?? null,
        agents: rt.agents.map((a) => ({ name: a.name, description: a.description, mode: a.mode })),
        commands: rt.commands.map((c) => ({ name: c.name, description: c.description })),
        modes: ["normal", "auto-edit", "plan"],
        yolo: rt.permissions.yolo,
      });
    }
    if (resource === "models" && method === "GET") {
      const out: Array<{ id: string; name?: string; provider: string }> = [];
      for (const p of rt.registry.providerIds()) {
        if (!rt.registry.hasCredentials(p)) continue;
        const fam = PRESETS[p]?.catalog;
        for (const m of fam ? catalogModels(fam) : []) out.push({ id: `${p}/${m.id}`, name: m.name, provider: p });
        for (const m of Object.keys(rt.registry.providerConfig(p).models ?? {})) out.push({ id: `${p}/${m}`, provider: p });
      }
      return send(res, 200, { models: out });
    }
    if (resource === "events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
      const client = { res, session: url.searchParams.get("session") ?? undefined };
      clients.add(client);
      syncInteractive();
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(client);
        syncInteractive();
        if (!clients.size) rt.denyPending("The client disconnected.");
      });
      return;
    }
    if (resource === "permissions" && id && method === "POST") {
      const body = await readBody(req);
      const decision = String(body.decision ?? "") as PermissionDecision;
      if (!["once", "session", "always", "deny"].includes(decision)) throw new HttpError(400, "decision must be once|session|always|deny");
      const ok = rt.replyPermission(id, { decision, feedback: typeof body.feedback === "string" ? body.feedback : undefined });
      return send(res, ok ? 200 : 404, { ok });
    }
    if (resource === "questions" && id && method === "POST") {
      const body = await readBody(req);
      const ok = rt.engine.answerQuestion(id, String(body.answer ?? ""));
      return send(res, ok ? 200 : 404, { ok });
    }
    if (resource === "plans" && id && method === "POST") {
      const body = await readBody(req);
      const mode = body.mode === "auto-edit" ? "auto-edit" : "normal";
      const ok = rt.engine.resolvePlan(id, { approved: Boolean(body.approved), feedback: typeof body.feedback === "string" ? body.feedback : undefined, mode });
      return send(res, ok ? 200 : 404, { ok });
    }
    if (resource !== "sessions") throw new HttpError(404, "not found");

    if (!id) {
      if (method === "GET") return send(res, 200, { sessions: await rt.store.list() });
      if (method === "POST") {
        const body = await readBody(req);
        const model = typeof body.model === "string" ? body.model : undefined;
        if (model) parseModelRef(model);
        const s = await rt.newSession({ model, agent: typeof body.agent === "string" ? body.agent : undefined });
        if (body.mode === "plan" || body.mode === "auto-edit") await rt.engine.setMode(s, body.mode as Mode);
        sessions.set(s.id, s);
        return send(res, 201, { session: { ...s.summary(), meta: s.meta } });
      }
      throw new HttpError(405, "method not allowed");
    }

    const s = await getSession(id);
    if (!action) {
      if (method === "GET") return send(res, 200, { header: s.header, meta: { ...s.meta, system: undefined }, messages: s.messages, running: running.has(s.id) });
      if (method === "DELETE") {
        if (running.has(s.id)) throw new HttpError(409, "session is running");
        await rt.store.delete(s.id);
        sessions.delete(s.id);
        return send(res, 200, { ok: true });
      }
      if (method === "PATCH") {
        const body = await readBody(req);
        if (typeof body.title === "string") await s.update({ title: body.title });
        if (typeof body.model === "string") {
          parseModelRef(body.model);
          await s.update({ model: body.model });
        }
        if (typeof body.agent === "string") await rt.engine.setAgent(s, body.agent);
        if (body.mode === "normal" || body.mode === "auto-edit" || body.mode === "plan") await rt.engine.setMode(s, body.mode);
        if (typeof body.effort === "string") {
          if (!EFFORT_LEVELS.includes(body.effort as Effort)) throw new HttpError(400, "invalid effort");
          await s.update({ effort: body.effort as Effort });
        }
        return send(res, 200, { meta: { ...s.meta, system: undefined } });
      }
      throw new HttpError(405, "method not allowed");
    }
    if (method !== "POST") throw new HttpError(405, "method not allowed");
    switch (action) {
      case "prompt": {
        const body = await readBody(req);
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) throw new HttpError(400, "text is required");
        if (running.has(s.id)) throw new HttpError(409, "a turn is already running in this session");
        const images: ImagePart[] = Array.isArray(body.images)
          ? (body.images as Array<{ mediaType?: string; data?: string; name?: string }>)
              .filter((i) => typeof i.data === "string" && typeof i.mediaType === "string")
              .map((i) => ({ type: "image", mediaType: i.mediaType!, data: i.data!, name: i.name }))
          : [];
        const att = await expandMentions(text, rt.cwd).catch(() => ({ context: [] as string[], images: [] as ImagePart[] }));
        const controller = new AbortController();
        running.set(s.id, controller);
        const done = rt.engine
          .prompt(s, { text, images: [...images, ...att.images], context: att.context }, { signal: controller.signal })
          .catch((err: Error) => ({ reason: "error", error: err.message }))
          .finally(() => running.delete(s.id));
        if (body.wait) {
          const result = await done;
          return send(res, 200, { result });
        }
        return send(res, 202, { accepted: true });
      }
      case "abort": {
        const c = running.get(s.id);
        c?.abort();
        rt.denyPending("The turn was aborted.");
        return send(res, 200, { ok: Boolean(c) });
      }
      case "undo":
      case "redo": {
        if (running.has(s.id)) throw new HttpError(409, "session is running");
        const r = action === "undo" ? await rt.engine.undo(s) : await rt.engine.redo(s);
        return send(res, 200, { result: r ?? null });
      }
      case "compact": {
        if (running.has(s.id)) throw new HttpError(409, "session is running");
        const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
        const summary = await rt.engine.compact(s, { signal: new AbortController().signal, instructions: typeof body.instructions === "string" ? body.instructions : undefined });
        return send(res, 200, { summary });
      }
      default:
        throw new HttpError(404, "not found");
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err: Error) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const hostForUrl = opts.host === "0.0.0.0" || opts.host === "::" ? "localhost" : opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  const url = `http://${hostForUrl}:${port}`;
  return {
    url,
    token,
    server,
    runtime: rt,
    async close() {
      for (const c of running.values()) c.abort();
      for (const c of clients) c.res.end();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await rt.close();
    },
  };
}

export async function runServer(opts: ServerOptions): Promise<number> {
  let handle: ServerHandle;
  try {
    handle = await startServer(opts);
  } catch (err) {
    process.stderr.write(`usta serve: ${(err as Error).message}\n`);
    return 1;
  }
  const open = handle.token ? `${handle.url}/?token=${handle.token}` : handle.url;
  process.stdout.write(`usta ${VERSION} serving ${handle.runtime.root}\n`);
  process.stdout.write(`  web UI : ${open}\n`);
  process.stdout.write(`  API    : ${handle.url}/api  (${handle.token ? `Authorization: Bearer ${handle.token}` : "no auth"})\n`);
  process.stdout.write(`  model  : ${handle.runtime.config.model ?? handle.runtime.registry.defaultModelRef() ?? "(none configured)"}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await handle.close();
  return 0;
}
