/**
 * POSIX shell analysis for permission checks: splits a command line into
 * simple commands (across ;, &&, ||, |, &, newlines, subshells, command and
 * process substitutions, arithmetic expansions and unquoted heredoc bodies),
 * tracks argv, assignments and output redirections, and looks through
 * wrappers (timeout, env, xargs, sh -c, find -exec, sudo, ...) to the
 * commands that actually run.
 */

export interface SimpleCommand {
  /** Words after leading VAR=value assignments, quotes removed. */
  argv: string[];
  /** Targets of output redirections (>, >>, &>), excluding fd duplications. */
  writes: string[];
  /** Leading (or standalone) VAR=value assignments. */
  assigns: string[];
  /** Normalized text used for rule matching. */
  text: string;
}

export interface ParseResult {
  commands: SimpleCommand[];
  /** Constructs that could not be parsed reliably (unbalanced quotes, ...). */
  complex: boolean;
}

const OPERATORS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n"];
const MAX_DEPTH = 8;

/** Environment assignments that cannot change which program runs or how. */
const HARMLESS_VAR =
  /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR(_FORCE)?|TERM|COLUMNS|LINES|CI|NODE_ENV|RUST_BACKTRACE|RUST_LOG|DEBUG|VERBOSE|PYTHONUNBUFFERED|PYTHONDONTWRITEBYTECODE|PYTHONIOENCODING|PYTHONWARNINGS|TMPDIR)$/;

export function isHarmlessAssignment(assign: string): boolean {
  const name = assign.slice(0, assign.indexOf("="));
  return HARMLESS_VAR.test(name);
}

function makeCommand(argv: string[], writes: string[], assigns: string[]): SimpleCommand {
  const shown = assigns.filter((a) => !isHarmlessAssignment(a));
  return { argv, writes, assigns, text: [...shown, ...argv].join(" ") };
}

/** Decode a $'...' (ANSI-C quoted) string body. */
function decodeAnsiC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs, (_, e: string) => {
    const k = e[0]!;
    if (k === "x" || k === "u" || k === "U") return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/[0-7]/.test(k)) return String.fromCharCode(parseInt(e, 8));
    if (k === "c") return String.fromCharCode(e.charCodeAt(1) & 31);
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
    return simple[k] ?? k;
  });
}

/** Index of the parenthesis closing the one at `open`, honoring quotes and escapes; -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(s, i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return -1;
}

/** A heredoc delimiter word: quotes and escapes removed; any quoting disables body expansion. */
function readDelimiter(src: string, start: number): { text: string; quoted: boolean; end: number } | undefined {
  let i = start;
  let text = "";
  let quoted = false;
  while (i < src.length && !/[\s;|&<>()]/.test(src[i]!)) {
    const c = src[i]!;
    if (c === "\\") {
      quoted = true;
      text += src[i + 1] ?? "";
      i += 2;
    } else if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) return undefined;
      quoted = true;
      text += src.slice(i + 1, end);
      i = end + 1;
    } else {
      text += c;
      i++;
    }
  }
  return text ? { text, quoted, end: i } : undefined;
}

/**
 * Commands run by expansions inside text that is otherwise literal to the
 * parser: arithmetic expressions and unquoted heredoc bodies. Quotes are not
 * special there, so every $(...) and `...` counts.
 */
