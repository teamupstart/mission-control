import { realpathSync, statSync } from "node:fs";
import type { DiscoveredSession } from "./correlate.ts";
import { run } from "../util/exec.ts";
import { parseSessionMeta, readHeadLine } from "../harness/codex/rollout.ts";

/** Parse lsof's machine-readable -F output into exact PID -> rollout bindings. */
export function parseCodexOpenFiles(text: string): Map<number, string[]> {
  const found = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isSafeInteger(n) && n > 0 ? n : null;
    } else if (pid && line.startsWith("n")) {
      const path = line.slice(1);
      if (!/(?:^|\/)sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.*\.jsonl$/.test(path)) continue;
      const list = found.get(pid) ?? [];
      list.push(path);
      found.set(pid, list);
    }
  }
  return found;
}

/**
 * Resolve the identity a process's open rollouts agree on, or null when they do not.
 *
 * Codex forks a second rollout mid-session - a new file id that still names the session
 * it belongs to - so "exactly one open rollout" is not a precondition for knowing who the
 * agent is. Reading only a lone file meant a forked session's identity went silent for the
 * rest of its life, and the `subagent` and cwd filters never ran at all, because the count
 * was checked before anything was parsed.
 *
 * Silence is not free: the work episode that identity anchors gets replaced when the
 * identity appears to change, and replacing it drops the task ownership of an agent that
 * never stopped working. So read every rollout, drop the ones that disqualify themselves,
 * and answer when the survivors agree. Genuine disagreement still says nothing rather than
 * guessing - that is the case the single-file rule was really protecting.
 */
export function selectRolloutIdentity(
  paths: string[],
  sessionCwd: string | null,
): { path: string; sessionId: string } | null {
  const candidates: { path: string; sessionId: string; mtimeMs: number }[] = [];
  for (const candidate of paths) {
    let path: string;
    try { path = realpathSync(candidate); } catch { continue; }
    const meta = parseSessionMeta(readHeadLine(path));
    if (!meta?.sessionId || meta.subagent) continue;
    if (sessionCwd && meta.cwd && sessionCwd !== meta.cwd) continue;
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    candidates.push({ path, sessionId: meta.sessionId, mtimeMs });
  }
  if (!candidates.length) return null;
  if (new Set(candidates.map((c) => c.sessionId)).size !== 1) return null;
  // The newest file is the one being appended to, so it is the transcript to read.
  const live = candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return { path: live.path, sessionId: live.sessionId };
}

/** Enrich Codex discovery with the rollout the exact live process has open. */
export async function annotateCodexRollouts(sessions: DiscoveredSession[]): Promise<void> {
  const codex = sessions.filter((s) => s.agent === "codex");
  if (!codex.length) return;
  const result = await run("lsof", ["-a", "-p", codex.map((s) => s.pid).join(","), "-Fn"], {
    timeoutMs: 3000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.code !== 0 && !result.stdout) return;
  const byPid = parseCodexOpenFiles(result.stdout);
  for (const session of codex) {
    const identity = selectRolloutIdentity(byPid.get(session.pid) ?? [], session.cwd);
    if (!identity) continue;
    session.transcriptPath = identity.path;
    session.agentSessionId = identity.sessionId;
  }
}
