import type { HookConfig, HookEvent } from "../config/config.ts";
import { runShell } from "../util/shell.ts";
import { truncateEnd } from "../util/text.ts";

export interface HookOutcome {
  /** A hook exited with code 2: the action is blocked / feedback must be acted on. */
  blocked: boolean;
  /** stderr (or stdout) of blocking hooks. */
  message?: string;
  /** stdout of successful hooks (added as context for prompt/session hooks). */
  context?: string;
  errors: string[];
}

/**
 * Runs user-configured shell hooks. Each hook receives the event payload as
 * JSON on stdin. Exit code 0 = ok (stdout is context), 2 = block with stderr
 * as the reason, anything else = non-blocking error.
 */
export class HookRunner {
  private readonly hooks: Partial<Record<HookEvent, HookConfig[]>>;
  private readonly cwd: string;
  private readonly root: string;

  constructor(hooks: Partial<Record<HookEvent, HookConfig[]>> | undefined, cwd: string, root: string) {
    this.hooks = hooks ?? {};
    this.cwd = cwd;
    this.root = root;
  }

  has(event: HookEvent): boolean {
    return Boolean(this.hooks[event]?.length);
  }

  private matching(event: HookEvent, toolName?: string): HookConfig[] {
    return (this.hooks[event] ?? []).filter((h) => {
      if (!h.matcher || h.matcher === "*" || toolName === undefined) return true;
      try {
        return new RegExp(`^(?:${h.matcher})$`).test(toolName);
      } catch {
        return h.matcher === toolName;
      }
    });
  }

  async run(event: HookEvent, payload: Record<string, unknown>, opts: { toolName?: string; signal?: AbortSignal; file?: string } = {}): Promise<HookOutcome> {
    const outcome: HookOutcome = { blocked: false, errors: [] };
    const hooks = this.matching(event, opts.toolName);
    if (!hooks.length) return outcome;
    const input = JSON.stringify({ hook_event_name: event, cwd: this.cwd, project_dir: this.root, ...payload });
    const contexts: string[] = [];
    const blocks: string[] = [];
    for (const h of hooks) {
      const res = await runShell(h.command, {
        cwd: this.cwd,
        timeoutMs: h.timeoutMs ?? 60_000,
        signal: opts.signal,
        stdin: input,
        env: {
          USTA_EVENT: event,
          USTA_PROJECT_DIR: this.root,
          CLAUDE_PROJECT_DIR: this.root,
          ...(opts.toolName ? { USTA_TOOL: opts.toolName } : {}),
          ...(opts.file ? { USTA_FILE: opts.file } : {}),
          ...(typeof payload.session_id === "string" ? { USTA_SESSION_ID: payload.session_id } : {}),
        },
        maxBuffer: 200_000,
      });
      const out = res.output.trim();
      if (res.exitCode === 0) {
        if (out) contexts.push(out);
      } else if (res.exitCode === 2) {
        blocks.push(out || `Hook "${h.command}" blocked this action.`);
      } else {
        outcome.errors.push(`Hook "${truncateEnd(h.command, 60)}" failed${res.timedOut ? " (timed out)" : ` (exit ${res.exitCode})`}: ${truncateEnd(out, 500)}`);
      }
    }
    if (blocks.length) {
      outcome.blocked = true;
      outcome.message = blocks.join("\n");
    }
    if (contexts.length) outcome.context = contexts.join("\n");
    return outcome;
  }
}
