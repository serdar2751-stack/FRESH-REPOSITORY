import path from "node:path";
import type { PermissionAction, PermissionConfig } from "../config/config.ts";
import { newId } from "../util/ids.ts";
import { isReadOnlyCommandLine, wildcardMatch } from "./bash.ts";

export type Mode = "normal" | "auto-edit" | "plan" | "yolo";

export interface Rule {
  permission: string;
  pattern: string;
  action: PermissionAction;
  /** Custom matcher (used for the built-in read-only command list). */
  test?: (value: string) => boolean;
  source?: string;
}

/** Tools that modify files share the "edit" permission. */
export const EDIT_TOOLS = new Set(["edit", "write", "apply_patch"]);

export interface PermissionRequest {
  id: string;
  sessionId: string;
  callId?: string;
  tool: string;
  permission: string;
  /** Values matched against rules: paths, commands, URLs. */
  patterns: string[];
  /** Patterns granted by an "always" answer. */
  always: string[];
  title: string;
  detail?: { diff?: string; command?: string; url?: string; path?: string; preview?: string };
  agent?: string;
  /**
   * For bash: whether each pattern is a read-only command, decided from the
   * parsed command (more precise than re-parsing the pattern text).
   */
  readOnly?: boolean[];
}

export type PermissionDecision = "once" | "session" | "always" | "deny";

export interface PermissionReply {
  decision: PermissionDecision;
  /** Guidance for the model when denying. */
  feedback?: string;
}

export class PermissionDeniedError extends Error {
  readonly feedback?: string;
  readonly byRule: boolean;
  constructor(message: string, opts: { feedback?: string; byRule?: boolean } = {}) {
    super(message);
    this.name = "PermissionDeniedError";
    this.feedback = opts.feedback;
    this.byRule = opts.byRule ?? false;
  }
}

/** Special pattern matching read-only shell commands (ls, git status, rg, ...). */
export const READ_ONLY = "@readonly";

function readOnlyCommand(cmd: string): boolean {
  return isReadOnlyCommandLine(cmd);
}

/** Secret files: reading them needs approval even inside the project. */
const SECRET_FILES = [
  "*.env",
  "*.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*id_rsa",
  "*id_dsa",
  "*id_ecdsa",
  "*id_ed25519",
  "*.netrc",
  "*.pgpass",
  "*.npmrc",
  "*.pypirc",
  "*.git-credentials",
  "*credentials.json",
];

/** Built-in defaults; user config rules are appended after these (last match wins). */
export function defaultRules(): Rule[] {
  return [
    { permission: "*", pattern: "*", action: "ask", source: "default" },
    { permission: "read", pattern: "*", action: "allow", source: "default" },
    ...SECRET_FILES.map<Rule>((pattern) => ({ permission: "read", pattern, action: "ask", source: "default" })),
    { permission: "read", pattern: "*.env.example", action: "allow", source: "default" },
    { permission: "read", pattern: "*.env.sample", action: "allow", source: "default" },
    { permission: "read", pattern: "*.env.template", action: "allow", source: "default" },
    { permission: "edit", pattern: "*", action: "ask", source: "default" },
    { permission: "bash", pattern: "*", action: "ask", source: "default" },
    { permission: "bash", pattern: READ_ONLY, action: "allow", source: "default", test: readOnlyCommand },
    { permission: "webfetch", pattern: "*", action: "ask", source: "default" },
    { permission: "external_directory", pattern: "*", action: "ask", source: "default" },
    { permission: "task", pattern: "*", action: "allow", source: "default" },
    { permission: "skill", pattern: "*", action: "allow", source: "default" },
  ];
}

export function rulesFromConfig(cfg: PermissionConfig | undefined, source: string): Rule[] {
  const rules: Rule[] = [];
  for (const [permission, value] of Object.entries(cfg ?? {})) {
    const perm = permission === "write" || permission === "apply_patch" ? "edit" : permission;
    if (typeof value === "string") rules.push({ permission: perm, pattern: "*", action: value, source });
    else if (value && typeof value === "object") {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({ permission: perm, pattern, action, source, ...(pattern === READ_ONLY ? { test: readOnlyCommand } : {}) });
      }
    }
  }
  return rules;
}

function permissionMatches(rulePerm: string, perm: string): boolean {
  return rulePerm === perm || (rulePerm.includes("*") && wildcardMatch(rulePerm, perm));
}

/** Last matching rule wins. `readOnly` answers the "@readonly" rule when known. */
export function evaluate(rules: Rule[], permission: string, value: string, readOnly?: boolean): { action: PermissionAction; rule?: Rule } {
  let found: Rule | undefined;
  for (const r of rules) {
    if (!permissionMatches(r.permission, permission)) continue;
    const ok = r.pattern === READ_ONLY && readOnly !== undefined ? readOnly : r.test ? r.test(value) : wildcardMatch(r.pattern, value);
    if (ok) found = r;
  }
  return { action: found?.action ?? "ask", rule: found };
}