function scanSubstitutions(text: string, depth: number): ParseResult {
  const commands: SimpleCommand[] = [];
  let complex = depth > MAX_DEPTH;
  for (let i = 0; i < text.length && !complex; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      const end = matchParen(text, i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      const r = arithmeticOrSubstitution(text, i, end, depth + 1);
      commands.push(...r.commands);
      complex ||= r.complex;
      i = end;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(text, i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      const r = parseShell(text.slice(i + 1, end), depth + 1);
      commands.push(...r.commands);
      complex ||= r.complex;
      i = end;
    }
  }
  return { commands, complex };
}

/**
 * `$(...)` at `start` ending at `end`: arithmetic when written $(( ... )) with
 * the inner parenthesis closing right before the outer one; otherwise a
 * command substitution (possibly of a subshell, like `$((cmd) )`).
 */
function arithmeticOrSubstitution(s: string, start: number, end: number, depth: number): ParseResult {
  if (s[start + 2] === "(" && matchParen(s, start + 2) === end - 1) return scanSubstitutions(s.slice(start + 3, end - 1), depth);
  return parseShell(s.slice(start + 2, end), depth);
}

export function parseShell(input: string, depth = 0): ParseResult {
  const commands: SimpleCommand[] = [];
  let complex = depth > MAX_DEPTH;
  if (complex) return { commands, complex };

  let words: string[] = [];
  let writes: string[] = [];
  let cur = "";
  let inWord = false;
  let pendingRedirect: "write" | "read" | null = null;
  const heredocs: Array<{ delim: string; expand: boolean }> = [];

  const absorb = (r: ParseResult) => {
    commands.push(...r.commands);
    if (r.complex) complex = true;
  };
  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect === "write") writes.push(cur);
    else if (pendingRedirect === "read") {
      // input redirection target: not part of argv
    } else words.push(cur);
    pendingRedirect = null;
    cur = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    // Leading assignments (FOO=bar cmd) are kept apart from argv.
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const assigns = words.slice(0, i);
    const argv = words.slice(i);
    if (argv.length || writes.length || assigns.length) commands.push(makeCommand(argv, writes, assigns));
    words = [];
    writes = [];
    pendingRedirect = null;
  };

  const src = input;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;

    // Heredoc bodies start after the newline that ends the command line.
    if (c === "\n" && heredocs.length) {
      endCommand();
      i++;
      while (heredocs.length && i <= src.length) {
        const doc = heredocs.shift()!;
        const bodyStart = i;
        let bodyEnd = -1;
        for (;;) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          const lineStart = i;
          i = nl === -1 ? src.length : nl + 1;
          if (line.replace(/^\t+/, "") === doc.delim) {
            bodyEnd = lineStart;
            break;
          }
          if (nl === -1) break;
        }
        // An unterminated body could hide the commands that follow it.
        if (bodyEnd === -1) {
          complex = true;
          bodyEnd = src.length;
        }
        // Without a quoted delimiter the body undergoes command substitution.
        if (doc.expand) absorb(scanSubstitutions(src.slice(bodyStart, bodyEnd), depth + 1));
      }
      continue;
    }

    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      cur += src[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        complex = true;
        cur += src.slice(i + 1);
        inWord = true;
        break;
      }
      cur += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      // ANSI-C quoting: $'\x72\x6d' is "rm".
      let j = i + 2;
      while (j < src.length && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) {
        complex = true;
        break;
      }
      cur += decodeAnsiC(src.slice(i + 2, j));
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '"' || (c === "$" && src[i + 1] === '"')) {
      let j = i + (c === "$" ? 2 : 1);
      let buf = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1]!)) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(") {
          const end = matchParen(src, j + 1);
          if (end === -1) {
            complex = true;
            break;
          }
          absorb(arithmeticOrSubstitution(src, j, end, depth + 1));
          buf += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (src[j] === "`") {
          const end = findBacktick(src, j + 1);
          if (end === -1) {
            complex = true;
            break;
          }
          absorb(parseShell(src.slice(j + 1, end), depth + 1));
          buf += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        buf += src[j];
        j++;
      }
      if (j >= src.length) complex = true;
      cur += buf;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      absorb(arithmeticOrSubstitution(src, i, end, depth + 1));
      cur += src.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = findBacktick(src, i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      absorb(parseShell(src.slice(i + 1, end), depth + 1));
      cur += src.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "(" || c === ")" || ((c === "{" || c === "}") && !inWord && /[\s;]|^$/.test(src[i + 1] ?? ""))) {
      endCommand();
      i++;
      continue;
    }
    // Redirections: [n]>, [n]>>, &>, <, <<, <<<, >&n, n>&m
    const redir = /^(\d*|&)(>>|>\||>&?|<<<|<<-?|<&?)/.exec(src.slice(i));
    if (redir && (!inWord || /^\d+$/.test(cur))) {
      const op = redir[2]!;
      if (inWord && /^\d+$/.test(cur)) {
        cur = "";
        inWord = false;
      } else endWord();
      i += redir[0].length;
      if (op.startsWith("<<") && op !== "<<<") {
        // heredoc delimiter; any quoting disables expansion of the body
        while (src[i] === " " || src[i] === "\t") i++;
        const word = readDelimiter(src, i);
        if (word) {
          heredocs.push({ delim: word.text, expand: !word.quoted });
          i = word.end;
        } else complex = true;
        continue;
      }
      if (op.endsWith("&") && /^[\d-]/.test(src[i] ?? "")) {
        // fd duplication (2>&1, >&2): no file target
        while (/[\d-]/.test(src[i] ?? "")) i++;
        continue;
      }
      pendingRedirect = op.startsWith(">") ? "write" : "read";
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      endCommand();
      i += op.length;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  endCommand();
  if (heredocs.length) complex = true;
  return { commands, complex };
}

// ----- wrappers -----

type OptSpec = { withValue: Set<string>; longWithValue?: Set<string> };

/**
 * Skip leading options of a wrapper; returns the index of the first operand,
 * or -1 when an option is unknown (the command is then taken at face value).
 */
function skipOptions(args: string[], spec: OptSpec, flags: Set<string>): number {
  let k = 0;
  while (k < args.length) {
    const a = args[k]!;
    if (a === "--") return k + 1;
    if (!a.startsWith("-") || a === "-") return k;
    if (a.startsWith("--")) {
      const name = a.split("=")[0]!;
      if (spec.longWithValue?.has(name)) k += a.includes("=") ? 1 : 2;
      else if (flags.has(name)) k++;
      else return -1;
      continue;
    }
    // Short option cluster: -abc, or -oVALUE / -o VALUE for options taking a value.
    let consumedNext = false;
    for (let p = 1; p < a.length; p++) {
      const opt = "-" + a[p];
      if (spec.withValue.has(opt)) {
        if (p === a.length - 1) consumedNext = true;
        break;
      }
      if (!flags.has(opt)) return -1;
    }
    k += consumedNext ? 2 : 1;
  }
  return k;
}

const set = (...xs: string[]) => new Set(xs);

interface Unwrapped {
  /** Commands that actually run. */
  commands: SimpleCommand[];
  /** Keep the wrapper itself in the evaluation too (privilege changes). */
  keepWrapper?: boolean;
  complex?: boolean;
}

function inner(argv: string[], assigns: string[] = [], writes: string[] = []): SimpleCommand {
  return makeCommand(argv, writes, assigns);
}

/** Look through a wrapper command; undefined when `cmd` is not a wrapper. */
function unwrap(cmd: SimpleCommand, depth: number): Unwrapped | undefined {
  const [name, ...args] = cmd.argv;
  if (!name) return undefined;
  const base = name.slice(name.lastIndexOf("/") + 1);
  const carry = (argv: string[], extraAssigns: string[] = []): Unwrapped => ({ commands: [inner(argv, [...cmd.assigns, ...extraAssigns], cmd.writes)] });
  switch (base) {
    case "timeout": {
      const k = skipOptions(args, { withValue: set("-s", "-k"), longWithValue: set("--signal", "--kill-after") }, set("-v", "--verbose", "--preserve-status", "--foreground"));
      if (k < 0 || k + 1 >= args.length) return undefined;
      return carry(args.slice(k + 1));
    }
    case "nice": {
      const k = skipOptions(args, { withValue: set("-n"), longWithValue: set("--adjustment") }, set());
      const k2 = k >= 0 ? k : /^-\d+$/.test(args[0] ?? "") ? 1 : -1;
      if (k2 < 0 || k2 >= args.length) return undefined;
      return carry(args.slice(k2));
    }
    case "nohup":
    case "builtin": {
      const k = args[0] === "--" ? 1 : 0;
      return k < args.length ? carry(args.slice(k)) : undefined;
    }
    case "time": {
      const k = skipOptions(args, { withValue: set("-f") , longWithValue: set("--format") }, set("-p", "-v", "--verbose", "--portability", "-q", "--quiet"));
      if (k < 0 || k >= args.length) return undefined;
      return carry(args.slice(k));
    }
    case "stdbuf": {
      const k = skipOptions(args, { withValue: set("-i", "-o", "-e"), longWithValue: set("--input", "--output", "--error") }, set());
      if (k < 0 || k >= args.length) return undefined;
      return carry(args.slice(k));
    }
    case "ionice": {
      const k = skipOptions(args, { withValue: set("-c", "-n"), longWithValue: set("--class", "--classdata") }, set("-t", "--ignore"));
      if (k < 0 || k >= args.length) return undefined;
      return carry(args.slice(k));
    }
    case "command": {
      const k = skipOptions(args, { withValue: set() }, set("-p"));
      // command -v / -V only describe a command.
      if (k < 0 || k >= args.length) return undefined;
      return carry(args.slice(k));
    }
    case "exec": {
      const k = skipOptions(args, { withValue: set("-a") }, set("-c", "-l"));
      if (k < 0 || k >= args.length) return undefined;
      return carry(args.slice(k));
    }
    case "env": {
      const k = skipOptions(
        args,
        { withValue: set("-u", "-C"), longWithValue: set("--unset", "--chdir") },
        set("-i", "--ignore-environment", "-0", "--null", "-v", "--debug"),
      );
      if (k < 0) return { commands: [cmd], complex: true };
      let j = k;
      const assigns: string[] = [];
      while (j < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j]!)) assigns.push(args[j++]!);
      // Without a command env prints the environment, which can hold secrets.
      if (j >= args.length) return undefined;
      return carry(args.slice(j), assigns);
    }
    case "xargs": {
      const k = skipOptions(
        args,
        {
          withValue: set("-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"),
          longWithValue: set("--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"),
        },
        set("-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-p", "--interactive", "-x", "--exit", "-o", "--open-tty"),
      );
      if (k < 0) return undefined;
      return carry(k < args.length ? args.slice(k) : ["echo"]);
    }
    case "watch": {
      let exec = false;
      const k = skipOptions(
        args,
        { withValue: set("-n"), longWithValue: set("--interval") },
        set("-d", "--differences", "-t", "--no-title", "-b", "--beep", "-e", "--errexit", "-g", "--chgexit", "-c", "--color", "-x", "--exec", "-p", "--precise", "-w", "--no-wrap"),
      );
      if (k < 0 || k >= args.length) return undefined;
      exec = args.slice(0, k).some((a) => a === "-x" || a === "--exec");
      if (exec) return carry(args.slice(k));
      const r = parseShell(args.slice(k).join(" "), depth + 1);
      return { commands: r.commands, complex: r.complex };
    }
    case "sudo":
    case "doas": {
      const k =
        base === "sudo"
          ? skipOptions(
              args,
              { withValue: set("-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-T"), longWithValue: set("--user", "--group", "--close-from", "--host", "--prompt", "--role", "--type", "--other-user", "--chdir", "--command-timeout") },
              set("-A", "-b", "-E", "-H", "-k", "-K", "-n", "-P", "-S", "--preserve-env", "--askpass", "--background", "--set-home", "--non-interactive", "--stdin"),
            )
          : skipOptions(args, { withValue: set("-u", "-C") }, set("-n", "-s"));
      if (k < 0 || k >= args.length) return undefined;
      return { ...carry(args.slice(k)), keepWrapper: true };
    }
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ksh":
    case "ash": {
      let hasC = false;
      let k = 0;
      while (k < args.length) {
        const a = args[k]!;
        if (a === "--") {
          k++;
          break;
        }
        if (a === "-o" || a === "+o" || a === "-O" || a === "+O") {
          k += 2;
          continue;
        }
        if (/^[-+][a-zA-Z]+$/.test(a)) {
          if (a.startsWith("-") && a.includes("c")) hasC = true;
          k++;
          continue;
        }
        if (/^--(login|norc|noprofile|posix|restricted|verbose|noediting)$/.test(a)) {
          k++;
          continue;
        }
        break;
      }
      if (!hasC || k >= args.length) return undefined;
      const r = parseShell(args[k]!, depth + 1);
      return { commands: r.commands, complex: r.complex };
    }
    case "find": {
      const rest: string[] = [];
      const inners: SimpleCommand[] = [];
      for (let p = 0; p < args.length; p++) {
        const a = args[p]!;
        if (a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir") {
          let q = p + 1;
          while (q < args.length && args[q] !== ";" && args[q] !== "+") q++;
          if (q === p + 1 || q >= args.length) return { commands: [cmd], complex: true };
          inners.push(inner(args.slice(p + 1, q)));
          p = q;
          continue;
        }
        rest.push(a);
      }
      if (!inners.length) return undefined;
      return { commands: [makeCommand([name, ...rest], cmd.writes, cmd.assigns), ...inners] };
    }
    default:
      return undefined;
  }
}

