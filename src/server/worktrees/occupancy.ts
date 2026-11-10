import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  listProcessesSnapshot,
  type Proc,
  type ProcessSnapshot,
  type ReadOptions,
} from "../discovery/processes.ts";
import {
  readProcCwdsSnapshot,
  type ProcCwdSnapshot,
} from "../discovery/proc-cwd.ts";
import {
  bothAttempts,
  OBSERVATION_RETRY_DELAY_MS,
  OBSERVATION_RETRY_TIMEOUT_SCALE,
  pauseFor,
} from "./observation-retry.ts";
import { ownWorktreeProcesses } from "./own-processes.ts";

const MAX_TARGETS = 256;
const MAX_COMMAND_BYTES = 512;
/** How many PIDs the cwd listing omitted are re-read one at a time before the rest stay unresolved. */
const MAX_SINGLE_REREADS = 8;

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
  listProcesses: (options?: ReadOptions) => Promise<ProcessSnapshot>;
  readCwds: (pids: number[], options?: ReadOptions) => Promise<ProcCwdSnapshot>;
  knownOwner: (process: Proc) => string | null;
  /** This daemon's running worktree Git commands; never occupants of the slot they read. */
  ownProcesses: () => ReadonlySet<number>;
  /** The wait before the one retry of a failed inspection. */
  pause: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: WorktreeOccupancyDeps = {
  listProcesses: (options) => listProcessesSnapshot(undefined, options),
  readCwds: readProcCwdsSnapshot,
  knownOwner: () => null,
  ownProcesses: ownWorktreeProcesses,
  pause: pauseFor,
};

/**
 * Every in-scope process with its resolved cwd, or why they could not all be resolved.
 * `overflowed` marks a listing too large to buffer: the retry doubles the timeout, not the
 * buffer, so asking again would only report the same overflow 2 s later.
 */
type Observation =
  | { ok: true; processes: Proc[]; cwds: ReadonlyMap<number, string> }
  | { ok: false; reason: string; overflowed?: boolean };

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
 * Our running worktree Git commands and every process below them in this snapshot. A Git
 * command may run helpers of its own; they are just as much our bounded read or removal.
 */
function ownDescendants(processes: readonly Proc[], roots: ReadonlySet<number>): Set<number> {
  const own = new Set<number>();
  if (roots.size === 0) return own;
  const parent = new Map(processes.map((process) => [process.pid, process.ppid]));
  for (const process of processes) {
    const seen = new Set<number>();
    for (let pid: number | undefined = process.pid; pid !== undefined && pid > 0 && !seen.has(pid); pid = parent.get(pid)) {
      seen.add(pid);
      if (roots.has(pid) || own.has(pid)) {
        own.add(process.pid);
        break;
      }
    }
  }
  return own;
}

