import { useEffect, useId, useRef } from "react";
import type { Session } from "@shared/types.ts";
import { costIsNotable } from "@shared/cost.ts";
import { relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { AgentDot, InspectorRailMark, WorkflowRailMark } from "../session-bits.tsx";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { Tooltip } from "../Tooltip.tsx";

/**
 * One line in a rail: enough to choose by, and nothing more. The goal is the
 * subtitle rather than the path, because the goal is what tells two worktrees of
 * the same repo apart.
 *
 * Shared by the console's always-open rail and the board's drill-in: when you open
 * a board tile, that column becomes a rail of exactly these rows, so the two layouts
 * read identically rather than through two copies that can drift.
 */
export function RailRow({
  session,
  selected,
  focusSelected = false,
  gateNeedsYou,
  onSelect,
  workflowRun = null,
  onOpenWorkflowRun,
}: {
  session: Session;
  selected: boolean;
  focusSelected?: boolean;
  gateNeedsYou: boolean;
  onSelect: () => void;
  workflowRun?: WorkflowRunSummary | null;
  onOpenWorkflowRun?: (runId: string) => void;
}): React.JSX.Element {
  const st = stateDisplay(session, gateNeedsYou);
  const ref = useRef<HTMLButtonElement>(null);

  // Keep the selected row in view as the arrow keys walk the rail. Local to the row
  // because the rail scrolls independently of the detail beside it - App's map holds
  // the card element, which in this layout is the pane, not the row.
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: "nearest" });
    if (focusSelected) ref.current?.focus({ preventScroll: true });
  }, [selected, focusSelected]);

  const marks: string[] = [];
  if (session.nomistakesGated) marks.push("◇");
  if (gateNeedsYou) marks.push("▮");
  if (session.note) marks.push("◆");
  if (session.queue && session.queue.openCount > 0) marks.push(`≡${session.queue.openCount}`);
  // Cost is the one signal the rail states as a GLYPH rather than a figure, and only once
  // it is notable. The two-line budget below is why: a full "≈$1.24" in `.rail-meta` is
  // honest but spends horizontal room on the tightest surface in the app, on every row,
  // for a number that is usually unremarkable. The trade is real and worth naming - the
  // rail is the one place a routine cost is invisible until it isn't. The other three
  // surfaces carry the figure itself (`CostChip`); `costIsNotable` is shared so all four
  // agree on where the line sits.
  if (costIsNotable(session.cost)) marks.push("≈$");
  const description = `${session.name || "(unnamed)"} - ${st.label}`;
  const descriptionId = useId();

  return (
    <>
      <button
        ref={ref}
        className={`rail-row tone-${st.tone}${selected ? " selected" : ""}`}
        aria-current={selected}
        aria-describedby={descriptionId}
        onClick={onSelect}
      >
        <AgentDot agent={session.agent} />
        <Tooltip label={description}>
          <span className="rail-name">{session.name || "(unnamed)"}</span>
        </Tooltip>
        <span className="rail-sub">{session.goal?.text ?? session.activity ?? ""}</span>
        {/* Two lines, never four: the state, then everything else on one line. Given a
            line each, the marks and the PR chip made a row as tall as three, and a rail
            you can only fit six sessions in has stopped being a rail. */}
        <span className="rail-right">
          <span className="rail-state">{st.label}</span>
          <span className="rail-meta">
            {marks.length > 0 && <span className="rail-marks">{marks.join(" ")}</span>}
            {session.prNumber && (
              <span className={`rail-pr pr-${session.prState ?? "open"}`}>#{session.prNumber}</span>
            )}
            {/* The rail is glyph-and-count only - it has one line of room and a name to fit
                in it - so the Inspector shows as ⌕ plus its count, and nothing when there
                is nothing outstanding. The DECISION and the tooltip are the shared ones;
                only the rendering is this terse. */}
            <InspectorRailMark session={session} />
            <WorkflowRailMark
              run={workflowRun}
              onOpen={workflowRun ? () => onOpenWorkflowRun?.(workflowRun.id) : undefined}
            />
            <span className="rail-seen">
              {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
            </span>
          </span>
        </span>
      </button>
      <span id={descriptionId} className="tt-desc">{description}</span>
    </>
  );
}
