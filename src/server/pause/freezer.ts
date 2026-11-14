import type { Session } from "@shared/types.ts";
import { daemonOwnedPids, listProcessesSnapshot, type Proc } from "../discovery/processes.ts";
import { createHash } from "node:crypto";
import { processStartIdentity } from "../workflows/check-identity.ts";
import type { ProcessFreezer, ProcessRef, SignalFailure } from "./manager.ts";

/**
 * The mechanism behind a pause: which processes make up a session's agent, and the signals.
 *
 * WHAT IS STOPPED. The agent's root process and every descendant (its tool runs, test runners,
 * background sub-agents), read from one fresh process snapshot. Plus, for a pane-backed agent
 * started from an interactive shell, that PARENT SHELL, stopped first and resumed last. A job-
 * control shell that sees its foreground job stop takes the terminal back and prints
 * "suspended"; the job it later resumes is in the background and stops again on its first read
 * of the terminal. A shell that is itself stopped cannot react, and by the time it runs again
 * its child is running, so there is nothing stopped left to report.
 *
 * WHAT IS NEVER STOPPED. The daemon, pid 1, anything outside the session's own tree, and a
 * process that is not the one the session names: a terminal session's id carries its root's
 * start time, and a root that no longer matches it is a reused pid, not the agent. An SDK
 * driver must be our own child; one that runs inside the daemon (Pi) has nothing to stop.
 */

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish"]);

/** `-zsh`, `/bin/zsh -l`, `zsh` → `zsh`. */
export function shellName(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.replace(/^-/, "").split("/").pop() ?? "";
  return SHELLS.has(base) ? base : null;
}

/** The start time a terminal session's id pins its root to: `proc:<tty>:<pid>:<startMs>`. */
export function terminalRootStart(sessionId: string): number | null {
  const match = /^proc:[^:]*:(\d+):(\d+)$/.exec(sessionId);
  return match ? Number(match[2]) : null;
}

/**
 * The ordered tree to stop, from one snapshot: the parent shell when there is one, then the
 * root, then its descendants breadth first - parents before children, so no frozen-to-be
 * process spawns a child the walk has already passed. Resume in reverse.
 */
export function agentTree(
  procs: readonly Proc[],
  root: number,
  options: { daemonPid: number; includeParentShell: boolean },
): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rootProc = byPid.get(root);
  if (!rootProc || root <= 1 || root === options.daemonPid) return [];
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    const kids = children.get(p.ppid);
    if (kids) kids.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const ordered: number[] = [];
  const seen = new Set<number>([options.daemonPid, 0, 1]);
  if (options.includeParentShell) {
    const parent = byPid.get(rootProc.ppid);
    if (
      parent &&
      !seen.has(parent.pid) &&
      parent.tty !== null &&
      parent.tty === rootProc.tty &&
      shellName(parent.command) !== null
    ) {
      ordered.push(parent.pid);
      seen.add(parent.pid);
    }
  }
  const queue = [root];
  seen.add(root);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    ordered.push(pid);
    for (const kid of children.get(pid) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      queue.push(kid);
    }
  }
  return ordered;
}

export interface FreezerDeps {
  /** The SDK driver's own child pid, or null when it has none (`SdkSupervisor.driverProcessId`). */
  sdkDriverPid: (sessionId: string) => number | null;
  snapshot?: () => Promise<{ processes: Proc[]; unknownReason: string | null }>;
  signal?: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  /**
   * A process's start-and-command identity, or null when it cannot be read
   * (`processStartIdentity`). What tells the agent a pause stopped apart from an unrelated
   * process that later received the same pid.
   */
  identify?: (pid: number) => string | null;
  /** Whether a pid names a live process at all (`kill(pid, 0)`). */
  exists?: (pid: number) => boolean;
  daemonPid?: number;
  log?: (message: string) => void;
}

