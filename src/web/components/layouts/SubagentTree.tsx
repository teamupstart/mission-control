import { useState } from "react";
import type { Session, SubagentEntry } from "@shared/types.ts";
import { hasSubagents, subagentCountLabel, subagentCounts, subagentElapsedMs } from "@shared/subagents.ts";
import { duration } from "../../lib/format.ts";
import { useNow } from "../../useNow.ts";
import { RepoGroupCaret } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";

/** Rows drawn before the rest collapse behind "+N more". */
export const SUBAGENT_TREE_VISIBLE = 3;

const END_LABEL: Record<Exclude<SubagentEntry["state"], "running">, string> = {
  completed: "done",
  failed: "failed",
  stopped: "stopped",
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The second line of a row: elapsed, tool count, last tool. A value the source did not
 * report is left out rather than drawn as a zero - a terminal hook knows only that an agent
 * started and stopped, and "0 tools" would be a claim about work nobody counted.
 */
export function subagentRowDetail(agent: SubagentEntry, now: number): string {
  const parts = [duration(subagentElapsedMs(agent, now))];
  if (agent.toolUses !== null) parts.push(plural(agent.toolUses, "tool", "tools"));
  if (agent.lastTool) parts.push(agent.lastTool);
  return parts.join(" · ");
}

/**
 * One agent as a row: status pip, type and description, an end label once it has ended, and
 * the detail line. Shared by the tree beneath a card and the chip's popover, so the two
 * treatments cannot describe the same agent differently.
 */
export function SubagentRow({ agent, now }: { agent: SubagentEntry; now: number }): React.JSX.Element {
  return (
    <li className={`st-row is-${agent.state}`}>
      <span className="st-pip" aria-hidden />
      <span className="st-body">
        <span className="st-title">
          {agent.type && <span className="st-type">{agent.type}</span>}
          {agent.type && agent.description && <span className="st-sep" aria-hidden> · </span>}
          {agent.description && <span className="st-desc">{agent.description}</span>}
          {agent.state !== "running" && <span className="st-end">{END_LABEL[agent.state]}</span>}
        </span>
        <span className="st-detail">{subagentRowDetail(agent, now)}</span>
      </span>
    </li>
  );
}

/**
 * A session's background sub-agents, hung beneath its board tile on a tree spine.
 *
 * Drawn OUTSIDE the tile, as its sibling, so the tile keeps its border, its click target and
 * its height while agents run: these rows are not part of opening the session, and they are
 * not a control of their own - nothing here stops, steers or opens an agent.
 *
 * Draws nothing at all for a session with no background agents, which is nearly every
 * session, so the board looks exactly as it did before this existed.
 */
export function SubagentTree({ session }: { session: Session }): React.JSX.Element | null {
  const summary = session.subagents;
  const counts = subagentCounts(summary);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  // One clock for every row, and only while something on screen is still counting.
  const now = useNow(open && counts.running > 0);
  if (!hasSubagents(summary)) return null;

  const agents = summary.agents;
  const shown = showAll ? agents : agents.slice(0, SUBAGENT_TREE_VISIBLE);
  const hidden = agents.length - shown.length;
  // A list full of running agents may have been cut short, so both figures read as a floor.
  const listed = subagentCountLabel(counts.listed, counts.atLeast);
  const headline = `${listed} ${counts.listed === 1 && !counts.atLeast ? "sub-agent" : "sub-agents"} · ${
    subagentCountLabel(counts.running, counts.atLeast)
  } running`;

  return (
    <div className="subagent-tree" role="group" aria-label={`Background sub-agents of ${session.name || "this session"}`}>
      <Tooltip label={open ? "Fold the background sub-agents" : "Show the background sub-agents"}>
        <button
          type="button"
          className="st-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <RepoGroupCaret />
          <span className="st-headline">{headline}</span>
        </button>
      </Tooltip>
      {open && (
        <ul className="st-list">
          {shown.map((agent) => <SubagentRow key={agent.id} agent={agent} now={now} />)}
          {hidden > 0 && (
            <li className="st-row st-more-row">
              <Tooltip label={`Show ${plural(hidden, "more sub-agent", "more sub-agents")}`}>
                <button
                  type="button"
                  className="st-more"
                  aria-label={`Show ${plural(hidden, "more sub-agent", "more sub-agents")}`}
                  onClick={() => setShowAll(true)}
                >
                  +{hidden} more
                </button>
              </Tooltip>
            </li>
          )}
          {counts.folded > 0 && <li className="st-row st-folded">{counts.folded} finished</li>}
        </ul>
      )}
    </div>
  );
}
