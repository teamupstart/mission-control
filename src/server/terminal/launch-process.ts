import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Proc, ProcessSnapshot } from "../discovery/processes.ts";
import type { Session } from "@shared/types.ts";
import { terminalResourceIds } from "@shared/pane.ts";
// Not `../config.ts`: its module scope freezes the state directory, and this module is
// imported by files that set their own state home only after their static imports.
import { stateDir } from "../../shared/harness-runtime.mjs";
import { resumeGuardPath } from "../resume-guard-path.ts";
import { FIXED_OS_EXECUTABLES } from "../executables/catalog.ts";
import type { SpawnedHome } from "./home.ts";
import { isResumeLeaseId, resumeLeaseRootPath } from "./resume-lease.ts";

export const LAUNCH_SCRIPT_FILE = "launch-and-cleanup.sh";
export const LAUNCH_PID_FILE = "terminal-launch.pid";
/**
 * Where a launch wrapper with a fallback argv writes which one it ran: `shaped` or `original`.
 * Beside the state home rather than in it, because the wrapper removes its state home when the
 * agent exits, and an agent that exits right after readiness would otherwise take the answer
 * with it. The dispatcher reads it before recording what the launch delivered, then removes it.
 */
export function turnOneOutcomePath(stateHome: string): string {
  return `${stateHome}.turn-one`;
}
export type LaunchProcess = Pick<Proc, "pid" | "startMs">;

/**
 * Where every agent-controlled launch gets its private state home, one `session-*` directory
 * per launch. Defined here, beside the wrapper's file name, because this module is also what
 * recognizes that wrapper in the process table; `agent-subprocess-env.ts` creates the homes
 * from the same constant. (It lives here rather than there because that module already imports
 * this one, and the reverse import would close a cycle.)
 */
export const DISPOSABLE_STATE_ROOT = join(tmpdir(), "mission-control-agent-state");

/**
 * What a Mission Control launch looks like in `ps`, resolved once per discovery sweep.
 *
 * `resumeGuard`/`resumeLeaseRoot` are null when they cannot be resolved (a state directory
 * that does not exist yet), which only means no resume guard can match: a daemon with no
 * state has launched no managed resume.
 */
export interface MissionLaunchMarkers {
  disposableRoot: string;
  resumeGuard: string | null;
  resumeLeaseRoot: string | null;
}

/** The last unexpected lease-root failure reported, so a sweep every ~1.5s logs it once. */
let reportedLeaseRootFailure: string | null = null;

/**
 * Read without side effects: discovery runs this every sweep and must never create state.
 *
 * A missing state directory (`ENOENT`) is the expected first-run state and stays quiet. Any
 * other failure (a permission error, a symlink loop, a path through a file) also leaves the
 * resume markers null, because failing the whole sweep would hide every session instead of
 * only managed resumes. It is logged once, though, because it hides every managed-resume and
 * Continue-in-terminal session on this machine, and nothing else would say why.
 */
export function missionLaunchMarkers(
  leaseRoot: () => string = () => resumeLeaseRootPath(stateDir()),
  warn: (message: string) => void = console.warn,
): MissionLaunchMarkers {
  let resumeLeaseRoot: string | null = null;
  try {
    resumeLeaseRoot = leaseRoot();
    reportedLeaseRootFailure = null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== reportedLeaseRootFailure) {
        reportedLeaseRootFailure = message;
        warn(
          `[discovery] cannot resolve the resume lease root (${message}); managed resumes and ` +
            "Continue in terminal sessions will be treated as started outside Mission Control",
        );
      }
    }
  }
  return {
    disposableRoot: DISPOSABLE_STATE_ROOT,
    resumeGuard: resumeLeaseRoot ? resumeGuardPath() : null,
    resumeLeaseRoot,
  };
}

