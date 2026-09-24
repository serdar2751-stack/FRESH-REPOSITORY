import fs from "node:fs/promises";
import path from "node:path";
import { globalConfigFiles, projectConfigFiles } from "./config/config.ts";
import { paths } from "./config/paths.ts";
import { authStore, trustStore } from "./config/store.ts";
import type { Effort } from "./core/types.ts";
import { EFFORT_LEVELS } from "./core/types.ts";
import type { Mode } from "./permission/permission.ts";
import { catalogModels } from "./provider/catalog.ts";
import { PRESETS } from "./provider/registry.ts";
import { Runtime } from "./runtime.ts";
import { exportMarkdown } from "./session/export.ts";
import { c, setColor } from "./ui/ansi.ts";
import { formatCost, formatTokens } from "./util/text.ts";
import { VERSION } from "./version.ts";

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(["model", "agent", "session", "cwd", "effort", "port", "host", "token", "max-steps", "allow", "file", "mode", "format", "key"]);
const ALIASES: Record<string, string> = {
  m: "model",
  a: "agent",
  s: "session",
  c: "continue",
  C: "cwd",
  q: "quiet",
  f: "file",
  p: "print",
  h: "help",
  v: "version",
  y: "yolo",
  "dangerously-skip-permissions": "yolo",
  "accept-edits": "auto-edit",
};
const COMMANDS = new Set(["run", "serve", "sessions", "models", "auth", "config", "trust", "untrust", "mcp", "help", "version", "export"]);

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  let command = "";
  const set = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      name = ALIASES[name] ?? name;
      if (eq !== -1) set(name, a.slice(eq + 1));
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) set(name, argv[++i]!);
      else set(name, "true");
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const letters = a.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const name = ALIASES[letters[j]!] ?? letters[j]!;
        if (VALUE_FLAGS.has(name)) {
          const rest = letters.slice(j + 1);
          set(name, rest || argv[++i] || "");
          break;
        }
        set(name, "true");
      }
      continue;
    }
    if (!command && !positional.length && COMMANDS.has(a)) command = a;
    else positional.push(a);
  }
  return { command, positional, flags };
}

const HELP = `${c.bold("usta")} ${VERSION} — an API-driven AI coding agent for your terminal

${c.bold("Usage")}
  usta [prompt]                 interactive session (optionally start with a prompt)
  usta run "prompt"             run once without the UI (scripts, CI, pipes)
  usta serve                    HTTP + SSE API with a built-in web UI
  usta sessions [list|show|export|delete] [id]
  usta models [provider]        list models (use --remote to query the provider)
  usta auth login|logout|list [provider]
  usta config [paths]           show merged config and where it comes from
  usta trust | untrust          trust this project's hooks, MCP servers and permissions
  usta mcp                      connect configured MCP servers and list their tools

${c.bold("Options")}
  -m, --model <provider/model>  e.g. anthropic/claude-opus-5, openai/gpt-5, ollama/qwen3-coder
  -a, --agent <name>            primary agent (default: build)
  -c, --continue                continue the most recent session
  -s, --session <id>            resume a session
      --plan | --auto-edit      start in plan mode / auto-accept edits
      --effort <level>          low | medium | high | xhigh | max
  -y, --yolo                    allow every action no rule denies (use with care)
      --trust                   trust project settings for this run
  -C, --cwd <dir>               working directory

${c.bold("usta run options")}
      --format text|json|quiet  output (json = one event per line)
  -q, --quiet                   print only the final answer
      --allow <rule>            allow without asking, e.g. edit, "bash:npm test*", webfetch (repeatable)
  -f, --file <path>             attach a file (repeatable)
      --max-steps <n>           stop after n model steps

${c.bold("usta serve options")}
      --port <n> (default 4096)  --host <addr> (default 127.0.0.1)  --token <secret>  --no-auth

Config: ${paths.config}/config.json and <project>/.usta/config.json · Docs: README.md`;

function flag(p: Parsed, name: string): string | undefined {
  return p.flags.get(name)?.at(-1);
}

function bool(p: Parsed, name: string): boolean {
  const v = flag(p, name);
  return v !== undefined && v !== "false";
}

function modeFrom(p: Parsed): Mode | undefined {
  const m = flag(p, "mode");
  if (m === "plan" || m === "auto-edit" || m === "normal") return m;
  if (bool(p, "plan")) return "plan";
  if (bool(p, "auto-edit")) return "auto-edit";
  return undefined;
}

