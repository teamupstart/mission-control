/** Process identities only: never collect commands or credential-bearing environments. */
export interface ResumeProcess { pid: number; ppid: number; startMs: number }
export type ResumeProcesses = ReadonlyMap<number, ResumeProcess>;

export function parseResumeProcesses(output: string, collectorPid: number | null | undefined): ResumeProcesses | null {
  const processes = new Map<number, ResumeProcess>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/);
    if (!match) return null;
    const pid = Number(match[1]), ppid = Number(match[2]), startMs = Date.parse(match[3]!);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(startMs) || processes.has(pid)) return null;
    if (pid !== collectorPid) processes.set(pid, { pid, ppid, startMs });
  }
  return processes.size ? processes : null;
}

/**
 * Orphans lose their original ancestry, including children that double-fork between scans.
 * Only a new process rooted at a surviving, unrelated baseline process can be excluded.
 * Guard ancestors may adopt orphans (PID 1, or a subreaper), so they cannot clear a survivor.
 * This can retain a home for an unrelated new orphan; absence of proof never deletes it.
 */
export function resumeDescendantsExited(
  before: ResumeProcesses | null, after: ResumeProcesses | null, guard: Pick<ResumeProcess, "pid" | "startMs">,
): boolean {
  if (!before || !after || before.get(guard.pid)?.startMs !== guard.startMs || after.get(guard.pid)?.startMs !== guard.startMs) return false;
  const potentialReapers = new Set<number>();
  for (const inventory of [before, after]) {
    const visited = new Set<number>();
    let pid = guard.pid;
    while (pid !== 0) {
      if (visited.has(pid)) return false;
      visited.add(pid);
      potentialReapers.add(pid);
      const process = inventory.get(pid);
      if (!process) return false;
      pid = process.ppid;
    }
  }
  for (const process of after.values()) {
    if (before.get(process.pid)?.startMs === process.startMs) continue;
    const visited = new Set<number>([process.pid]);
    let child = process;
    let pid = process.ppid;
    while (true) {
      if (pid === 0 || potentialReapers.has(pid) || visited.has(pid)) return false;
      visited.add(pid);
      const parent = after.get(pid);
      if (!parent || parent.startMs > child.startMs) return false;
      if (before.get(pid)?.startMs === parent.startMs) break;
      child = parent;
      pid = parent.ppid;
    }
  }
  return true;
}