/**
 * Whether this process is one of Mission Control's own launch wrappers. Exactly two shapes,
 * one per launch builder:
 *
 * - `isolatedAgentArgv` (dispatch, the agent button, the terminal chooser) runs
 *   `/bin/sh <DISPOSABLE_STATE_ROOT>/session-<id>/launch-and-cleanup.sh`, which does not
 *   `exec`, so the shell stays the agent's ancestor. Ghostty's `exec -l` prefixes argv0 with
 *   a dash, as `readLaunchProcess` already allows.
 * - `prepareTerminalResume` (managed resume, Continue in terminal) writes its wrapper at
 *   `<lease root>/homes/<lease id>/launch-and-cleanup.sh`, which `exec`s
 *   `<runtime> <resume guard> <lease root> <lease id>` (`resumeGuardArgv`); the guard then
 *   spawns the agent as its child. Both forms are accepted, the wrapper before its `exec` as
 *   well as the guard after it, and both only under this daemon's own lease root.
 *
 * Compared as whole strings and never split on whitespace: a packaged app lives in
 * `Agent Mission Control.app`, so the runtime and guard paths both contain spaces.
 */
export function isMissionLaunchProcess(
  proc: Pick<Proc, "command">,
  markers: MissionLaunchMarkers = missionLaunchMarkers(),
): boolean {
  const command = proc.command.replace(/^-/, "");
  const prefix = `${FIXED_OS_EXECUTABLES.sh} ${markers.disposableRoot}/session-`;
  const suffix = `/${LAUNCH_SCRIPT_FILE}`;
  if (command.startsWith(prefix) && command.endsWith(suffix)) {
    const segment = command.slice(prefix.length, command.length - suffix.length);
    if (segment.length > 0 && !segment.includes("/")) return true;
  }
  if (!markers.resumeGuard || !markers.resumeLeaseRoot) return false;
  const resumePrefix = `${FIXED_OS_EXECUTABLES.sh} ${markers.resumeLeaseRoot}/homes/`;
  if (command.startsWith(resumePrefix) && command.endsWith(suffix)
    && isResumeLeaseId(command.slice(resumePrefix.length, command.length - suffix.length))) return true;
  const lastSpace = proc.command.lastIndexOf(" ");
  if (lastSpace < 0 || !isResumeLeaseId(proc.command.slice(lastSpace + 1))) return false;
  const head = proc.command.slice(0, lastSpace);
  const guardTail = ` ${markers.resumeGuard} ${markers.resumeLeaseRoot}`;
  // Something must precede the guard: the runtime that runs it.
  return head.endsWith(guardTail) && head.length > guardTail.length;
}

/**
 * The private state home of the ONE launch this process is, or null when it is not a Mission
 * Control launch wrapper or resume guard. Every launch gets its own home (a `session-*`
 * directory, or a resume lease's `homes/<id>`), so this names a launch exactly - unlike the
 * checkout it runs in, which another pane can share. The same command shapes
 * `isMissionLaunchProcess` recognizes.
 */
export function missionLaunchHomeOf(
  proc: Pick<Proc, "command">,
  markers: MissionLaunchMarkers = missionLaunchMarkers(),
): string | null {
  if (!isMissionLaunchProcess(proc, markers)) return null;
  const command = proc.command.replace(/^-/, "");
  const suffix = `/${LAUNCH_SCRIPT_FILE}`;
  const wrapperPrefix = `${FIXED_OS_EXECUTABLES.sh} `;
  if (command.startsWith(wrapperPrefix) && command.endsWith(suffix)) {
    return command.slice(wrapperPrefix.length, command.length - suffix.length);
  }
  // The resume guard's own form: `<runtime> <guard> <leaseRoot> <leaseId>`.
  if (!markers.resumeLeaseRoot) return null;
  return join(markers.resumeLeaseRoot, "homes", proc.command.slice(proc.command.lastIndexOf(" ") + 1));
}

