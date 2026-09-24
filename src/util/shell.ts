import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

let cachedShell: { file: string; args: (cmd: string) => string[]; name: string } | undefined;

/** Locate an executable on PATH. */
export function which(cmd: string): string | undefined {
  const exts = isWindows ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/**
 * The shell used to run model-issued commands. Bash is preferred everywhere
 * because models write bash; the user's interactive shell (zsh, fish) could
 * interpret commands differently.
 */
export function getShell(): { file: string; args: (cmd: string) => string[]; name: string } {
  if (cachedShell) return cachedShell;
  if (isWindows) {
    const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) =>
      existsSync(p),
    );
    const bash = gitBash ?? which("bash");
    if (bash) cachedShell = { file: bash, args: (c) => ["-c", c], name: "bash" };
    else {
      const comspec = process.env.ComSpec ?? "cmd.exe";
      cachedShell = { file: comspec, args: (c) => ["/d", "/s", "/c", c], name: "cmd" };
    }
    return cachedShell;
  }
  const bash = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"].find((p) => existsSync(p)) ?? which("bash");
  if (bash) cachedShell = { file: bash, args: (c) => ["-c", c], name: "bash" };
  else cachedShell = { file: "/bin/sh", args: (c) => ["-c", c], name: "sh" };
  return cachedShell;
}

/** Environment for non-interactive command execution. */
export function commandEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Keep tools from paging or prompting: there is no TTY on the other end.
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    EDITOR: process.env.EDITOR && process.env.USTA_KEEP_EDITOR ? process.env.EDITOR : "true",
    NO_COLOR: process.env.NO_COLOR ?? "1",
    TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
    USTA: "1",
    ...extra,
  };
}

/** Kill a process and its children. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onData?: (chunk: string) => void;
  /** Maximum characters kept in memory (head + tail are preserved). */
  maxBuffer?: number;
  stdin?: string;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  truncatedChars: number;
  durationMs: number;
}

/** Bounded output buffer that keeps the first and last part of a long stream. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  private readonly max: number;
  constructor(max = 1_000_000) {
    this.max = max;
  }

  push(chunk: string): void {
    const half = this.max / 2;
    if (this.head.length < half) {
      const take = Math.min(chunk.length, half - this.head.length);
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > half) {
      const cut = this.tail.length - half;
      this.dropped += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  get droppedChars(): number {
    return this.dropped;
  }

  toString(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n… [${this.dropped} characters omitted] …\n${this.tail}`;
  }
}

/** Run a shell command, capturing interleaved stdout/stderr. */
export function runShell(command: string, opts: RunOptions): Promise<RunResult> {
  const shell = getShell();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(shell.file, shell.args(command), {
      cwd: opts.cwd,
      env: commandEnv(opts.env),
      stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
    });
    const buf = new OutputBuffer(opts.maxBuffer);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const onChunk = (data: Buffer) => {
      const s = data.toString("utf8");
      buf.push(s);
      opts.onData?.(s);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }

    const terminate = () => {
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 2000).unref();
    };
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs)
        : undefined;
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        signal: sig,
        output: buf.toString(),
        timedOut,
        aborted,
        truncatedChars: buf.droppedChars,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => {
      buf.push(`\n${err.message}\n`);
      finish(127, null);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** Run a program (no shell) and capture stdout; used for git and ripgrep. */
export function runFile(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number; input?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const max = opts.maxBuffer ?? 20_000_000;
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString("utf8");
      else if (!killed) {
        killed = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 100_000) stderr += d.toString("utf8");
    });
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: 127, stdout, stderr: stderr + err.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}
