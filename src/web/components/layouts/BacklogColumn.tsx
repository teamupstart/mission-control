import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { BacklogBlocker } from "@shared/backlog.ts";
import type { AssignResetConfirm, BacklogPlan, Session, Task, TaskPriority } from "@shared/types.ts";
import type { ReorderTask } from "@shared/protocol.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { backlogIndex, blockersIn, deadBlockersFor, nextUpTaskId } from "@shared/backlog.ts";
import { workflowRunIsOpen } from "@shared/workflow.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import { api } from "../../lib/api.ts";
// The words and the tone rule for a blocked item, shared with the Line's Backlog drawer so
// the board and the drawer cannot describe one task two ways.
import {
  backlogTaskNotice,
  blockedLabel,
  blockersNeedYou,
  type BacklogTaskNoticeView,
  type BacklogTrustView,
} from "../../lib/backlog-copy.ts";
import { relativeTime, stateDisplay } from "../../lib/format.ts";
import {
  ColumnWidthToggle,
  BacklogTaskNotice,
  DeadBlockerButton,
  LabelChips,
  ScheduleOriginChip,
  ScheduleSwitch,
} from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";

/**
 * The backlog as a board column you dispatch OUT of by dragging.
 *
 * Work you've queued but not started is otherwise only visible behind the Roundup
 * panel, which means the board - the screen you actually watch the fleet on - can
 * show you two idle agents and no hint that there are four things waiting to be
 * given to them. Putting the backlog on the board puts the supply next to the
 * demand, and makes "this agent is free" and "this needs doing" a single gesture
 * apart instead of a panel, a modal and a repo picker apart.
 *
 * Drag semantics are deliberately narrow: a card may only be dropped on an IDLE
 * agent in the SAME repo, because that is the only drop whose meaning is
 * unambiguous. Everything else the board can offer (launch a fresh worktree for it)
 * is still a click away on the card itself, and stays the right answer when no
 * suitable agent is free.
 *
 * The column never shrinks or hides when empty, unlike the tone columns beside it:
 * it is a drop target and an inbox, not a readout, and a target that disappears
 * when it has nothing in it is a target you cannot drop into.
 *
 * A card is also a way back INTO the form that wrote it: clicking one reopens the
 * dispatch modal over that task, where it can be corrected and then dispatched from
 * the same dialog. Shelving a task is a decision to come back to it, and coming back
 * to it almost always means rereading it - so the card is the door, not a tooltip.
 *
 * When Foreman's backlog autopilot has read the backlog (see
 * docs/plans/backlog-autopilot/plan.md) the cards also carry ITS view: which items are
 * waiting on another task, and which one it would take next. Drawn from the shared
 * predicates the scheduler decides with, never from a second reading of the plan, so
 * the column cannot mark a card ready that the machine will not touch.
 *
 * Each card also carries the one control that changes that view: an on/off switch
 * saying whether the autopilot may schedule this item at all. It is a hold, not a
 * cancel - the launch button and the drag gesture keep working on a parked card,
 * because they are you, and the switch only ever speaks for the machine.
 *
 * AND THE COLUMN IS IN YOUR ORDER. Not priority, not age, not a model's: `backlogTasks`
 * sorts by `backlogRank`, the four move controls on each card write it, and the scheduler
 * reads the same list through the same comparator - so what this column draws IS what
 * Foreman takes next. See docs/plans/backlog-manual-order/plan.md. The controls are
 * ordinary buttons rather than a mouse-only gesture, because a reorder that only exists
 * as a drag is one half the surfaces cannot test and some people cannot perform.
 *
 * The order is ALSO a drag, and it is the same drag. A card carries one payload and starts
 * one `dragstart`; what decides whether it is assigned or reordered is WHERE it is dropped -
 * an agent tile hands it over, a gap in this column moves it. No handle, no modifier, no
 * mode, and deliberately no second MIME type: a second payload would mean the card had to
 * know at `dragstart` what the drag was FOR, which is exactly the mode this avoids. Adding
 * a third destination later means adding a drop target, not a second kind of drag.
 */
