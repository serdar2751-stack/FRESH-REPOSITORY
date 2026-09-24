/**
 * Glob -> RegExp conversion supporting `**`, `*`, `?`, `[...]` classes and
 * `{a,b}` alternation. Paths are matched with forward slashes.
 */
export function globToRegExp(glob: string, opts: { dot?: boolean } = {}): RegExp {
  return new RegExp("^" + globToRegexSource(glob, opts.dot ?? true) + "$");
}

function globToRegexSource(glob: string, dot: boolean): string {
  let re = "";
  let i = 0;
  const n = glob.length;
  let braceDepth = 0;
  while (i < n) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` - any number of path segments.
        const prevSlash = i === 0 || glob[i - 1] === "/";
        const nextSlash = glob[i + 2] === "/";
        if (prevSlash && nextSlash) {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        if (prevSlash && i + 2 === n) {
          re += ".*";
          i += 2;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += dot ? "[^/]*" : "(?!\\.)[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        i++;
        continue;
      }
      let cls = glob.slice(i + 1, close);
      if (cls.startsWith("!") || cls.startsWith("^")) cls = "^" + cls.slice(1);
      re += "[" + cls.replace(/\\/g, "\\\\") + "]";
      i = close + 1;
      continue;
    }
    if (c === "{") {
      braceDepth++;
      re += "(?:";
      i++;
      continue;
    }
    if (c === "}" && braceDepth > 0) {
      braceDepth--;
      re += ")";
      i++;
      continue;
    }
    if (c === "," && braceDepth > 0) {
      re += "|";
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      re += escapeChar(glob[i + 1]!);
      i += 2;
      continue;
    }
    re += escapeChar(c);
    i++;
  }
  while (braceDepth-- > 0) re += ")";
  return re;
}

function escapeChar(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? "\\" + c : c;
}

export interface GlobMatcher {
  (relPath: string): boolean;
}

/**
 * Build a matcher with ripgrep-like semantics: a pattern without a slash
 * matches the basename at any depth; otherwise it matches the relative path.
 */
export function createGlobMatcher(pattern: string): GlobMatcher {
  let p = pattern.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  const hasSlash = p.includes("/");
  const re = globToRegExp(p);
  if (!hasSlash) {
    return (rel) => {
      const norm = rel.replace(/\\/g, "/");
      const base = norm.slice(norm.lastIndexOf("/") + 1);
      return re.test(base);
    };
  }
  return (rel) => re.test(rel.replace(/\\/g, "/"));
}

export function hasGlobChars(s: string): boolean {
  return /[*?[{]/.test(s);
}