export interface PermissionManagerOptions {
  rules: Rule[];
  /** Interactive approval handler; undefined means requests needing approval are denied. */
  ask?: (req: PermissionRequest) => Promise<PermissionReply>;
  /** Allow everything that is not explicitly denied (--yolo). */
  yolo?: boolean;
  /** Persist "always" grants (per project). */
  persist?: (rules: Rule[]) => Promise<void>;
  root: string;
}

export interface CheckOptions {
  agentRules?: Rule[];
  mode?: Mode;
}

export class PermissionManager {
  private readonly baseRules: Rule[];
  private readonly sessionRules = new Map<string, Rule[]>();
  private persisted: Rule[] = [];
  askHandler?: (req: PermissionRequest) => Promise<PermissionReply>;
  yolo: boolean;
  private readonly persistFn?: (rules: Rule[]) => Promise<void>;
  /** Serializes interactive prompts so parallel tool calls ask one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: PermissionManagerOptions) {
    this.baseRules = opts.rules;
    this.askHandler = opts.ask;
    this.yolo = opts.yolo ?? false;
    this.persistFn = opts.persist;
  }

  setPersisted(rules: Rule[]): void {
    this.persisted = rules;
  }

  persistedRules(): Rule[] {
    return [...this.persisted];
  }

  rulesFor(sessionId: string, agentRules: Rule[] = []): Rule[] {
    return [...this.baseRules, ...this.persisted, ...agentRules, ...(this.sessionRules.get(sessionId) ?? [])];
  }

  grant(sessionId: string, rules: Rule[]): void {
    const list = this.sessionRules.get(sessionId) ?? [];
    list.push(...rules);
    this.sessionRules.set(sessionId, list);
  }

  /** Decide without asking: returns the combined action for all patterns. */
  decide(req: Omit<PermissionRequest, "id">, opts: CheckOptions = {}): PermissionAction {
    const rules = this.rulesFor(req.sessionId, opts.agentRules);
    const mode: Mode = opts.mode === "plan" ? "plan" : this.yolo ? "yolo" : (opts.mode ?? "normal");
    let result: PermissionAction = "allow";
    const patterns = req.patterns.length ? req.patterns : ["*"];
    for (let i = 0; i < patterns.length; i++) {
      const { action, rule } = evaluate(rules, req.permission, patterns[i]!, req.readOnly?.[i]);
      let a = action;
      // Modes adjust the default answer but never override an explicit user deny.
      if (mode === "plan" && req.permission === "edit") a = "deny";
      else if (mode === "yolo" && a === "ask") a = "allow";
      else if (mode === "auto-edit" && req.permission === "edit" && a === "ask" && rule?.source === "default") a = "allow";
      if (a === "deny") return "deny";
      if (a === "ask") result = "ask";
    }
    return result;
  }

  async check(req: Omit<PermissionRequest, "id">, opts: CheckOptions = {}): Promise<void> {
    const action = this.decide(req, opts);
    if (action === "allow") return;
    if (action === "deny") {
      if (opts.mode === "plan" && req.permission === "edit") {
        throw new PermissionDeniedError("Plan mode is active: file modifications are not allowed. Finish the plan and call exit_plan_mode.", { byRule: true });
      }
      throw new PermissionDeniedError(`Permission denied by rule: ${req.title}`, { byRule: true });
    }
    const handler = this.askHandler;
    if (!handler) {
      throw new PermissionDeniedError(
        `This action needs approval but no user is available (non-interactive mode): ${req.title}. Allow it via config "permission" or run with --yolo.`,
        { byRule: true },
      );
    }
    const full: PermissionRequest = { ...req, id: newId("perm") };
    const reply = await this.enqueue(async () => {
      // Another prompt in the queue may have granted this already.
      if (this.decide(req, opts) === "allow") return { decision: "once" } as PermissionReply;
      return handler(full);
    });
    if (reply.decision === "deny") {
      throw new PermissionDeniedError(
        reply.feedback ? `The user denied this action and said: ${reply.feedback}` : "The user denied this action.",
        { feedback: reply.feedback },
      );
    }
    if (reply.decision === "session" || reply.decision === "always") {
      const rules = (req.always.length ? req.always : req.patterns).map<Rule>((pattern) => ({
        permission: req.permission,
        pattern,
        action: "allow",
        source: reply.decision,
      }));
      this.grant(req.sessionId, rules);
      if (reply.decision === "always") {
        this.persisted.push(...rules);
        await this.persistFn?.(this.persisted).catch(() => {});
      }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** Pattern for "always allow edits under this directory". */
export function directoryPattern(root: string, file: string): string {
  const rel = path.relative(root, path.dirname(file));
  if (!rel || rel === ".") return "*";
  return rel.split(path.sep).join("/") + "/*";
}
