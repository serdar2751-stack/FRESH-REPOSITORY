import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setColor } from "../src/ui/ansi.ts";
import { Editor } from "../src/ui/editor.ts";
import { type Key, KeyParser } from "../src/ui/keys.ts";
import { renderMarkdown } from "../src/ui/markdown.ts";
import { SelectPrompt, TextPrompt } from "../src/ui/prompts.ts";
import { stringWidth } from "../src/util/width.ts";

setColor(false);

function keys(...chunks: string[]): Key[] {
  const out: Key[] = [];
  const parser = new KeyParser((k) => out.push(k));
  for (const chunk of chunks) parser.feed(chunk);
  parser.dispose();
  return out;
}

function type(target: { handleKey(k: Key): unknown }, ...chunks: string[]): void {
  for (const k of keys(...chunks)) target.handleKey(k);
}

describe("key parser", () => {
  it("decodes CSI sequences, modifiers and control keys", () => {
    const ks = keys("\x1b[A\x1b[1;5C\x1b[Z\x01\x1bb\x7f\r\n\t\x1b[3~");
    assert.deepEqual(
      ks.map((k) => [k.name, Boolean(k.ctrl), Boolean(k.alt), Boolean(k.shift)]),
      [
        ["up", false, false, false],
        ["right", true, false, false],
        ["tab", false, false, true],
        ["a", true, false, false],
        ["b", false, true, false],
        ["backspace", false, false, false],
        ["enter", false, false, false],
        ["enter", true, false, false],
        ["tab", false, false, false],
        ["delete", false, false, false],
      ],
    );
  });

  it("recognizes Shift+Enter in kitty and modifyOtherKeys encodings", () => {
    for (const seq of ["\x1b[13;2u", "\x1b[27;2;13~"]) {
      const [k] = keys(seq);
      assert.equal(k?.name, "enter");
      assert.equal(k?.shift, true);
    }
  });

  it("joins sequences split across reads and keeps Unicode intact", () => {
    assert.deepEqual(keys("\x1b[", "B").map((k) => k.name), ["down"]);
    assert.deepEqual(keys("ş😀İ").map((k) => k.text), ["ş", "😀", "İ"]);
  });

  it("collects bracketed paste, even across reads", () => {
    const [p] = keys("\x1b[200~line1\r\nli", "ne2\x1b[201~");
    assert.equal(p?.name, "paste");
    assert.equal(p?.paste, "line1\nline2");
  });

  it("emits a lone Escape after a short delay", async () => {
    const out: Key[] = [];
    const parser = new KeyParser((k) => out.push(k));
    parser.feed("\x1b");
    assert.equal(out.length, 0);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(out.map((k) => k.name), ["escape"]);
    parser.dispose();
  });
});

describe("editor", () => {
  it("edits by code point and moves by line", () => {
    const e = new Editor();
    type(e, "merhaba😀");
    assert.equal(e.value, "merhaba😀");
    type(e, "\x7f");
    assert.equal(e.value, "merhaba");
    type(e, "\x01");
    assert.equal(e.pos, 0);
    type(e, ">> ");
    assert.equal(e.value, ">> merhaba");
    type(e, "\x05");
    assert.equal(e.pos, e.value.length);
    type(e, "\x17");
    assert.equal(e.value, ">> ");
  });

  it("submits on Enter and continues lines with backslash or Ctrl+J", () => {
    const e = new Editor();
    const sent: string[] = [];
    e.onSubmit = (t) => sent.push(t);
    type(e, "a\\\rb\nc\r");
    assert.deepEqual(sent, ["a\nb\nc"]);
    assert.equal(e.value, "");
    type(e, "\x1b[A");
    assert.equal(e.value, "a\nb\nc");
  });

  it("folds large pastes into a placeholder and expands them on submit", () => {
    const e = new Editor();
    const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    e.handleKey({ name: "paste", paste: big, sequence: big });
    assert.equal(e.value, "[Pasted text #1 +20 lines]");
    assert.equal(e.expanded(), big);
    let sent = "";
    e.onSubmit = (t) => (sent = t);
    type(e, "\r");
    assert.equal(sent, big);
  });

  it("places the cursor on a fresh row when a line exactly fills the width", () => {
    const e = new Editor();
    const width = 20;
    const avail = width - stringWidth(e.prompt) - 1;
    e.setValue("x".repeat(avail - 1));
    assert.deepEqual(e.render(width).cursor, { row: 0, col: 2 + avail - 1 });
    e.setValue("x".repeat(avail));
    const r = e.render(width);
    assert.deepEqual(r.cursor, { row: 1, col: 2 });
    assert.ok(r.lines.every((l) => stringWidth(l) <= width));
  });
});