/**
 * The state home of the nearest Mission Control launch this process runs beneath (itself or an
 * ancestor in the same snapshot), or null. `hasMissionLaunchAncestor`'s walk, answering WHICH
 * launch rather than whether there is one.
 */
export function missionLaunchAncestorHome(
  pid: number,
  procs: readonly Proc[] | ReadonlyMap<number, Proc>,
  markers: MissionLaunchMarkers = missionLaunchMarkers(),
): string | null {
  const byPid = procs instanceof Map ? procs : new Map((procs as readonly Proc[]).map((p) => [p.pid, p]));
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    const home = missionLaunchHomeOf(current, markers);
    if (home) return home;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return null;
}

/**
 * Whether a Mission Control launch wrapper is this process or one of its ancestors in the
 * same snapshot. Walks `ppid` with cycle protection, as `belongsToLaunch` does. Read from the
 * live process table, so a Mission terminal session that outlived a daemon restart is still
 * recognized as one.
 */
export function hasMissionLaunchAncestor(
  pid: number,
  procs: readonly Proc[] | ReadonlyMap<number, Proc>,
  markers: MissionLaunchMarkers = missionLaunchMarkers(),
): boolean {
  const byPid = procs instanceof Map ? procs : new Map((procs as readonly Proc[]).map((p) => [p.pid, p]));
  let current = byPid.get(pid);
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    if (isMissionLaunchProcess(current, markers)) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

/** A missing claim or a complete scan can find no wrapper. An incomplete scan cannot prove its absence. */
export async function readTerminalWrapperProcess(
  stateHome: string,
  knownPid?: number,
  readSnapshot?: () => Promise<Pick<ProcessSnapshot, "processes" | "unknownReason">>,
): Promise<LaunchProcess | null | "unknown"> {
  let pid = knownPid;
  if (!pid) {
    try {
      const value = readFileSync(join(stateHome, LAUNCH_PID_FILE), "utf8").trim();
      pid = /^\d+$/.test(value) ? Number(value) : 0;
      if (!pid) return null;
    } catch { return null; } // No readable PID claim yet.
  }
  try {
    const snapshot = await (readSnapshot ?? (await import("../discovery/processes.ts")).listProcessesSnapshot)();
    const process = snapshot.processes.find((p) => p.pid === pid);
    // Ghostty uses `exec -l`, which prefixes the shell's argv0 with a dash.
    if (process?.startMs && process.command.replace(/^-/, "") === `/bin/sh ${join(stateHome, LAUNCH_SCRIPT_FILE)}`) {
      return { pid, startMs: process.startMs };
    }
    return snapshot.unknownReason === null ? null : "unknown";
  } catch { return "unknown"; }
}

/** The private wrapper records its own PID before starting the requested command. */
export async function readLaunchProcess(stateHome: string): Promise<LaunchProcess | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      // Managed resume guards record their own exact lifetime after winning the lease.
      const marker = JSON.parse(readFileSync(join(stateHome, "terminal-launch.json"), "utf8")) as LaunchProcess;
      const { listProcesses } = await import("../discovery/processes.ts");
      const owner = (await listProcesses()).find((p) => p.pid === marker.pid && p.startMs === marker.startMs);
      if (owner) return marker;
    } catch { /* Legacy launch wrappers have only the PID file below. */ }
    const wrapper = await readTerminalWrapperProcess(stateHome);
    if (wrapper && wrapper !== "unknown") return wrapper;
    await delay(50);
  }
  return null;
}