export function BacklogColumn({
  tasks,
  allTasks,
  plan,
  wide = false,
  onToggleWide,
  onAssignError,
  onDragging,
  onEdit,
  onOpenSchedule,
  scheduleNameById,
  backlogTrust = null,
  onManageTrust,
}: {
  tasks: Task[];
  /** Every task, not just the backlog - dependencies point at tasks that already left it. */
  allTasks: Task[];
  /** Foreman's reading of the backlog, or null when it has none. */
  plan: BacklogPlan | null;
  /**
   * Whether the board has widened this column to read more of each card.
   *
   * Optional, and the default is the honest answer rather than a convenience: width is
   * a BOARD arrangement, and this component is also rendered on its own in tests. A
   * column with no board around it has no width to toggle, so it draws no control.
   */
  wide?: boolean;
  onToggleWide?: () => void;
  onAssignError: (message: string) => void;
  /** The repo of the card now in the air, or null when nothing is being dragged. */
  onDragging: (repoRoot: string | null) => void;
  /** Reopen the dispatch modal over this task. */
  onEdit: (taskId: string) => void;
  /** Open Recurring Missions from a generated task's provenance mark. */
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  /** Live schedule names by id, for the provenance mark's copy. */
  scheduleNameById?: ReadonlyMap<string, string>;
  /** Loaded Foreman posture, or null while either config or status is unavailable. */
  backlogTrust?: BacklogTrustView | null;
  /** Open the existing Trust matrix. Omitted in isolated renders with no App router. */
  onManageTrust?: () => void;
}): React.JSX.Element {
  const nextUp = nextUpTaskId(allTasks, plan);
  const index = backlogIndex(allTasks, plan);
  /**
   * The card in the air, by id, or null when nothing is being dragged.
   *
   * ONE notion of that, shared with the board: the card reports its drag start and end
   * through the same `onDragging` call the tiles already listen to, widened to carry the id
   * this column needs rather than given a second callback beside it. Two notions is how a
   * board ends up with lit tiles and no dragged card, or the reverse.
   */
  const [lifted, setLifted] = useState<string | null>(null);
  /**
   * Which gap the cursor is over, by index, or null.
   *
   * Set on `dragover` rather than tracked with an enter/leave pair: `dragleave` fires when
   * the cursor moves onto a child element, so a counting scheme flickers the indicator on
   * every pixel of travel across a target that has one.
   */
  const [overGap, setOverGap] = useState<number | null>(null);
  const liftedIndex = lifted === null ? -1 : tasks.findIndex((t) => t.id === lifted);
  /**
   * The same fact, but only while the card is still HERE to be moved.
   *
   * A drag that ends on an agent tile assigns the task, which takes it out of the backlog -
   * and the `dragend` that would have cleared this can be swallowed by the re-render that
   * removes the card (the same window `SessionTile` clears the board's own drag state in).
   * Deriving it off the rendered list means the column cannot be left dimmed and lit up over
   * a card that is no longer in it.
   */
  const inAir = liftedIndex >= 0 ? lifted : null;

  const reportDragging = (repoRoot: string | null, taskId: string | null): void => {
    setLifted(taskId);
    if (taskId === null) setOverGap(null);
    onDragging(repoRoot);
  };

  /**
   * Where a drop into gap `i` puts the card, as a body the route understands.
   *
   * Anchors, never indices - an index is a claim about the list this browser last rendered,
   * and the daemon's has moved on since. The two ends are `top`/`bottom` rather than
   * `before`/`after` the current end cards, because the ends are the one place a second
   * dashboard can change what "first" means between this render and this drop.
   */
  const gapTarget = (i: number): ReorderTask => {
    if (i === 0) return { position: "top" };
    const anchor = tasks[i];
    return anchor ? { position: "before", anchorTaskId: anchor.id } : { position: "bottom" };
  };

  /**
   * Take a dropped card into gap `i`.
   *
   * The two gaps either side of the dragged card are where it already is, so they answer
   * with nothing rather than with a request that would change nothing - a 200 whose only
   * effect is a wasted rank allocation and a `task_upsert` every dashboard has to redraw for.
   *
   * A refusal is SURFACED through the same channel the move buttons use. Phase 1's 409s are
   * reachable here by ordinary racing - a card that dispatched while it was in the air, or
   * an anchor that did - and a column that silently snapped back would look broken rather
   * than late.
   */
  const dropInGap = async (e: React.DragEvent, i: number): Promise<void> => {
    const id = e.dataTransfer.getData("application/x-mission-task");
    if (!id) return;
    const from = tasks.findIndex((t) => t.id === id);
    if (from >= 0 && (i === from || i === from + 1)) return;
    const r = await api.reorderTask(id, gapTarget(i));
    if (!r.ok) onAssignError(r.error ?? "could not move that");
  };

  /** One gap's handlers, shared by the between-card slots and the empty column's message. */
  const gapProps = (
    i: number,
  ): Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDrop"> => ({
    onDragOver: (e) => {
      // Only the drag this column is about. Without the guard a file dragged onto the
      // dashboard would be swallowed here, because `preventDefault` on `dragover` is what
      // tells the browser a drop is welcome at all.
      if (inAir === null) return;
      e.preventDefault();
      // The card itself and the body below both listen; stopping here is what lets the
      // body's own handler mean "over the column but not over a gap" and clear the mark.
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      // A gap the card is already beside draws nothing: that IS the feedback - there is
      // nowhere for it to go, so no line is drawn promising a move.
      setOverGap(i === liftedIndex || i === liftedIndex + 1 ? null : i);
    },
    onDrop: (e) => {
      if (inAir === null) return;
      e.preventDefault();
      e.stopPropagation();
      setOverGap(null);
      void dropInGap(e, i);
    },
  });

  return (
    <section
      className={`board-col board-backlog${wide ? " is-wide" : ""}${
        inAir === null ? "" : " is-reordering"
      }`}
    >
      {/* The same two ways in as every other column head - see BoardView. */}
      <header className="board-col-head" onDoubleClick={onToggleWide}>
        <span className="board-swatch" aria-hidden />
        <h2>Backlog</h2>
        {/* Before the count, for the reason BoardView's head states. */}
        {onToggleWide && (
          <ColumnWidthToggle wide={wide} label="Backlog" onToggle={onToggleWide} />
        )}
        <span className="board-col-n">{tasks.length}</span>
      </header>
      <div
        className="board-col-body"
        // Over the column but not over a gap - a card, or the space beside one. The mark
        // is cleared here rather than by each gap's own `dragleave`, so travelling from
        // one gap to the next can never leave two lines drawn or none.
        onDragOver={() => setOverGap(null)}
        // And out of the column entirely, towards an agent tile. `dragleave` also fires
        // on the way onto a child, which is why the relatedTarget is checked rather than
        // trusted: without it the mark would blink out every time the cursor crossed a card.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverGap(null);
        }}
      >
        {tasks.length === 0 ? (
          // The message IS the target when there is nothing to drop between, so the first
          // card of an empty backlog has somewhere to land. `bottom` and `top` mean the
          // same thing to an empty list; `bottom` is the one that stays right if a card
          // arrived between this render and this drop.
          <p className={`board-col-empty bl-drop-empty${overGap === 0 ? " is-over" : ""}`} {...gapProps(0)}>
            Nothing queued
          </p>
        ) : (
          tasks.map((t, i) => (
            <Fragment key={t.id}>
              {/* Above every card, and one more below the last: N cards, N+1 places to
                  put one. Zero-height and inert until something is in the air, because a
                  list that reflows under a drag is a list you cannot aim at. */}
              <div
                className={`bl-gap${overGap === i ? " is-over" : ""}`}
                aria-hidden
                {...gapProps(i)}
              />
              <BacklogCard
                task={t}
                blockers={blockersIn(t, index)}
                deadBlockers={deadBlockersFor(t, index)}
                nextUp={t.id === nextUp}
                lifted={t.id === inAir}
                // The cards this one is drawn BETWEEN, which is what the move controls send
                // as their anchor. Read off the rendered list rather than off the raw
                // backlog, so "move above the card above me" means the card the operator can
                // actually see - the same place a drag would land it.
                above={tasks[i - 1] ?? null}
                below={tasks[i + 1] ?? null}
                onAssignError={onAssignError}
                onDragging={reportDragging}
                onEdit={() => onEdit(t.id)}
                onOpenSchedule={onOpenSchedule}
                scheduleNameById={scheduleNameById}
                notice={backlogTaskNotice(t, backlogTrust)}
                onManageTrust={onManageTrust}
              />
              {i === tasks.length - 1 && (
                <div
                  className={`bl-gap${overGap === tasks.length ? " is-over" : ""}`}
                  aria-hidden
                  {...gapProps(tasks.length)}
                />
              )}
            </Fragment>
          ))
        )}
      </div>
      {/* Only once there IS a plan: before autopilot has ever run, this line would be
          a footer explaining a feature that isn't doing anything. */}
      {plan?.note && <p className="bl-plan-note">{plan.note}</p>}
    </section>
  );
}

