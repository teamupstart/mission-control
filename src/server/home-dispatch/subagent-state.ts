import type { HomeDispatchSubagentCounts } from "@shared/home-dispatch.ts";
import type { Session } from "@shared/types.ts";

// Owner: P4. Per-task subagent counts for the inbox (spec 7.7, 7.17). P9 reuses this module for
// the transcript response's per-subagent lines.
//
// The session registry already holds the subagent state: `Registry.setSubagents` is fed by the
// harness hook adapters' `SubagentStart`, `SubagentStop` and `background_tasks` signals
// (`src/server/harness/claude/hooks.ts`), and lands on `Session.subagents`. So this module adds
// no tracking of its own and touches neither `hooks/harness-hook.mjs` nor the hook-event handler
// (D43); it only reads that summary.

/**
 * `{ running, finished }` for a session's background subagents, or undefined when the session has
 * no subagent record at all. A subagent that is no longer running (completed, failed or stopped)
 * is finished, and so is every one the daemon already folded away after the person's next prompt.
 */
export function subagentCountsFor(session: Pick<Session, "subagents"> | undefined): HomeDispatchSubagentCounts | undefined {
  const summary = session?.subagents;
  if (!summary) return undefined;
  const running = summary.agents.filter((a) => a.state === "running").length;
  return { running, finished: summary.agents.length - running + summary.finishedFolded };
}
