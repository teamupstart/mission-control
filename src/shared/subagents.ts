import type { Session, SubagentEntry, SubagentSummary } from "./types.ts";

/**
 * The one reading of `Session.subagents` every surface shares.
 *
 * Sources (harness adapters) write the summary and renderers draw it; neither re-derives a
 * count of its own, so the board tile, the conversation and any later treatment cannot
 * disagree about how many agents are still running.
 */

/** How many agents a summary lists at most. Past this, finished agents fold into the count. */
export const SUBAGENT_LIMIT = 12;

export interface SubagentCounts {
  /** Listed agents still running. */
  running: number;
  /**
   * Listed agents that have ended, shown dimmed until the next turn folds them, or until a
   * full list folds the oldest to make room.
   */
  finished: number;
  /** Agents already folded into the "N finished" count by an earlier turn. */
  folded: number;
  /** Listed agents, running or finished. */
  listed: number;
  /**
   * True when every slot of the list is a running agent, so more may be running than were
   * listed. The list puts running agents first, so a list with any finished agent in it holds
   * every running one; only a list full of running agents can be cut short. `running` is then
   * a floor, not a count, and is written with `subagentCountLabel`.
   */
  atLeast: boolean;
}

export function subagentCounts(summary: SubagentSummary | null | undefined): SubagentCounts {
  const agents = summary?.agents ?? [];
  const running = agents.filter((a) => a.state === "running").length;
  return {
    running,
    finished: agents.length - running,
    folded: summary?.finishedFolded ?? 0,
    listed: agents.length,
    atLeast: running >= SUBAGENT_LIMIT,
  };
}

/**
 * A count as a person should read it: "12+" when the list may have been cut short, so the
 * board never states a number smaller than what is actually running.
 */
export function subagentCountLabel(n: number, atLeast: boolean): string {
  return atLeast ? `${n}+` : String(n);
}

/** Whether a summary has anything to draw. A session without one looks exactly as before. */
export function hasSubagents(summary: SubagentSummary | null | undefined): summary is SubagentSummary {
  return !!summary && (summary.agents.length > 0 || summary.finishedFolded > 0);
}

/** A parent whose own turn is over: idle, or waiting on a person. */
const PARKED: ReadonlySet<Session["state"]> = new Set(["idle", "awaiting_input", "awaiting_review"]);

/**
 * The activity line for a parent that has stopped but still has agents working under it:
 * "idle · 2 agents still running". Null whenever the parent is busy itself (its own line
 * describes that) or nothing is running.
 *
 * A parent that needs you reads the same as an idle one. The point of the line is that the
 * parent's own turn is over while work continues beneath it, which is equally true of both.
 */
export function subagentActivityLine(
  session: Pick<Session, "state" | "subagents">,
): string | null {
  if (!PARKED.has(session.state)) return null;
  const { running, atLeast } = subagentCounts(session.subagents);
  if (running === 0) return null;
  const label = subagentCountLabel(running, atLeast);
  return `idle · ${label} ${running === 1 && !atLeast ? "agent" : "agents"} still running`;
}

/** Milliseconds an agent has run, or ran: to `now` while running, to its end once ended. */
export function subagentElapsedMs(agent: Pick<SubagentEntry, "startedAt" | "endedAt">, now: number): number {
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt);
}
