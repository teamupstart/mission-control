import { useCallback, useEffect, useState } from "react";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { PipelineRunLink } from "@shared/pipeline.ts";
import { liveActivity } from "@shared/session.ts";
import { relativeTime, repoLeaf, sessionTitleDetail, stateDisplay, uptime } from "../../lib/format.ts";
import { useDisplayItems } from "../../lib/board-card.ts";
import type { RuntimeMetaPart } from "../session-bits.tsx";
import { useInterrupting } from "../../lib/interrupting.ts";
import { heldByRun } from "../../lib/held.ts";
import { isDragSelection } from "../../lib/pointer.ts";
import {
  AgentDot,
  CostChip,
  InspectorTileFlag,
  PrTileFlag,
  RuntimeMetaRow,
  RuntimeTileFlag,
  ScheduleOriginTileFlag,
  EnsembleTileFlag,
  TaskPipelineRunTileFlag,
} from "../session-bits.tsx";
import { EffortPicker } from "../EffortPicker.tsx";
import { ModePicker } from "../ModePicker.tsx";
import { canAcceptTask, dropTaskOnSession } from "./BacklogColumn.tsx";
import { Tooltip } from "../Tooltip.tsx";
import { WorkflowLadderPanel } from "../../workflows/WorkflowLadder.tsx";
import type { WorkflowDisclosureHandle } from "./types.ts";
import { useIsTourTask, useTourTaskTargetRef } from "../../tour/target-context.tsx";

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
  onCursorTo,
  registerEl,
  draggingRepo,
  onDropped,
  onDropError,
  onDropConfirm,
  workflowRun = null,
  workflowStageDetail = "load",
  workflowRuns = null,
  registerWorkflowDisclosure,
  onOpenWorkflowRun,
  onOpenSchedule,
  scheduleNameById,
  onOpenEnsemble,
  ensembleSummary = null,
  onOpenPipelineRun,
  pipelineRunObserved = false,
}: {
  session: Session;
  /** The board's arrow-key cursor. Selection does not open the tile until Enter. */
  selected?: boolean;
  onOpen: () => void;
  /** Make this tile the board's cursor without opening it. See `onSurfaceClick` below. */
  onCursorTo?: () => void;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  draggingRepo: string | null;
  onDropped: () => void;
  onDropError: (message: string) => void;
  /** The drop needs a yes: the handover would take something from this agent. */
  onDropConfirm: (pending: { taskId: string; confirm: AssignResetConfirm }) => void;
  workflowRun?: WorkflowRunSummary | null;
  /**
   * Whether the workflow panel may load the run's stages, passed straight through.
   *
   * `"load"` for the Board, which is showing a live run. `"summary"` is for a host holding
   * a run SUMMARY and no run - the Board card preview in Settings - so the panel draws its
   * settled placeholder instead of fetching an id the daemon can only 404.
   */
  workflowStageDetail?: "load" | "summary";
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
  onOpenPipelineRun?: (link: PipelineRunLink) => void;
  pipelineRunObserved?: boolean;
}): React.JSX.Element {
  // Board tiles draw their own badge rather than `StateBadge`, so the transient stop has to
  // be asked for here too - Ctrl+C works from the board overview, so this is a surface where
  // it is pressed.
  const st = stateDisplay(session, useInterrupting(session.id));
  const ticker = liveActivity(session);
  const workflowRunId = workflowRun?.id ?? null;
  // Held reads off the run this tile was already handed, not a second lookup: the section rule
  // above it and this tag have to agree about the same session, and one source is how they do.
  // `heldByRun` is the shared sentence used across supported fleet surfaces, and
  // the run it returns is the one the tooltip names, so the mark cannot credit a sibling
  // review that has already finished.
  const heldBy = heldByRun(workflowRuns, st.tone);
  const held = heldBy !== null;
  const [over, setOver] = useState(false);
  const [workflowExpanded, setWorkflowExpanded] = useState(false);
  const tourTargetRef = useTourTaskTargetRef<HTMLDivElement>("see-work:demo-task", session.task?.id);
  const isTourTask = useIsTourTask(session.task?.id);
  const toggleWorkflowExpanded = useCallback(
    () => setWorkflowExpanded((expanded) => !expanded),
    [],
  );
  const setTileRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerEl?.(session.id, el);
      tourTargetRef(el);
    },
    [registerEl, session.id, tourTargetRef],
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
  const openName = session.name ? sessionTitleDetail(session) : "unnamed session";

  // Which optional items this operator asked the card to draw. ONE registry
  // (`lib/board-card.ts`) owns the ids and the prose the settings panel prints, and this
  // is the only place the board consults it - a private list here would be the second
  // source of truth the whole feature exists to avoid, and `test/board-card-items.test.ts`
  // is what fails when one appears.
  //
  // The attention flags below (`.tile-marks`) are deliberately NOT gated on any of this,
  // and neither are the tone spine, the name and its open button, the agent dot, the
  // `held` tag or the drop hint. See the registry's header for why each is pinned on.
  const shown = useDisplayItems();
  // The board has always drawn the interactive `EffortPicker` as a sibling of the shared
  // runtime row rather than the read-only pill inside it, so `effort` is omitted from the
  // row unconditionally and the operator's choice gates the picker instead.
  const omitRuntime = new Set<RuntimeMetaPart>(["effort"]);
  if (!shown("model")) omitRuntime.add("model");
  if (!shown("context")) omitRuntime.add("context");
  // Gated on the operator's CHOICES, not on the data. Today's card draws both wrappers
  // even when everything inside them happens to be absent, so keeping them while any of
  // their items is switched on is what makes the shipped defaults byte-identical - while
  // an operator who switches a whole row off gets its height back rather than an empty
  // flex line still eating the tile's column gap.
  const runtimeLine =
    shown("model") || shown("context") || shown("effort") || shown("mode") || shown("cost");
  const foot = shown("branch") || shown("worktree") || shown("lastSeen");

  return (
    <div
      ref={setTileRef}
      className={`tile tone-${st.tone}${st.tone === "attention" ? " attention" : ""}${
        selected ? " selected" : ""
      }${held ? " is-held" : ""}${
        droppable ? " can-drop" : ""
      }${over ? " drop-over" : ""}${workflowExpanded ? " workflow-expanded" : ""}${
        isTourTask ? " mc-tour-task" : ""
      }`}
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
      <Tooltip label={`Open ${openName}`}>
        <button
          type="button"
          className="tile-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={`Open ${openName}`}
          aria-current={selected}
        />
      </Tooltip>

      <span className="tile-head">
        <AgentDot agent={session.agent} />
        <Tooltip label={`Open ${openName}`}>
          <span className="tile-name">{session.name || "(unnamed)"}</span>
        </Tooltip>
        {/* Says the same thing as the section rule this tile sits under, and is not redundant
            with it: the rule scrolls off the top of a full column, and a tile dragged into view
            by the arrow keys has to carry its own answer to "why can I not use this one". */}
        {held && (
          <Tooltip
            label={`Held by ${heldBy?.workflowName ?? "a workflow"} - the run owns this session's next turn`}
          >
            <span className="tile-held">held</span>
          </Tooltip>
        )}
      </span>

      {shown("goal") && session.goal?.text && (
        <span className="tile-goal">{session.goal.text}</span>
      )}

      {/* What it's doing right now - the board's only live signal past "6s ago", and what
          tells an actively-editing session apart from one stalled on a prompt. `liveActivity`
          is where the gate's reasoning lives: it answers with the line only while there is
          something happening for it to describe, which is also what the conversation's
          in-progress row asks. This tile established the rule; the shared predicate is what
          stops the two from drifting apart. */}
      {shown("activity") && ticker && (
        <span className="tile-activity">
          <span className="ta-glyph" aria-hidden>
            ⟳
          </span>
          <span className="ta-txt">{ticker}</span>
        </span>
      )}

      {/* D′ is a cropped rung of the same Stage Ladder the Console detail draws. The summary
          arrives over SSE; this panel loads the existing run detail, shows the consequential rung
          while collapsed, and reuses the real actionable ladder when disclosed. Its wrapper owns
          click propagation so neither action accidentally drills into the Console: the compact
          preview opens the exact run, while the disclosure control expands in place. */}
      {shown("workflow") && workflowRun && (
        <WorkflowLadderPanel
          run={workflowRun}
          session={session}
          stageDetail={workflowStageDetail}
          onOpenRun={() => onOpenWorkflowRun?.(workflowRun.id)}
          tileDisclosure={{
            expanded: workflowExpanded,
            onExpandedChange: setWorkflowExpanded,
            // Two clicks, because this panel's background has two honest meanings and the
            // tile's own selection is what tells them apart. An expanded ladder is most of
            // the tile, and a click into it used to mean nothing at all - the tile you
            // aimed at did not even become the cursor. So the first click selects it, the
            // way a click on the goal line or the activity ticker above it would.
            //
            // Selects rather than opens, and that is the whole reason `onCursorTo` exists:
            // drilling in morphs this column into the console rail, which replaces the tile
            // - and the ladder being read - with a rail row, leaving the second click
            // nowhere to land. Once the tile IS the cursor that question is answered, and
            // the next click into the same area can only be about the run on screen: it
            // follows that run into Runs, the same destination as the collapsed peek link
            // and the ladder's own "Open run" button.
            onSurfaceClick: () =>
              selected ? onOpenWorkflowRun?.(workflowRun.id) : (onCursorTo ?? onOpen)(),
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
        <TaskPipelineRunTileFlag
          link={session.task?.pipelineRun ?? null}
          observed={pipelineRunObserved}
          onOpen={
            session.task?.pipelineRun
              ? () => onOpenPipelineRun?.(session.task!.pipelineRun!)
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
      {runtimeLine && (
        <span className="tile-runtime-line">
          {session.meta && (
            <RuntimeMetaRow meta={session.meta} session={session} omit={omitRuntime} />
          )}
          {shown("effort") && session.meta?.thinkingLevel && <EffortPicker session={session} />}
          {/* On this row rather than in `.tile-foot`: a
              tile's foot is branch-and-timestamp, while mode is the same kind of thing as
              the effort chip beside it - what this session is allowed to do right now, and
              changeable from here. This is the shared picker the Board tile and Console detail
              mount, so the two cannot drift on what a mode is called or how it is driven; it draws
              nothing for a harness with no permission modes, and degrades to a read-only
              chip when there is no pane to drive its native control. */}
          {shown("mode") && <ModePicker session={session} />}
          {shown("cost") && <CostChip cost={session.cost} />}
        </span>
      )}

      {foot && (
        <span className="tile-foot">
          {/* The branch, with its fallback intact: a session with no branch prints where its
              NAME came from instead, so hiding "branch" hides the branch and does not empty
              the cell for a session that never had one. */}
          {shown("branch") && (
            <span className="tile-branch">{session.gitBranch ?? session.nameSource}</span>
          )}
          {/* Which checkout this is - the one fact on this card that the console detail used
              to be the only place to read. The LEAF, not the path: a pool worktree path is
              sixty characters of bookkeeping, and this row is two cells sharing one line's
              width. The whole path is on hover, which is the same bargain every other
              shortened path in the app makes. */}
          {shown("worktree") && session.cwd && (
            <Tooltip label={session.cwd}>
              <span className="tile-worktree">{repoLeaf(session.cwd)}</span>
            </Tooltip>
          )}
          {shown("lastSeen") && (
            <span className="tile-seen">
              {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