/** A matching directory or recycled PID is not proof of launch ownership. */
export function belongsToLaunch(
  session: { pid: number; startedAt: number | null },
  launch: LaunchProcess,
  procs: readonly Proc[],
): boolean {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let current = byPid.get(session.pid);
  if (!current || current.startMs !== session.startedAt) return false;
  const seen = new Set<number>();
  while (current && !seen.has(current.pid)) {
    if (current.pid === launch.pid) return current.startMs === launch.startMs;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

/**
 * Whether a spawn returned anything that names the worker it started: the terminal resource it
 * opened, or the launch wrapper it runs beneath. A home with none of these cannot be told apart
 * from another worker in the same checkout at all - when a worker appeared is not evidence of
 * whose it is - so nothing may be bound to it by discovery.
 */
export function spawnHasLaunchIdentity(home: SpawnedHome): boolean {
  return home.terminalResourceId !== null || !!home.launchProcess || !!home.launchStateHome;
}

/**
 * Decides, for one spawn, whether a discovered session is the worker that spawn started.
 *
 * A shared checkout is not evidence: a cancelled launch and its replacement can both be live in
 * the same worktree, and so can an operator's own pane. Only the spawn's own identity is -
 * the exact terminal resource it opened, or the live launch wrapper (`launchProcess`, else the
 * one recorded in `launchStateHome`) the session's process descends from. A resource is checked
 * on every sighting, since a pane's handles can arrive after the process does. The wrapper's
 * identity is looked up again on each check until it is found: a lookup can come back empty while
 * the process table cannot be read. Once found, process ancestry cannot change for a session, so
 * a session that a COMPLETE process listing places outside the launch stays rejected. A listing
 * that could not be read in full proves no absence, so its "no" is not kept.
 *
 * Callers check `spawnHasLaunchIdentity` first; a home without identity matches nothing here.
 * `readOwner` reads the wrapper's identity from `launchStateHome`, and `listSnapshot` reads the
 * process table; both default to the real readers.
 */
export function launchedSessionMatcher(
  home: SpawnedHome,
  {
    readOwner = readLaunchProcess,
    listSnapshot,
  }: {
    readOwner?: (stateHome: string) => Promise<LaunchProcess | null>;
    listSnapshot?: () => Promise<{ processes: readonly Proc[]; unknownReason: string | null }>;
  } = {},
): (session: Session) => Promise<boolean> {
  // Only a found owner is kept. A lookup that finds none may simply have run before the wrapper
  // recorded itself, so the next sighting asks again; concurrent sightings share one lookup.
  let owner: LaunchProcess | null = home.launchProcess ?? null;
  let lookup: Promise<LaunchProcess | null> | null = null;
  const resolveOwner = async (): Promise<LaunchProcess | null> => {
    if (owner || !home.launchStateHome) return owner;
    lookup ??= readOwner(home.launchStateHome).finally(() => { lookup = null; });
    owner = await lookup;
    return owner;
  };
  const rejected = new Set<string>();
  return async (session) => {
    if (home.terminalResourceId !== null && terminalResourceIds(session).has(home.terminalResourceId)) return true;
    if (rejected.has(session.id)) return false;
    const launch = await resolveOwner();
    if (!launch) return false;
    // Process discovery depends on initialized harnesses, which themselves reach Registry.
    const snapshot = listSnapshot
      ? await listSnapshot()
      : await (await import("../discovery/processes.ts")).listProcessesSnapshot();
    if (belongsToLaunch(session, launch, snapshot.processes)) return true;
    // Partial rows can omit the session or its wrapper; only a complete listing proves it is not this launch.
    if (snapshot.unknownReason === null) rejected.add(session.id);
    return false;
  };
}

/** An emulator spawn requires an observed exact target or its live launch ancestry. */
export async function verifiesEmulatorLaunch(home: SpawnedHome, session: Session): Promise<boolean> {
  if (!home.terminalResourceId?.startsWith("emulator:")) return true;
  if (terminalResourceIds(session).has(home.terminalResourceId)) return true;
  const launch = home.launchProcess ?? (home.launchStateHome ? await readLaunchProcess(home.launchStateHome) : null);
  if (!launch) return false;
  // Process discovery depends on initialized harnesses, which themselves reach Registry.
  const { listProcesses } = await import("../discovery/processes.ts");
  return belongsToLaunch(session, launch, await listProcesses());
}