function effortFrom(p: Parsed): Effort | undefined {
  const e = flag(p, "effort");
  if (!e) return undefined;
  if (!EFFORT_LEVELS.includes(e as Effort)) throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(", ")}`);
  return e as Effort;
}

async function sessionsCommand(p: Parsed, cwd: string): Promise<number> {
  const rt = await Runtime.create({ cwd, mcp: false });
  const [sub = "list", id] = p.positional;
  try {
    if (sub === "list") {
      const list = await rt.store.list({ includeSubagents: bool(p, "all") });
      if (!list.length) console.log(c.gray("No sessions in this project yet."));
      for (const s of list) {
        console.log(`${c.bold(s.id)}  ${s.title || c.gray("(untitled)")}  ${c.gray(`${new Date(s.updated).toLocaleString()} · ${s.messages} msgs · ${s.model}${s.cost ? " · " + formatCost(s.cost) : ""}`)}`);
      }
      return 0;
    }
    if (!id) throw new Error(`usage: usta sessions ${sub} <id>`);
    if (sub === "show" || sub === "export") {
      const s = await rt.loadSession(id);
      const md = exportMarkdown(s, { tools: !bool(p, "no-tools") });
      const file = p.positional[2];
      if (file) {
        await fs.writeFile(file, md);
        console.log(`Wrote ${file}`);
      } else process.stdout.write(md);
      return 0;
    }
    if (sub === "delete") {
      await rt.store.delete(id);
      console.log(`Deleted ${id}`);
      return 0;
    }
    throw new Error(`unknown subcommand: sessions ${sub}`);
  } finally {
    await rt.close();
  }
}

async function modelsCommand(p: Parsed, cwd: string): Promise<number> {
  const rt = await Runtime.create({ cwd, mcp: false });
  const only = p.positional[0];
  try {
    for (const id of rt.registry.providerIds()) {
      if (only && id !== only) continue;
      const has = rt.registry.hasCredentials(id);
      if (!only && !has) continue;
      console.log(`${c.bold(rt.registry.name(id))} ${c.gray(`(${id})`)}${has ? "" : c.yellow(" — no credentials")}`);
      if (bool(p, "remote") || (only && !PRESETS[id]?.catalog)) {
        try {
          const remote = await rt.registry.get(id).listModels?.();
          for (const m of remote ?? []) console.log(`  ${id}/${m.id}${m.contextWindow ? c.gray(`  ${formatTokens(m.contextWindow)} ctx`) : ""}`);
          continue;
        } catch (err) {
          console.log(c.red(`  could not list models: ${(err as Error).message}`));
        }
      }
      const family = PRESETS[id]?.catalog;
      for (const m of family ? catalogModels(family) : []) {
        const price = m.pricing ? c.gray(`  $${m.pricing.input}/$${m.pricing.output} per MTok`) : "";
        console.log(`  ${id}/${m.id}  ${c.gray(`${formatTokens(m.contextWindow)} ctx · ${formatTokens(m.maxOutput)} out`)}${price}`);
      }
      for (const m of Object.keys(rt.registry.providerConfig(id).models ?? {})) console.log(`  ${id}/${m}  ${c.gray("(config)")}`);
    }
    if (!rt.registry.providerIds().some((id) => rt.registry.hasCredentials(id))) {
      console.log(c.yellow("No provider credentials found. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / ... or run `usta auth login <provider>`."));
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const ch of stdin) chunks.push(ch as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return new Promise((resolve) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (d: string) => {
      for (const ch of d) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\x03") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function authCommand(p: Parsed): Promise<number> {
  const [sub = "list", provider] = p.positional;
  if (sub === "list") {
    const saved = authStore.all();
    for (const [id, preset] of Object.entries(PRESETS)) {
      const env = preset.env.find((e) => process.env[e]);
      const src = env ? `env ${env}` : saved[id] ? "saved" : preset.keyless ? "local (no key needed)" : "";
      console.log(`${src ? c.green("●") : c.gray("○")} ${id.padEnd(11)} ${c.gray(src || "not configured")}`);
    }
    return 0;
  }
  if (!provider) throw new Error(`usage: usta auth ${sub} <provider>`);
  if (sub === "login") {
    const key = flag(p, "key") ?? (await readSecret(`API key for ${provider}: `));
    if (!key) throw new Error("no key given");
    await authStore.set(provider, key);
    console.log(`Saved to ${authStore.file()} (readable only by you).`);
    return 0;
  }
  if (sub === "logout") {
    console.log((await authStore.remove(provider)) ? `Removed the saved key for ${provider}.` : `No saved key for ${provider}.`);
    return 0;
  }
  throw new Error(`unknown subcommand: auth ${sub}`);
}

async function configCommand(p: Parsed, cwd: string): Promise<number> {
  const root = Runtime.findRoot(cwd);
  if (p.positional[0] === "paths") {
    console.log(`config dir : ${paths.config}`);
    console.log(`data dir   : ${paths.data}`);
    console.log("global     : " + globalConfigFiles().join(", "));
    console.log("project    : " + projectConfigFiles(root, cwd).join("\n             "));
    return 0;
  }
  const rt = await Runtime.create({ cwd, mcp: false });
  try {
    console.log(c.gray(`# sources: ${rt.loaded.sources.map((s) => s.path).join(", ") || "(none)"}`));
    for (const w of rt.loaded.withheld) console.log(c.yellow(`# ignored (untrusted): ${w.keys.join(", ")} from ${w.path}`));
    const redacted = JSON.parse(JSON.stringify(rt.config, (k, v) => (k === "apiKey" && typeof v === "string" && !v.startsWith("env:") ? "***" : v)));
    console.log(JSON.stringify(redacted, null, 2));
    console.log(c.gray(`# default model: ${rt.config.model ?? rt.registry.defaultModelRef() ?? "(none)"}`));
    return 0;
  } finally {
    await rt.close();
  }
}

