import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffText, formatUnifiedDiff } from "../src/util/diff.ts";
import { parseFrontmatter, parseYaml } from "../src/util/frontmatter.ts";
import { createGlobMatcher, globToRegExp } from "../src/util/glob.ts";
import { htmlToMarkdown } from "../src/util/html.ts";
import { IgnoreMatcher } from "../src/util/ignore.ts";
import { parseJsonc } from "../src/util/jsonc.ts";
import { validateInput } from "../src/util/schema.ts";
import { clipOutput, formatTokens, stableStringify } from "../src/util/text.ts";
import { stringWidth, wrapText } from "../src/util/width.ts";

describe("diff", () => {
  it("produces unified hunks", () => {
    const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nl\nm\n";
    const b = "a\nb\nc\nD\ne\nf\ng\nh\ni\nj\nl\nm\nk\n";
    const d = diffText(a, b);
    assert.equal(d.additions, 2);
    assert.equal(d.deletions, 1);
    assert.equal(d.hunks.length, 2);
    assert.deepEqual(d.hunks[0]!.lines, [" a", " b", " c", "-d", "+D", " e", " f", " g"]);
    assert.equal(d.hunks[0]!.oldStart, 1);
    assert.equal(d.hunks[1]!.newStart, 10);
    // A gap of exactly 2*context unchanged lines merges into one hunk.
    assert.equal(diffText("a\nb\nc\nd\ne\nf\ng\nh\n", "A\nb\nc\nd\ne\nf\ng\nH\n").hunks.length, 1);
  });

  it("merges nearby changes and handles empty sides", () => {
    const d = diffText("", "x\ny\n");
    assert.equal(d.hunks.length, 1);
    assert.equal(d.hunks[0]!.oldStart, 0);
    assert.equal(d.hunks[0]!.oldLines, 0);
    const u = formatUnifiedDiff("f.txt", "1\n2\n3\n", "1\n3\n");
    assert.match(u, /@@ -1,3 \+1,2 @@/);
  });

  it("diffs larger inputs correctly", () => {
    const a = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const b = [...a];
    b.splice(100, 3, "x", "y");
    b.splice(400, 0, "inserted");
    const d = diffText(a.join("\n") + "\n", b.join("\n") + "\n");
    assert.equal(d.deletions, 3);
    assert.equal(d.additions, 3);
  });
});

describe("glob", () => {
  it("matches globstar and braces", () => {
    assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/c.ts"));
    assert.ok(globToRegExp("*.{js,ts}").test("x.ts"));
    assert.ok(createGlobMatcher("*.md")("docs/readme.md"));
    assert.ok(!createGlobMatcher("docs/*.md")("other/readme.md"));
  });
});

describe("gitignore", () => {
  it("follows negation, anchoring and dir-only rules", () => {
    const m = new IgnoreMatcher();
    m.add("*.log\n!keep.log\n/build\nnode_modules/\ndocs/*.tmp\n");
    assert.ok(m.ignores("a.log", false));
    assert.ok(m.ignores("x/y/a.log", false));
    assert.ok(!m.ignores("keep.log", false));
    assert.ok(m.ignores("build", true));
    assert.ok(!m.ignores("src/build", true));
    assert.ok(m.ignores("pkg/node_modules", true));
    assert.ok(!m.ignores("node_modules", false));
    assert.ok(m.ignores("docs/a.tmp", false));
  });

  it("scopes nested ignore files", () => {
    const m = new IgnoreMatcher();
    m.add("*.gen.ts", "packages/a");
    assert.ok(m.ignores("packages/a/x.gen.ts", false));
    assert.ok(!m.ignores("packages/b/x.gen.ts", false));
  });
});

describe("yaml frontmatter", () => {
  it("parses nested structures", () => {
    const { data, body } = parseFrontmatter(`---
description: Reviews code  # trailing comment
model: anthropic/claude-opus-5
temperature: 0.2
tools: [read, grep, "glob"]
permission:
  edit: deny
  bash:
    "git diff*": allow
    "*": ask
list:
  - one
  - two: 2
    three: 3
prompt: |
  line one
  line two
folded: >
  a
  b
---
Body here
`);
    assert.equal(body, "Body here\n");
    assert.equal(data.description, "Reviews code");
    assert.equal(data.temperature, 0.2);
    assert.deepEqual(data.tools, ["read", "grep", "glob"]);
    assert.deepEqual(data.permission, { edit: "deny", bash: { "git diff*": "allow", "*": "ask" } });
    assert.deepEqual(data.list, ["one", { two: 2, three: 3 }]);
    assert.equal(data.prompt, "line one\nline two\n");
    assert.equal(data.folded, "a b\n");
  });

  it("parses flow mappings and empty docs", () => {
    assert.deepEqual(parseYaml("a: {x: 1, y: [2, 3]}"), { a: { x: 1, y: [2, 3] } });
    assert.deepEqual(parseFrontmatter("no frontmatter").data, {});
  });
});

describe("jsonc", () => {
  it("strips comments and trailing commas", () => {
    const v = parseJsonc(`{
      // comment
      "a": "http://x.y/z", /* block */
      "b": [1, 2,],
    }`);
    assert.deepEqual(v, { a: "http://x.y/z", b: [1, 2] });
  });
});

describe("schema", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      flag: { type: "boolean" },
      items: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["a", "b"] },
    },
    required: ["path"],
    additionalProperties: false,
  };

  it("coerces near-misses", () => {
    const r = validateInput({ path: "x", limit: "10", flag: "true", items: '["a"]' }, schema);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, { path: "x", limit: 10, flag: true, items: ["a"] });
  });

  it("reports errors", () => {
    const r = validateInput({ limit: 1.5, mode: "c", extra: 1 }, schema);
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("path: required")));
      assert.ok(r.errors.some((e) => e.includes("mode")));
      assert.ok(r.errors.some((e) => e.includes("unknown property")));
      assert.ok(r.errors.some((e) => e.includes("limit")));
    }
  });
});

describe("html", () => {
  it("converts common elements", () => {
    const md = htmlToMarkdown(
      `<html><head><title>T</title><style>x{}</style></head><body><h1>Hi</h1><p>Some <b>bold</b> and <a href="/x">link</a>.</p><ul><li>a</li><li>b</li></ul><pre><code>code  here</code></pre><script>evil()</script></body></html>`,
      "https://example.com/page",
    );
    assert.match(md, /^# Hi/m);
    assert.match(md, /\*\*bold\*\*/);
    assert.match(md, /\[link\]\(https:\/\/example.com\/x\)/);
    assert.match(md, /^- a$/m);
    assert.match(md, /```\ncode  here\n```/);
    assert.doesNotMatch(md, /evil/);
  });
});

describe("text helpers", () => {
  it("formats and clips", () => {
    assert.equal(formatTokens(1234), "1.2k");
    assert.equal(formatTokens(45_000), "45k");
    assert.equal(formatTokens(1_500_000), "1.5M");
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const c = clipOutput(big, { maxLines: 100 });
    assert.ok(c.truncated);
    assert.ok(c.text.split("\n").length <= 102);
    assert.match(c.text, /lines omitted/);
    assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("measures width and wraps", () => {
    assert.equal(stringWidth("abc"), 3);
    assert.equal(stringWidth("\u001b[31mabc\u001b[0m"), 3);
    assert.equal(stringWidth("日本"), 4);
    assert.equal(stringWidth("çğış"), 4);
    assert.deepEqual(wrapText("hello world foo", 11), ["hello world", "foo"]);
  });
});
