import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  PORT,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  isolatedScoutSubmissionCredentialPath,
  readToken,
} from "../shared/harness-runtime.mjs";
import { executableChildEnv } from "./executables/locator.ts";
import { FIXED_OS_EXECUTABLES } from "./executables/catalog.ts";

/** Every spelling that can redirect normal Mission Control state resolution. */
export const STATE_HOME_ENV_NAMES = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"] as const;

/** Terminal pane identifiers that a headless or SDK child must never inherit. */
const PANE_IDENTITY_ENV_NAMES = ["TMUX_PANE", "WEZTERM_PANE", "ITERM_SESSION_ID"] as const;

const DISPOSABLE_STATE_ROOT = join(tmpdir(), "mission-control-agent-state");
const LOOPBACK_TOKEN_FILE = "loopback-token";
const TERMINAL_CLEANUP_WRAPPER = "launch-and-cleanup.sh";
const liveDisposableStateHomes = new Set<string>();
let cleanupHooked = false;
const ABANDONED_CREDENTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Remove only expired Pipeline caller files left by a previous daemon crash. */
export function reconcileDisposableAgentStateHomes(now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(DISPOSABLE_STATE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("session-")) continue;
    const stateHome = join(DISPOSABLE_STATE_ROOT, entry);
    if (liveDisposableStateHomes.has(stateHome)) continue;
    try {
      const info = statSync(stateHome);
      if (!info.isDirectory()) continue;
      for (const name of readdirSync(stateHome)) {
        if (!name.startsWith("pipeline-caller-") || !name.endsWith(".json")) continue;
        const credentialPath = join(stateHome, name);
        const credentialInfo = statSync(credentialPath);
        let expiresAt = credentialInfo.mtimeMs + ABANDONED_CREDENTIAL_MAX_AGE_MS;
        try {
          const parsed = JSON.parse(readFileSync(credentialPath, "utf8")) as { expiresAt?: unknown };
          if (typeof parsed.expiresAt === "number") expiresAt = parsed.expiresAt;
        } catch {
          // An unreadable credential still has a bounded lifetime from its mtime.
        }
        if (expiresAt <= now) unlinkSync(credentialPath);
      }
    } catch {
      // Another process may be cleaning the same expired credential.
    }
  }
}

function hookProcessCleanup(): void {
  if (cleanupHooked) return;
  cleanupHooked = true;
  process.once("exit", () => {
    for (const stateHome of liveDisposableStateHomes) {
      rmSync(stateHome, { recursive: true, force: true });
    }
    liveDisposableStateHomes.clear();
  });
}

/** Make one private state home for one agent-controlled launch. */
export function createDisposableAgentStateHome(): string {
  mkdirSync(DISPOSABLE_STATE_ROOT, { recursive: true, mode: 0o700 });
  // Terminal wrappers remove their own homes in the child, so discard those completed
  // entries before tracking another launch in the parent daemon.
  for (const stateHome of liveDisposableStateHomes) {
    if (!existsSync(stateHome)) liveDisposableStateHomes.delete(stateHome);
  }
  const stateHome = mkdtempSync(join(DISPOSABLE_STATE_ROOT, "session-"));
  liveDisposableStateHomes.add(stateHome);
  hookProcessCleanup();
  return stateHome;
}

/** Remove only a home minted by this module. Safe to repeat after another owner cleaned it. */
export function cleanupDisposableAgentStateHome(stateHome: string | undefined): void {
  if (!stateHome) return;
  const prefix = `${DISPOSABLE_STATE_ROOT}/session-`;
  if (!stateHome.startsWith(prefix) || stateHome.slice(prefix.length).includes("/")) return;
  rmSync(stateHome, { recursive: true, force: true });
  liveDisposableStateHomes.delete(stateHome);
}

/** Release the disposable home named by a child environment. */
export function cleanupAgentSubprocessEnv(env: NodeJS.ProcessEnv | undefined): void {
  cleanupDisposableAgentStateHome(env?.MISSION_HOME);
}

