import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../util/fs.ts";
import { paths } from "./paths.ts";

function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** API keys saved with `usta auth login` (file mode 0600). */
export const authStore = {
  file(): string {
    return path.join(paths.data, "auth.json");
  },
  all(): Record<string, { key: string }> {
    return readJsonSync(this.file(), {} as Record<string, { key: string }>);
  },
  get(provider: string): string | undefined {
    return this.all()[provider]?.key;
  },
  async set(provider: string, key: string): Promise<void> {
    const all = this.all();
    all[provider] = { key };
    await atomicWrite(this.file(), JSON.stringify(all, null, 2), 0o600);
  },
  async remove(provider: string): Promise<boolean> {
    const all = this.all();
    if (!(provider in all)) return false;
    delete all[provider];
    await atomicWrite(this.file(), JSON.stringify(all, null, 2), 0o600);
    return true;
  },
};

/** Project folders whose privileged config (hooks, MCP, permissions, providers) the user trusted. */
export const trustStore = {
  file(): string {
    return path.join(paths.data, "trusted.json");
  },
  list(): string[] {
    return readJsonSync(this.file(), [] as string[]);
  },
  isTrusted(root: string): boolean {
    return this.list().includes(path.resolve(root));
  },
  async trust(root: string): Promise<void> {
    const list = new Set(this.list());
    list.add(path.resolve(root));
    await atomicWrite(this.file(), JSON.stringify([...list], null, 2));
  },
  async untrust(root: string): Promise<void> {
    const list = this.list().filter((p) => p !== path.resolve(root));
    await atomicWrite(this.file(), JSON.stringify(list, null, 2));
  },
};