describe("markdown", () => {
  it("renders blocks within the width", () => {
    const lines = renderMarkdown(
      "# Title\n\nSome **bold** and `code` with [docs](https://x.dev) text that wraps around the narrow width here.\n\n- one\n- two\n  1. nested\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n",
      40,
    );
    assert.equal(lines[0], "Title");
    assert.ok(lines.every((l) => stringWidth(l) <= 40));
    assert.ok(lines.join("\n").includes("docs\n(https://x.dev)") || lines.join(" ").includes("docs (https://x.dev)"));
    assert.ok(lines.includes("• one") && lines.includes("  1. nested"));
    assert.ok(lines.includes("│ quoted"));
    assert.ok(lines.includes("  a │ b") && lines.includes("  1 │ 2"));
    assert.ok(lines.includes("  const a = 1;"));
  });

  it("keeps styled text intact when colors are on", () => {
    setColor(true);
    try {
      const [line] = renderMarkdown("see [the docs](https://x.dev) and **this**", 80);
      assert.match(line!, /\x1b\[/);
      assert.equal(line!.replace(/\x1b\[[0-9;]*m/g, ""), "see the docs (https://x.dev) and this");
    } finally {
      setColor(false);
    }
  });
});

describe("prompts", () => {
  it("masks secrets but returns the real text", () => {
    let got: string | undefined;
    const p = new TextPrompt({ title: "API key", mask: true, placeholder: "paste the key", onDone: (t) => (got = t) });
    assert.match(p.render(50).lines.join("\n"), /paste the key/);
    type(p, "sk-secret");
    const text = p.render(50).lines.join("\n");
    assert.ok(!text.includes("sk-secret"));
    assert.match(text, /•{9}/);
    assert.match(text, /9 chars/);
    type(p, "\r");
    assert.equal(got, "sk-secret");
  });

  it("fits the terminal height, keeping the title and options", () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i + 1}`, value: String(i) }));
    const body = Array.from({ length: 30 }, (_, i) => `diff line ${i}`);
    const p = new SelectPrompt({ title: "Allow this edit?", body, options, onDone: () => {} });
    const full = p.render(60).lines;
    assert.equal(full.length, 1 + 30 + 1 + 12 + 1);
    for (const height of [40, 20, 9]) {
      const lines = p.render(60, height).lines;
      assert.ok(lines.length <= height, `height ${height}: ${lines.length} lines`);
      assert.match(lines[0]!, /Allow this edit\?/);
      assert.ok(lines.some((l) => l.includes("❯ 1. Option 1")));
      assert.match(lines.at(-1)!, /enter choose/);
    }
    const mid = p.render(60, 20).lines.join("\n");
    assert.match(mid, /diff line 0/);
    assert.match(mid, /… \d+ more lines/);
    const tiny = new TextPrompt({ title: "Key", body: ["a", "b", "c", "d", "e", "f"], mask: true, onDone: () => {} });
    assert.ok(tiny.render(40, 6).lines.length <= 6);
  });

  it("selects by number, asks for free text and filters", () => {
    let picked: [string | undefined, string | undefined] | undefined;
    const p = new SelectPrompt({
      title: "Pick",
      options: [
        { label: "A", value: "a" },
        { label: "Other", value: "o", input: { prompt: "Which?" } },
      ],
      onDone: (v, t) => (picked = [v, t]),
    });
    type(p, "2");
    assert.equal(picked, undefined);
    assert.match(p.render(40).lines.join("\n"), /Which\?/);
    type(p, "zzz\r");
    assert.deepEqual(picked, ["o", "zzz"]);

    let sel: string | undefined;
    const f = new SelectPrompt({
      title: "Model",
      filterable: true,
      options: [
        { label: "anthropic/claude-opus-5", value: "a" },
        { label: "openai/gpt-5", value: "b" },
      ],
      onDone: (v) => (sel = v),
    });
    type(f, "gpt");
    assert.ok(!f.render(60).lines.join("\n").includes("claude"));
    type(f, "\r");
    assert.equal(sel, "b");
  });
});
