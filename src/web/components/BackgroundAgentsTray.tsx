import { useState } from "react";
import type { Session, SubagentEntry } from "@shared/types.ts";
import { hasSubagents, subagentCountLabel, subagentCounts } from "@shared/subagents.ts";
import type { LaunchMiss } from "../lib/launch-lookup.ts";
import { useNow } from "../useNow.ts";
import { subagentRowDetail } from "./layouts/SubagentTree.tsx";
import { RepoGroupCaret } from "./session-bits.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Where a row's "Jump to launch" search stands: under way, or ended without a turn. */
export type LaunchSearch = "searching" | LaunchMiss;

const END_LABEL: Record<Exclude<SubagentEntry["state"], "running">, string> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

const LAUNCH_TIP: Record<LaunchSearch | "ready", string> = {
  ready: "Scroll the conversation to the turn that launched this agent",
  searching: "Loading older messages to find the turn that launched this agent",
  missing:
    "No call in this conversation's transcript is recorded as launching this agent. An agent that launched moments ago may not be recorded yet - click to look again",
  error: "Couldn't load older messages to find the turn that launched this agent - click to try again",
};

const LAUNCH_TEXT: Record<LaunchSearch | "ready", string> = {
  ready: "Jump to launch",
  searching: "Finding launch…",
  missing: "Launch not in transcript",
  error: "Jump to launch",
};

/**
 * The tray header's words, without the glyph: "Background agents · 2 running · 1 done".
 * Done counts the finished agents still listed; those already folded by a turn are the
 * "N finished" line under the rows, so no agent is counted twice.
 */
export function backgroundAgentsHeadline(session: Pick<Session, "subagents">): string {
  const counts = subagentCounts(session.subagents);
  const parts = ["Background agents", `${subagentCountLabel(counts.running, counts.atLeast)} running`];
  if (counts.finished > 0) parts.push(`${counts.finished} done`);
  return parts.join(" · ");
}

/**
 * A session's background sub-agents, docked above its reply box.
 *
 * The conversation half of the nested sub-cards treatment. It sits between the log and the
 * composer, outside both, so it stays in view whatever the secondary rail is showing and
 * whatever the log is scrolled to - the reason it is a tray and not a row in the log. A
 * resident is an ordinary SDK session in this same panel, so it gets the tray with no
 * branch of its own.
 *
 * Every agent carries "Jump to launch", which scrolls the log to the turn that made the
 * launching call - found by identity only (`turnForLaunch`): the call's id when the source
 * named it, or the agent's own id as the transcript recorded it against its launch. A search
 * that ends without a turn says why on the link rather than removing it, and never guesses. Like the board's tree it controls nothing about the agent
 * itself: nothing here stops, steers or opens one.
 *
 * Draws nothing for a session without background agents, so the conversation looks exactly
 * as it did before this existed.
 */
export function BackgroundAgentsTray({
  session,
  launches,
  onJumpToLaunch,
}: {
  session: Pick<Session, "subagents">;
  /** Searches under way or ended without a turn, keyed by agent id. */
  launches?: ReadonlyMap<string, LaunchSearch>;
  onJumpToLaunch?: (agent: SubagentEntry) => void;
}): React.JSX.Element | null {
  const summary = session.subagents;
  const counts = subagentCounts(summary);
  const [open, setOpen] = useState(true);
  // One clock for every row, and only while something on screen is still counting.
  const now = useNow(open && counts.running > 0);
  if (!hasSubagents(summary)) return null;

  const headline = backgroundAgentsHeadline(session);
  return (
    <section className="bg-tray" aria-label="Background agents">
      <Tooltip label={open ? "Fold the background agents" : "Show the background agents"}>
        <button
          type="button"
          className="bg-tray-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <RepoGroupCaret />
          <span className="bg-tray-glyph" aria-hidden>
            ⑂
          </span>
          <span className="bg-tray-headline">{headline}</span>
        </button>
      </Tooltip>
      {open && (
        <ul className="bg-tray-list">
          {summary.agents.map((agent) => {
            const search = launches?.get(agent.id) ?? "ready";
            return (
              <li key={agent.id} className={`bg-tray-row is-${agent.state}`}>
                <span className="bg-tray-pip" aria-hidden />
                <span className="bg-tray-title">
                  {agent.type && <span className="bg-tray-type">{agent.type}</span>}
                  {agent.description && <span className="bg-tray-desc">{agent.description}</span>}
                </span>
                <span className="bg-tray-detail">
                  {agent.state !== "running" && <span className="bg-tray-end">{END_LABEL[agent.state]} · </span>}
                  {subagentRowDetail(agent, now)}
                </span>
                <Tooltip label={LAUNCH_TIP[search]}>
                  <button
                    type="button"
                    className={`bg-tray-jump is-${search}`}
                    aria-busy={search === "searching" || undefined}
                    onClick={() => {
                      if (search !== "searching") onJumpToLaunch?.(agent);
                    }}
                  >
                    {LAUNCH_TEXT[search]}
                  </button>
                </Tooltip>
              </li>
            );
          })}
          {counts.folded > 0 && <li className="bg-tray-row bg-tray-folded">{counts.folded} finished</li>}
        </ul>
      )}
    </section>
  );
}
