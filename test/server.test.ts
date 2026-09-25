import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type ServerHandle, startServer } from "../src/server/server.ts";
import { tempDir } from "./helpers/context.ts";
import { MockLLM } from "./helpers/mock-llm.ts";

const mock = new MockLLM();
let srv: ServerHandle;
let dir = "";

function request(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const url = new URL(p, srv.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(srv.token ? { authorization: `Bearer ${srv.token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : undefined }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Collect SSE events from /api/events until `until` returns true. */
function events(session: string, until: (e: any) => boolean, onEvent?: (e: any) => void): { done: Promise<any[]>; close: () => void } {
  const seen: any[] = [];
  let req: http.ClientRequest;
  const done = new Promise<any[]>((resolve, reject) => {
    req = http.get(new URL(`/api/events?session=${session}&token=${srv.token}`, srv.url), (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!data) continue;
          const e = JSON.parse(data.slice(6));
          seen.push(e);
          onEvent?.(e);
          if (until(e)) {
            req.destroy();
            resolve(seen);
          }
        }
      });
    });
    req.on("error", (err) => (seen.length ? resolve(seen) : reject(err)));
  });
  return { done, close: () => req.destroy() };
}

before(async () => {
  const url = await mock.start();
  process.env.USTA_DATA_DIR = await tempDir("usta-data-");
  process.env.USTA_CONFIG_DIR = await tempDir("usta-config-");
  await fs.writeFile(
    path.join(process.env.USTA_CONFIG_DIR, "config.json"),
    JSON.stringify({ model: "anthropic/claude-opus-5", providers: { anthropic: { apiKey: "k", baseURL: url } } }),
  );
  dir = await tempDir("usta-srv-");
  srv = await startServer({ cwd: dir, port: 0, host: "127.0.0.1" });
});
after(async () => {
  await srv.close();
  await mock.stop();
});

describe("server", () => {
  it("serves the web UI and protects the API", async () => {
    const { page, csp } = await new Promise<{ page: string; csp: string }>((resolve) =>
      http.get(srv.url + "/", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ page: d, csp: String(res.headers["content-security-policy"]) }));
      }),
    );
    assert.match(page, /<title>usta<\/title>/);
    // Only the page's own script (carrying this response's nonce) may run.
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && page.includes(`<script nonce="${nonce}">`));
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    const noAuth = await request("GET", "/api/sessions", undefined, { authorization: "Bearer wrong" });
    assert.equal(noAuth.status, 401);
    const shortToken = await request("GET", "/api/sessions", undefined, { authorization: "Bearer x" });
    assert.equal(shortToken.status, 401);
    const nullOrigin = await request("GET", "/api/health", undefined, { origin: "null" });
    assert.equal(nullOrigin.status, 403);
    const badHost = await request("GET", "/api/health", undefined, { host: "evil.example.com" });
    assert.equal(badHost.status, 403);
    const health = await request("GET", "/api/health");
    assert.equal(health.json.ok, true);
  });

  it("creates sessions and runs a prompt to completion", async () => {
    mock.push({ blocks: [{ type: "text", text: "Hi from the API." }] });
    const created = await request("POST", "/api/sessions", {});
    assert.equal(created.status, 201);
    const id = created.json.session.id;
    const res = await request("POST", `/api/sessions/${id}/prompt`, { text: "hello", wait: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.result.text, "Hi from the API.");
    const got = await request("GET", `/api/sessions/${id}`);
    assert.equal(got.json.messages.length, 2);
    const list = await request("GET", "/api/sessions");
    assert.ok(list.json.sessions.some((s: { id: string }) => s.id === id));
    const patched = await request("PATCH", `/api/sessions/${id}`, { mode: "plan", title: "Renamed" });
    assert.equal(patched.json.meta.mode, "plan");
    assert.equal(patched.json.meta.title, "Renamed");
  });

  it("streams events and takes permission replies over HTTP", async () => {
    mock.push({ blocks: [{ type: "tool_use", name: "bash", input: { command: "touch from-api.txt" } }] }, { blocks: [{ type: "text", text: "Created." }] });
    const created = await request("POST", "/api/sessions", {});
    const id = created.json.session.id;
    const stream = events(
      id,
      (e) => e.type === "turn.end",
      (e) => {
        if (e.type === "permission.request") void request("POST", `/api/permissions/${e.request.id}`, { decision: "once" });
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    const accepted = await request("POST", `/api/sessions/${id}/prompt`, { text: "create the file" });
    assert.equal(accepted.status, 202);
    const seen = await stream.done;
    const types = seen.map((e) => e.type);
    assert.ok(types.includes("permission.request"));
    assert.ok(types.includes("tool.end"));
    assert.equal(seen.at(-1).reason, "done");
    await fs.access(path.join(dir, "from-api.txt"));
  });

  it("exports a session as HTML or Markdown", async () => {
    const created = await request("POST", "/api/sessions", {});
    const id = created.json.session.id as string;
    await request("POST", `/api/sessions/${id}/prompt`, { text: "export me <b>now</b>", wait: true });
    const get = (q: string) =>
      new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        http
          .get(new URL(`/api/sessions/${id}/export${q}`, srv.url), { headers: { authorization: `Bearer ${srv.token}` } }, (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body: d }));
          })
          .on("error", reject);
      });
    const html = await get("?format=html");
    assert.equal(html.status, 200);
    assert.match(html.type, /text\/html/);
    assert.match(html.body, /^<!doctype html>/);
    assert.match(html.body, /export me &lt;b&gt;now&lt;\/b&gt;/);
    assert.doesNotMatch(html.body, /<script/i);
    const md = await get("?format=md");
    assert.match(md.type, /text\/markdown/);
    assert.match(md.body, /## User\n\nexport me <b>now<\/b>/);
  });

  it("rejects bad input", async () => {
    const bad = await request("POST", "/api/sessions/ses_nope/prompt", { text: "x" });
    assert.equal(bad.status, 404);
    const created = await request("POST", "/api/sessions", {});
    const empty = await request("POST", `/api/sessions/${created.json.session.id}/prompt`, { text: "" });
    assert.equal(empty.status, 400);
    const wrongType = await new Promise<number>((resolve) => {
      const req = http.request(new URL(`/api/sessions/${created.json.session.id}/prompt`, srv.url), { method: "POST", headers: { authorization: `Bearer ${srv.token}`, "content-type": "text/plain" } }, (res) => resolve(res.statusCode ?? 0));
      req.end("text=hi");
    });
    assert.equal(wrongType, 415);
  });
});