/**
 * One bounded all-process query projected over one or more worktrees. Both system reads run
 * once per attempt. A failed attempt (a listing or cwd read that failed, or a PID that stayed
 * unresolved) is retried once, 2 s later with double the timeouts, and only a second failure
 * returns unknown for every target, never an empty set.
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

  let observed = await observe(d, {});
  if (!observed.ok && !observed.overflowed) {
    await d.pause(OBSERVATION_RETRY_DELAY_MS);
    const retried = await observe(d, { timeoutScale: OBSERVATION_RETRY_TIMEOUT_SCALE });
    observed = retried.ok ? retried : { ok: false, reason: bothAttempts(observed.reason, retried.reason) };
  }
  if (!observed.ok) {
    for (const target of targets) result.set(target, { status: "unknown", reason: observed.reason });
    return result;
  }
  const { processes, cwds } = observed;

  const canonicalTargets = new Map<string, string>();
  await Promise.all(targets.map(async (target) => canonicalTargets.set(target, await physical(target))));
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const occupants = new Map(targets.map((target) => [target, [] as WorktreeOccupant[]]));

  for (const [pid, cwdPath] of cwds) {
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

/** One attempt at resolving every in-scope process's cwd. */
async function observe(d: WorktreeOccupancyDeps, options: ReadOptions): Promise<Observation> {
  let snapshot: ProcessSnapshot;
  try {
    snapshot = await d.listProcesses(options);
  } catch (error) {
    return { ok: false, reason: `process listing failed: ${String(error)}` };
  }
  if (snapshot.unknownReason) {
    return { ok: false, reason: snapshot.unknownReason, overflowed: snapshot.overflowed === true };
  }

  // Mission Control is a per-user daemon. macOS exposes other users' processes through ps
  // while withholding their cwd from an unprivileged lsof, so they are outside the process
  // security boundary the daemon can positively observe. Within that boundary every PID must
  // resolve, disappear under a fresh stable-identity snapshot, or make occupancy unknown.
  const cwdScope = new Set(snapshot.cwdScopePids);
  const completedCollectors = new Set(snapshot.completedCollectorPids);
  const own = ownDescendants(snapshot.processes, d.ownProcesses());
  const processes = snapshot.processes.filter(
    (process) =>
      Number.isInteger(process.pid) &&
      process.pid > 0 &&
      cwdScope.has(process.pid) &&
      !completedCollectors.has(process.pid) &&
      !own.has(process.pid),
  );
  let cwdSnapshot: ProcCwdSnapshot;
  try {
    cwdSnapshot = await d.readCwds(processes.map((process) => process.pid), options);
  } catch (error) {
    return { ok: false, reason: `cwd listing failed: ${String(error)}` };
  }
  // Treat the dependency result as untrusted evidence: even a reader that reports itself
  // healthy cannot make omission prove that a ps-listed process exited. Re-list and compare
  // stable process identity so only independently proven PID churn is ignored. A failed cwd
  // read starts with every PID unresolved: an all-empty `lsof` result is safe only when the
  // fresh snapshot proves every process in the original scope exited during the read.
  //
  // A PID a healthy listing omitted is first re-read on its own: a batched `lsof` under load
  // drops a PID it answers for when asked alone, and one such omission used to make a whole
  // pass unknown. The re-reads run one at a time and stop at the first that does not answer
  // (or throws): under the load that causes a timeout the next would time out too, so an
  // attempt spends at most one cwd timeout on them rather than eight.
  const cwdFailure = cwdSnapshot.unknownReason;
  const cwds = new Map(cwdSnapshot.cwds);
  let unresolved = cwdFailure
    ? processes
    : processes.filter((process) => !cwds.has(process.pid));
  if (!cwdFailure) {
    for (const process of unresolved.slice(0, MAX_SINGLE_REREADS)) {
      let alone: ProcCwdSnapshot;
      try {
        alone = await d.readCwds([process.pid], options);
      } catch {
        break; // This and the rest stay unresolved; the disappearance check below decides.
      }
      if (alone.unanswered) break;
      // Only this PID's own answer counts, whatever else the reader returned.
      const cwd = alone.cwds.get(process.pid);
      if (cwd !== undefined) cwds.set(process.pid, cwd);
    }
    unresolved = unresolved.filter((process) => !cwds.has(process.pid));
  }
  if (unresolved.length > 0) {
    let confirmation: ProcessSnapshot;
    try {
      confirmation = await d.listProcesses(options);
    } catch (error) {
      return { ok: false, reason: `process disappearance check failed: ${String(error)}` };
    }
    if (confirmation.unknownReason) {
      return { ok: false, reason: confirmation.unknownReason, overflowed: confirmation.overflowed === true };
    }
    const confirmed = new Map(confirmation.processes.map((process) => [process.pid, process]));
    // Still alive means still in scope, by the same rule the first snapshot used. A short-lived
    // process caught mid-exit - its cwd already released, so the cwd reader omits it - is
    // listed again as a zombie with the same start time. A zombie holds no cwd and cannot
    // occupy anything; counting it as alive turned every busy moment of this daemon's own Git
    // reads into unknown occupancy and a refused cleanup.
    const confirmedScope = new Set(confirmation.cwdScopePids);
    unresolved = unresolved.filter((process) => {
      const current = confirmed.get(process.pid);
      return current?.startRaw === process.startRaw && confirmedScope.has(process.pid);
    });
  }
  if (unresolved.length > 0) {
    if (cwdFailure) return { ok: false, reason: cwdFailure, overflowed: cwdSnapshot.overflowed === true };
    const unresolvedPids = unresolved.map((process) => process.pid);
    const shown = unresolvedPids.slice(0, 8).join(", ");
    const remainder = unresolvedPids.length > 8 ? ` and ${unresolvedPids.length - 8} more` : "";
    const reason =
      `cwd listing omitted ${unresolvedPids.length} ps-listed PID${unresolvedPids.length === 1 ? "" : "s"}: ${shown}${remainder}`;
    return { ok: false, reason };
  }
  return { ok: true, processes, cwds };
}
