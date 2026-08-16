import { run } from "../util/exec.ts";

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
  // lsof exits 1 when one PID vanishes during a batched read, while still printing the
  // survivors. A partial answer is usable evidence, but omission is not proof of exit;
  // destructive callers compare unresolved PIDs against a fresh process snapshot.
  const unknown =
    res.outcomeUnknown || res.overflowed || (res.code !== 0 && out.size === 0)
      ? `cwd listing failed: ${res.stderr.trim() || `exit ${res.code}`}`
      : null;
  return { cwds: out, unknownReason: unknown };
}

export async function readProcCwds(pids: number[]): Promise<Map<number, string>> {
  return (await readProcCwdsSnapshot(pids)).cwds;
}
