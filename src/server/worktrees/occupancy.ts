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

  // Mission Control is a per-user daemon. macOS exposes other users' processes through ps
  // while withholding their cwd from an unprivileged lsof, so they are outside the process
  // security boundary the daemon can positively observe. Within that boundary every PID must
  // resolve, disappear under a fresh stable-identity snapshot, or make occupancy unknown.
  const cwdScope = new Set(snapshot.cwdScopePids);
  const completedCollectors = new Set(snapshot.completedCollectorPids);
  const processes = snapshot.processes.filter(
    (process) =>
      Number.isInteger(process.pid) &&
      process.pid > 0 &&
      cwdScope.has(process.pid) &&
      !completedCollectors.has(process.pid),
  );
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

  // Treat the dependency result as untrusted evidence: even a reader that reports itself
  // healthy cannot make omission prove that a ps-listed process exited. Re-list and compare
  // stable process identity so only independently proven PID churn is ignored.
  let unresolved = processes.filter((process) => !cwdSnapshot.cwds.has(process.pid));
  if (unresolved.length > 0) {
    let confirmation: ProcessSnapshot;
    try {
      confirmation = await d.listProcesses();
    } catch (error) {
      const reason = `process disappearance check failed: ${String(error)}`;
      for (const target of targets) result.set(target, { status: "unknown", reason });
      return result;
    }
    if (confirmation.unknownReason) {
      for (const target of targets) {
        result.set(target, { status: "unknown", reason: confirmation.unknownReason });
      }
      return result;
    }
    const confirmed = new Map(confirmation.processes.map((process) => [process.pid, process]));
    unresolved = unresolved.filter((process) => {
      const current = confirmed.get(process.pid);
      return current?.startRaw === process.startRaw;
    });
  }
  if (unresolved.length > 0) {
    const unresolvedPids = unresolved.map((process) => process.pid);
    const shown = unresolvedPids.slice(0, 8).join(", ");
    const remainder = unresolvedPids.length > 8 ? ` and ${unresolvedPids.length - 8} more` : "";
    const reason =
      `cwd listing omitted ${unresolvedPids.length} ps-listed PID${unresolvedPids.length === 1 ? "" : "s"}: ${shown}${remainder}`;
    for (const target of targets) result.set(target, { status: "unknown", reason });
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
