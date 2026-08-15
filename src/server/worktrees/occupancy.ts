import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  listProcessesSnapshot,
  type Proc,
  type ProcessSnapshot,
} from "../discovery/processes.ts";
import {
  readProcCwdsSnapshot,
  type ProcCwdSnapshot,
} from "../discovery/proc-cwd.ts";

const MAX_TARGETS = 256;
const MAX_COMMAND_BYTES = 512;

export interface WorktreeOccupant {
  pid: number;
  ppid: number;
  startRaw: string;
  startMs: number;
  command: string;
  cwd: string;
  /** Which existing Mission Control runtime owns it, or null when it is unknown to us. */
  knownOwner: string | null;
}

export type WorktreeOccupancy =
  | { status: "known"; occupants: WorktreeOccupant[] }
  | { status: "unknown"; reason: string };

export interface WorktreeOccupancyDeps {
  listProcesses: () => Promise<ProcessSnapshot>;
  readCwds: (pids: number[]) => Promise<ProcCwdSnapshot>;
  knownOwner: (process: Proc) => string | null;
}

const DEFAULT_DEPS: WorktreeOccupancyDeps = {
  listProcesses: listProcessesSnapshot,
  readCwds: readProcCwdsSnapshot,
  knownOwner: () => null,
};

async function physical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Segment-aware containment. `/pool/1` never matches `/pool/10`. */
export function pathContains(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * One bounded all-process query projected over one or more worktrees. Both system reads run
 * exactly once. Unknown system evidence returns unknown for every target, never an empty set.
 */
export async function inspectWorktreeOccupancy(
  targetPaths: readonly string[],
  deps: Partial<WorktreeOccupancyDeps> = {},
): Promise<Map<string, WorktreeOccupancy>> {
  const d = { ...DEFAULT_DEPS, ...deps };
  const result = new Map<string, WorktreeOccupancy>();
  const targets = [...new Set(targetPaths)];
  if (targets.length === 0) return result;
  if (targets.length > MAX_TARGETS) {
    for (const target of targets) {
      result.set(target, { status: "unknown", reason: `occupancy query exceeds ${MAX_TARGETS} paths` });
    }
    return result;
  }

  let snapshot: ProcessSnapshot;
  try {
    snapshot = await d.listProcesses();
  } catch (error) {
    const reason = `process listing failed: ${String(error)}`;
    for (const target of targets) result.set(target, { status: "unknown", reason });
    return result;
  }
  if (snapshot.unknownReason) {
    for (const target of targets) {
      result.set(target, { status: "unknown", reason: snapshot.unknownReason });
    }
    return result;
  }

  const processes = snapshot.processes.filter((process) => Number.isInteger(process.pid) && process.pid > 0);
  let cwdSnapshot: ProcCwdSnapshot;
  try {
    cwdSnapshot = await d.readCwds(processes.map((process) => process.pid));
  } catch (error) {
    const reason = `cwd listing failed: ${String(error)}`;
    for (const target of targets) result.set(target, { status: "unknown", reason });
    return result;
  }
  if (cwdSnapshot.unknownReason) {
    for (const target of targets) {
      result.set(target, { status: "unknown", reason: cwdSnapshot.unknownReason });
    }
    return result;
  }

  const canonicalTargets = new Map<string, string>();
  await Promise.all(targets.map(async (target) => canonicalTargets.set(target, await physical(target))));
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const occupants = new Map(targets.map((target) => [target, [] as WorktreeOccupant[]]));

  for (const [pid, cwdPath] of cwdSnapshot.cwds) {
    const process = byPid.get(pid);
    if (!process) continue; // PID churn: lsof saw a process the ps snapshot did not.
    const cwd = await physical(cwdPath);
    for (const [target, canonicalTarget] of canonicalTargets) {
      if (!pathContains(canonicalTarget, cwd)) continue;
      occupants.get(target)!.push({
        pid: process.pid,
        ppid: process.ppid,
        startRaw: process.startRaw,
        startMs: process.startMs,
        command: process.command.slice(0, MAX_COMMAND_BYTES),
        cwd,
        knownOwner: d.knownOwner(process),
      });
    }
  }

  for (const target of targets) {
    result.set(target, {
      status: "known",
      occupants: occupants.get(target)!.sort((a, b) => a.pid - b.pid),
    });
  }
  return result;
}
