import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Proc } from "../discovery/processes.ts";
import type { Session } from "@shared/types.ts";
import { terminalResourceIds } from "@shared/pane.ts";
import type { SpawnedHome } from "./home.ts";

export const LAUNCH_SCRIPT_FILE = "launch-and-cleanup.sh";
export const LAUNCH_PID_FILE = "terminal-launch.pid";
export type LaunchProcess = Pick<Proc, "pid" | "startMs">;

/** The private wrapper records its own PID before starting the requested command. */
export async function readLaunchProcess(stateHome: string): Promise<LaunchProcess | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
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
  if (!home.launchProcess) return false;
  // Process discovery depends on initialized harnesses, which themselves reach Registry.
  const { listProcesses } = await import("../discovery/processes.ts");
  return belongsToLaunch(session, home.launchProcess, await listProcesses());
}
