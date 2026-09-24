import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { McpManager } from "../src/mcp/client.ts";
import { makeContext, tempDir } from "./helpers/context.ts";

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "mcp-server.mjs");

describe("mcp", () => {
  it("connects over stdio, lists paginated tools and calls them", async () => {
    const dir = await tempDir();
    const mgr = new McpManager({ test: { command: process.execPath, args: [server] }, off: { command: "nope", disabled: true }, broken: { command: "/nonexistent/binary" } }, dir);
    await mgr.start();
    try {
      const names = mgr.tools().map((t) => t.name);
      assert.deepEqual(names, ["mcp__test__echo", "mcp__test__fail"]);
      assert.equal(mgr.statuses.get("test")?.status, "connected");
      assert.equal(mgr.statuses.get("off")?.status, "disabled");
      assert.equal(mgr.statuses.get("broken")?.status, "failed");
      assert.match(mgr.instructions(), /Use echo/);
      const echo = mgr.tools()[0]!;
      assert.equal(echo.readOnly, true);
      const ctx = makeContext(dir);
      const r = await echo.execute({ text: "hello" }, ctx);
      assert.equal(r.output, "echo: hello");
      assert.equal(ctx.permits[0]!.permission, "mcp__test__echo");
      const f = await mgr.tools()[1]!.execute({}, ctx);
      assert.equal(f.isError, true);
    } finally {
      await mgr.close();
    }
  });
});

describe("mcp over http", () => {
  it("speaks streamable HTTP with JSON and SSE responses", async () => {
    const http = await import("node:http");
    const seen: Array<{ method: string; session?: string; version?: string }> = [];
    const srv = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ method: msg.method, session: req.headers["mcp-session-id"] as string, version: req.headers["mcp-protocol-version"] as string });
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "h" } } }));
      } else if (msg.id === undefined) {
        res.writeHead(202).end();
      } else if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "time", inputSchema: { type: "object" } }] } })}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "12:00" }] } })}\n\n`);
        res.end();
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as import("node:net").AddressInfo).port;
    const dir = await tempDir();
    const mgr = new McpManager({ remote: { type: "http", url: `http://127.0.0.1:${port}/mcp` } }, dir);
    try {
      await mgr.start();
      assert.equal(mgr.statuses.get("remote")?.status, "connected", mgr.statuses.get("remote")?.error);
      const tool = mgr.tools()[0]!;
      assert.equal(tool.name, "mcp__remote__time");
      const r = await tool.execute({}, makeContext(dir));
      assert.equal(r.output, "12:00");
      const call = seen.find((s) => s.method === "tools/call")!;
      assert.equal(call.session, "sess-1");
      assert.equal(call.version, "2025-06-18");
    } finally {
      await mgr.close();
      srv.close();
    }
  });
});
