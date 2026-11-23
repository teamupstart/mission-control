/**
 * Where the daemon is and how the mod proves who it is (spec 7.10). The mod runs in the
 * engine's module environment with no Node, so it learns both from the environment variables
 * and the token file the daemon's own clients use (`src/shared/harness-runtime.mjs`): the same
 * names, the same order, the same state-dir fallbacks. A change there is a change here.
 *
 * Pure over an injected environment and file reader, so a test needs no engine.
 */

/** The names `register.ts` reads at session start, each spelled as a literal there. */
export const DAEMON_ENV_NAMES = [
  "MISSION_PORT",
  "FLEET_PORT",
  "HARNESS_PORT",
  "MISSION_HOME",
  "FLEET_HOME",
  "HARNESS_HOME",
  "MISSION_API_TOKEN",
  "MISSION_API_TOKEN_FILE",
  "HOME",
  "CLAUDE_CODE_ENTRYPOINT",
] as const;

export type DaemonEnv = Readonly<Partial<Record<(typeof DAEMON_ENV_NAMES)[number], string>>>;

/** The state dir names the app has used, newest first (`STATE_DIRS` in `harness-runtime.mjs`). */
const STATE_DIR_NAMES = [".mission-control", ".fleet-control", ".ai-harness"] as const;

const DEFAULT_PORT = 7317;

/** `http://127.0.0.1:<port>`: the daemon binds loopback only. */
export function daemonBaseUrl(env: DaemonEnv): string {
  const raw = env.MISSION_PORT ?? env.FLEET_PORT ?? env.HARNESS_PORT;
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT}`;
}

/** The files that may hold the token, in the order the daemon's clients try them. */
export function tokenFileCandidates(env: DaemonEnv): string[] {
  const out: string[] = [];
  if (env.MISSION_API_TOKEN_FILE) out.push(env.MISSION_API_TOKEN_FILE);
  const override = env.MISSION_HOME ?? env.FLEET_HOME ?? env.HARNESS_HOME;
  if (override) {
    out.push(`${override}/token`);
    return out;
  }
  if (env.HOME) for (const name of STATE_DIR_NAMES) out.push(`${env.HOME}/${name}/token`);
  return out;
}

/** The token, or `""` when none is readable (the daemon then answers 401 and the mod says so). */
export async function readDaemonToken(
  env: DaemonEnv,
  readText: (path: string) => Promise<string>,
): Promise<string> {
  const supplied = env.MISSION_API_TOKEN?.trim();
  if (supplied) return supplied;
  for (const path of tokenFileCandidates(env)) {
    try {
      const text = (await readText(path)).trim();
      if (text) return text;
    } catch {
      // Not there (yet): try the next candidate.
    }
  }
  return "";
}
