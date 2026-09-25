import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../src/core/events.ts";
import type { Config } from "../src/config/config.ts";
import { Runtime } from "../src/runtime.ts";
import { tempDir } from "./helpers/context.ts";
import { MockLLM } from "./helpers/mock-llm.ts";

const mock = new MockLLM();
let baseURL = "";
const LSP_SERVER = fileURLToPath(new URL("./helpers/lsp-server.mjs", import.meta.url));

before(async () => {
  baseURL = await mock.start();
  process.env.USTA_DATA_DIR = await tempDir("usta-data-");
  process.env.USTA_CONFIG_DIR = await tempDir("usta-config-");
});
after(() => mock.stop());
beforeEach(() => {
  mock.reset();
});

async function project(opts: { git?: boolean } = {}): Promise<string> {
  const dir = await tempDir("usta-proj-");
  if (opts.git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await fs.writeFile(path.join(dir, "README.md"), "# demo\n");
  }
  return dir;
}

async function runtime(cwd: string, over: { config?: Config; yolo?: boolean; interactive?: boolean; model?: string } = {}) {
  const rt = await Runtime.create({
    cwd,
    trusted: true,
    yolo: over.yolo,
    interactive: over.interactive,
    model: over.model ?? "anthropic/claude-opus-5",
    config: {
      providers: {
        anthropic: { apiKey: "test-key", baseURL },
        openai: { apiKey: "test-key", baseURL: baseURL + "/v1" },
      },
      // Real language servers may be installed; tests opt in with a fake one.
      lsp: false,
      ...over.config,
    },
    mcp: false,
  });
  const events: AgentEvent[] = [];
  rt.bus.on((e) => events.push(e));
  return { rt, events };
}

const signal = () => new AbortController().signal;

