import { useCallback, useEffect, useState } from "react";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import { relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { sessionIsHeld } from "../../lib/held.ts";
import {
  AgentDot,
  CostChip,
  InspectorTileFlag,
  PrTileFlag,
  RuntimeMetaRow,
  RuntimeTileFlag,
  ScheduleOriginTileFlag,
  EnsembleTileFlag,
} from "../session-bits.tsx";
import { EffortPicker } from "../EffortPicker.tsx";
import { ModePicker } from "../ModePicker.tsx";
import { canAcceptTask, dropTaskOnSession } from "./BacklogColumn.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { WorkflowLadderPanel } from "../../workflows/WorkflowLadder.tsx";
import type { WorkflowDisclosureHandle } from "./types.ts";

/**
 * Whether a click only marks the end of a drag-select rather than a click on the thing
 * underneath it. Copying a branch name off a tile is a fair thing to want on a triage
 * board, and the mouseup that ends that drag lands on the tile as a click - which should
 * not navigate you into a session you were only reading.
 *
 * Takes the selection rather than reading it, so the decision can be tested without a DOM.
 */
export function isDragSelection(sel: { isCollapsed: boolean } | null): boolean {
  return sel != null && !sel.isCollapsed;
}

/**
 * A session shrunk to what you'd triage by, without opening it: who it is, what it's
 * for, what it's doing this second, how much context it has left, and whether it wants
 * something. The conversation and diff are one click away in the console detail.
 *
 * An idle tile is also a drop target for a backlog card - see BacklogColumn.
 *
 * Lives beside BoardView rather than inside it for consistency with the rest of the
 * board layout - BacklogColumn, RailRow and ConsoleDetail are each their own file, and
 * the tile was the one piece still inline. BoardView is left composing the board.
 */
export function SessionTile({
  session,
  selected = false,
  onOpen,
  registerEl,
  draggingRepo,
  onDropped,
  onDropError,
  onDropConfirm,
  workflowRun = null,
  workflowRuns = null,
  registerWorkflowDisclosure,
  onOpenWorkflowRun,
  onOpenSchedule,
  scheduleNameById,
  onOpenEnsemble,
  ensembleSummary = null,
}: {
  session: Session;
  /** The board's arrow-key cursor. Selection does not open the tile until Enter. */
  selected?: boolean;
  onOpen: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  draggingRepo: string | null;
  onDropped: () => void;
  onDropError: (message: string) => void;
  /** The drop needs a yes: the handover would take something from this agent. */
  onDropConfirm: (pending: { taskId: string; confirm: AssignResetConfirm }) => void;
  workflowRun?: WorkflowRunSummary | null;
  /** Every review this conversation carries - one per repository a multi-repo task changed. */
  workflowRuns?: readonly WorkflowRunSummary[] | null;
  /** Register the same disclosure transition the Show/Collapse workflow button drives. */
  registerWorkflowDisclosure?: (id: string, handle: WorkflowDisclosureHandle | null) => void;
  onOpenWorkflowRun?: (runId: string) => void;
  /** Open Recurring Missions from a scheduled task's tile flag. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Live schedule names by id, for the tile flag's hover copy. */
  scheduleNameById?: ReadonlyMap<string, string>;
  onOpenEnsemble?: (runId: string) => void;
  /** This member's run summary, for the flag's hover copy. Null until its SSE summary lands. */
  ensembleSummary?: EnsembleSummary | null;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const isRunning = session.state === "working" || session.state === "starting";
  const workflowRunId = workflowRun?.id ?? null;
  // Held reads off the run this tile was already handed, not a second lookup: the section rule
  // above it and this tag have to agree about the same session, and one source is how they do.
  // `sessionIsHeld` is the shared sentence, so the Cards card cannot spell it differently.
  const held = sessionIsHeld(workflowRuns, st.tone);
  const [over, setOver] = useState(false);
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const toggleWorkflowExpanded = useCallback(
    () => setWorkflowExpanded((expanded) => !expanded),
    [],
  );
  const setTileRef = useCallback(
    (el: HTMLDivElement | null) => registerEl?.(session.id, el),
    [registerEl, session.id],
  );
  useEffect(() => setWorkflowExpanded(false), [workflowRunId]);
  useEffect(() => {
    if (!workflowRunId || !registerWorkflowDisclosure) return;
    registerWorkflowDisclosure(session.id, { toggle: toggleWorkflowExpanded });
    return () => registerWorkflowDisclosure(session.id, null);
  }, [registerWorkflowDisclosure, session.id, toggleWorkflowExpanded, workflowRunId]);

  // The run rides along so a held tile refuses the drop: handing work over resets the agent,
  // and the run owns its next turn. Same source as the `held` flag above, so the tag and the
  // refusal cannot disagree about one tile.
  const droppable = canAcceptTask(session, draggingRepo, workflowRuns);

  return (
    <div
      ref={setTileRef}
      className={`tile tone-${st.tone}${st.tone === "attention" ? " attention" : ""}${
        selected ? " selected" : ""
      }${held ? " is-held" : ""}${
        droppable ? " can-drop" : ""
      }${over ? " drop-over" : ""}${workflowExpanded ? " workflow-expanded" : ""}`}
      onDragOver={(e) => {
        if (!droppable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onClick={() => {
        if (isDragSelection(window.getSelection())) return;
        onOpen();
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!droppable) return;
        e.preventDefault();
        // Clear the drag here as well as on dragend: a drop that lands inside a
        // re-rendering board can swallow the dragend, leaving every tile lit.
        onDropped();
        void dropTaskOnSession(e, session, onDropError, onDropConfirm);
      }}
    >
      {/* The tile is not a <button> around its content, because the PR flag has to be a
          real link and a link cannot live inside a button - nested there it could only
          ever have been a span, which is what made clicking a PR open the console and
          cost you a second click on the chip in there.

          So the open action is split. The pointer half lives on the tile root above:
          clicks land on whatever content you aimed at and bubble up, which keeps the
          shared tooltips on the model, effort, and context meter
          hoverable. This stretched button is the keyboard half - focusable, labelled,
          Enter/Space-activatable, which a bare div with onClick would not be. It takes
          no pointer events, so it can never swallow a click meant for the content. The
          PR flag is a real link that stops propagation, so it navigates instead of
          opening the console.

          It opens the session itself rather than letting its click bubble to the root,
          because the root declines clicks that merely end a text selection. Reaching a
          session by keyboard must not depend on whether something happens to be selected
          somewhere on the page. */}
      <Tooltip label={`Open ${session.name || "unnamed session"}`}>
        <button
          type="button"
          className="tile-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={`Open ${session.name || "unnamed session"}`}
          aria-current={selected}
        />
      </Tooltip>

      <span className="tile-head">
        <AgentDot agent={session.agent} />
        <Tooltip label={`Open ${session.name || "unnamed session"}`}>
          <span className="tile-name">{session.name || "(unnamed)"}</span>
        </Tooltip>
        {/* Says the same thing as the section rule this tile sits under, and is not redundant
            with it: the rule scrolls off the top of a full column, and a tile dragged into view
            by the arrow keys has to carry its own answer to "why can I not use this one". */}
        {held && (
          <Tooltip
            label={`Held by ${workflowRun?.workflowName ?? "a workflow"} - the run owns this session's next turn`}
          >
            <span className="tile-held">held</span>
          </Tooltip>
        )}
      </span>

      {session.goal?.text && <span className="tile-goal">{session.goal.text}</span>}

      {/* What it's doing right now - the board's only live signal past "6s ago", and what
          tells an actively-editing session apart from one stalled on a prompt. Only a
          running session has a live action to report: once it settles, activity holds a
          status label ("idle", "ended (logout)") the column and badge already carry, and
          a ticker there would animate over a session that isn't moving. `instrumented`
          is the freshness half of that: when hooks lapse past the overlay TTL the passive
          poller refreshes `state` from the transcript but leaves `activity` at its stale
          overlay value, so only a live hook makes the label worth animating. */}
      {session.instrumented && isRunning && session.activity && (
        <span className="tile-activity">
          <span className="ta-glyph" aria-hidden>
            ⟳
          </span>
          <span className="ta-txt">{session.activity}</span>
        </span>
      )}

      {/* D′ is a cropped rung of the same Stage Ladder the Console detail draws. The summary
          arrives over SSE; this panel loads the existing run detail, shows the consequential rung
          while collapsed, and reuses the real actionable ladder when disclosed. Its wrapper owns
          click propagation so using it never drills into the Console or leaves for Runs. */}
      {workflowRun && (
        <WorkflowLadderPanel
          run={workflowRun}
          session={session}
          onOpenRun={() => onOpenWorkflowRun?.(workflowRun.id)}
          tileDisclosure={{
            expanded: workflowExpanded,
            onExpandedChange: setWorkflowExpanded,
          }}
        />
      )}

      <span className="tile-marks">
        {/* Where this session lives, in the tile's flag vocabulary. Nothing renders for a
            pane-backed one, which is every session until an operator turns the runtime on.
            The DECISION and the tooltip are shared with the card chip and the rail glyph
            (`RuntimeTileFlag`), so the three cannot drift on what it is called. */}
        <RuntimeTileFlag session={session} />
        {session.note && (
          <span className={`tile-flag tf-${session.note.disposition}`}>
            {session.note.disposition === "escalated" ? "◆ decision" : "✎ draft"}
          </span>
        )}
        {session.pendingReviews > 0 && <span className="tile-flag tf-review">review</span>}
        {session.queue && session.queue.openCount > 0 && (
          <span className="tile-flag tf-queue">{session.queue.openCount} queued</span>
        )}
        {/* A PR the operator can reach in one click, from the board, without a detour
            through the console. The DECISION and the tooltip are shared (`PrTileFlag`);
            only the presentation differs, matching how the Inspector flag beside it works. */}
        <PrTileFlag session={session} />
        {/* The Inspector, in the tile's own flag vocabulary. The DECISION and the tooltip
            are shared (`InspectorTileFlag`); only the presentation differs, so the three
            surfaces can't drift on what a state means or how it's explained on hover. */}
        <InspectorTileFlag session={session} />
        {/* A generated task's recurring-mission origin, in the tile's flag vocabulary.
            The DECISION and the tooltip are shared (`ScheduleOriginTileFlag`) with the
            card chip and rail glyph, so the four surfaces can't drift. */}
        <ScheduleOriginTileFlag
          task={session.task}
          scheduleNames={scheduleNameById}
          onOpen={onOpenSchedule}
        />
        <EnsembleTileFlag
          link={session.task?.ensemble ?? null}
          summary={ensembleSummary}
          onOpen={
            session.task?.ensemble
              ? () => onOpenEnsemble?.(session.task!.ensemble!.runId)
              : undefined
          }
        />
      </span>

      {/* Only rendered while a compatible card is in the air, so it costs the tile
          nothing the rest of the time. */}
      {droppable && <span className="tile-drop-hint">↳ drop to hand this over</span>}

      {/* The same runtime row the card shows - model, thinking level, and a context meter
          that now carries its number. The board used to draw only the bare meter here; the
          percentage is the triage signal (a session near full is about to compact). */}
      {/* Beside the runtime row, deliberately NOT up in `.tile-marks` above: that row
          means "things that want your attention", and a routine estimate is not an
          alert. When it stops being routine the chip's own tone says so (costTone), which
          keeps one spelling of the number per surface rather than two. */}
      <span className="tile-runtime-line">
        {session.meta && <RuntimeMetaRow meta={session.meta} session={session} showEffort={false} />}
        {session.meta?.thinkingLevel && <EffortPicker session={session} />}
        {/* On this row rather than in `.tile-foot` where the card's footer keeps it: a
            tile's foot is branch-and-timestamp, while mode is the same kind of thing as
            the effort chip beside it - what this session is allowed to do right now, and
            changeable from here. This is the shared picker the card and console detail
            mount, so
            the three cannot drift on what a mode is called or how it is driven; it draws
            nothing for a harness with no permission modes, and degrades to a read-only
            chip when there is no pane to drive its native control. */}
        <ModePicker session={session} />
        <CostChip cost={session.cost} />
      </span>

      <span className="tile-foot">
        <span className="tile-branch">{session.gitBranch ?? session.nameSource}</span>
        <span className="tile-seen">
          {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
        </span>
      </span>
    </div>
  );
}