async function mcpCommand(cwd: string, trusted: boolean): Promise<number> {
  const rt = await Runtime.create({ cwd, trusted: trusted || undefined });
  try {
    if (!rt.mcp.statuses.size) console.log(c.gray('No MCP servers configured. Add them under "mcp" in your config.'));
    for (const st of rt.mcp.statuses.values()) {
      console.log(`${st.status === "connected" ? c.green("●") : st.status === "disabled" ? c.gray("○") : c.red("●")} ${c.bold(st.name)} ${c.gray(st.status)}${st.error ? " " + c.red(st.error) : ""}`);
      for (const t of rt.mcp.tools().filter((x) => x.name.startsWith(`mcp__${st.name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`))) {
        console.log(`  ${t.name} ${c.gray(t.description.slice(0, 80))}`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const p = parseArgs(argv);
  if (bool(p, "no-color")) setColor(false);
  if (bool(p, "version") || p.command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (bool(p, "help") || p.command === "help") {
    console.log(HELP);
    return 0;
  }
  const cwd = path.resolve(flag(p, "cwd") ?? process.cwd());
  try {
    await fs.access(cwd);
  } catch {
    console.error(`usta: directory not found: ${cwd}`);
    return 2;
  }
  const trusted = bool(p, "trust");
  const prompt = p.positional.join(" ");
  switch (p.command) {
    case "run": {
      const { runHeadless } = await import("./headless.ts");
      const format = bool(p, "quiet") ? "quiet" : bool(p, "json") ? "json" : ((flag(p, "format") as "text" | "json" | "quiet" | undefined) ?? "text");
      return runHeadless({
        cwd,
        prompt,
        model: flag(p, "model"),
        agent: flag(p, "agent"),
        continueLast: bool(p, "continue"),
        session: flag(p, "session"),
        yolo: bool(p, "yolo"),
        trusted: trusted || undefined,
        mode: modeFrom(p),
        effort: effortFrom(p),
        format,
        maxSteps: flag(p, "max-steps") ? Number(flag(p, "max-steps")) : undefined,
        allow: p.flags.get("allow"),
        files: p.flags.get("file"),
        verbose: bool(p, "verbose"),
      });
    }
    case "serve": {
      const { runServer } = await import("./server/server.ts");
      return runServer({
        cwd,
        port: Number(flag(p, "port") ?? 4096),
        host: flag(p, "host") ?? "127.0.0.1",
        token: flag(p, "token"),
        noAuth: bool(p, "no-auth"),
        model: flag(p, "model"),
        yolo: bool(p, "yolo"),
        trusted: trusted || undefined,
      });
    }
    case "sessions":
      return sessionsCommand(p, cwd);
    case "export":
      return sessionsCommand({ ...p, positional: ["export", ...p.positional] }, cwd);
    case "models":
      return modelsCommand(p, cwd);
    case "auth":
      return authCommand(p);
    case "config":
      return configCommand(p, cwd);
    case "trust":
      await trustStore.trust(Runtime.findRoot(cwd));
      console.log(`Trusted ${Runtime.findRoot(cwd)}`);
      return 0;
    case "untrust":
      await trustStore.untrust(Runtime.findRoot(cwd));
      console.log(`No longer trusting ${Runtime.findRoot(cwd)}`);
      return 0;
    case "mcp":
      return mcpCommand(cwd, trusted);
    default: {
      if (bool(p, "print")) {
        const { runHeadless } = await import("./headless.ts");
        return runHeadless({ cwd, prompt, model: flag(p, "model"), agent: flag(p, "agent"), yolo: bool(p, "yolo"), format: "quiet", continueLast: bool(p, "continue"), session: flag(p, "session") });
      }
      const { runRepl } = await import("./ui/repl.ts");
      return runRepl({
        cwd,
        model: flag(p, "model"),
        agent: flag(p, "agent"),
        continueLast: bool(p, "continue"),
        session: flag(p, "session"),
        yolo: bool(p, "yolo"),
        prompt: prompt || undefined,
        mode: modeFrom(p),
        effort: effortFrom(p),
      });
    }
  }
}
