import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "@shared/harness-runtime.mjs";
import { realExec, type Exec } from "../claude-cli.ts";

/**
 * What a setup step or doctor check touches outside itself, injectable so a test runs the whole
 * of `mctl setup` against a fake `claude`, a fake daemon and a temporary state directory.
 */
export interface SetupDeps {
  env: Readonly<Record<string, string | undefined>>;
  exec: Exec;
  /** `fetch` for the daemon's `/api/health`. */
  fetch: (url: string, init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  /** The state directory (`MISSION_HOME` and its older names, else `~/.mission-control`). */
  stateDir: string;
  /** The built mod folder marketplace to stage (`dist/mod`). */
  modSource: string;
  /** The user's home directory, for `claude` detection. */
  home: string;
  /**
   * When present, what one `mctl setup` run has already established is kept here and shared by its
   * steps, so the closing doctor step does not ask the daemon or `claude` the same question again:
   * the first `/api/health` reading, the `mod-calls` verdict on the bytes that were published, and
   * the installed-mod listing the mod step verified after installing.
   */
  runCache?: {
    reading?: Promise<import("./checks.ts").HealthReading>;
    modCalls?: import("./types.ts").DoctorCheck;
    installed?: { mod: import("./checks.ts").InstalledMod | null };
  };
}

/** Where the built mod is: beside the bundle (`dist/cli` next to `dist/mod`), or in a source checkout. */
export function defaultModSource(env: Readonly<Record<string, string | undefined>>, here: string = import.meta.url): string {
  if (env.MISSION_MOD_SOURCE) return env.MISSION_MOD_SOURCE;
  // `here` is this module's own URL: `dist/cli/mctl.mjs` when bundled, `src/cli/setup-steps/context.ts` from source.
  const candidates = [new URL("../mod", here), new URL("../../../dist/mod", here)].map((url) => fileURLToPath(url));
  const found = candidates.find((path) => existsSync(join(path, ".claude-plugin", "marketplace.json")));
  if (found) return found;
  // Not built anywhere: name where the build would put it for this layout, so the error says where to look.
  const fromSource = fileURLToPath(here).split(sep).includes("src");
  return candidates[fromSource ? 1 : 0]!;
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
    ...(partial.runCache ? { runCache: partial.runCache } : {}),
  };
}
