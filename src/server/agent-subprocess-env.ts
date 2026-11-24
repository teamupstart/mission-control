import { DISPOSABLE_STATE_ROOT, LAUNCH_PID_FILE, LAUNCH_SCRIPT_FILE, readTerminalWrapperProcess, turnOneOutcomePath, type LaunchProcess } from "./terminal/launch-process.ts";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  PORT,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  SCOUT_SESSION_LOCATOR_ENV,
  isolatedScoutSubmissionCredentialPath,
  readToken,
} from "../shared/harness-runtime.mjs";
import { WORK_UNIT_ENV_VAR } from "../shared/work-unit.ts";
import { executableChildEnv } from "./executables/locator.ts";
import { FIXED_OS_EXECUTABLES } from "./executables/catalog.ts";
import { probePadding, shellCommand } from "./terminal/shell.ts";

/** Every spelling that can redirect normal Mission Control state resolution. */
export const STATE_HOME_ENV_NAMES = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"] as const;

/**
 * Variables a child may carry only when its launch sets them: removed from every inherited
 * environment, and unset by the terminal wrapper before its exports. Today that is the work
 * unit (`docs/work-units.md`, "The launch environment").
 */
const INHERITED_ONLY_ENV_NAMES = [WORK_UNIT_ENV_VAR] as const;

/** Terminal pane identifiers that a headless or SDK child must never inherit. */
const PANE_IDENTITY_ENV_NAMES = ["TMUX_PANE", "WEZTERM_PANE", "ITERM_SESSION_ID"] as const;

// Outside session homes so their cleanup cannot evict another task's warm cache.
// See docs/configuration.md for the scope of sandbox-writability verification.
const GO_CACHE_UID = userInfo().uid;
const SHARED_GO_BUILD_CACHE = join(tmpdir(), `mission-control-go-build-${GO_CACHE_UID}`);
const LOOPBACK_TOKEN_FILE = "loopback-token";
const liveDisposableStateHomes = new Set<string>();
const pendingTerminalHomeChecks = new Set<() => void>();
const WRAPPER_EXIT_FILE = "terminal-wrapper.exit";
let cleanupHooked = false;
const ABANDONED_CREDENTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Hold the inode through removal of the home. An unmarked, unlinked file is not proof of exit. */
export function observeTerminalWrapperExit(stateHome: string, readOwner = readTerminalWrapperProcess) {
  const fd = openSync(join(stateHome, WRAPPER_EXIT_FILE), "wx", 0o600);
  const outcome = () => {
    const file = fstatSync(fd);
    return file.nlink === 0 ? file.size === 1 : null;
  };
  return {
    confirmed: () => outcome() === true,
    async waitForExit(stillOwned: () => boolean): Promise<boolean> {
      let owner: LaunchProcess | null = null;
      let retriedClaim = false;
      while (stillOwned()) {
        const exited = outcome();
        if (exited !== null) return exited;
        const current = await readOwner(stateHome, owner?.pid);
        if (current !== "unknown") {
          if (owner && (!current || current.pid !== owner.pid || current.startMs !== owner.startMs)) return outcome() === true;
          if (!current && retriedClaim) return outcome() === true;
          owner = current;
          retriedClaim = true;
        }
        // The wrapper may have exited while the process table was being read.
        const observed = outcome();
        if (observed !== null) return observed;
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref());
      }
      return false;
    },
    close: () => closeSync(fd),
  };
}

function sharedGoBuildCache(): string {
  mkdirSync(SHARED_GO_BUILD_CACHE, { recursive: true, mode: 0o700 });
  const info = lstatSync(SHARED_GO_BUILD_CACHE);
  // A predictable name in a shared temp directory must not follow another user's link.
  if (!info.isDirectory() || (GO_CACHE_UID !== -1 && info.uid !== GO_CACHE_UID)) {
    throw new Error(`Go build cache is not an owned directory: ${SHARED_GO_BUILD_CACHE}`);
  }
  return SHARED_GO_BUILD_CACHE;
}

/**
 * How long a turn-one outcome is kept after its wrapper wrote it, whoever owns it. A dispatch reads
 * its outcome seconds after the launch, so this outlasts any in-flight dispatch of another daemon
 * sharing the disposable root, while still reclaiming the ones a dead daemon left behind.
 */
