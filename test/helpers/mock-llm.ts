/**
 * A scripted fake of the Anthropic Messages API, the OpenAI Chat Completions
 * API and the OpenAI Responses API (streaming). Tests queue responses and
 * inspect requests.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export type MockBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "fallback"; from: string; to: string };

export interface MockTurn {
  blocks: MockBlock[];
  stopReason?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number };
  model?: string;
  /** Respond with an HTTP error instead. */
  error?: { status: number; type: string; message: string };
  /** Emit an SSE error event after the blocks (mid-stream failure). */
  midStreamError?: { type: string; message: string };
  /** Delay between SSE events (ms). */
  delayMs?: number;
  stopDetails?: { category: string | null; explanation: string | null };
}

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export class MockLLM {
  readonly requests: RecordedRequest[] = [];
  private queue: MockTurn[] = [];
  private server?: http.Server;
  private idCounter = 0;
  /** Called when the queue is empty; default: a plain "done" text reply. */
  fallback: (req: RecordedRequest) => MockTurn = () => ({ blocks: [{ type: "text", text: "done" }] });

  push(...turns: MockTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  reset(): void {
    this.queue = [];
    this.requests.length = 0;
  }

  get pending(): number {
    return this.queue.length;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections?.();
      this.server?.close(() => resolve());
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "";
    const key = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (key === "bad-key") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      const id = decodeURIComponent(url.split("?")[0]!.slice("/v1/models/".length));
      res.writeHead(200, { "content-type": "application/json" });
      if (id) {
        res.end(JSON.stringify({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 123_456, max_tokens: 32_000, capabilities: null }));
      } else {
        res.end(JSON.stringify({ data: [{ id: "mock-model", object: "model", type: "model", display_name: "Mock", context_length: 99_000 }], has_more: false, first_id: null, last_id: null }));
      }
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    const rec: RecordedRequest = { path: url, headers: req.headers, body };
    this.requests.push(rec);
    const turn = this.queue.shift() ?? this.fallback(rec);
    if (turn.error) {
      res.writeHead(turn.error.status, { "content-type": "application/json", "retry-after-ms": "10" });
      res.end(JSON.stringify({ type: "error", error: { type: turn.error.type, message: turn.error.message } }));
      return;
    }
    if (url.startsWith("/v1/messages")) await this.anthropic(turn, body, res);
    else if (url.includes("/chat/completions")) await this.openai(turn, body, res);
    else if (url.endsWith("/responses")) await this.responses(turn, body, res);
    else {
      res.writeHead(404);
      res.end();
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}_${String(++this.idCounter).padStart(4, "0")}`;
  }

  private async anthropic(turn: MockTurn, body: any, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = async (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    };
    const model = turn.model ?? body.model;
    const u = turn.usage ?? {};
    await send("message_start", {
      type: "message_start",
      message: {
        id: this.nextId("msg"),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: u.input ?? 100,
          output_tokens: 1,
          cache_read_input_tokens: u.cacheRead ?? 0,
          cache_creation_input_tokens: u.cacheWrite ?? 0,
        },
      },
    });
    let index = 0;
    let hasTool = false;
    for (const b of turn.blocks) {
      if (b.type === "text") {
        await send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        for (const piece of splitPieces(b.text)) {
          await send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
        }
      } else if (b.type === "thinking") {
        await send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        if (b.thinking) await send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
        await send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature ?? "sig-" + index } });
      } else if (b.type === "tool_use") {
        hasTool = true;
        const id = b.id ?? this.nextId("toolu");
        await send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name: b.name, input: {} } });
        const json = JSON.stringify(b.input);
        for (const piece of splitPieces(json, 17)) {
          await send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } });
        }
      } else if (b.type === "fallback") {
        await send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "fallback", from: { model: b.from }, to: { model: b.to }, trigger: { type: "refusal" } },
        });
      }
      await send("content_block_stop", { type: "content_block_stop", index });
      index++;
    }
    if (turn.midStreamError) {
      await send("error", { type: "error", error: turn.midStreamError });
      res.end();
      return;
    }
    await send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: turn.stopReason ?? (hasTool ? "tool_use" : "end_turn"), stop_sequence: null, stop_details: turn.stopDetails ?? null },
      usage: { output_tokens: u.output ?? 50 },
    });
    await send("message_stop", { type: "message_stop" });
    res.end();
  }

  private async openai(turn: MockTurn, body: any, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const id = this.nextId("chatcmpl");
    const model = turn.model ?? body.model;
    const send = async (data: unknown) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    };
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    await send(chunk({ role: "assistant", content: "" }));
    let toolIndex = 0;
    let hasTool = false;
    for (const b of turn.blocks) {
      if (b.type === "text") {
        for (const piece of splitPieces(b.text)) await send(chunk({ content: piece }));
      } else if (b.type === "thinking") {
        await send(chunk({ reasoning_content: b.thinking }));
      } else if (b.type === "tool_use") {
        hasTool = true;
        const callId = b.id ?? this.nextId("call");
        const json = JSON.stringify(b.input);
        await send(chunk({ tool_calls: [{ index: toolIndex, id: callId, type: "function", function: { name: b.name, arguments: "" } }] }));
        for (const piece of splitPieces(json, 13)) {
          await send(chunk({ tool_calls: [{ index: toolIndex, function: { arguments: piece } }] }));
        }
        toolIndex++;
      }
    }
    const finish = turn.stopReason ?? (hasTool ? "tool_calls" : "stop");
    await send(chunk({}, finish));
    const u = turn.usage ?? {};
    await send({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: {
        prompt_tokens: (u.input ?? 100) + (u.cacheRead ?? 0),
        completion_tokens: u.output ?? 50,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: u.cacheRead ?? 0 },
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private async responses(turn: MockTurn, body: any, res: http.ServerResponse): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const model = turn.model ?? body.model;
    let seq = 0;
    const send = async (type: string, data: Record<string, unknown>) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    };
    const base = { id: this.nextId("resp"), object: "response", created_at: 1, model, status: "in_progress", error: null, incomplete_details: null, output: [] };
    await send("response.created", { response: base });
    const output: Array<Record<string, unknown>> = [];
    for (const b of turn.blocks) {
      const output_index = output.length;
      if (b.type === "thinking") {
        const item = { id: this.nextId("rs"), type: "reasoning", summary: [] as unknown[] };
        await send("response.output_item.added", { output_index, item });
        await send("response.reasoning_summary_part.added", { item_id: item.id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } });
        for (const piece of splitPieces(b.thinking)) {
          await send("response.reasoning_summary_text.delta", { item_id: item.id, output_index, summary_index: 0, delta: piece });
        }
        const done = { ...item, summary: [{ type: "summary_text", text: b.thinking }], encrypted_content: b.signature ?? `enc-${item.id}` };
        await send("response.output_item.done", { output_index, item: done });
        output.push(done);
      } else if (b.type === "text") {
        const item = { id: this.nextId("msg"), type: "message", role: "assistant", status: "in_progress", content: [] as unknown[] };
        await send("response.output_item.added", { output_index, item });
        for (const piece of splitPieces(b.text)) {
          await send("response.output_text.delta", { item_id: item.id, output_index, content_index: 0, delta: piece, logprobs: [] });
        }
        const done = { ...item, status: "completed", content: [{ type: "output_text", text: b.text, annotations: [] }] };
        await send("response.output_item.done", { output_index, item: done });
        output.push(done);
      } else if (b.type === "tool_use") {
        const item = { id: this.nextId("fc"), type: "function_call", call_id: b.id ?? this.nextId("call"), name: b.name, arguments: "", status: "in_progress" };
        await send("response.output_item.added", { output_index, item });
        const json = JSON.stringify(b.input);
        for (const piece of splitPieces(json, 13)) {
          await send("response.function_call_arguments.delta", { item_id: item.id, output_index, delta: piece });
        }
        const done = { ...item, arguments: json, status: "completed" };
        await send("response.output_item.done", { output_index, item: done });
        output.push(done);
      }
    }
    if (turn.midStreamError) {
      await send("error", { code: turn.midStreamError.type, message: turn.midStreamError.message, param: null });
      res.end();
      return;
    }
    const u = turn.usage ?? {};
    const stop = turn.stopReason;
    const incomplete = stop === "max_tokens" || stop === "length" ? "max_output_tokens" : stop === "refusal" || stop === "content_filter" ? "content_filter" : undefined;
    await send(incomplete ? "response.incomplete" : "response.completed", {
      response: {
        ...base,
        status: incomplete ? "incomplete" : "completed",
        incomplete_details: incomplete ? { reason: incomplete } : null,
        output,
        usage: {
          input_tokens: (u.input ?? 100) + (u.cacheRead ?? 0),
          input_tokens_details: { cached_tokens: u.cacheRead ?? 0 },
          output_tokens: u.output ?? 50,
          output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 },
          total_tokens: 0,
        },
      },
    });
    res.end();
  }
}

function splitPieces(s: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}