/**
 * The four ways to move a card, as data rather than as four near-identical blocks of JSX.
 *
 * `up`/`down` are `before`/`after` against the neighbour the operator can SEE, not against
 * an index: an index is a claim about the list this browser last rendered, and the daemon's
 * has moved on since. `top`/`bottom` need no anchor at all - "first" and "last" mean the
 * same thing in both lists whatever has happened in between.
 *
 * The wording of the `aria-label` this feeds - `Move "Fix the flaky test" up` - is a
 * cross-phase contract: phase 2's drag work and the e2e spec both select by it.
 */
/**
 * The two cards this one sits between, as a value that can be compared across renders.
 *
 * `null` at an end is spelled out rather than left blank, so the top of the column and a
 * card whose neighbour happens to be missing cannot produce the same key.
 */
const neighbourKey = (above: Task | null, below: Task | null): string =>
  `${above?.id ?? "-"}|${below?.id ?? "-"}`;

/** The tail of a move control's `aria-label`, and the identity focus restoration works in. */
type MoveKey = "up" | "down" | "to top" | "to bottom";

const MOVES: ReadonlyArray<{
  /** The tail of the `aria-label`, and the key React draws the list by. */
  key: MoveKey;
  /** What the button reads as. Lowercase, like every other word on this card. */
  text: string;
  tip: (title: string) => string;
  /** The request body, or null when there is nowhere to go. */
  target: (above: Task | null, below: Task | null) => ReorderTask | null;
  /** True when the card is already where this control would send it. */
  atEnd: (above: Task | null, below: Task | null) => boolean;
  /**
   * Where focus goes when pressing this control DISABLES it.
   *
   * Pressing `up` on the second card lands it at the top, and the control that was under
   * the finger is now disabled - which drops focus to `<body>` and throws a keyboard user
   * to the top of the document, on the one gesture that exists for them. The counterpart
   * is the opposite direction, which is the one button in the group guaranteed to be live
   * afterwards: a card cannot be at both ends of a column it is not alone in.
   */
  counterpart: MoveKey;
}> = [
  {
    key: "to top",
    text: "top",
    tip: (title) => `Move "${title}" to the top of the backlog - Foreman takes it first`,
    target: () => ({ position: "top" }),
    atEnd: (above) => above === null,
    counterpart: "to bottom",
  },
  {
    key: "up",
    text: "up",
    tip: (title) => `Move "${title}" one place up the backlog`,
    target: (above) => (above ? { position: "before", anchorTaskId: above.id } : null),
    atEnd: (above) => above === null,
    counterpart: "down",
  },
  {
    key: "down",
    text: "down",
    tip: (title) => `Move "${title}" one place down the backlog`,
    target: (_above, below) => (below ? { position: "after", anchorTaskId: below.id } : null),
    atEnd: (_above, below) => below === null,
    counterpart: "up",
  },
  {
    key: "to bottom",
    text: "bottom",
    tip: (title) => `Move "${title}" to the bottom of the backlog`,
    target: () => ({ position: "bottom" }),
    atEnd: (_above, below) => below === null,
    counterpart: "to top",
  },
];

