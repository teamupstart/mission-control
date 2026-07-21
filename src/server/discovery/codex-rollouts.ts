import { realpathSync } from "node:fs";
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
    const paths = byPid.get(session.pid);
    if (!paths || paths.length !== 1) continue;
    let path = paths[0]!;
    try { path = realpathSync(path); } catch { continue; }
    const meta = parseSessionMeta(readHeadLine(path));
    if (!meta || meta.subagent || (session.cwd && meta.cwd && session.cwd !== meta.cwd)) continue;
    session.transcriptPath = path;
    session.agentSessionId = meta.sessionId;
  }
}
