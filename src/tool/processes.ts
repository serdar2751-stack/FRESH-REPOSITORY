import { spawn, type ChildProcess } from "node:child_process";
import { commandEnv, getShell, killTree } from "../util/shell.ts";
import { stripAnsi } from "../util/text.ts";

interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  output: string;
  /** Characters dropped from the start of `output` to bound memory. */
  dropped: number;
  /** Absolute read cursor (in characters emitted so far). */
  cursor: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: boolean;
  started: number;
}

const MAX_BUFFER = 2_000_000;

const managers = new Set<ProcessManager>();
let exitHooked = false;
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", () => {
    for (const m of managers) m.killAll();
  });
}

/** Long-running shell commands started with run_in_background. */
export class ProcessManager {
  private readonly procs = new Map<string, BackgroundProcess>();
  private counter = 0;

  constructor() {
    managers.add(this);
    hookExit();
  }

  start(command: string, cwd: string): BackgroundProcess {
    const shell = getShell();
    const id = `bg_${++this.counter}`;
    const child = spawn(shell.file, shell.args(command), {
      cwd,
      env: commandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const p: BackgroundProcess = {
      id,
      command,
      cwd,
      child,
      output: "",
      dropped: 0,
      cursor: 0,
      exitCode: null,
      signal: null,
      running: true,
      started: Date.now(),
    };
    const onData = (d: Buffer) => {
      p.output += stripAnsi(d.toString("utf8"));
      if (p.output.length > MAX_BUFFER) {
        const cut = p.output.length - MAX_BUFFER;
        p.output = p.output.slice(cut);
        p.dropped += cut;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      p.output += `\n${err.message}\n`;
      p.running = false;
      p.exitCode = 127;
    });
    child.on("close", (code, sig) => {
      p.running = false;
      p.exitCode = code;
      p.signal = sig;
    });
    this.procs.set(id, p);
    return p;
  }

  get(id: string): BackgroundProcess | undefined {
    return this.procs.get(id);
  }

  /** Output produced since the previous read. */
  readNew(id: string): { text: string; skipped: number } | undefined {
    const p = this.procs.get(id);
    if (!p) return undefined;
    const total = p.dropped + p.output.length;
    const start = Math.max(p.cursor, p.dropped);
    const skipped = start - p.cursor;
    const text = p.output.slice(start - p.dropped);
    p.cursor = total;
    return { text, skipped };
  }

  kill(id: string): boolean {
    const p = this.procs.get(id);
    if (!p || !p.running) return false;
    killTree(p.child, "SIGTERM");
    setTimeout(() => {
      if (p.running) killTree(p.child, "SIGKILL");
    }, 2000).unref();
    return true;
  }

  list(): BackgroundProcess[] {
    return [...this.procs.values()];
  }

  killAll(): void {
    for (const p of this.procs.values()) if (p.running) killTree(p.child, "SIGKILL");
  }
}
