import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Every spelling that can redirect normal Mission Control state resolution. */
export const STATE_HOME_ENV_NAMES = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"] as const;

/** Terminal pane identifiers that a headless or SDK child must never inherit. */
const PANE_IDENTITY_ENV_NAMES = ["TMUX_PANE", "WEZTERM_PANE", "ITERM_SESSION_ID"] as const;

const DISPOSABLE_STATE_ROOT = join(tmpdir(), "mission-control-agent-state");
const LOOPBACK_TOKEN_FILE = "loopback-token";
const TERMINAL_CLEANUP_WRAPPER = "launch-and-cleanup.sh";
const liveDisposableStateHomes = new Set<string>();
let cleanupHooked = false;

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
  for (const [name, value] of Object.entries(base)) {
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
    "/usr/bin/env",
    ...STATE_HOME_ENV_NAMES.flatMap((name) => ["-u", name]),
    ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    "/bin/sh",
    wrapper,
    ...argv,
  ];
}
