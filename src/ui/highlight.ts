import { c, colorEnabled } from "./ansi.ts";

const KEYWORDS: Record<string, string[]> = {
  js: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield interface type enum implements private protected public readonly declare namespace abstract as satisfies keyof".split(" "),
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self".split(" "),
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" "),
  rust: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while".split(" "),
  sh: "if then else elif fi for while do done case esac function in return export local readonly set unset source echo".split(" "),
  java: "abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while var record".split(" "),
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override nullptr using".split(" "),
  ruby: "def end if elsif else unless while until for in do return class module self nil true false yield begin rescue ensure require attr_accessor".split(" "),
};

const ALIASES: Record<string, string> = {
  javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", json: "js", jsonc: "js",
  python: "py", py: "py",
  golang: "go", go: "go",
  rs: "rust", rust: "rust",
  bash: "sh", shell: "sh", zsh: "sh", sh: "sh", console: "sh",
  java: "java", kotlin: "java", kt: "java", scala: "java", swift: "java", cs: "java", csharp: "java",
  c: "c", cpp: "c", "c++": "c", h: "c", hpp: "c",
  rb: "ruby", ruby: "ruby",
};

const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil", "NaN"]);

/** Lightweight single-line syntax coloring for code blocks. */
export function highlightLine(line: string, lang: string | undefined): string {
  if (!colorEnabled) return line;
  const family = lang ? ALIASES[lang.toLowerCase()] : undefined;
  const base = c.fg(252);
  if (!family) return base(line);
  const keywords = new Set(KEYWORDS[family] ?? []);
  const hashComment = family === "py" || family === "sh" || family === "ruby";
  const re = hashComment
    ? /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
    : /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out += base(line.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out += c.gray(tok);
    else if (m[2]) out += c.fg(150)(tok);
    else if (m[3]) out += c.fg(179)(tok);
    else if (m[4] && keywords.has(tok)) out += c.fg(176)(tok);
    else if (m[4] && LITERALS.has(tok)) out += c.fg(179)(tok);
    else if (m[4] && line[m.index + tok.length] === "(") out += c.fg(117)(tok);
    else out += base(tok);
    last = m.index + tok.length;
  }
  out += base(line.slice(last));
  return out;
}
