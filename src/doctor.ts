import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { paths } from "./config/paths.ts";
import { checkCredentials } from "./provider/registry.ts";
import { Runtime } from "./runtime.ts";
import { websearchBackendSummary } from "./tool/websearch.ts";
import { c } from "./ui/ansi.ts";
import { displayPath } from "./util/fs.ts";
import { runFile, which } from "./util/shell.ts";

/** `usta doctor`: check the environment and configuration, with hints. */
export async function runDoctor(cwd: string, opts: { online?: boolean } = {}): Promise<number> {
  let problems = 0;
  let notes = 0;
  const home = os.homedir();
  const ok = (s: string) => console.log(`${c.green("✓")} ${s}`);
  const warn = (s: string) => {
    notes++;
    console.log(`${c.yellow("!")} ${s}`);
  };
  const bad = (s: string) => {
    problems++;
    console.log(`${c.red("✗")} ${s}`);
  };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 20 || (major === 20 && minor >= 3)) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node}: usta needs 20.3 or newer`);

  const git = which("git");
  if (git) {
    const v = await runFile(git, ["--version"], { cwd, timeoutMs: 5000 });
    ok(v.stdout.trim() || "git");
  } else warn("git not found: undo covers only edits made by usta's own tools");
  if (which("rg")) ok("ripgrep (rg)");
  else warn("ripgrep (rg) not found: glob and grep use a slower built-in search");

  let rt: Runtime;
  try {
    rt = await Runtime.create({ cwd, mcp: false });
  } catch (err) {
    bad(`configuration: ${(err as Error).message}`);
    return 1;
  }
  try {
    const show = (p: string) => displayPath(p, home);
    if (!rt.loaded.sources.length) ok("config: defaults (no config files)");
    for (const s of rt.loaded.sources) ok(`config: ${show(s.path)}`);
    for (const w of rt.loaded.warnings) warn(w.replace(home, "~"));
    for (const w of rt.loaded.withheld) warn(`ignored ${w.keys.join(", ")} from ${show(w.path)}: this project is not trusted (usta trust)`);

    const withKeys = rt.registry.providerIds().filter((p) => rt.registry.hasCredentials(p));
    if (withKeys.length) ok(`providers with credentials: ${withKeys.join(", ")}`);
    else bad("no provider credentials: run `usta auth login <provider>` or set ANTHROPIC_API_KEY, OPENAI_API_KEY, ...");
    const model = rt.config.model ?? rt.registry.defaultModelRef();
    if (model) ok(`default model: ${model}`);
    else if (withKeys.length) warn("no default model: set \"model\" in the config or pick one with /model");
    if (opts.online) {
      for (const id of withKeys) {
        const r = await checkCredentials(rt.registry, id);
        if (r.status === "ok") ok(`${id}: key accepted`);
        else if (r.status === "rejected") bad(`${id}: key rejected (${r.message})`);
        else warn(`${id}: could not verify${r.message ? ` (${r.message})` : ""}`);
      }
    }

    ok(rt.snapshotter.kind === "git" ? "undo: git snapshots (restores every change, including shell commands)" : "undo: file snapshots (edits made by usta's tools only; the project is not a git repository)");

    const lsp = rt.lsp.status();
    if (!lsp.length) warn("language servers: off (lsp: false)");
    for (const s of lsp) {
      if (s.state === "not installed") warn(`${s.name}: not installed (install it for error feedback after edits)`);
      else ok(`${s.name}: available`);
    }
    for (const [bin, key] of [
      ["typescript-language-server", "typescript"],
      ["rust-analyzer", "rust"],
    ] as const) {
      if (!lsp.some((s) => s.id === key) && which(bin)) warn(`${bin} is installed but opt-in (it can run project code): set "lsp": { "${key}": true } to use it`);
    }

    const search = websearchBackendSummary(rt.config);
    if (search.ok) ok(`web search: ${search.text}`);
    else warn(`web search: ${search.text}`);

    const mcp = Object.keys(rt.config.mcp ?? {});
    if (mcp.length) ok(`MCP servers configured: ${mcp.join(", ")} (\`usta mcp\` tests the connections)`);

    try {
      await fs.mkdir(paths.data, { recursive: true });
      await fs.access(paths.data, constants.W_OK);
      ok(`data: ${show(paths.data)}`);
    } catch (err) {
      bad(`data directory ${paths.data} is not writable: ${(err as Error).message}`);
    }

    if (process.stdout.isTTY) ok(`terminal: ${process.env.TERM ?? "unknown"} ${process.stdout.columns}x${process.stdout.rows}`);
    else warn("stdout is not a terminal: the interactive UI needs one (`usta run` works anywhere)");
  } finally {
    await rt.close();
  }
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (problems) console.log(c.red(`\n${plural(problems, "problem")} found${notes ? `, ${plural(notes, "warning")}` : ""}.`));
  else console.log(notes ? c.yellow(`\nNo problems; ${plural(notes, "warning")} above.`) : c.green("\nAll good."));
  return problems ? 1 : 0;
}