function BacklogCard({
  task,
  blockers,
  deadBlockers,
  nextUp,
  lifted,
  above,
  below,
  onAssignError,
  onDragging,
  onEdit,
  onOpenSchedule,
  scheduleNameById,
  notice,
  onManageTrust,
}: {
  task: Task;
  blockers: BacklogBlocker[];
  /** Cancelled/failed tasks blocking this card, directly or up its chain. */
  deadBlockers: Task[];
  /** True on the item Foreman's autopilot would pick up next. */
  nextUp: boolean;
  /** True while THIS card is the one in the air, so the column can dim it. */
  lifted: boolean;
  /** The card drawn directly above this one, or null when this is the first. */
  above: Task | null;
  /** The card drawn directly below this one, or null when this is the last. */
  below: Task | null;
  onAssignError: (message: string) => void;
  /**
   * This card entering or leaving the air: its repo for the tiles that might accept it,
   * and its id for the column's own gaps. One call, because there is one drag - see the
   * component comment above.
   */
  onDragging: (repoRoot: string | null, taskId: string | null) => void;
  onEdit: () => void;
  onOpenSchedule?: (scheduleId: string, occurrenceId?: string, scheduledFor?: number) => void;
  scheduleNameById?: ReadonlyMap<string, string>;
  notice: BacklogTaskNoticeView | null;
  onManageTrust?: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  /** The move-control group, so focus can be put back on it after a move redraws it. */
  const moveGroup = useRef<HTMLSpanElement>(null);
  /** Which control was pressed, and where focus should fall if it ends up disabled. */
  const wantFocus = useRef<{
    pressed: MoveKey;
    counterpart: MoveKey;
    /**
     * The neighbours at the moment of the press, so the redraw can be recognised - or
     * `null` for a REFUSED move, which redraws nothing and so has nothing to wait for.
     */
    neighbours: string | null;
  } | null>(null);
  const [deadBlockerOpen, setDeadBlockerOpen] = useState(false);
  const blocked = blockers.length > 0;
  const declaredBlocked = blockers.some((blocker) => blocker.source === "declared");

  async function launch(): Promise<void> {
    setBusy(true);
    const r = await api.dispatchBacklog(task.id, true);
    if (!r.ok) onAssignError(r.error ?? "could not dispatch");
    setBusy(false);
  }

  // Resolve a dead prerequisite - the two halves of unblocking this card. The target is
  // the DEAD task, never `task`: fixing it releases every dependent, not just this one.
  async function rescheduleDead(deadId: string): Promise<void> {
    setBusy(true);
    const r = await api.rescheduleTask(deadId);
    if (!r.ok) onAssignError(r.error ?? "could not reschedule that task");
    setBusy(false);
  }
  async function completeDead(deadId: string): Promise<void> {
    setBusy(true);
    const r = await api.completeTask(
      deadId,
      "Marked done from a blocked dependent - its work is already in place.",
      undefined,
      true,
      true,
    );
    if (!r.ok) onAssignError(r.error ?? "could not complete that task");
    setBusy(false);
  }

  /**
   * Flip the autopilot toggle.
   *
   * Nothing is held locally and nothing is drawn optimistically: the card re-renders
   * off the next snapshot, the same way the priority picker beside it does. What IS
   * different is that a refusal is surfaced - this patch is status-guarded, so a task
   * that dispatched between the render and the click comes back 409, and a control
   * that silently sprang back would look broken rather than late.
   */
  async function setEnabled(next: boolean): Promise<void> {
    setBusy(true);
    const r = await api.updateTask(task.id, { enabled: next });
    if (!r.ok) onAssignError(r.error ?? "could not change that");
    setBusy(false);
  }

  /**
   * Move this card in the operator's order.
   *
   * `setEnabled`'s pattern exactly: nothing optimistic, the card re-renders off the next
   * snapshot, and a refusal is SURFACED. The route is status-guarded, so a card that
   * dispatched between the render and the click comes back 409 - and a control that
   * silently sprang back would look broken rather than late.
   */
  async function move(body: ReorderTask, pressed: MoveKey, counterpart: MoveKey): Promise<void> {
    // Recorded BEFORE the request, together with the neighbours this card had when the
    // operator pressed - which is how the effect below tells the render that merely cleared
    // `busy` from the later one that actually redrew the column.
    wantFocus.current = { pressed, counterpart, neighbours: neighbourKey(above, below) };
    setBusy(true);
    const r = await api.reorderTask(task.id, body);
    if (!r.ok) {
      onAssignError(r.error ?? "could not move that");
      // A refusal moves nothing, so this card's neighbours never change and the effect
      // below would wait forever for a redraw that is not coming. Focus still has to come
      // back: the button spent the request disabled by `busy`, which dropped it to
      // `<body>` exactly as a successful move does. Flagged rather than focused here,
      // because `busy` is still true until React re-renders and every button in the group
      // is still disabled at this instant.
      wantFocus.current = { pressed, counterpart, neighbours: null };
    }
    setBusy(false);
  }

  /**
   * Put focus back on the move controls after a move redraws them.
   *
   * Every button in this group spends the request disabled by `busy`, and the pressed one
   * may STAY disabled afterwards because the card reached the end it was sent to. A
   * disabled button cannot hold focus, so without this the browser drops focus to `<body>`
   * and a keyboard user is thrown to the top of the document - on the gesture that exists
   * for them specifically. Reordering a column would mean re-Tabbing to it after every
   * single press.
   *
   * It runs on every render rather than on a completion callback because the render that
   * disables the button is the one driven by the daemon's `task_upsert`, which lands after
   * the request resolves. `wantFocus` is set only by a press on THIS card's own group, is
   * cleared as soon as it has acted, and stands down entirely if focus has meanwhile moved
   * somewhere else - so no other re-render can pull focus around.
   *
   * `useLayoutEffect`, not `useEffect`: focus has to be restored in the same frame the
   * button was disabled in, or the paint in between shows a focus ring vanishing.
   */
  useLayoutEffect(() => {
    const want = wantFocus.current;
    if (!want || busy) return;
    const group = moveGroup.current;
    if (!group) return;
    // The request resolving is NOT the column being redrawn: the new order arrives on the
    // daemon's `task_upsert`, which can land either side of it. Waiting for this card's
    // neighbours to actually change is what stops focus being restored to a button that is
    // about to be disabled by the render after this one - which is the whole failure being
    // repaired, one frame later.
    if (want.neighbours !== null && neighbourKey(above, below) === want.neighbours) return;
    // Somewhere else has focus, so the operator moved on while the move was in flight.
    // Restoring here would be a yank, not a repair.
    const active = document.activeElement;
    if (active && active !== document.body && !group.contains(active)) {
      wantFocus.current = null;
      return;
    }
    // Matched in JS rather than with an attribute selector: the label embeds a task title
    // a person typed, and a title containing a quote would break the selector's own quoting.
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button.bl-move-btn")];
    const button = (key: MoveKey): HTMLButtonElement | undefined =>
      buttons.find((el) => el.getAttribute("aria-label") === `Move "${task.title}" ${key}`);
    const target = [want.pressed, want.counterpart]
      .map((key) => button(key))
      .find((el): el is HTMLButtonElement => el !== undefined && !el.disabled);
    // Nothing live to hold it means this card is alone in the column, where all four are
    // disabled and no press could have happened. Clear regardless, so a stale intent can
    // never take focus off something the operator moved to later.
    target?.focus();
    wantFocus.current = null;
  });

  return (
    <article
      className={`bl-card${busy ? " is-busy" : ""}${blocked ? " is-blocked" : ""}${
        nextUp ? " is-next" : ""
      }${task.enabled ? "" : " is-disabled"}${deadBlockerOpen ? " is-deadblock-open" : ""}${
        lifted ? " is-lifted" : ""
      }`}
      // Foreman's inferred edge remains overridable. An operator-declared dependency is
      // policy, so both drag-to-assign and launch are disabled until it completes.
      draggable={!busy && !declaredBlocked}
      onDragStart={(e) => {
        // The id travels in the payload (the only thing the drop needs); the repo goes
        // up to the board as state, because which tiles may accept this card has to be
        // decided in a render, not read off the DOM during one.
        e.dataTransfer.setData("application/x-mission-task", task.id);
        e.dataTransfer.effectAllowed = "move";
        // A multi-repo task announces NO repo, so no tile lights up and none will take the
        // drop - `canAcceptTask` refuses a null repo and `SessionTile` gates both dragover
        // and drop on that answer. These tasks are dispatch-only: their extra worktrees and
        // the agent's write access to them are granted when the session LAUNCHES, and no
        // already-running session can be given either. `TaskManager.assign` refuses one
        // server-side too, which is the enforcement; this is what stops the board offering
        // a gesture that could only ever end in an error toast.
        // The id goes up as well, and unconditionally: a multi-repo card announces no
        // repo so no TILE lights up, but this column's own gaps must still take it.
        // Reordering a dispatch-only task is fine; only assigning it is not.
        onDragging(task.extraRepos.length > 0 ? null : task.repoRoot, task.id);
      }}
      onDragEnd={() => onDragging(null, null)}
      // Anywhere on the card opens it, so the gesture matches what the whole card looks
      // like: one object. A drag doesn't fire this - the browser suppresses the click
      // that ends one - so dragging a card to an agent still only ever assigns it.
      onClick={onEdit}
    >
      {/* The real, focusable control behind the card-wide click: a card is not a button
          (it contains one), so the title carries the keyboard route in - and it carries
          the card's tooltip too. The `<article>` held `title={task.intent}` until this
          became a Tooltip; wrapping the card itself would have put a second bubble on
          screen every time you reached for the switch or the launch button inside it. */}
      <Tooltip label={task.intent || "Open this task for editing"}>
        <button className="bl-title" onClick={onEdit}>
          {task.title}
        </button>
      </Tooltip>
      <span className="bl-marks">
        {/* The enable/disable switch sits with the priority picker rather than with the
            launch button because it is triage, not execution: both say how this item
            should be treated when Foreman gets to it, and both are things you do to a
            row while reading down the column. */}
        <ScheduleSwitch
          enabled={task.enabled}
          taskTitle={task.title}
          busy={busy}
          onChange={(next) => void setEnabled(next)}
        />
        {/* The priority control IS the chip here, rather than a read-only chip with an
            editor under it - two of those meant the card said "BLOCKER" and "Blocker"
            inches apart, the same fact twice. The backlog is the surface where triage
            actually happens, so its one priority affordance is the editable one, and it
            wears the same colour the read-only `PriorityChip` uses elsewhere.

            It is annotation and it moves nothing: the column is in the order the operator
            arranged (see the move controls below), so setting a priority recolours this
            card and leaves it exactly where it is. That is the trade the feature took
            deliberately - an order a chip could rearrange is not an order you set.

            Both handlers stop propagation and they stop two DIFFERENT things. The card
            is `draggable`, so without `onMouseDown` the browser starts a drag instead of
            opening the select. The card is also click-to-edit, so without `onClick`
            picking a priority would open the dispatch modal over the board on the way
            past - the control would work, and look like it had done something else. */}
        <span
          className={`bl-prio${task.priority ? ` prio-${task.priority}` : " is-unset"}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip label={`Priority for "${task.title}" - a triage mark, not its place in the backlog`}>
          <select
            aria-label={`Priority for ${task.title}`}
            value={task.priority ?? ""}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value;
              void api.updateTask(task.id, {
                // "" clears the field back to unset; null is what the API takes for that.
                priority: next === "" ? null : (next as TaskPriority),
              });
            }}
          >
            <option value="">priority</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
          </Tooltip>
        </span>
        {/* Capped here and nowhere else: this card is the narrowest surface a task is
            drawn on, and the chip component reports the remainder as "+N" rather than
            dropping it, so a heavily-tagged task never looks lightly tagged. */}
        <LabelChips labels={task.labels} max={3} />
      </span>
      {/* The order, as controls rather than as a gesture.

          A reorder that existed only as a drag would be a reorder half the surfaces cannot
          test and some people cannot perform, so the keyboard route is the primary one and
          the drag (phase 2) is the shortcut on top of it. These are ordinary focusable
          buttons in DOM order, so Tab reaches them and Enter or Space presses them with no
          key handling of our own. The one thing this card does add is putting focus back
          after a press - see the effect above, and why losing it is not cosmetic.

          `aria-label`s name the task because the app selects by role and label and never by
          `data-testid`, and because four unlabelled arrows repeated down a column say
          nothing to a screen reader about WHICH card they move.

          Both hazards the priority picker above already teaches apply here, and they stop
          two different things: the card is `draggable`, so without `onMouseDown` the
          browser starts a drag instead of pressing the button; and the card is
          click-to-edit, so without `onClick` the move would open the dispatch modal on the
          way past. The group carries both once rather than each button carrying them. */}
      <span
        className="bl-move"
        ref={moveGroup}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {MOVES.map(({ key, text, tip, target, atEnd, counterpart }) => (
          <Tooltip key={key} label={tip(task.title)}>
            <button
              className="bl-move-btn"
              aria-label={`Move "${task.title}" ${key}`}
              // At the end it is already where this would send it, so the honest control is
              // a disabled one saying so rather than a live one that does nothing.
              disabled={busy || atEnd(above, below)}
              onClick={() => {
                const body = target(above, below);
                if (body) void move(body, key, counterpart);
              }}
            >
              {text}
            </button>
          </Tooltip>
        ))}
      </span>
      <span className="bl-foot">
        <span className={`bl-kind bl-kind-${task.kind}`}>{task.kind}</span>
        <span className="bl-agent">{task.agent}</span>
        {/* Counted, not listed: the card is the narrowest surface a task is drawn on, and
            the repo set only has to be VISIBLE here - the modal that opens on click names
            every one. It also explains, without a second chip saying so, why this card
            refuses to drop onto an idle agent. */}
        {task.extraRepos.length > 0 && (
          <Tooltip
            label={`Spans ${task.extraRepos.length + 1} repos: ${[task.repoRoot, ...task.extraRepos.map((e) => e.repoRoot)].join(", ")} - dispatch only`}
          >
            <span className="bl-repos">{task.extraRepos.length + 1} repos</span>
          </Tooltip>
        )}
        <span className="bl-added">{relativeTime(task.createdAt)}</span>
      </span>
      {/* One notification slot beneath metadata. A persisted launch error is the strongest
          explanation; otherwise live autopilot can name a missing repository grant here. */}
      <BacklogTaskNotice
        notice={notice}
        className="bl-recovery"
        onManageTrust={onManageTrust}
      />
      {/* A generated task's recurring-mission origin. The shared chip stops propagation so
          opening its history does not also open Dispatch or start a drag. */}
      <ScheduleOriginChip task={task} scheduleNames={scheduleNameById} onOpen={onOpenSchedule} />
      {blocked && (
        <Tooltip label={`Waiting on: ${blockers.map((b) => b.title).join(", ")}`}>
          <span className={`bl-blocked${blockersNeedYou(blockers) ? " is-stopped" : ""}`}>
            {blockedLabel(blockers)}
          </span>
        </Tooltip>
      )}
      {/* The blocked chip above says WHAT this is waiting on; this button is the way OUT
          when that thing is a cancelled/failed task that will never finish - including one
          buried up the chain, which the chip (direct blockers only) cannot name. */}
      <DeadBlockerButton
        deadBlockers={deadBlockers}
        busy={busy}
        onReschedule={(id) => void rescheduleDead(id)}
        onComplete={(id) => void completeDead(id)}
        onOpenChange={setDeadBlockerOpen}
      />
      {/* The CONSEQUENCE, not the setting - the switch above already says which way it
          is set, and repeating "disabled" here would be the card saying one fact twice,
          the way a read-only priority chip over a priority picker did. What a two-letter
          pill cannot carry is what being off costs, and that sentence is what stops a
          quiet autopilot from looking like a broken one. Drawn alongside a blocked chip
          rather than instead of it: different facts, neither implying the other. */}
      {!task.enabled && (
        <Tooltip label="Turn the switch back on to let Foreman schedule it">
          <span className="bl-off">autopilot will skip this</span>
        </Tooltip>
      )}
      {/* `nextUp` comes from `readyBacklog`, which drops disabled items, so this is
          already unreachable on a parked card - no second guard here to drift. */}
      {nextUp && !blocked && (
        <Tooltip label="Foreman's autopilot would pick this up next">
          <span className="bl-next">next up</span>
        </Tooltip>
      )}
      <Tooltip
        label={
          declaredBlocked
            ? `Waiting for: ${blockers.filter((blocker) => blocker.source === "declared").map((blocker) => blocker.title).join(", ")}`
            : !task.enabled
            ? "Disabled for the autopilot - this launches it yourself, right now"
            : blocked
            ? "Launch it anyway, ahead of what Foreman thinks it's waiting on"
            : "Dispatch into a fresh worktree"
        }
      >
      {/* `is-waiting` is not decoration: in this one state the label is the card's
          explanation rather than a verb you cannot press, so it opts out of the generic
          disabled dimming instead of stacking it on the card's own. See `.bl-launch`. */}
      <button
        className={`bl-launch${declaredBlocked && !busy ? " is-waiting" : ""}`}
        onClick={(e) => {
          // Launching is not opening: without this the card's own handler would fire
          // too and drop the modal over a task that is already on its way out.
          e.stopPropagation();
          void launch();
        }}
        disabled={busy || declaredBlocked}
      >
        {busy
          ? "dispatching…"
          : declaredBlocked
          ? "waiting for dependencies"
          : blocked || !task.enabled
          ? "launch anyway"
          : "launch new agent"}
      </button>
      </Tooltip>
    </article>
  );
}

/**
 * Whether a session can accept the task currently being dragged.
 *
 * Idle is judged by the session's TONE, not its raw `state`, so a session with a review
 * waiting on you cannot accept more work just because its agent state says `idle`.
 * Live hook instrumentation is a separate requirement: passive rollout evidence may
 * place a Codex session in the Idle column, but cannot confirm the reset and prompt
 * delivery that assigning work performs.
 *
 * A session an OPEN workflow run holds refuses the drop outright. The drop is a reset -
 * `dropTaskOnSession` assigns with `reset: true` - and resetting an agent whose next turn
 * belongs to a run would yank it out from under that run the moment the board has started
 * calling it "held". The caller passes the runs it already renders (the tile's `workflowRuns`)
 * rather than this predicate doing a second lookup, for the same reason the held tag reads
 * off them: the rule, the tag and the drop must agree about one session, and one source is
 * how. ANY open run refuses, which matters for a multi-repo task's session - its repositories'
 * reviews finish at different times, and the last one still owns the pane.
 * `workflowRunIsOpen` decides, so a terminal run releases the drop target the same instant
 * it releases the section rule.
 *
 * The server re-checks in `TaskManager.assign` regardless, because a session can go
 * busy between the hover and the drop.
 */
export function canAcceptTask(
  session: Session,
  repoRoot: string | null,
  workflowRuns?: readonly WorkflowRunSummary[] | null,
): boolean {
  if (!repoRoot) return false;
  if (!session.instrumented) return false;
  if (workflowRuns != null && workflowRuns.some((run) => workflowRunIsOpen(run.status))) return false;
  if (stateDisplay(session).tone !== "idle") return false;
  return session.repoRoot != null && session.repoRoot === repoRoot;
}

/**
 * Hand a dragged task to a session, reporting any refusal to the caller.
 *
 * One refusal is not a complaint but a question: the drop resets the agent, and when
 * that would take its work queue or the branch it stands on, the daemon answers with the
 * breakdown and changes nothing. That is routed to `onConfirm` rather than shown as an
 * error, because the operator has a decision to make and the payload already says what
 * they are deciding about. An agent with nothing to lose never reaches it.
 */
export async function dropTaskOnSession(
  e: React.DragEvent,
  session: Session,
  onError: (message: string) => void,
  onConfirm: (pending: { taskId: string; confirm: AssignResetConfirm }) => void,
): Promise<void> {
  const id = e.dataTransfer.getData("application/x-mission-task");
  if (!id) return;
  const r = await api.assignTask(id, session.id, true);
  if (r.ok) return;
  if (r.resetConfirm) {
    onConfirm({ taskId: id, confirm: r.resetConfirm });
    return;
  }
  onError(r.error ?? "could not hand that to the agent");
}