/** The commands a command line actually runs, with wrappers looked through. */
export function analyzeCommand(command: string): ParseResult {
  const parsed = parseShell(command);
  const out: SimpleCommand[] = [];
  let complex = parsed.complex;
  const visit = (cmd: SimpleCommand, depth: number) => {
    if (depth > MAX_DEPTH) {
      complex = true;
      out.push(cmd);
      return;
    }
    const u = unwrap(cmd, depth);
    if (!u) {
      out.push(cmd);
      return;
    }
    if (u.complex) complex = true;
    if (u.keepWrapper) out.push(cmd);
    for (const c of u.commands) visit(c, depth + 1);
  };
  for (const c of parsed.commands) visit(c, 0);
  return { commands: out, complex };
}

/** Number of leading words that identify a command for "always allow" rules. */
const ARITY: Record<string, number> = {
  git: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  deno: 2,
  npx: 2,
  bunx: 2,
  pnpx: 2,
  cargo: 2,
  go: 2,
  docker: 2,
  podman: 2,
  kubectl: 2,
  helm: 2,
  terraform: 2,
  gh: 3,
  glab: 3,
  aws: 3,
  gcloud: 3,
  az: 3,
  pip: 2,
  pip3: 2,
  uv: 2,
  poetry: 2,
  pipenv: 2,
  conda: 2,
  make: 2,
  just: 2,
  dotnet: 2,
  mvn: 2,
  gradle: 2,
  "./gradlew": 2,
  brew: 2,
  apt: 2,
  "apt-get": 2,
  systemctl: 2,
  rails: 2,
  rake: 2,
  bundle: 2,
  composer: 2,
  mix: 2,
  swift: 2,
  flutter: 2,
  dart: 2,
  python: 2,
  python3: 2,
  node: 2,
  ruby: 2,
  php: 2,
  sudo: 2,
};

