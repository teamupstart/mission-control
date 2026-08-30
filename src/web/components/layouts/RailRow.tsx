import { useCallback, useEffect, useId, useRef } from "react";
import type { Session } from "@shared/types.ts";
import { costIsNotable } from "@shared/cost.ts";
import { relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { useInterrupting } from "../../lib/interrupting.ts";
import { heldByRun } from "../../lib/held.ts";
import {
  AgentDot,
  InspectorRailMark,
  PrRailMark,
  ScheduleOriginRailMark,
  WorkflowRailMark,
  EnsembleRailMark,
  runtimeRailMark,
  TaskPipelineRunRailMark,
  PipelineCommissionRailMark,
} from "../session-bits.tsx";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { PipelineCommission, PipelineRun, PipelineRunLink } from "@shared/pipeline.ts";
import { Tooltip } from "../Tooltip.tsx";
import { pipelineCommissionLine } from "../../pipelines/pipeline-run-model.ts";

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
  onSelect,
  registerEl,
  workflowRun = null,
  workflowRuns = null,
  onOpenWorkflowRun,
  onOpenSchedule,
  scheduleNameById,
  onOpenEnsemble,
  ensembleSummary = null,
  onOpenPipelineRun,
  pipelineRunObserved = false,
  pipelineCommission = null,
  pipelineCommissionRun = null,
  onOpenPipelineCommission,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  workflowRun?: WorkflowRunSummary | null;
  /** Every review this conversation carries; the rail's one glyph still marks the newest. */
  workflowRuns?: readonly WorkflowRunSummary[] | null;
  onOpenWorkflowRun?: (runId: string) => void;
  /** Open Recurring Missions from a scheduled task's rail glyph. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Live schedule names by id, for the rail glyph's hover copy. */
  scheduleNameById?: ReadonlyMap<string, string>;
  onOpenEnsemble?: (runId: string) => void;
  /** This member's run summary, for the glyph's hover copy. Null until its SSE summary lands. */
  ensembleSummary?: EnsembleSummary | null;
  onOpenPipelineRun?: (link: PipelineRunLink) => void;
  pipelineRunObserved?: boolean;
  pipelineCommission?: PipelineCommission | null;
  pipelineCommissionRun?: PipelineRun | null;
  onOpenPipelineCommission?: (commissionId: string) => void;
}): React.JSX.Element {
  // The rail draws its own badge, so it asks for the transient stop directly - the Console
  // is where a session is watched while it works, and so where the wait is most visible.
  const st = stateDisplay(session, useInterrupting(session.id));
  // The same shared sentence the Board tile reads. The rail shows more
  // rows per screen than either, so it is the surface where "the section rule scrolled
  // away" happens soonest - the row has to carry its own answer here most of all.
  const heldBy = heldByRun(workflowRuns, st.tone);
  const held = heldBy !== null;
  const ref = useRef<HTMLButtonElement>(null);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      ref.current = el;
      registerEl?.(session.id, el);
    },
    [registerEl, session.id],
  );

  // Keep the selected row in view as the arrow keys walk the rail. Local to the row
  // because the rail scrolls independently of the detail beside it.
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const marks: string[] = [];
  // First, because it is a fact about WHERE this session is rather than about what it
  // needs - a reader scanning the rail for something to act on should not have to step
  // past it, and a reader wondering why Focus is missing should find it immediately.
  const runtime = runtimeRailMark(session);
  if (runtime) marks.push(runtime);
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
        ref={setRef}
        className={`rail-row tone-${st.tone}${held ? " is-held" : ""}${selected ? " selected" : ""}`}
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
          {/* Beside the state word ON ITS LINE - `.rail-right` is a column, and the row's
              whole two-line budget is the point of it. "held" qualifies the "idle" it sits
              next to, the same pairing the card's head draws. */}
          <span className="rail-state-line">
            {held && (
              <Tooltip
                label={`Held by ${heldBy?.workflowName ?? "a workflow"} - the run owns this session's next turn`}
              >
                <span className="rail-held">held</span>
              </Tooltip>
            )}
            <span className="rail-state">{st.label}</span>
          </span>
          <span className="rail-meta">
            {marks.length > 0 && <span className="rail-marks">{marks.join(" ")}</span>}
            <PrRailMark session={session} />
            {/* The rail is glyph-and-count only - it has one line of room and a name to fit
                in it - so the Inspector shows as ⌕ plus its count, and nothing when there
                is nothing outstanding. The DECISION and the tooltip are the shared ones;
                only the rendering is this terse. */}
            <InspectorRailMark session={session} />
            <WorkflowRailMark
              run={workflowRun}
              onOpen={workflowRun ? () => onOpenWorkflowRun?.(workflowRun.id) : undefined}
            />
            <ScheduleOriginRailMark
              task={session.task}
              scheduleNames={scheduleNameById}
              onOpen={onOpenSchedule}
            />
            <EnsembleRailMark
              link={session.task?.ensemble ?? null}
              summary={ensembleSummary}
              onOpen={
                session.task?.ensemble
                  ? () => onOpenEnsemble?.(session.task!.ensemble!.runId)
                  : undefined
              }
            />
            <TaskPipelineRunRailMark
              link={pipelineCommission ? null : (session.task?.pipelineRun ?? null)}
              observed={pipelineRunObserved}
              onOpen={
                session.task?.pipelineRun
                  ? () => onOpenPipelineRun?.(session.task!.pipelineRun!)
                  : undefined
              }
            />
            <PipelineCommissionRailMark
              commission={pipelineCommission}
              line={pipelineCommission ? pipelineCommissionLine(pipelineCommission, pipelineCommissionRun) : ""}
              onOpen={
                pipelineCommission
                  ? () => onOpenPipelineCommission?.(pipelineCommission.id)
                  : undefined
              }
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
