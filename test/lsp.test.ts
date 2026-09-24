import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "../src/lsp/client.ts";
import { LspClient } from "../src/lsp/client.ts";
import { LspManager, newErrors } from "../src/lsp/manager.ts";
import { tempDir } from "./helpers/context.ts";

const SERVER = fileURLToPath(new URL("./helpers/lsp-server.mjs", import.meta.url));
const fake = (env?: Record<string, string>) => ({ fake: { command: [process.execPath, SERVER], extensions: [".txt"], ...(env ? { env } : {}) } });

describe("lsp client", () => {
  it("initializes, answers server requests and tracks diagnostics per version", async () => {
    const root = await tempDir("usta-lsp-");
    const client = new LspClient({ id: "fake", command: [process.execPath, SERVER], root, settings: { fake: { strict: true } } });
    try {
      await client.start();
      assert.equal(client.state, "ready");
      const file = path.join(root, "a.txt");
      const first = await client.waitForDiagnostics(file, client.sync(file, "ok\nERROR one\nWARN two\n"), 5000);
      assert.deepEqual(
        first?.map((d) => [d.range.start.line, d.severity, d.message]),
        [
          [1, 1, "found ERROR: ERROR one"],
          [2, 2, "found WARN: WARN two"],
        ],
      );
      assert.deepEqual(await client.waitForDiagnostics(file, client.sync(file, "ok\n"), 5000), []);
      assert.equal(client.openDocuments, 1);
    } finally {
      await client.close();
    }
    assert.equal(client.state, "closed");
  });

  it("lets staged publishes settle before answering", async () => {
    const root = await tempDir("usta-lsp-");
    const client = new LspClient({ id: "fake", command: [process.execPath, SERVER], root, env: { FAKE_LSP_STAGED: "1" } });
    try {
      await client.start();
      const file = path.join(root, "b.txt");
      const diags = await client.waitForDiagnostics(file, client.sync(file, "ERROR late\n"), 5000);
      assert.equal(diags?.length, 1);
    } finally {
      await client.close();
    }
  });

  it("reports servers that cannot start", async () => {
    const client = new LspClient({ id: "missing", command: ["/nonexistent/usta-lsp"], root: await tempDir("usta-lsp-") });
    await assert.rejects(client.start());
    assert.equal(client.state, "failed");
    assert.ok(client.error);
  });
});

describe("lsp manager", () => {
  it("reports only the errors introduced since a file was read", async () => {
    const root = await tempDir("usta-lsp-");
    const file = path.join(root, "notes.txt");
    await fs.writeFile(file, "ERROR old\nfine\n");
    const lsp = new LspManager({ root, config: fake() });
    try {
      lsp.touch(file);
      await fs.writeFile(file, "ERROR old\nfine\nERROR new\nWARN meh\n");
      const report = await lsp.diagnose([file]);
      assert.equal(report?.errors, 1);
      assert.equal(
        report?.text,
        '<diagnostics file="notes.txt">\nERROR [3:1] found ERROR: ERROR new (fake error)\n</diagnostics>\n(1 other error in this file predate your changes.)',
      );
      // Fixing the new error leaves nothing to report.
      await fs.writeFile(file, "ERROR old\nfine\n");
      assert.deepEqual(await lsp.diagnose([file]), { text: "", errors: 0 });
      const st = lsp.status().find((s) => s.id === "fake");
      assert.equal(st?.state, "ready");
      assert.equal(st?.documents, 1);
    } finally {
      await lsp.close();
    }
  });

  it("treats unseen files as new and ignores other extensions", async () => {
    const root = await tempDir("usta-lsp-");
    const file = path.join(root, "new.txt");
    await fs.writeFile(file, "ERROR a\nERROR b\n");
    const lsp = new LspManager({ root, config: { ...fake(), python: false, go: false, clangd: false } });
    try {
      const report = await lsp.diagnose([file, path.join(root, "other.md")]);
      assert.equal(report?.errors, 2);
      assert.doesNotMatch(report!.text, /predate/);
      // Deleted files are closed quietly.
      await fs.rm(file);
      assert.deepEqual(await lsp.diagnose([file]), { text: "", errors: 0 });
    } finally {
      await lsp.close();
    }
  });

  it("selects servers from config; project-code servers are opt-in", () => {
    const ids = (config?: ConstructorParameters<typeof LspManager>[0]["config"]) => new LspManager({ root: "/", config }).status().map((s) => s.id);
    assert.equal(new LspManager({ root: "/", config: false }).enabled, false);
    assert.deepEqual(ids(undefined), ["python", "go", "clangd"]);
    assert.deepEqual(ids(true), ["python", "go", "clangd", "typescript", "rust"]);
    assert.deepEqual(ids({ typescript: true, go: false }), ["python", "clangd", "typescript"]);
    assert.deepEqual(ids({ mine: { command: ["x"], extensions: ["py"] }, broken: { command: ["y"] } }), ["mine", "python", "go", "clangd"]);
  });

  it("compares errors by code and message, not position", () => {
    const d = (message: string, line: number, severity = 1): Diagnostic => ({ message, severity, range: { start: { line, character: 0 }, end: { line, character: 1 } } });
    const { added, preexisting } = newErrors([d("a", 1), d("x", 5)], [d("a", 3), d("a", 9), d("b", 4), d("x", 7), d("w", 2, 2)]);
    assert.deepEqual(added.map((x) => [x.message, x.range.start.line]), [["a", 3], ["a", 9], ["b", 4]]);
    assert.equal(preexisting, 1);
  });
});
