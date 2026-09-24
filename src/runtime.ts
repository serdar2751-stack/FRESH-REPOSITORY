import path from "node:path";
import { type AgentInfo, isPrimary, loadAgents } from "./agent/agents.ts";
import { type InstructionFile, loadInstructions, loadSkills, type Skill } from "./agent/context.ts";
import { Engine } from "./agent/engine.ts";
import { collectEnvironment, type EnvironmentInfo } from "./agent/prompt.ts";
import { type CommandInfo, loadCommands } from "./commands/commands.ts";
import { type Config, type LoadedConfig, loadConfig, projectNeedsTrust } from "./config/config.ts";
import { paths, projectDataDir } from "./config/paths.ts";
import { trustStore } from "./config/store.ts";
import { Bus } from "./core/bus.ts";
import type { AgentEvent } from "./core/events.ts";
import { HookRunner } from "./hooks/hooks.ts";
import { LspManager } from "./lsp/manager.ts";
import { McpManager } from "./mcp/client.ts";
import { defaultRules, type Mode, PermissionManager, type PermissionReply, type PermissionRequest, type Rule, rulesFromConfig } from "./permission/permission.ts";
import { ProviderRegistry } from "./provider/registry.ts";
import { projectId, type Session, SessionStore } from "./session/session.ts";
import { createSnapshotter, type Snapshotter } from "./session/snapshot.ts";
import { ProcessManager } from "./tool/processes.ts";
import type { Tool } from "./tool/types.ts";
import { atomicWrite, findUp, readJson } from "./util/fs.ts";

export interface RuntimeOptions {
  cwd?: string;
  /** Override the configured model ("provider/model"). */
  model?: string;
  agent?: string;
  /** Allow everything that no rule explicitly denies. */
  yolo?: boolean;
  /** Treat the project config as trusted (hooks, MCP, permissions, providers). */
  trusted?: boolean;
  /** A user is present to answer permission prompts and questions. */
  interactive?: boolean;
  config?: Config;
  /** Connect configured MCP servers (default true). */
  mcp?: boolean;
  /** Override where sessions are stored (tests). */
  sessionDir?: string;
  /** Extra tools offered to the model (embedding usta in another program). */
  tools?: Tool[];
}

export class Runtime {
  readonly cwd: string;
  readonly root: string;
  readonly loaded: LoadedConfig;
  readonly registry: ProviderRegistry;
  readonly permissions: PermissionManager;
  readonly bus = new Bus<AgentEvent>();
  readonly agents: AgentInfo[];
  readonly skills: Map<string, Skill>;
  readonly instructions: InstructionFile[];
  readonly commands: CommandInfo[];
  readonly processes = new ProcessManager();
  readonly snapshotter: Snapshotter;
  readonly hooks: HookRunner;
  readonly store: SessionStore;
  readonly engine: Engine;
  readonly mcp: McpManager;
  readonly lsp: LspManager;
  readonly trusted: boolean;
  interactive: boolean;
  private env?: Promise<EnvironmentInfo>;
  private readonly opts: RuntimeOptions;
  private readonly pendingPermissions = new Map<string, (r: PermissionReply) => void>();

  private constructor(opts: RuntimeOptions, loaded: LoadedConfig, cwd: string, root: string, trusted: boolean) {
    this.opts = opts;
    this.cwd = cwd;
    this.root = root;
    this.loaded = loaded;
    this.trusted = trusted;
    this.interactive = opts.interactive ?? false;
    const config = loaded.config;
    this.registry = new ProviderRegistry(config);
    this.agents = loadAgents(root, config);
    this.skills = loadSkills(root);
    this.instructions = loadInstructions(root, cwd, config);
    this.commands = loadCommands(root);
    this.snapshotter = createSnapshotter(root, paths.data, config.snapshots !== false);
    this.hooks = new HookRunner(config.hooks, cwd, root);
    this.store = new SessionStore(root, opts.sessionDir);
    this.mcp = new McpManager(config.mcp, cwd);
    this.lsp = new LspManager({ root, config: config.lsp });
    const rules: Rule[] = [...defaultRules(), ...rulesFromConfig(config.permission, "config")];
    this.permissions = new PermissionManager({
      rules,
      root,
      yolo: opts.yolo,
      ask: (req) => this.askPermission(req),
      persist: (r) => this.savePersistedRules(r),
    });
    this.engine = new Engine({
      cwd,
      root,
      config,
      registry: this.registry,
      permissions: this.permissions,
      bus: this.bus,
      agents: this.agents,
      skills: this.skills,
      instructions: this.instructions,
      environment: () => (this.env ??= collectEnvironment(root, cwd)),
      processes: this.processes,
      snapshotter: this.snapshotter,
      hooks: this.hooks,
      store: this.store,
      extraTools: () => [...this.mcp.tools(), ...(opts.tools ?? [])],
      interactive: () => this.interactive,
      promptExtra: () => this.mcp.instructions(),
      lsp: this.lsp.enabled ? this.lsp : undefined,
    });
  }

