import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Proc } from "../discovery/processes.ts";
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

/** Read without side effects: discovery runs this every sweep and must never create state. */
export function missionLaunchMarkers(): MissionLaunchMarkers {
  let resumeLeaseRoot: string | null = null;
  try {
    resumeLeaseRoot = resumeLeaseRootPath(stateDir());
  } catch { /* No state directory yet, so no lease can exist under it. */ }
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
    try {
      const value = readFileSync(join(stateHome, LAUNCH_PID_FILE), "utf8").trim();
      const pid = /^\d+$/.test(value) ? Number(value) : 0;
      const { listProcesses } = await import("../discovery/processes.ts");
      const process = (await listProcesses()).find((p) => p.pid === pid);
      // Ghostty uses `exec -l`, which prefixes the shell's argv0 with a dash.
      if (process?.startMs && process.command.replace(/^-/, "") === `/bin/sh ${join(stateHome, LAUNCH_SCRIPT_FILE)}`) {
        return { pid, startMs: process.startMs };
      }
    } catch { /* The wrapper may not have reached its first instruction yet. */ }
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
