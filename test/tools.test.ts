import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { bashKillTool, bashOutputTool, bashTool, commandPatterns } from "../src/tool/bash.ts";
import { editTool } from "../src/tool/edit.ts";
import { findMatches } from "../src/tool/fuzzy.ts";
import { applyChunks, applyPatchTool, parsePatch } from "../src/tool/patch.ts";
import { readTool } from "../src/tool/read.ts";
import { globTool, grepTool, lsTool } from "../src/tool/search.ts";
import { writeTool } from "../src/tool/write.ts";
import { makeContext, tempDir } from "./helpers/context.ts";

describe("file tools", () => {
  let root = "";
  before(async () => {
    root = await tempDir();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    await fs.writeFile(path.join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  });

  it("reads with line numbers and paging", async () => {
    const ctx = makeContext(root);
    const r = await readTool.execute({ file_path: "src/a.ts" }, ctx);
    assert.match(r.output, /^ {5}1\texport function add/);
    const p = await readTool.execute({ file_path: "src/a.ts", offset: 2, limit: 1 }, ctx);
    assert.match(p.output, /^ {5}2\t {2}return a \+ b;/);
    assert.match(p.output, /Showing lines 2-2 of 3/);
    await assert.rejects(readTool.execute({ file_path: "src/b.ts" }, ctx), /not found[\s\S]*a\.ts/);
    assert.equal(ctx.permits[0]!.permission, "read");
  });

  it("pages long files at an output budget instead of clipping them", async () => {
    const ctx = makeContext(root);
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i + 1} ${"x".repeat(60)}`);
    await fs.writeFile(path.join(root, "big.txt"), lines.join("\n") + "\n");
    const first = await readTool.execute({ file_path: "big.txt" }, ctx);
    assert.ok(first.output.length <= 51_000);
    const m = /Showing lines 1-(\d+) of 1500 \(output limit reached\)\. Use offset=(\d+) to continue\./.exec(first.output);
    assert.ok(m, first.output.slice(-200));
    assert.equal(Number(m[2]), Number(m[1]) + 1);
    const next = await readTool.execute({ file_path: "big.txt", offset: Number(m[2]) }, ctx);
    assert.match(next.output, new RegExp(`^ *${m[2]}\tline ${m[2]} `));
  });

  it("refuses to edit unread files and edits read ones", async () => {
    const ctx = makeContext(root);
    await assert.rejects(editTool.execute({ file_path: "src/a.ts", old_string: "a + b", new_string: "a - b" }, ctx), /must read/);
    await readTool.execute({ file_path: "src/a.ts" }, ctx);
    const r = await editTool.execute({ file_path: "src/a.ts", old_string: "a + b", new_string: "b + a" }, ctx);
    assert.match(r.output, /Edited src\/a.ts/);
    assert.match(r.output, /return b \+ a;/);
    assert.equal((await fs.readFile(path.join(root, "src/a.ts"), "utf8")).includes("return b + a;"), true);
    assert.deepEqual(ctx.checkpoints, [path.join(root, "src/a.ts")]);
    assert.ok(String(r.metadata?.diff).includes("-  return a + b;"));
    const permit = ctx.permits.find((p) => p.permission === "edit")!;
    assert.deepEqual(permit.patterns, ["src/a.ts"]);
    assert.deepEqual(permit.always, ["src/*"]);
  });

  it("detects external modification since the last read", async () => {
    const ctx = makeContext(root);
    await readTool.execute({ file_path: "src/a.ts" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    await fs.appendFile(path.join(root, "src/a.ts"), "// changed\n");
    await assert.rejects(editTool.execute({ file_path: "src/a.ts", old_string: "export", new_string: "export " }, ctx), /modified since/);
  });

  it("rejects ambiguous edits and supports replace_all", async () => {
    const ctx = makeContext(root);
    await fs.writeFile(path.join(root, "dup.txt"), "x = 1\nx = 1\n");
    await readTool.execute({ file_path: "dup.txt" }, ctx);
    await assert.rejects(editTool.execute({ file_path: "dup.txt", old_string: "x = 1", new_string: "x = 2" }, ctx), /matches 2 places/);
    await editTool.execute({ file_path: "dup.txt", old_string: "x = 1", new_string: "x = 2", replace_all: true }, ctx);
    assert.equal(await fs.readFile(path.join(root, "dup.txt"), "utf8"), "x = 2\nx = 2\n");
  });

  it("preserves CRLF line endings", async () => {
    const ctx = makeContext(root);
    await readTool.execute({ file_path: "crlf.txt" }, ctx);
    await editTool.execute({ file_path: "crlf.txt", old_string: "two\nthree", new_string: "2\n3" }, ctx);
    assert.equal(await fs.readFile(path.join(root, "crlf.txt"), "utf8"), "one\r\n2\r\n3\r\n");
  });

  it("tolerates indentation drift with re-indentation", () => {
    const content = "class A {\n    method() {\n        return 1;\n    }\n}\n";
    const found = findMatches(content, "method() {\n    return 1;\n}");
    assert.equal(found.strategy, "indentation");
    assert.equal(found.matches.length, 1);
    const replaced = found.replacement!(found.matches[0]!.text, "method() {\n    return 2;\n}");
    assert.equal(replaced, "    method() {\n        return 2;\n    }");
  });

  it("writes new files and requires reading before overwrite", async () => {
    const ctx = makeContext(root);
    const r = await writeTool.execute({ file_path: "new/dir/file.md", content: "hello\n" }, ctx);
    assert.match(r.output, /Created new\/dir\/file.md/);
    const ctx2 = makeContext(root);
    await assert.rejects(writeTool.execute({ file_path: "new/dir/file.md", content: "bye\n" }, ctx2), /must read/);
  });

  it("asks before touching files outside the project", async () => {
    const outside = await tempDir("usta-outside-");
    await fs.writeFile(path.join(outside, "x.txt"), "secret\n");
    const ctx = makeContext(root);
    ctx.deny = (req) => req.permission === "external_directory";
    await assert.rejects(readTool.execute({ file_path: path.join(outside, "x.txt") }, ctx), /denied/);
    assert.equal(ctx.permits[0]!.permission, "external_directory");
  });
});

describe("apply_patch", () => {
  it("parses and applies multi-file patches", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "a.py"), "def f():\n    x = 1\n    y = 2\n    return x + y\n\n\ndef g():\n    return 0\n");
    await fs.writeFile(path.join(root, "old.txt"), "bye\n");
    const ctx = makeContext(root);
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.py",
      "@@ def g():",
      "-    return 0",
      "+    return 42",
      "*** Update File: a.py",
      "@@",
      "     x = 1",
      "-    y = 2",
      "+    y = 3",
      "     return x + y",
      "*** Add File: b/new.py",
      "+print('hi')",
      "*** Delete File: old.txt",
      "*** End Patch",
    ].join("\n");
    const ops = parsePatch(patch);
    assert.equal(ops.length, 4);
    // Updates to the same file in separate sections apply sequentially.
    const merged = parsePatch(patch.replace("*** Update File: a.py\n@@\n", "@@\n"));
    assert.equal(merged.length, 3);
    const r = await applyPatchTool.execute({ patch: patch.replace("*** Update File: a.py\n@@\n", "@@\n") }, ctx);
    assert.match(r.output, /M a.py/);
    assert.equal(await fs.readFile(path.join(root, "a.py"), "utf8"), "def f():\n    x = 1\n    y = 3\n    return x + y\n\n\ndef g():\n    return 42\n");
    assert.equal(await fs.readFile(path.join(root, "b/new.py"), "utf8"), "print('hi')\n");
    await assert.rejects(fs.access(path.join(root, "old.txt")));
    assert.equal(ctx.permits.filter((p) => p.permission === "edit").length, 1);
  });

  it("fails atomically when context does not match", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "a.txt"), "alpha\nbeta\n");
    const ctx = makeContext(root);
    const bad = "*** Begin Patch\n*** Add File: c.txt\n+c\n*** Update File: a.txt\n@@\n-gamma\n+delta\n*** End Patch";
    await assert.rejects(applyPatchTool.execute({ patch: bad }, ctx), /Could not find/);
    await assert.rejects(fs.access(path.join(root, "c.txt")));
  });

  it("matches despite trailing whitespace and smart quotes", () => {
    const out = applyChunks("say(“hi”)  \nnext\n", [{ oldLines: ['say("hi")'], newLines: ['say("bye")'], eof: false }], "f");
    assert.equal(out, 'say("bye")\nnext\n');
  });
});

describe("bash", () => {
  it("runs commands with exit codes and streaming", async () => {
    const root = await tempDir();
    const ctx = makeContext(root);
    const ok = await bashTool.execute({ command: "echo hello && echo err 1>&2" }, ctx);
    assert.match(ok.output, /hello/);
    assert.match(ok.output, /err/);
    assert.ok(!ok.isError);
    assert.ok(ctx.progressChunks.join("").includes("hello"));
    const fail = await bashTool.execute({ command: "exit 3" }, ctx);
    assert.ok(fail.isError);
    assert.match(fail.output, /Exit code 3/);
  });

  it("times out and can be aborted", async () => {
    const root = await tempDir();
    const ctx = makeContext(root);
    const r = await bashTool.execute({ command: "sleep 5", timeout: 1000 }, ctx);
    assert.match(r.output, /timed out/);
    const ctrl = new AbortController();
    const ctx2 = makeContext(root, { signal: ctrl.signal });
    const started = Date.now();
    setTimeout(() => ctrl.abort(), 200);
    const r2 = await bashTool.execute({ command: "sleep 5" }, ctx2);
    assert.match(r2.output, /interrupted/);
    assert.ok(Date.now() - started < 4000);
  });

  it("builds permission patterns per sub-command", () => {
    const p = commandPatterns("git add -A && git commit -m 'x' > /dev/null; echo hi > out.txt");
    assert.deepEqual(p.patterns, ["git add -A", "git commit -m x > /dev/null", "echo hi > out.txt"]);
    assert.deepEqual(p.always, ["git add *", "git commit *", "echo *"]);
  });

  it("manages background processes", async () => {
    const root = await tempDir();
    const ctx = makeContext(root);
    const r = await bashTool.execute({ command: "echo start; sleep 10", run_in_background: true }, ctx);
    const id = String(r.metadata?.background);
    await new Promise((res) => setTimeout(res, 300));
    const out = await bashOutputTool.execute({ id }, ctx);
    assert.match(out.output, /running/);
    assert.match(out.output, /start/);
    const again = await bashOutputTool.execute({ id }, ctx);
    assert.match(again.output, /no new output/);
    await bashKillTool.execute({ id }, ctx);
    await new Promise((res) => setTimeout(res, 300));
    const done = await bashOutputTool.execute({ id }, ctx);
    assert.match(done.output, /exited/);
  });
});

describe("search tools", () => {
  let root = "";
  before(async () => {
    root = await tempDir();
    await fs.mkdir(path.join(root, "src/lib"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules/x"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "dist/\n*.log\n");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/out.js"), "TODO in dist\n");
    await fs.writeFile(path.join(root, "debug.log"), "TODO in log\n");
    await fs.writeFile(path.join(root, "src/main.ts"), "// TODO: main\nconst x = 1;\n");
    await fs.writeFile(path.join(root, "src/lib/util.ts"), "export const todo = 'TODO later';\n");
    await fs.writeFile(path.join(root, "node_modules/x/index.js"), "TODO dep\n");
    await fs.writeFile(path.join(root, "README.md"), "# Readme\n");
  });

  for (const noRg of [false, true]) {
    const label = noRg ? " (js fallback)" : " (ripgrep)";
    it("globs respecting gitignore" + label, async () => {
      if (noRg) process.env.USTA_NO_RG = "1";
      const { ripgrep } = await import("../src/tool/search.ts");
      void ripgrep;
      const ctx = makeContext(root);
      const r = await globTool.execute({ pattern: "**/*.ts" }, ctx);
      const files = r.output.split("\n").sort();
      assert.deepEqual(files, ["src/lib/util.ts", "src/main.ts"]);
      const md = await globTool.execute({ pattern: "*.md" }, ctx);
      assert.equal(md.output, "README.md");
    });
  }

  it("greps in all modes", async () => {
    const ctx = makeContext(root);
    const files = await grepTool.execute({ pattern: "TODO" }, ctx);
    assert.deepEqual(files.output.split("\n").sort(), ["src/lib/util.ts", "src/main.ts"]);
    const content = await grepTool.execute({ pattern: "todo", case_insensitive: true, output_mode: "content", glob: "*.ts" }, ctx);
    assert.match(content.output, /src\/main.ts:1:\/\/ TODO: main/);
    const count = await grepTool.execute({ pattern: "TODO", output_mode: "count" }, ctx);
    assert.match(count.output, /2 matches in 2 files/);
    const none = await grepTool.execute({ pattern: "zzz_nothing" }, ctx);
    assert.equal(none.output, "No matches found.");
  });

  it("lists a tree", async () => {
    const ctx = makeContext(root);
    const r = await lsTool.execute({}, ctx);
    assert.match(r.output, /src\/\n {4}lib\/\n {6}util.ts\n {4}main.ts/);
    assert.doesNotMatch(r.output, /node_modules\/|dist\/|debug\.log/);
  });
});

describe("webfetch", () => {
  it("asks again before following a redirect to another origin", async () => {
    const http = await import("node:http");
    const target = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret internal data");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/meta`;
    const hops = http.createServer((req, res) => {
      if (req.url === "/same") res.writeHead(302, { location: "/final" }).end();
      else if (req.url === "/final") res.writeHead(200, { "content-type": "text/plain" }).end("same-origin page");
      else res.writeHead(302, { location: targetUrl }).end();
    });
    await new Promise<void>((r) => hops.listen(0, "127.0.0.1", r));
    const base = `http://localhost:${(hops.address() as { port: number }).port}`;
    const { webfetchTool } = await import("../src/tool/misc.ts");
    try {
      // Same-origin redirects need no new approval.
      const ctx1 = makeContext(await tempDir());
      const same = await webfetchTool.execute({ url: `${base}/same` }, ctx1);
      assert.match(same.output, /redirected to .*\/final/);
      assert.match(same.output, /same-origin page/);
      assert.equal(ctx1.permits.length, 1);
      // A cross-origin hop is checked separately and can be refused.
      const ctx2 = makeContext(await tempDir(), {});
      ctx2.deny = (req) => req.patterns[0] === targetUrl;
      await assert.rejects(webfetchTool.execute({ url: `${base}/go` }, ctx2), /denied/);
      assert.deepEqual(
        ctx2.permits.map((p) => p.patterns[0]),
        [`${base}/go`, targetUrl],
      );
      assert.match(ctx2.permits[1]!.title, /Follow redirect/);
    } finally {
      hops.close();
      target.close();
    }
  });
});