/** Remove inherited pane ownership while preserving unrelated terminal metadata. */
export function dropPaneIdentityEnv(env: Record<string, string | undefined>): void {
  for (const name of PANE_IDENTITY_ENV_NAMES) delete env[name];
}

/**
 * Build the shared environment for headless provider subprocesses.
 *
 * A daemon started from a terminal must not hand its pane identity to embedded provider
 * sessions. Provider hooks would otherwise attribute every child event to the daemon's own
 * pane instead of the session identity. TERM_PROGRAM is also terminal ownership metadata for
 * these pane-less launches, while the ordinary toolchain environment and narrow loopback
 * capability remain intact.
 */
export function headlessAgentSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  stateHome?: string,
): Record<string, string | undefined> {
  const env = agentSubprocessEnv(base, { loopbackAccess: true, cwd, stateHome });
  dropPaneIdentityEnv(env);
  delete env.TERM_PROGRAM;
  return env;
}

export interface AgentSubprocessEnvOptions {
  /** Reuse one home across the cooperating processes that make up a session launch. */
  stateHome?: string;
  /** Supply the daemon's loopback coordinate and bearer without exposing its state path. */
  loopbackAccess?: boolean;
  /** Checkout whose already-provisioned scoped scout capability should follow the launch. */
  cwd?: string;
}

/**
 * Isolate a process from the operator's Mission Control state while preserving its ordinary
 * toolchain environment. Undefined values are omitted for SDK string-only env records.
 */
export function agentSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  options: AgentSubprocessEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(executableChildEnv(base))) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of STATE_HOME_ENV_NAMES) delete env[name];
  const stateHome = options.stateHome ?? createDisposableAgentStateHome();
  env.MISSION_HOME = stateHome;
  delete env[MISSION_API_TOKEN_ENV];
  delete env[MISSION_API_TOKEN_FILE_ENV];

  try {
    if (options.loopbackAccess) {
      env.MISSION_PORT = String(PORT);
      const token = readToken();
      if (token) {
        const tokenFile = join(stateHome, LOOPBACK_TOKEN_FILE);
        writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
        env[MISSION_API_TOKEN_FILE_ENV] = tokenFile;
      }
      if (options.cwd) {
        env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV] = isolatedScoutSubmissionCredentialPath(options.cwd);
      }
    } else {
      delete env.MISSION_PORT;
      delete env[MISSION_API_TOKEN_ENV];
      delete env[MISSION_API_TOKEN_FILE_ENV];
      delete env[SCOUT_SUBMISSION_CREDENTIAL_ENV];
      delete env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV];
    }
    return env;
  } catch (error) {
    if (options.stateHome === undefined) cleanupDisposableAgentStateHome(stateHome);
    throw error;
  }
}

/**
 * Wrap argv for terminal backends whose launch APIs do not accept an environment object.
 * The override runs inside the pane or tab, after a long-lived terminal server contributes
 * its own inherited environment.
 */
export function isolatedAgentArgv(
  argv: readonly string[],
  options: Omit<AgentSubprocessEnvOptions, "loopbackAccess"> = {},
): string[] {
  const env = agentSubprocessEnv({}, { ...options, loopbackAccess: true });
  const stateHome = env.MISSION_HOME!;
  const wrapper = join(stateHome, TERMINAL_CLEANUP_WRAPPER);
  try {
    writeFileSync(
      wrapper,
      '#!/bin/sh\ntrap \'/bin/rm -rf -- "$MISSION_HOME"\' EXIT\n"$@"\n',
      { mode: 0o700 },
    );
  } catch (error) {
    cleanupDisposableAgentStateHome(stateHome);
    throw error;
  }
  return [
    FIXED_OS_EXECUTABLES.env,
    ...STATE_HOME_ENV_NAMES.flatMap((name) => ["-u", name]),
    ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    FIXED_OS_EXECUTABLES.sh,
    wrapper,
    ...argv,
  ];
}