  static findRoot(cwd: string): string {
    return findUp(cwd, ".git") ?? cwd;
  }

  /** Project config files with privileged settings that need the user's trust. */
  static trustNeeded(cwd: string): string[] {
    const root = Runtime.findRoot(path.resolve(cwd));
    if (trustStore.isTrusted(root)) return [];
    return projectNeedsTrust(root, path.resolve(cwd));
  }

  static async create(opts: RuntimeOptions = {}): Promise<Runtime> {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const root = Runtime.findRoot(cwd);
    const trusted = opts.trusted ?? trustStore.isTrusted(root);
    const loaded = loadConfig({ root, cwd, trusted, extra: opts.config });
    if (opts.model) loaded.config.model = opts.model;
    const rt = new Runtime(opts, loaded, cwd, root, trusted);
    const persisted = await readJson<Array<Omit<Rule, "test">>>(rt.permissionsFile()).catch(() => undefined);
    if (Array.isArray(persisted)) rt.permissions.setPersisted(persisted.map((r) => ({ ...r, source: "always" })));
    if (opts.mcp !== false && Object.keys(loaded.config.mcp ?? {}).length) await rt.mcp.start();
    return rt;
  }

  get config(): Config {
    return this.loaded.config;
  }

  private permissionsFile(): string {
    return path.join(projectDataDir(projectId(this.root)), "permissions.json");
  }

  private async savePersistedRules(rules: Rule[]): Promise<void> {
    await atomicWrite(this.permissionsFile(), JSON.stringify(rules.map(({ test: _t, ...r }) => r), null, 2));
  }

  // ----- permission prompts (answered by a UI through the bus) -----

  private askPermission(req: PermissionRequest): Promise<PermissionReply> {
    if (!this.interactive || !this.bus.size) {
      return Promise.resolve({ decision: "deny", feedback: "No user is available to approve this action (non-interactive run)." });
    }
    return new Promise((resolve) => {
      this.pendingPermissions.set(req.id, resolve);
      this.bus.emit({ type: "permission.request", request: req });
    });
  }

  replyPermission(id: string, reply: PermissionReply): boolean {
    const fn = this.pendingPermissions.get(id);
    if (!fn) return false;
    this.pendingPermissions.delete(id);
    fn(reply);
    this.bus.emit({ type: "permission.resolved", id, decision: reply.decision });
    return true;
  }

  /** Deny every outstanding permission prompt (e.g. when a turn is aborted). */
  denyPending(feedback = "The turn was interrupted."): void {
    for (const id of [...this.pendingPermissions.keys()]) this.replyPermission(id, { decision: "deny", feedback });
  }

  // ----- sessions -----

  defaultAgent(): string {
    const wanted = this.opts.agent ?? this.config.defaultAgent ?? "build";
    const a = this.agents.find((x) => x.name === wanted && isPrimary(x));
    return a ? a.name : "build";
  }

  requireModel(): string {
    const m = this.config.model ?? this.registry.defaultModelRef();
    if (!m) {
      throw new Error(
        "No model configured and no API key found. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ...), " +
          'run "usta auth login <provider>", or set "model" in ~/.config/usta/config.json.',
      );
    }
    return m;
  }

  async newSession(opts: { model?: string; agent?: string; mode?: Mode } = {}): Promise<Session> {
    const agentName = opts.agent ?? this.defaultAgent();
    const agent = this.agents.find((a) => a.name === agentName);
    const session = await this.store.create({
      cwd: this.cwd,
      root: this.root,
      model: opts.model ?? agent?.model ?? this.requireModel(),
      agent: agentName,
      mode: opts.mode,
    });
    if (this.hooks.has("SessionStart")) {
      const res = await this.hooks.run("SessionStart", { session_id: session.id, source: "startup" });
      if (res.context) this.engine.remind(session.id, `<session-start-context>\n${res.context}\n</session-start-context>`);
    }
    return session;
  }

  async loadSession(id: string): Promise<Session> {
    const s = await this.store.load(id);
    if (this.opts.model) await s.update({ model: this.opts.model });
    return s;
  }

  async latestSession(): Promise<Session | undefined> {
    const latest = await this.store.latest();
    return latest ? this.loadSession(latest.id) : undefined;
  }

  async close(): Promise<void> {
    this.processes.killAll();
    await Promise.all([this.mcp.close(), this.lsp.close()]);
  }
}