describe("websearch", () => {
  it("queries the configured backend and formats results", async () => {
    const http = await import("node:http");
    const { websearchTool, SEARCH_ENDPOINTS, searchBackend } = await import("../src/tool/websearch.ts");
    const seen: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];
    const srv = http.createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/brave")) res.end(JSON.stringify({ web: { results: [{ title: "Node <b>docs</b>", url: "https://nodejs.org/api", description: "The <strong>API</strong> reference" }] } }));
      else res.end(JSON.stringify({ results: [{ title: "Tavily hit", url: "https://example.com/a", content: "snippet text" }] }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const saved = { ...SEARCH_ENDPOINTS };
    SEARCH_ENDPOINTS.tavily = `${base}/tavily`;
    SEARCH_ENDPOINTS.brave = `${base}/brave`;
    try {
      const ctx = makeContext(await tempDir(), { config: { search: { provider: "tavily", apiKey: "tv-key" } } });
      const r = await websearchTool.execute({ query: "node streams", limit: 3, site: "https://nodejs.org/docs" }, ctx);
      assert.match(r.output, /^1\. Tavily hit\n {3}https:\/\/example\.com\/a\n {3}snippet text$/);
      assert.equal(seen[0]!.headers.authorization, "Bearer tv-key");
      assert.deepEqual(JSON.parse(seen[0]!.body), { query: "node streams site:nodejs.org", max_results: 3, search_depth: "basic" });
      assert.equal(ctx.permits[0]!.permission, "websearch");

      const ctx2 = makeContext(await tempDir(), { config: { search: { provider: "brave", apiKey: "br-key" } } });
      const b = await websearchTool.execute({ query: "fs.promises" }, ctx2);
      assert.match(b.output, /1\. Node docs\n {3}https:\/\/nodejs\.org\/api\n {3}The API reference/);
      assert.equal(seen[1]!.headers["x-subscription-token"], "br-key");
      assert.match(seen[1]!.url, /q=fs\.promises&count=5/);

      assert.equal(searchBackend({}).backend === "duckduckgo" || Boolean(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY || process.env.EXA_API_KEY), true);
      await assert.rejects(websearchTool.execute({ query: "x" }, makeContext(await tempDir(), { config: { search: { provider: "exa" } } })), /No API key|Search failed/);
    } finally {
      Object.assign(SEARCH_ENDPOINTS, saved);
      srv.close();
    }
  });

  it("parses DuckDuckGo HTML results", async () => {
    const { parseDuckDuckGo } = await import("../src/tool/websearch.ts");
    const html = `<div class="result results_links web-result"><div class="links_main">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html&amp;rut=abc">asyncio &mdash; Asynchronous I/O</a></h2>
      <a class="result__snippet" href="x">asyncio is a library to write <b>concurrent</b> code.</a></div></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result results_links"><a class="result__a" href="https://example.org/b">Second</a><div class="result__snippet">Two</div></div>`;
    assert.deepEqual(parseDuckDuckGo(html, 5), [
      { title: "asyncio — Asynchronous I/O", url: "https://docs.python.org/3/library/asyncio.html", snippet: "asyncio is a library to write concurrent code." },
      { title: "Second", url: "https://example.org/b", snippet: "Two" },
    ]);
  });
});
