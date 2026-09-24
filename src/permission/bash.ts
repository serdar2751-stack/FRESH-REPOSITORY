/**
 * Minimal POSIX shell parsing for permission checks: splits a command line
 * into simple commands (across ;, &&, ||, |, &, newlines, subshells and
 * command substitutions), tracking argv and output redirections.
 */

export interface SimpleCommand {
  /** Words after leading VAR=value assignments, quotes removed. */
  argv: string[];
  /** Targets of output redirections (>, >>, &>), excluding fd duplications. */
  writes: string[];
  /** Normalized text used for rule matching. */
  text: string;
}

export interface ParseResult {
  commands: SimpleCommand[];
  /** Constructs that could not be parsed reliably (unbalanced quotes, ...). */
  complex: boolean;
}

const OPERATORS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n"];

export function parseShell(input: string): ParseResult {
  const commands: SimpleCommand[] = [];
  let complex = false;

  let words: string[] = [];
  let writes: string[] = [];
  let cur = "";
  let inWord = false;
  let pendingRedirect: "write" | "read" | null = null;
  const heredocs: string[] = [];

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
    // Strip leading assignments (FOO=bar cmd).
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    const argv = words.slice(i);
    if (argv.length || writes.length) {
      commands.push({ argv, writes, text: argv.join(" ") });
    }
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
        const delim = heredocs.shift()!;
        for (;;) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          i = nl === -1 ? src.length : nl + 1;
          if (line.replace(/^\t+/, "") === delim || nl === -1) break;
        }
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
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1]!)) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(" && src[j + 2] !== "(") {
          const end = matchParen(src, j + 1);
          if (end === -1) {
            complex = true;
            break;
          }
          commands.push(...parseShell(src.slice(j + 2, end)).commands);
          buf += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (src[j] === "`") {
          const end = src.indexOf("`", j + 1);
          if (end === -1) {
            complex = true;
            break;
          }
          commands.push(...parseShell(src.slice(j + 1, end)).commands);
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
      if (src[i + 2] === "(") {
        // arithmetic expansion $(( ... ))
        const end = src.indexOf("))", i + 3);
        const stop = end === -1 ? src.length : end + 2;
        cur += src.slice(i, stop);
        inWord = true;
        i = stop;
        continue;
      }
      const end = matchParen(src, i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      commands.push(...parseShell(src.slice(i + 2, end)).commands);
      cur += src.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end === -1) {
        complex = true;
        break;
      }
      commands.push(...parseShell(src.slice(i + 1, end)).commands);
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
        // heredoc delimiter
        while (src[i] === " " || src[i] === "\t") i++;
        const m = /^(['"]?)([^\s'";|&<>]+)\1/.exec(src.slice(i));
        if (m) {
          heredocs.push(m[2]!);
          i += m[0].length;
        }
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
  return { commands, complex };
}

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
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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

const SAFE_SIMPLE = new Set([
  "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "column", "nl",
  "which", "whereis", "type", "whoami", "id", "hostname", "uname", "date", "cal", "uptime",
  "file", "stat", "du", "df", "tree", "realpath", "dirname", "basename", "readlink",
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "diff", "cmp", "comm", "md5sum", "sha1sum", "sha256sum", "shasum",
  "true", "false", "test", "[", "sleep", "ps", "free", "less", "more", "jq", "yq", "bat",
]);

const SAFE_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"]);

const SAFE_GIT = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "shortlog", "reflog", "grep", "cat-file", "merge-base", "whatchanged"]);

/** Read-only commands that are auto-allowed unless a rule says otherwise. */
export function isSafeCommand(cmd: SimpleCommand): boolean {
  if (cmd.writes.some((w) => w !== "/dev/null")) return false;
  const [name, ...args] = cmd.argv;
  if (!name) return true;
  if (SAFE_SIMPLE.has(name)) {
    if ((name === "sort" || name === "tree") && args.some((a) => a === "-o" || a.startsWith("--output") || a === "-o=")) return false;
    return true;
  }
  if (name === "find") {
    return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
  }
  if (name === "sed") {
    // Printing is safe; in-place edits and the w/e commands are not.
    return !args.some((a) => a.startsWith("-i") || a.startsWith("--in-place") || /(^|[;/}])\s*[0-9,$]*[we]\s|\/[gpIi0-9]*[we](\s|$)/.test(a));
  }
  if (name === "git") {
    let k = 0;
    while (k < args.length && args[k]!.startsWith("-")) k += args[k] === "-C" || args[k] === "-c" ? 2 : 1;
    const sub = args[k];
    const rest = args.slice(k + 1);
    if (!sub) return true;
    if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return false;
    if (SAFE_GIT.has(sub)) return true;
    if (sub === "branch") return rest.every((a) => SAFE_BRANCH_FLAGS.has(a));
    if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "tag") return rest.length === 0 || rest.every((a) => a === "-l" || a === "--list" || a === "-n");
    if (sub === "config") return rest.includes("--get") || rest.includes("--list") || rest.includes("-l") || rest.includes("--get-all");
    return false;
  }
  if ((name === "node" || name === "python" || name === "python3" || name === "npm" || name === "go" || name === "cargo" || name === "rustc" || name === "java" || name === "deno" || name === "bun") && args.length === 1 && (args[0] === "--version" || args[0] === "-v" || args[0] === "-V" || args[0] === "version")) {
    return true;
  }
  return false;
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