describe("engine", () => {
  it("answers a plain prompt and persists the session", async () => {
    const dir = await project();
    const { rt, events } = await runtime(dir);
    mock.push({ blocks: [{ type: "text", text: "Hello there." }], usage: { input: 50, output: 5 } });
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "hi" }, { signal: signal() });
    assert.equal(res.reason, "done");
    assert.equal(res.text, "Hello there.");
    assert.equal(s.messages.length, 2);
    assert.equal(s.meta.title, "hi");
    assert.ok(s.meta.cost > 0);
    const req = mock.requests[0]!.body;
    assert.match(req.system[0].text, /You are Usta/);
    assert.ok(req.tools.some((t: { name: string }) => t.name === "edit"));
    assert.ok(events.some((e) => e.type === "message.delta"));
    const reloaded = await rt.store.load(s.id);
    assert.equal(reloaded.messages.length, 2);
    assert.equal(reloaded.meta.system, s.meta.system);
  });

  it("runs a tool loop, snapshots and reports changes, then undoes and redoes", async () => {
    const dir = await project({ git: true });
    const { rt, events } = await runtime(dir, { yolo: true });
    mock.push(
      { blocks: [{ type: "text", text: "Creating it." }, { type: "tool_use", name: "write", input: { file_path: "hello.txt", content: "hi\n" } }] },
      { blocks: [{ type: "text", text: "Done." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "create hello.txt" }, { signal: signal() });
    assert.equal(res.reason, "done");
    assert.equal(await fs.readFile(path.join(dir, "hello.txt"), "utf8"), "hi\n");
    assert.deepEqual(res.changes?.map((c) => [c.path, c.status]), [["hello.txt", "added"]]);
    const second = mock.requests[1]!.body;
    const results = second.messages.at(-1).content;
    assert.equal(results[0].type, "tool_result");
    assert.match(results[0].content, /Created hello.txt/);
    assert.ok(events.some((e) => e.type === "tool.end" && e.name === "write"));

    const undone = await rt.engine.undo(s);
    assert.equal(undone?.prompt, "create hello.txt");
    await assert.rejects(fs.access(path.join(dir, "hello.txt")));
    assert.equal(s.messages.length, 0);
    const redone = await rt.engine.redo(s);
    assert.equal(redone?.prompt, "create hello.txt");
    assert.equal(await fs.readFile(path.join(dir, "hello.txt"), "utf8"), "hi\n");
    assert.equal(s.messages.length, 4);
  });

  it("rewinds to an earlier prompt: code, conversation or both, with redo", async () => {
    const dir = await project({ git: true });
    const { rt } = await runtime(dir, { yolo: true });
    const s = await rt.newSession();
    for (const [i, name] of ["one", "two", "three"].entries()) {
      mock.push({ blocks: [{ type: "tool_use", name: "write", input: { file_path: `${name}.txt`, content: `${i}\n` } }] }, { blocks: [{ type: "text", text: `wrote ${name}` }] });
      await rt.engine.prompt(s, { text: `write ${name}` }, { signal: signal() });
    }
    const points = rt.engine.rewindPoints(s);
    assert.deepEqual(points.map((p) => p.text), ["write one", "write two", "write three"]);
    assert.ok(points.every((p) => p.hasSnapshot));
    const exists = async (f: string) => fs.access(path.join(dir, f)).then(() => true, () => false);

    // Code only: files go back, the conversation stays.
    const before = s.messages.length;
    const code = await rt.engine.rewind(s, points[1]!.id, { conversation: false });
    assert.equal(code.prompt, "write two");
    assert.equal(s.messages.length, before);
    assert.deepEqual([await exists("one.txt"), await exists("two.txt"), await exists("three.txt")], [true, false, false]);
    await rt.engine.redo(s);
    assert.deepEqual([await exists("two.txt"), await exists("three.txt")], [true, true]);

    // Both: back to before "write two"; redo restores everything.
    await rt.engine.rewind(s, points[1]!.id);
    assert.deepEqual(rt.engine.rewindPoints(s).map((p) => p.text), ["write one"]);
    assert.deepEqual([await exists("one.txt"), await exists("two.txt")], [true, false]);
    const redo = await rt.engine.redo(s);
    assert.equal(redo?.prompt, "write two");
    assert.equal(s.messages.length, before);
    assert.equal(await exists("three.txt"), true);

    // Conversation only: the files stay as they are.
    await rt.engine.rewind(s, points[2]!.id, { code: false });
    assert.deepEqual(rt.engine.rewindPoints(s).map((p) => p.text), ["write one", "write two"]);
    assert.equal(await exists("three.txt"), true);
    await assert.rejects(rt.engine.rewind(s, "msg_missing"), /Not a prompt/);
  });

  it("runs read-only tools in parallel and returns results in order", async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, "a.txt"), "AAA\n");
    await fs.writeFile(path.join(dir, "b.txt"), "BBB\n");
    const { rt } = await runtime(dir);
    mock.push(
      {
        blocks: [
          { type: "tool_use", name: "read", input: { file_path: "a.txt" } },
          { type: "tool_use", name: "read", input: { file_path: "b.txt" } },
        ],
      },
      { blocks: [{ type: "text", text: "Both read." }] },
    );
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "read both" }, { signal: signal() });
    const content = mock.requests[1]!.body.messages.at(-1).content;
    assert.match(content[0].content, /AAA/);
    assert.match(content[1].content, /BBB/);
  });

  it("denies actions needing approval when non-interactive", async () => {
    const dir = await project();
    const { rt } = await runtime(dir);
    mock.push({ blocks: [{ type: "tool_use", name: "bash", input: { command: "touch x" } }] }, { blocks: [{ type: "text", text: "ok" }] });
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "touch x" }, { signal: signal() });
    const result = mock.requests[1]!.body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /no user is available|needs approval/i);
    await assert.rejects(fs.access(path.join(dir, "x")));
  });

  it("asks interactively and remembers session grants", async () => {
    const dir = await project();
    const { rt } = await runtime(dir, { interactive: true });
    let asked = 0;
    rt.bus.on((e) => {
      if (e.type === "permission.request") {
        asked++;
        rt.replyPermission(e.request.id, { decision: "session" });
      }
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "bash", input: { command: "touch one" } }] },
      { blocks: [{ type: "tool_use", name: "bash", input: { command: "touch two" } }] },
      { blocks: [{ type: "text", text: "ok" }] },
    );
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "touch files" }, { signal: signal() });
    assert.equal(asked, 1);
    await fs.access(path.join(dir, "one"));
    await fs.access(path.join(dir, "two"));
  });

  it("retries overloaded errors", async () => {
    const dir = await project();
    const { rt, events } = await runtime(dir);
    mock.push({ blocks: [], error: { status: 529, type: "overloaded_error", message: "Overloaded" } }, { blocks: [{ type: "text", text: "recovered" }] });
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "hi" }, { signal: signal() });
    assert.equal(res.text, "recovered");
    assert.ok(events.some((e) => e.type === "retry"));
  });

  it("stops without retrying on auth errors", async () => {
    const dir = await project();
    const { rt } = await runtime(dir);
    mock.push({ blocks: [], error: { status: 401, type: "authentication_error", message: "invalid x-api-key" } });
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "hi" }, { signal: signal() });
    assert.equal(res.reason, "error");
    assert.match(res.error!, /usta auth login anthropic/);
    assert.equal(mock.requests.length, 1);
  });

  it("discards refused responses", async () => {
    const dir = await project();
    const { rt, events } = await runtime(dir);
    mock.push({ blocks: [{ type: "text", text: "partial" }], stopReason: "refusal", stopDetails: { category: "cyber", explanation: null } });
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "do something" }, { signal: signal() });
    assert.equal(res.reason, "refusal");
    assert.equal(s.messages.length, 1);
    assert.ok(events.some((e) => e.type === "notice" && /declined.*cyber/.test(e.message)));
  });

  it("does not run tool calls cut off by max_tokens", async () => {
    const dir = await project();
    const { rt } = await runtime(dir, { yolo: true });
    mock.push(
      { blocks: [{ type: "tool_use", name: "write", input: { file_path: "big.txt", content: "partial" } }], stopReason: "max_tokens" },
      { blocks: [{ type: "text", text: "I'll split it." }] },
    );
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "write big" }, { signal: signal() });
    await assert.rejects(fs.access(path.join(dir, "big.txt")));
    assert.match(mock.requests[1]!.body.messages.at(-1).content[0].content, /Not executed/);
  });

  it("blocks repeated identical mutating calls", async () => {
    const dir = await project();
    const { rt } = await runtime(dir, { yolo: true });
    const call = { type: "tool_use" as const, name: "bash", input: { command: "echo same >> log.txt" } };
    mock.push({ blocks: [call] }, { blocks: [call] }, { blocks: [call] }, { blocks: [{ type: "text", text: "stopping" }] });
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "loop" }, { signal: signal() });
    assert.equal(await fs.readFile(path.join(dir, "log.txt"), "utf8"), "same\nsame\n");
    assert.match(mock.requests[3]!.body.messages.at(-1).content[0].content, /already made twice/);
  });

  it("compacts when the context grows past the threshold", async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, "f.txt"), "data\n");
    const { rt, events } = await runtime(dir, { config: { compaction: { maxContextTokens: 10_000 } } });
    mock.push(
      { blocks: [{ type: "tool_use", name: "read", input: { file_path: "f.txt" } }], usage: { input: 20_000, output: 100 } },
      { blocks: [{ type: "text", text: "## Summary\nThe user asked to read f.txt; it contains 'data'." }] },
      { blocks: [{ type: "text", text: "The file says data." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "read f.txt" }, { signal: signal() });
    assert.equal(res.text, "The file says data.");
    const summaryReq = mock.requests[1]!.body;
    assert.deepEqual(summaryReq.tool_choice, { type: "none" });
    assert.match(summaryReq.messages.at(-1).content.at(-1).text, /detailed summary/);
    const after = mock.requests[2]!.body.messages;
    assert.equal(after.length, 1);
    assert.match(after[0].content[0].text, /<summary>/);
    assert.ok(events.some((e) => e.type === "compaction" && e.phase === "end"));
    assert.equal(s.active.length, 2);
  });

  it("clears old tool outputs once the context grows, keeping recent ones", async () => {
    const dir = await project();
    const { rt, events } = await runtime(dir);
    const s = await rt.newSession();
    const model = await rt.engine.resolveModel(s);
    const big = "x".repeat(40_000); // ~10k tokens each
    for (let i = 0; i < 8; i++) {
      await s.add({ id: `a${i}`, role: "assistant", time: 0, provider: "anthropic", model: model.id, parts: [{ type: "tool_call", id: `call_${i}`, name: i === 1 ? "question" : "read", input: {} }] });
      await s.add({ id: `u${i}`, role: "user", time: 0, origin: "tool_results", parts: [{ type: "tool_result", callId: `call_${i}`, name: i === 1 ? "question" : "read", output: `${i}:${big}` }] });
    }
    // Small contexts are left alone.
    assert.equal(await rt.engine.pruneToolOutputs(s, model), 0);
    await s.update({ lastContextTokens: 200_000 });
    const freed = await rt.engine.pruneToolOutputs(s, model);
    // The newest ~40k tokens stay; older outputs go, except answers to questions.
    assert.deepEqual([...s.pruned].sort(), ["call_0", "call_2", "call_3"]);
    assert.ok(freed >= 30_000);
    assert.ok(events.some((e) => e.type === "notice" && /Cleared 3 old tool outputs/.test(e.message)));
    const ctx = s.context();
    const outputs = ctx.flatMap((m) => (m.role === "user" ? m.parts : [])).map((p) => (p.type === "tool_result" ? p.output.slice(0, 2) : ""));
    assert.deepEqual(outputs.map((o) => o.startsWith("[") ? "cleared" : o), ["cleared", "1:", "cleared", "cleared", "4:", "5:", "6:", "7:"]);
    // The session keeps the originals; the pruning survives a reload.
    assert.ok(s.messages.every((m) => m.role !== "user" || m.parts.every((p) => p.type !== "tool_result" || p.output.length > 40_000)));
    const reloaded = await rt.store.load(s.id);
    assert.deepEqual([...reloaded.pruned].sort(), ["call_0", "call_2", "call_3"]);
    // The next request carries the placeholder.
    mock.push({ blocks: [{ type: "text", text: "ok" }] });
    await rt.engine.prompt(s, { text: "continue" }, { signal: signal() });
    const sent = JSON.stringify(mock.requests[0]!.body.messages);
    assert.match(sent, /Output of this read call was cleared/);
    assert.ok(!sent.includes("0:xxxx"));
    assert.ok(sent.includes("7:xxxx"));
    // prune: false turns it off.
    const off = await runtime(dir, { config: { compaction: { prune: false } } });
    const s2 = await off.rt.newSession();
    for (let i = 0; i < 8; i++) {
      await s2.add({ id: `b${i}`, role: "user", time: 0, origin: "tool_results", parts: [{ type: "tool_result", callId: `c${i}`, name: "read", output: big }] });
    }
    await s2.update({ lastContextTokens: 200_000 });
    assert.equal(await off.rt.engine.pruneToolOutputs(s2, model), 0);
  });

  it("delegates to a sub-agent", async () => {
    const dir = await project();
    const { rt, events } = await runtime(dir);
    mock.push(
      { blocks: [{ type: "tool_use", name: "task", input: { description: "find config", prompt: "Where is the config loaded?", subagent_type: "explore" } }] },
      { blocks: [{ type: "text", text: "Config is loaded in src/config.ts:10." }] },
      { blocks: [{ type: "text", text: "It's in src/config.ts." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "where is config?" }, { signal: signal() });
    assert.equal(res.text, "It's in src/config.ts.");
    const childReq = mock.requests[1]!.body;
    assert.match(childReq.system[0].text, /read-only exploration sub-agent/);
    assert.ok(!childReq.tools.some((t: { name: string }) => t.name === "task" || t.name === "edit"));
    const report = mock.requests[2]!.body.messages.at(-1).content[0].content;
    assert.match(report, /src\/config.ts:10/);
    assert.ok(events.some((e) => e.type === "subagent.start"));
    const all = await rt.store.list({ includeSubagents: true });
    assert.equal(all.filter((x) => x.parentId === s.id).length, 1);
  });

  it("enforces plan mode and exits through plan review", async () => {
    const dir = await project();
    const { rt } = await runtime(dir, { interactive: true, yolo: true });
    rt.bus.on((e) => {
      if (e.type === "plan.review") rt.engine.resolvePlan(e.id, { approved: true, mode: "normal" });
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "write", input: { file_path: "p.txt", content: "x" } }] },
      { blocks: [{ type: "tool_use", name: "exit_plan_mode", input: { plan: "1. write p.txt" } }] },
      { blocks: [{ type: "tool_use", name: "write", input: { file_path: "p.txt", content: "x" } }] },
      { blocks: [{ type: "text", text: "done" }] },
    );
    const s = await rt.newSession();
    await rt.engine.setMode(s, "plan");
    await rt.engine.prompt(s, { text: "plan it" }, { signal: signal() });
    const first = mock.requests[0]!.body.messages[0].content;
    assert.ok(first.some((b: { text?: string }) => b.text?.includes("Plan mode is active")));
    assert.match(mock.requests[1]!.body.messages.at(-1).content[0].content, /Plan mode is active/);
    assert.match(mock.requests[2]!.body.messages.at(-1).content[0].content, /approved the plan/);
    assert.equal(s.meta.mode, "normal");
    assert.equal(await fs.readFile(path.join(dir, "p.txt"), "utf8"), "x");
  });

  it("runs hooks: PostToolUse feedback and Stop continuation", async () => {
    const dir = await project();
    const marker = path.join(dir, "stop-ran");
    const { rt } = await runtime(dir, {
      yolo: true,
      config: {
        hooks: {
          PostToolUse: [{ matcher: "write", command: "echo 'lint: missing semicolon' >&2; exit 2" }],
          Stop: [{ command: `if [ ! -f ${marker} ]; then touch ${marker}; echo 'tests are failing' >&2; exit 2; fi` }],
        },
      },
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "write", input: { file_path: "a.js", content: "x = 1" } }] },
      { blocks: [{ type: "text", text: "Wrote it." }] },
      { blocks: [{ type: "text", text: "Fixed the tests." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "write a.js" }, { signal: signal() });
    assert.match(mock.requests[1]!.body.messages.at(-1).content[0].content, /lint: missing semicolon/);
    assert.match(mock.requests[2]!.body.messages.at(-1).content[0].text, /tests are failing/);
    assert.equal(res.text, "Fixed the tests.");
  });

  it("works with OpenAI through the Responses API and apply_patch", async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, "m.py"), "def f():\n    return 1\n");
    const { rt } = await runtime(dir, { yolo: true, model: "openai/gpt-5" });
    mock.push(
      {
        blocks: [
          { type: "thinking", thinking: "Patch the return value." },
          { type: "tool_use", name: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: m.py\n@@ def f():\n-    return 1\n+    return 2\n*** End Patch" } },
        ],
        model: "gpt-5-2025-08-07",
      },
      { blocks: [{ type: "text", text: "Patched." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "return 2" }, { signal: signal() });
    assert.equal(res.text, "Patched.");
    assert.equal(await fs.readFile(path.join(dir, "m.py"), "utf8"), "def f():\n    return 2\n");
    const req = mock.requests[0]!;
    assert.equal(req.path, "/v1/responses");
    assert.ok(req.body.tools.some((t: { name: string }) => t.name === "apply_patch"));
    assert.ok(!req.body.tools.some((t: { name: string }) => t.name === "edit"));
    assert.deepEqual(req.body.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(req.body.store, false);
    // The dated snapshot that served the turn still gets its encrypted reasoning back.
    const next = mock.requests[1]!.body.input;
    assert.equal(next[1].type, "reasoning");
    assert.equal(next[2].type, "function_call");
    assert.equal(next.at(-1).type, "function_call_output");
    assert.equal(next.at(-1).call_id, next[2].call_id);
  });

  it("works with Chat Completions providers", async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, "m.py"), "def f():\n    return 1\n");
    const { rt } = await runtime(dir, {
      yolo: true,
      model: "openai/gpt-5",
      config: { providers: { openai: { apiKey: "test-key", baseURL: baseURL + "/v1", options: { api: "chat" } } } },
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "apply_patch", input: { patch: "*** Begin Patch\n*** Update File: m.py\n@@ def f():\n-    return 1\n+    return 2\n*** End Patch" } }] },
      { blocks: [{ type: "text", text: "Patched." }] },
    );
    const s = await rt.newSession();
    const res = await rt.engine.prompt(s, { text: "return 2" }, { signal: signal() });
    assert.equal(res.text, "Patched.");
    assert.equal(await fs.readFile(path.join(dir, "m.py"), "utf8"), "def f():\n    return 2\n");
    const req = mock.requests[0]!.body;
    assert.ok(req.tools.some((t: { function: { name: string } }) => t.function.name === "apply_patch"));
    assert.equal(req.reasoning_effort, "medium");
    assert.equal(mock.requests[1]!.body.messages.at(-1).role, "tool");
  });

  it("reports errors an edit introduced, from a language server", async () => {
    const dir = await project();
    await fs.writeFile(path.join(dir, "notes.txt"), "ERROR old\nfine\n");
    const { rt, events } = await runtime(dir, {
      yolo: true,
      config: { lsp: { fake: { command: [process.execPath, LSP_SERVER], extensions: [".txt"] } } },
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "read", input: { file_path: "notes.txt" } }] },
      { blocks: [{ type: "tool_use", name: "edit", input: { file_path: "notes.txt", old_string: "fine", new_string: "fine\nERROR new" } }] },
      { blocks: [{ type: "text", text: "Done." }] },
    );
    try {
      const s = await rt.newSession();
      await rt.engine.prompt(s, { text: "add a line" }, { signal: signal() });
      const result = mock.requests[2]!.body.messages.at(-1).content[0].content as string;
      assert.match(result, /<diagnostics file="notes.txt">\nERROR \[3:1\] found ERROR: ERROR new \(fake error\)\n<\/diagnostics>/);
      assert.match(result, /1 other error in this file predate your changes/);
      const end = events.find((e) => e.type === "tool.end" && e.name === "edit");
      assert.equal(end?.type === "tool.end" && end.result.metadata?.diagnostics, 1);
    } finally {
      await rt.close();
    }
  });

  it("accepts custom tools with config-driven permissions", async () => {
    const dir = await project();
    const deployed: string[] = [];
    const rt = await Runtime.create({
      cwd: dir,
      trusted: true,
      mcp: false,
      model: "anthropic/claude-opus-5",
      tools: [
        {
          name: "deploy",
          description: "Deploy the app",
          parameters: { type: "object", properties: { env: { type: "string", enum: ["staging", "prod"] } }, required: ["env"] },
          async execute(input: { env: string }, ctx) {
            await ctx.permit({ permission: "deploy", patterns: [input.env], always: [input.env], title: `Deploy to ${input.env}` });
            deployed.push(input.env);
            return { output: `Deployed to ${input.env}.` };
          },
        },
      ],
      config: {
        providers: { anthropic: { apiKey: "k", baseURL } },
        permission: { deploy: { staging: "allow", prod: "deny" } },
      },
    });
    mock.push(
      { blocks: [{ type: "tool_use", name: "deploy", input: { env: "staging" } }, { type: "tool_use", name: "deploy", input: { env: "prod" } }] },
      { blocks: [{ type: "text", text: "Staging deployed; prod was denied." }] },
    );
    const s = await rt.newSession();
    await rt.engine.prompt(s, { text: "deploy" }, { signal: signal() });
    assert.deepEqual(deployed, ["staging"]);
    const results = mock.requests[1]!.body.messages.at(-1).content;
    assert.match(results[0].content, /Deployed to staging/);
    assert.match(results[1].content, /denied by rule/);
    await rt.close();
  });

  it("aborts a running turn and records interrupted tool results", async () => {
    const dir = await project();
    const { rt } = await runtime(dir, { yolo: true });
    mock.push({ blocks: [{ type: "tool_use", name: "bash", input: { command: "sleep 10" } }] });
    const s = await rt.newSession();
    const ctrl = new AbortController();
    rt.bus.on((e) => {
      if (e.type === "tool.start") setTimeout(() => ctrl.abort(), 100);
    });
    const res = await rt.engine.prompt(s, { text: "sleep" }, { signal: ctrl.signal });
    assert.equal(res.reason, "aborted");
    const last = s.messages.at(-1)!;
    assert.equal(last.role, "user");
    assert.ok(last.role === "user" && last.parts[0]!.type === "tool_result" && /interrupted/i.test(last.parts[0]!.output));
    // The next turn continues cleanly.
    mock.push({ blocks: [{ type: "text", text: "ready" }] });
    const next = await rt.engine.prompt(s, { text: "continue" }, { signal: signal() });
    assert.equal(next.text, "ready");
  });
});