const ARITY_3_SUBCOMMANDS = new Set(["npm run", "pnpm run", "yarn run", "bun run", "npm exec", "docker compose", "uv run", "poetry run", "python -m", "python3 -m", "go mod", "cargo +nightly"]);

/** "git push origin main" -> "git push *" */
export function commandPrefix(argv: string[]): string {
  if (!argv.length) return "*";
  let arity = ARITY[argv[0]!] ?? 1;
  if (argv.length >= 2 && ARITY_3_SUBCOMMANDS.has(`${argv[0]} ${argv[1]}`)) arity = 3;
  const head = argv.slice(0, Math.min(arity, argv.length));
  // Skip flag-like words in the identifying prefix ("git -C dir status").
  if (head.some((w) => w.startsWith("-")) && argv[0] !== "python" && argv[0] !== "python3") return argv[0] + " *";
  return head.join(" ") + " *";
}

/** Pattern granted by "always allow" for a command: never a bare "*". */
export function alwaysPattern(cmd: SimpleCommand): string {
  if (!cmd.argv.length) return cmd.text;
  const prefix = commandPrefix(cmd.argv);
  const shown = cmd.assigns.filter((a) => !isHarmlessAssignment(a));
  return shown.length ? `${shown.join(" ")} ${prefix}` : prefix;
}