const TURN_ONE_OUTCOME_GRACE_MS = 10 * 60 * 1000;

function outcomeIsStale(path: string, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs >= TURN_ONE_OUTCOME_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Remove only expired Pipeline caller files left by a previous daemon crash, and turn-one outcome
 * files (`turnOneOutcomePath`) whose launch is over: their wrapper has removed its state home,
 * and the dispatch that would have read and removed them died with that daemon.
 */
export function reconcileDisposableAgentStateHomes(now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(DISPOSABLE_STATE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("session-")) continue;
    const outcomeOf = entry.endsWith(".turn-one") ? join(DISPOSABLE_STATE_ROOT, entry.slice(0, -".turn-one".length)) : null;
    if (outcomeOf) {
      // Still running under a live wrapper, still owned by this daemon, or young enough that another
      // daemon's dispatch may not have read it yet: leave it.
      if (!liveDisposableStateHomes.has(outcomeOf) && !existsSync(outcomeOf) && outcomeIsStale(join(DISPOSABLE_STATE_ROOT, entry), now)) {
        try {
          rmSync(turnOneOutcomePath(outcomeOf), { force: true });
        } catch (error) {
          // One entry that cannot be removed never stops the rest of the scan.
          console.warn(`[launch] could not remove the orphaned turn-one outcome ${entry}:`, error);
        }
      }
      continue;
    }
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
    for (const release of pendingTerminalHomeChecks) release();
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

/**
 * Keep a named dispatch home across backend timeouts and interrupted socket reads. At the
 * deadline (or shutdown), the daemon and shell compete to create the same private PID file.
 * A winning wrapper has installed its EXIT trap and owns cleanup for the rest of its life.
 */
export function retainPendingTerminalHome(stateHome: string, timeoutMs: number) {
  if (!liveDisposableStateHomes.delete(stateHome)) return { release() {}, unstarted: Promise.resolve(false) };
  let reportUnstarted!: (value: boolean) => void;
  const unstarted = new Promise<boolean>((resolve) => { reportUnstarted = resolve; });
  const release = () => {
    if (!pendingTerminalHomeChecks.delete(release)) return;
    clearTimeout(timer);
    try {
      writeFileSync(join(stateHome, LAUNCH_PID_FILE), "", { flag: "wx", mode: 0o600 });
      reportUnstarted(true);
      cleanupDisposableAgentStateHome(stateHome);
    } catch (error) {
      // A missing home can belong to a wrapper that started and already exited.
      reportUnstarted(false);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") console.warn("Could not release an unstarted terminal launch home.");
    }
  };
  const timer = setTimeout(release, timeoutMs).unref();
  pendingTerminalHomeChecks.add(release);
  return { release, unstarted };
}

/** Release the disposable home named by a child environment. */
export function cleanupAgentSubprocessEnv(env: NodeJS.ProcessEnv | undefined): void {
  cleanupDisposableAgentStateHome(env?.MISSION_HOME);
}

/** Remove inherited pane ownership while preserving unrelated terminal metadata. */
export function dropPaneIdentityEnv(env: Record<string, string | undefined>): void {
  for (const name of PANE_IDENTITY_ENV_NAMES) delete env[name];
}

/** Session overrides must never supply the terminal identity. A pane supplies its own. */
export function dropTerminalIdentityEnv(env: Record<string, string | undefined>): void {
  dropPaneIdentityEnv(env);
  delete env.TERM_PROGRAM;
}

export interface AgentSubprocessEnvOptions {
  /** Reuse one home across the cooperating processes that make up a session launch. */
  stateHome?: string;
  /** Supply the daemon's loopback coordinate and bearer without exposing its state path. */
  loopbackAccess?: boolean;
  /** Checkout whose already-provisioned scoped scout capability should follow the launch. */
  cwd?: string;
  /**
   * Launch variables selected for this agent, including capability overrides and named credentials. Applied over the inherited environment and BEFORE the isolation below,
   * so nothing here can name a state home, a token or a credential back into the child.
   */
  extraEnv?: Readonly<Record<string, string>>;
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
  // Never inherited: the daemon may have been started from a worker's shell, and no process it
  // spawns - an agent, a workflow check, a one-shot model call - may carry that unit's id. A
  // launch that carries one supplies it in `extraEnv`, which is applied after this.
  for (const name of INHERITED_ONLY_ENV_NAMES) delete env[name];
  Object.assign(env, options.extraEnv);
  if (!env.GOCACHE) env.GOCACHE = sharedGoBuildCache();
  for (const name of STATE_HOME_ENV_NAMES) delete env[name];
  const stateHome = options.stateHome ?? createDisposableAgentStateHome();
  env.MISSION_HOME = stateHome;
  delete env[MISSION_API_TOKEN_ENV];
  delete env[MISSION_API_TOKEN_FILE_ENV];
  // Only the SDK supervisor may issue a report locator for this particular launch.
  delete env[SCOUT_SESSION_LOCATOR_ENV];

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
 * The whole launch, as a script: the isolation the argv prefix used to carry, the agent
 * itself, and the cleanup that releases the disposable state home when the agent exits.
 *
 * It is a script rather than an argv prefix because of what a backend has to do with the
 * argv. tmux and cmux hand it to the multiplexer to exec, but Herdr's socket API has no
 * command parameter at all - a launch is TYPED into the workspace's login shell as a
 * bracketed paste. A real dispatch's prefix-plus-argv encodes to about 3.5 KB, and at that
 * size the paste and its Enter race: measured against the live 0.9.0 server, a 3,009-byte
 * command was executed 1 time in 6. Sweeping the size showed no clean threshold - 207, 607,
 * 907, 1009 and 1509 bytes ran, 1109 and 3009 did not - which is the signature of a race
 * rather than a limit, so the size is a probability and not a guarantee. Folding the
 * environment and the agent argv in here leaves one short line to deliver, and the herdr
 * adapter separates the Enter from the paste so the remaining probability is not relied on.
 *
 * Three details are load-bearing:
 *
 *   - The `unset` comes first and names every spelling of the state home, so the login
 *     shell's own `MISSION_HOME` cannot survive into the agent, and `WORK_UNIT_ID`, so a
 *     terminal server started from a worker's shell cannot tag the agent with that unit. It
 *     replaces the `env -u NAME` prefix rather than sitting beside it.
 *   - The exports carry `PATH`. Herdr's `workspace.create` accepts an `env` map, and it is
 *     NOT a substitute: measured, the map reaches the shell, but the login shell's rc files
 *     then rewrite `PATH` back to the operator's interactive one, which is exactly the
 *     isolation this exists to provide.
 *   - The agent is the script's last statement and is NOT `exec`ed. `exec` replaces the
 *     shell process, so the `EXIT` trap never fires and the disposable state home is never
 *     removed. Running it as an ordinary command also leaves the agent's exit status as the
 *     script's, which is what a backend reports.
 */
function launchAndCleanupScript(
  env: Record<string, string>,
  argv: readonly string[],
  preserveShellGoCache: boolean,
  fallbackArgv: readonly string[] | null = null,
): string {
  return [
    "#!/bin/sh",
    // The pane already holds the terminal server's environment, so a variable the launch
    // leaves out would otherwise reach the agent from there. The exports below are then the
    // only source of a work unit: set when the launch carries one, absent when it does not.
    `unset ${[...STATE_HOME_ENV_NAMES, ...INHERITED_ONLY_ENV_NAMES].join(" ")}`,
    ...Object.entries(env).map(([name, value]) => {
      const assignment = `export ${name}=${shellCommand([value])}`;
      // Terminal servers and login shells can supply a setting the daemon never saw.
      return name === "GOCACHE" && preserveShellGoCache
        ? `if [ -z "\${GOCACHE:-}" ]; then ${assignment}; fi`
        : assignment;
    }),
    // Install cleanup before competing for the start record. An interrupted contender
    // can reach EXIT at any point, so only the recorded owner may remove the home.
    "cleanup_owned_home() {",
    `  IFS= read -r launch_pid 2>/dev/null < "$MISSION_HOME/${LAUNCH_PID_FILE}" || return`,
    '  [ "$launch_pid" = "$$" ] || return',
    `  exit_record="$MISSION_HOME/${WRAPPER_EXIT_FILE}"`,
    '  if [ -f "$exit_record" ] && [ ! -L "$exit_record" ]; then printf x >> "$exit_record"; fi',
    '  /bin/rm -rf -- "$MISSION_HOME"',
    "}",
    "trap cleanup_owned_home EXIT",
    `(set -C; printf '%s\\n' "$$" > "$MISSION_HOME/${LAUNCH_PID_FILE}") || exit 1`,
    ...(fallbackArgv ? fittingLaunch(argv, fallbackArgv, turnOneOutcomePath(env.MISSION_HOME!)) : [shellCommand(argv)]),
    "",
  ].join("\n");
}

/**
 * Run `argv` only if it fits under the platform's argument limit in THIS shell's environment -
 * the pane's, which the daemon cannot see before the launch - and otherwise run `fallbackArgv`.
 * Either way `outcome` (`turnOneOutcomePath`) says which ran, before the agent starts.
 *
 * The check is an exec of `/bin/sh -c :` carrying every word of `argv` plus padding for the real
 * exec's image overhead, under the same environment: it fails with `E2BIG` exactly when the
 * agent's own exec would, and costs one fork of a shell that does nothing. The agent's exit
 * status after a launch is never read as an exec failure, so the task is never run twice.
 */
function fittingLaunch(argv: readonly string[], fallbackArgv: readonly string[], outcome: string): string[] {
  const probe = shellCommand([FIXED_OS_EXECUTABLES.sh, "-c", ":", "mission-turn-one-probe", probePadding(argv[0] ?? ""), ...argv]);
  const record = (which: string) => `printf '%s' ${which} > ${shellCommand([outcome])}`;
  return [
    `if ${probe} 2>/dev/null; then`,
    `  ${record("shaped")}`,
    `  ${shellCommand(argv)}`,
    "else",
    `  ${record("original")}`,
    `  ${shellCommand(fallbackArgv)}`,
    "fi",
  ];
}

/**
 * The environment `isolatedAgentArgv`'s wrapper exports to the agent, for a caller that has to
 * measure it before the launch: a launch argument shares `ARG_MAX` with every one of these.
 * Writes the same loopback token file into `options.stateHome` the wrapper's own call writes,
 * so `options.stateHome` should be the launch's, already created.
 */
export function isolatedAgentEnvironment(
  options: Omit<AgentSubprocessEnvOptions, "loopbackAccess"> = {},
): Record<string, string> {
  return agentSubprocessEnv({ GOCACHE: process.env.GOCACHE }, { ...options, loopbackAccess: true });
}

/**
 * Wrap argv for terminal backends whose launch APIs do not accept an environment object.
 * The override runs inside the pane or tab, after a long-lived terminal server contributes
 * its own inherited environment.
 *
 * What comes back names the interpreter and the wrapper and nothing else, so every backend
 * receives a short command. See `launchAndCleanupScript` for why the length is a contract
 * and not a tidiness preference.
 */
export function isolatedAgentArgv(
  argv: readonly string[],
  options: Omit<AgentSubprocessEnvOptions, "loopbackAccess"> & {
    /**
     * The launch to run instead when `argv` would not fit under the platform's argument limit
     * in the pane's environment (see `fittingLaunch`). Only a launch whose argv carries
     * optional text - a shaped turn one - has one; every other launch's script is unchanged.
     */
    fallbackArgv?: readonly string[] | null;
  } = {},
): string[] {
  const { fallbackArgv = null, ...envOptions } = options;
  const env = isolatedAgentEnvironment(envOptions);
  const stateHome = env.MISSION_HOME!;
  const wrapper = join(stateHome, LAUNCH_SCRIPT_FILE);
  try {
    writeFileSync(wrapper, launchAndCleanupScript(env, argv, !options.extraEnv?.GOCACHE, fallbackArgv), { mode: 0o700 });
  } catch (error) {
    cleanupDisposableAgentStateHome(stateHome);
    throw error;
  }
  return [FIXED_OS_EXECUTABLES.sh, wrapper];
}