/** The stored form of an identity: a digest, so a long command line costs the record nothing. */
export function identityDigest(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function liveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else. Only ESRCH means there is no such process.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function processFreezer(deps: FreezerDeps): ProcessFreezer {
  const snapshot = deps.snapshot ?? (() => listProcessesSnapshot());
  const daemonPid = deps.daemonPid ?? process.pid;
  const log = deps.log ?? ((message: string) => console.log(`[pause] ${message}`));
  const signal = deps.signal ?? ((pid: number, sig: "SIGSTOP" | "SIGCONT") => process.kill(pid, sig));
  const identify = deps.identify ?? processStartIdentity;
  const exists = deps.exists ?? liveProcess;
  /** The digest of a pid's identity now; null when it has none, `unreadable` when it is alive but unidentifiable. */
  const identityNow = (pid: number): string | null | "unreadable" => {
    const identity = identify(pid);
    if (identity !== null) return identityDigest(identity);
    return exists(pid) ? "unreadable" : null;
  };
  /** The guards a pid needs before any signal: never the daemon, never a process group. */
  const signalable = (pid: number): boolean => Number.isSafeInteger(pid) && pid > 1 && pid !== daemonPid;
  /** Signal each pid; answer the ones that refused. */
  const send = (pids: readonly number[], sig: "SIGSTOP" | "SIGCONT"): SignalFailure[] => {
    const failed: SignalFailure[] = [];
    for (const pid of pids) {
      if (!signalable(pid)) continue;
      try {
        signal(pid, sig);
      } catch (error) {
        // ESRCH: it exited, which is fine for both directions. Anything else (EPERM) means the
        // process is still running unstopped, and the caller has to know.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") continue;
        log(`${sig} ${pid} failed: ${code ?? String(error)}`);
        failed.push({ pid, code: code ?? String(error) });
      }
    }
    return failed;
  };
  /** Each pid with its identity. A live pid that cannot be identified fails the whole read. */
  const withIdentities = (pids: readonly number[]): ProcessRef[] => {
    const refs: ProcessRef[] = [];
    for (const pid of pids) {
      const identity = identityNow(pid);
      // Exited between the snapshot and now: nothing to stop.
      if (identity === null) continue;
      if (identity === "unreadable") throw new Error(`pid ${pid} could not be identified`);
      refs.push({ pid, identity });
    }
    return refs;
  };
  return {
    async treeOf(session: Session): Promise<ProcessRef[]> {
      const { processes, unknownReason } = await snapshot();
      if (unknownReason) throw new Error(unknownReason);
      if (session.runtime === "sdk") {
        const root = deps.sdkDriverPid(session.id);
        // Our own child, or nothing: a driver pid that is not under the daemon is not ours.
        if (root === null || !daemonOwnedPids(processes, daemonPid).has(root)) return [];
        return withIdentities(agentTree(processes, root, { daemonPid, includeParentShell: false }));
      }
      const root = session.pid;
      const pinned = terminalRootStart(session.id);
      const rootProc = processes.find((p) => p.pid === root);
      // A reused pid is somebody else's process. Lstart has one-second resolution, so allow it.
      if (!rootProc || (pinned !== null && Math.abs(rootProc.startMs - pinned) > 1000)) return [];
      if (daemonOwnedPids(processes, daemonPid).has(root)) return [];
      return withIdentities(agentTree(processes, root, { daemonPid, includeParentShell: true }));
    },
    stop(refs) {
      // Each pid checked against the identity `treeOf` recorded, immediately before its signal:
      // a short-lived child can exit after the read and its pid be reused by an unrelated
      // process, and SIGSTOP would freeze that one instead. A pid now naming a different process,
      // or none, is a tree member that has gone - not a failure, and not signalled. A live pid
      // that cannot be identified is a failure: the freeze is not called complete over it.
      const failed: SignalFailure[] = [];
      for (const ref of refs) {
        if (!signalable(ref.pid)) continue;
        const now = identityNow(ref.pid);
        if (now === "unreadable") {
          log(`pid ${ref.pid} could not be identified, so it was not stopped`);
          failed.push({ pid: ref.pid, code: "UNIDENTIFIED" });
          continue;
        }
        if (now !== ref.identity) continue;
        failed.push(...send([ref.pid], "SIGSTOP"));
      }
      return failed;
    },
    resume(refs) {
      // Every pid is checked against the identity recorded when it was stopped, because a stored
      // pid can outlive its process - across a restart above all - and SIGCONT to whatever
      // received that pid since would resume an unrelated stopped process. A pid now naming a
      // different process, or none, is not ours to signal and is not a failure: ours is gone. A
      // live pid that cannot be identified is a failure, kept recorded to try again.
      const verified: number[] = [];
      const failed: SignalFailure[] = [];
      for (const ref of refs) {
        const now = identityNow(ref.pid);
        if (now === "unreadable") {
          log(`pid ${ref.pid} could not be identified, so it was not continued`);
          failed.push({ pid: ref.pid, code: "UNIDENTIFIED" });
          continue;
        }
        if (now !== ref.identity) {
          if (now !== null) log(`pid ${ref.pid} is now a different process; not continuing it`);
          continue;
        }
        verified.push(ref.pid);
      }
      // Reverse of the stop order: children first, the parent shell last.
      return [...failed, ...send(verified.reverse(), "SIGCONT")];
    },
  };
}