const SENSITIVE_PATH = [
  // .env files, but not the committed templates
  /(^|[/:=~])\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
  /(^|[/:=~])id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /(^|[/:=~])\.ssh(\/|$)/,
  /(^|[/:=~])\.(netrc|pgpass|npmrc|pypirc|git-credentials)$/,
  /(^|[/:=~])\.aws\/(credentials|config)$/,
  /(^|[/:=~])\.docker\/config\.json$/,
  /(^|[/:=~])\.kube\/config$/,
  /(^|[/:=~])\.gnupg(\/|$)/,
  /(^|[/:=~])credentials(\.json)?$/,
  /^\/etc\/(g?shadow|sudoers)/,
];

/** Arguments naming secret files (.env, private keys, credential stores). */
export function isSensitivePath(arg: string): boolean {
  return SENSITIVE_PATH.some((re) => re.test(arg));
}

const SAFE_SIMPLE = new Set([
  "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "fold", "fmt", "paste", "join", "rev", "tac", "expand", "unexpand",
  "which", "whereis", "type", "whoami", "id", "groups", "hostname", "uname", "arch", "nproc", "date", "cal", "uptime", "locale", "tty",
  "file", "stat", "du", "df", "tree", "realpath", "dirname", "basename", "readlink",
  "grep", "egrep", "fgrep", "rg", "ag", "diff", "cmp", "comm", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "shasum", "base64", "strings", "od", "hexdump",
  "true", "false", ":", "test", "[", "sleep", "ps", "free", "less", "more", "jq", "yq", "bat", "seq", "expr",
  "cd", "pushd", "popd", "dirs", "wait",
]);

