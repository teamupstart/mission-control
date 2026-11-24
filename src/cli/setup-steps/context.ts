import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realExec, type Exec } from "../claude-cli.ts";

/**
 * What a setup step or doctor check touches outside itself, injectable so a test runs the whole
 * of `mctl setup` against a fake `claude`, a fake daemon and a temporary state directory.
 */
export interface SetupDeps {
  env: Readonly<Record<string, string | undefined>>;
  exec: Exec;
  /** `fetch` for the daemon's `/api/health`. */
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** The state directory (`MISSION_HOME` and its older names, else `~/.mission-control`). */
  stateDir: string;
  /** The built mod folder marketplace to stage (`dist/mod`). */
  modSource: string;
  /** The user's home directory, for `claude` detection. */
  home: string;
}

const STATE_DIR_NAMES = [".mission-control", ".fleet-control", ".ai-harness"] as const;

/** The same resolution as `stateDir()` in `src/shared/harness-runtime.mjs`, over an injected environment. */
export function resolveStateDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env.MISSION_HOME ?? env.FLEET_HOME ?? env.HARNESS_HOME;
  if (override) return override;
  for (const name of STATE_DIR_NAMES) {
    const path = join(home, name);
    if (existsSync(path)) return path;
  }
  return join(home, STATE_DIR_NAMES[0]);
}

/** Where the built mod is: beside the bundle (`dist/cli` next to `dist/mod`), or in a source checkout. */
export function defaultModSource(env: Readonly<Record<string, string | undefined>>): string {
  if (env.MISSION_MOD_SOURCE) return env.MISSION_MOD_SOURCE;
  const candidates = [new URL("../mod", import.meta.url), new URL("../../../dist/mod", import.meta.url)].map((url) => fileURLToPath(url));
  return candidates.find((path) => existsSync(join(path, ".claude-plugin", "marketplace.json"))) ?? candidates[0]!;
}

export function resolveDeps(partial: Partial<SetupDeps> = {}): SetupDeps {
  const env = partial.env ?? process.env;
  const home = partial.home ?? env.HOME ?? homedir();
  return {
    env,
    exec: partial.exec ?? realExec,
    fetch: partial.fetch ?? ((url, init) => fetch(url, init)),
    home,
    stateDir: partial.stateDir ?? resolveStateDir(env, home),
    modSource: partial.modSource ?? defaultModSource(env),
  };
}
