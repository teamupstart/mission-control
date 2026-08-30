import { run } from "../util/exec.ts";

const CWD_LIST_TIMEOUT_MS = 30_000;

export interface ProcCwdSnapshot {
  cwds: Map<number, string>;
  /** Non-null when lsof failed without a usable, bounded process answer. */
  unknownReason: string | null;
}

/**
 * Resolve the real working directory of each pid via one batched `lsof`.
 *
 * This is authoritative for a session's cwd. Unlike a tmux/wezterm pane path
 * (which tracks where the pane's launcher was invoked) or a wrapper launcher's
 * own cwd, it reflects where the agent process itself runs - and therefore where
 * Claude writes its transcript (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`).
 *
 * `-Fpn` prints `p<pid>` then `n<path>` records; we pair them. Never throws:
 * lsof may exit non-zero when some pids vanish mid-call, but still prints the
 * survivors. The partial map remains available to discovery callers; destructive callers
 * independently recheck an omitted PID before treating it as gone.
 */
export async function readProcCwdsSnapshot(pids: number[]): Promise<ProcCwdSnapshot> {
  const out = new Map<number, string>();
  const uniq = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (uniq.length === 0) return { cwds: out, unknownReason: null };

  const res = await run("lsof", ["-a", "-d", "cwd", "-p", uniq.join(","), "-Fpn"], {
    // This is a system-wide read over every process the daemon user owns. The four-second
    // default turned host contention into a permanent worktree quarantine. Match the
    // process snapshot budget: uncertainty still fails closed, but ordinary load gets time
    // to produce the evidence cleanup requires.
    timeoutMs: CWD_LIST_TIMEOUT_MS,
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
  // lsof exits 1 when one PID vanishes during a batched read, while still printing the
  // survivors. A partial answer is usable evidence, but omission is not proof of exit;
  // destructive callers compare unresolved PIDs against a fresh process snapshot.
  const failure = res.overflowed
    ? "the cwd listing was too large to buffer"
    : res.outcomeUnknown
      ? "the cwd listing was killed before it answered (timed out, or stopped from outside)"
      : res.stderr.trim() || `exit ${res.code}`;
  const unknown =
    res.outcomeUnknown || res.overflowed || (res.code !== 0 && out.size === 0)
      ? `cwd listing failed: ${failure}`
      : null;
  return { cwds: out, unknownReason: unknown };
}

export async function readProcCwds(pids: number[]): Promise<Map<number, string>> {
  return (await readProcCwdsSnapshot(pids)).cwds;
}