const SAFE_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes", "--merged", "--no-merged", "--contains"]);

const SAFE_GIT = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "describe", "shortlog", "grep", "cat-file",
  "merge-base", "whatchanged", "for-each-ref", "name-rev", "count-objects", "check-ignore", "var", "version",
]);

const SAFE_NPM = new Set(["ls", "list", "la", "ll", "view", "v", "info", "show", "explain", "why", "outdated", "prefix", "root"]);

/** Short-option cluster containing `letter` (e.g. "-no" contains "o"). */
const hasShort = (a: string, letter: string) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter);

/** Flags that make an otherwise read-only command write files or run programs. */
const UNSAFE_ARGS: Record<string, (args: string[]) => boolean> = {
  sort: (a) => a.some((x) => hasShort(x, "o") || x.startsWith("--output") || x.startsWith("--compress-program")),
  tree: (a) => a.some((x) => x === "-o" || x.startsWith("--output")),
  rg: (a) => a.some((x) => x === "--pre" || x.startsWith("--pre=")),
  ag: (a) => a.some((x) => x.startsWith("--pager")),
  bat: (a) => a.some((x) => x.startsWith("--pager")),
  less: (a) => a.some((x) => x.startsWith("+") || x.startsWith("--")),
  more: (a) => a.some((x) => x.startsWith("+")),
  file: (a) => a.some((x) => hasShort(x, "C") || x === "--compile"),
  date: (a) => a.some((x) => hasShort(x, "s") || x.startsWith("--set")),
  hostname: (a) => a.some((x) => !x.startsWith("-")),
  uniq: (a) => a.filter((x) => !x.startsWith("-")).length > 1,
  yq: (a) => a.some((x) => hasShort(x, "i") || x.startsWith("--inplace")),
  cd: () => false,
};

