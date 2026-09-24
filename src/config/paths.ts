import os from "node:os";
import path from "node:path";

function base(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && path.isAbsolute(v) ? v : fallback;
}

const home = os.homedir();
const isWindows = process.platform === "win32";
const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

export const paths = {
  get config(): string {
    return process.env.USTA_CONFIG_DIR ?? (isWindows ? path.join(appData, "usta") : path.join(base("XDG_CONFIG_HOME", path.join(home, ".config")), "usta"));
  },
  get data(): string {
    return process.env.USTA_DATA_DIR ?? (isWindows ? path.join(localAppData, "usta") : path.join(base("XDG_DATA_HOME", path.join(home, ".local", "share")), "usta"));
  },
  get cache(): string {
    return process.env.USTA_CACHE_DIR ?? (isWindows ? path.join(localAppData, "usta", "cache") : path.join(base("XDG_CACHE_HOME", path.join(home, ".cache")), "usta"));
  },
};

/** Directory holding per-project data (sessions, snapshots). */
export function projectDataDir(projectId: string): string {
  return path.join(paths.data, "projects", projectId);
}
