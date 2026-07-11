import { run } from "../util/exec.ts";
import { gitInfo } from "../util/git.ts";
import type { Proc } from "./processes.ts";
import type { DiscoveredSession, NmLaunch } from "./correlate.ts";

// Attributes a live no-mistakes run to the session that launched it.
//
// Several agent terminals routinely share one checkout on one branch (main), so
// cwd + git branch can't tell them apart, and `no-mistakes axi status` reports a
// single run per repo regardless of which session kicked it off. The one signal
// that *does* distinguish them: the launching session runs a blocking
// `no-mistakes axi run` (or `respond`/`attach`/`rerun`) whose process is a
// descendant of that session's agent, working in the run's worktree. We find
// those processes, map each back to its owning session via the parent chain, and
// resolve the worktree it's driving (its cwd) - the registry then attributes the
// run on that worktree's branch to only that session, never the idle siblings.

/** Max hops walking a process's parent chain to its owning session's root pid. */
const MAX_PARENT_HOPS = 40;

/**
 * The no-mistakes subcommands that drive (or attach to) a specific run in a
 * worktree - a session running one is actively behind that run. Read-only checks
 * (`status`, `runs`, `stats`, `doctor`) are excluded so an incidental status peek
 * doesn't get mistaken for driving a run.
 */
const DRIVE_VERBS = /\b(axi run|axi respond|attach|rerun)\b/;

/** True when a process is a session-driven no-mistakes run driver (argv0 is the binary). */
export function isNomistakesDriver(command: string): boolean {
  const argv0 = command.split(/\s+/, 1)[0] ?? "";
  const base = argv0.replace(/.*\//, "");
  if (base !== "no-mistakes") return false;
  return DRIVE_VERBS.test(command);
}

/**
 * Walk a driver process's parent chain until it reaches a discovered session's
 * root agent pid, returning that session. The daemon's own pipeline agents and
 * the harness's status polls never reach a session root, so they resolve to
 * undefined and are ignored.
 */
function ownerSession(
  proc: Proc,
  byPid: Map<number, Proc>,
  rootPids: Map<number, DiscoveredSession>,
): DiscoveredSession | undefined {
  let cur = proc.ppid;
  for (let i = 0; i < MAX_PARENT_HOPS; i++) {
    const owner = rootPids.get(cur);
    if (owner) return owner;
    const parent = byPid.get(cur);
    if (!parent || parent.pid === parent.ppid) return undefined;
    cur = parent.ppid;
  }
  return undefined;
}

/**
 * Resolve the cwd of each pid via one batched `lsof`. `-Fpn` prints `p<pid>`
 * then `n<path>` records; we pair them. Never throws (lsof may exit non-zero
 * when some pids vanish mid-call, but still prints the survivors).
 */
async function lsofCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  const res = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], {
    timeoutMs: 4000,
  });
  let pid: number | null = null;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isNaN(n) ? null : n;
    } else if (line.startsWith("n") && pid !== null) {
      out.set(pid, line.slice(1));
    }
  }
  return out;
}

/**
 * Annotate sessions in place with the worktrees where each is driving a
 * no-mistakes run. Cheap when nothing is running (no drivers -> no lsof).
 */
export async function annotateNomistakesLaunches(
  sessions: DiscoveredSession[],
  procs: Proc[],
): Promise<void> {
  if (sessions.length === 0) return;

  const byPid = new Map<number, Proc>();
  for (const p of procs) byPid.set(p.pid, p);
  const rootPids = new Map<number, DiscoveredSession>();
  for (const s of sessions) rootPids.set(s.pid, s);

  const drivers: { pid: number; session: DiscoveredSession }[] = [];
  for (const p of procs) {
    if (!isNomistakesDriver(p.command)) continue;
    const session = ownerSession(p, byPid, rootPids);
    if (session) drivers.push({ pid: p.pid, session });
  }
  if (drivers.length === 0) return;

  const cwds = await lsofCwds(drivers.map((d) => d.pid));
  for (const { pid, session } of drivers) {
    const cwd = cwds.get(pid);
    if (!cwd) continue;
    const runs = (session.nomistakesRuns ??= []);
    if (runs.some((r) => r.cwd === cwd)) continue; // dedup: two driver procs, one worktree
    const launch: NmLaunch = { cwd, branch: gitInfo(cwd).branch };
    runs.push(launch);
  }
}