/** Read-only commands that are auto-allowed unless a rule says otherwise. */
export function isSafeCommand(cmd: SimpleCommand): boolean {
  if (cmd.writes.some((w) => w !== "/dev/null" && w !== "/dev/stdout" && w !== "/dev/stderr")) return false;
  if (!cmd.assigns.every(isHarmlessAssignment)) return false;
  const [name, ...args] = cmd.argv;
  if (!name) return true;
  if (args.some(isSensitivePath)) return false;
  if (SAFE_SIMPLE.has(name)) return !UNSAFE_ARGS[name]?.(args);
  if (name === "set") return args.length > 0 && args.every((a) => /^[-+][a-zA-Z]+$/.test(a) || a === "-o" || a === "+o" || /^[a-z]+$/.test(a));
  if (name === "shopt") return args.length > 0 && args.every((a) => /^-[supqo]+$/.test(a) || /^[a-z_]+$/.test(a));
  if (name === "command") return args[0] === "-v" || args[0] === "-V";
  if (name === "find") {
    return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
  }
  if (name === "sed") {
    // Printing is safe; in-place edits, script files and the w/e commands are not.
    return !args.some(
      (a) =>
        a.startsWith("-i") ||
        a.startsWith("--in-place") ||
        hasShort(a, "f") ||
        a.startsWith("--file") ||
        /(^|[;/}])\s*[0-9,$]*[we]\s|\/[gpIi0-9]*[we](\s|$)/.test(a),
    );
  }
  if (name === "git") {
    let k = 0;
    while (k < args.length && args[k]!.startsWith("-")) {
      const a = args[k]!;
      // -c and --config-env set configuration that can run programs (core.pager, core.fsmonitor, ...).
      if (a === "-c" || a.startsWith("--config-env") || a.startsWith("--exec-path=")) return false;
      k += a === "-C" ? 2 : 1;
    }
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (!sub) return true;
    if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return false;
    if (sub === "grep" && rest.some((a) => a.startsWith("-O") || a.startsWith("--open-files-in-pager"))) return false;
    if (SAFE_GIT.has(sub)) return true;
    if (sub === "reflog") return rest[0] === undefined || rest[0] === "show" || rest[0]!.startsWith("-");
    if (sub === "branch") return rest.every((a) => SAFE_BRANCH_FLAGS.has(a));
    if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "worktree") return rest[0] === "list";
    if (sub === "submodule") return rest[0] === "status";
    if (sub === "tag") return rest.length === 0 || rest.every((a) => a === "-l" || a === "--list" || a === "-n");
    if (sub === "config") return rest.includes("--get") || rest.includes("--list") || rest.includes("-l") || rest.includes("--get-all");
    return false;
  }
  if (name === "npm" || name === "pnpm") return SAFE_NPM.has(args[0] ?? "") || (args.length === 1 && (args[0] === "--version" || args[0] === "-v"));
  if (name === "pip" || name === "pip3") return ["list", "show", "freeze", "check"].includes(args[0] ?? "") || (args.length === 1 && args[0] === "--version");
  if (name === "go") return args[0] === "version" || args[0] === "doc";
  if (name === "docker" || name === "podman") return ["ps", "images", "version", "info"].includes(args[0] ?? "") && args.length <= 3;
  if (["node", "python", "python3", "cargo", "rustc", "java", "deno", "bun", "ruby", "gcc", "clang", "make", "cmake", "tsc"].includes(name) && args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]!)) {
    return true;
  }
  return false;
}

/** Whether every command a command line runs is read-only. */
export function isReadOnlyCommandLine(command: string): boolean {
  const { commands, complex } = analyzeCommand(command);
  return !complex && commands.length > 0 && commands.every(isSafeCommand);
}

/** Wildcard match: `*` any sequence, `?` one character; "cmd *" also matches bare "cmd". */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp(
    "^" +
      pattern
        .split("")
        .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&")))
        .join("") +
      "$",
    "s",
  );
  if (re.test(value)) return true;
  if (pattern.endsWith(" *")) return wildcardMatch(pattern.slice(0, -2), value);
  return false;
}
