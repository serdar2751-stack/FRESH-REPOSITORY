import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TodoItem } from "../../src/core/types.ts";
import { PermissionDeniedError } from "../../src/permission/permission.ts";
import type { ModelInfo } from "../../src/provider/types.ts";
import { ProcessManager } from "../../src/tool/processes.ts";
import { FileTracker, type PermitRequest, type ToolContext } from "../../src/tool/types.ts";

export const testModel: ModelInfo = {
  id: "test-model",
  provider: "test",
  contextWindow: 200_000,
  maxOutput: 32_000,
  vision: true,
  thinking: "none",
  effortLevels: [],
  editTool: "edit",
  source: "default",
};

export async function tempDir(prefix = "usta-test-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export interface TestContext extends ToolContext {
  permits: PermitRequest[];
  checkpoints: string[];
  progressChunks: string[];
  deny: (req: PermitRequest) => boolean;
}

export function makeContext(root: string, over: Partial<ToolContext> = {}): TestContext {
  let todos: TodoItem[] = [];
  const ctx: TestContext = {
    cwd: root,
    root,
    sessionId: "ses_test",
    callId: "call_test",
    agent: "build",
    signal: new AbortController().signal,
    config: {},
    model: testModel,
    permits: [],
    checkpoints: [],
    progressChunks: [],
    deny: () => false,
    async permit(req) {
      ctx.permits.push(req);
      if (ctx.deny(req)) throw new PermissionDeniedError("denied in test");
    },
    files: new FileTracker(),
    async checkpoint(file) {
      ctx.checkpoints.push(file);
    },
    progress(chunk) {
      ctx.progressChunks.push(chunk);
    },
    todos: { get: () => todos, set: (t) => (todos = t) },
    processes: new ProcessManager(),
    ...over,
  };
  return ctx;
}
