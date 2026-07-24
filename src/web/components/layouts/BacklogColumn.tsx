import { useState } from "react";
import type { BacklogBlocker } from "@shared/backlog.ts";
import type { AssignResetConfirm, BacklogPlan, Session, Task, TaskPriority } from "@shared/types.ts";
import { backlogIndex, blockersIn, deadBlockersFor, nextUpTaskId } from "@shared/backlog.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import { api } from "../../lib/api.ts";
import { relativeTime, stateDisplay } from "../../lib/format.ts";
import { DeadBlockerButton, LabelChips, ScheduleSwitch } from "../session-bits.tsx";
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
 */
export function BacklogColumn({
  tasks,
  allTasks,
  plan,
  onAssignError,
  onDragging,
  onEdit,
}: {
  tasks: Task[];
  /** Every task, not just the backlog - dependencies point at tasks that already left it. */
  allTasks: Task[];
  /** Foreman's reading of the backlog, or null when it has none. */
  plan: BacklogPlan | null;
  onAssignError: (message: string) => void;
  /** The repo of the card now in the air, or null when nothing is being dragged. */
  onDragging: (repoRoot: string | null) => void;
  /** Reopen the dispatch modal over this task. */
  onEdit: (taskId: string) => void;
}): React.JSX.Element {
  const nextUp = nextUpTaskId(allTasks, plan);
  const index = backlogIndex(allTasks, plan);
  return (
    <section className="board-col board-backlog">
      <header className="board-col-head">
        <span className="board-swatch" aria-hidden />
        <h2>Backlog</h2>
        <span className="board-col-n">{tasks.length}</span>
      </header>
      <div className="board-col-body">
        {tasks.length === 0 ? (
          <p className="board-col-empty">Nothing queued</p>
        ) : (
          tasks.map((t) => (
            <BacklogCard
              key={t.id}
              task={t}
              blockers={blockersIn(t, index)}
              deadBlockers={deadBlockersFor(t, index)}
              nextUp={t.id === nextUp}
              onAssignError={onAssignError}
              onDragging={onDragging}
              onEdit={() => onEdit(t.id)}
            />
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
 * One line naming what a card is waiting on. Two by name, then a count, because the
 * chip has to stay a chip - and the full list is in the shared tooltip either way.
 *
 * The two "this will never clear on its own" states lead, and they lead in that order
 * because they ask for different things: a dependency that failed needs looking at,
 * while a disabled one needs one click on a toggle somebody already knows they turned
 * off. Both beat "after X", which promises a queue that is not moving.
 */
function blockedLabel(blockers: BacklogBlocker[]): string {
  const stopped = blockers.filter((b) => b.state === "stopped");
  // A dependency that was cancelled or failed will never clear on its own, so it is a
  // different message from "wait your turn" - it is the one that needs you.
  if (stopped.length > 0) return `needs you - ${stopped[0]!.title} didn't finish`;
  const off = blockers.filter((b) => b.state === "disabled");
  if (off.length > 0) return `${off[0]!.title} is disabled`;
  if (blockers.length === 1) return `after ${blockers[0]!.title}`;
  return `after ${blockers[0]!.title} +${blockers.length - 1}`;
}

/** True while a blocker means "nothing will move this until you act". */
function needsYou(blockers: BacklogBlocker[]): boolean {
  return blockers.some((b) => b.state === "stopped" || b.state === "disabled");
}

function BacklogCard({
  task,
  blockers,
  deadBlockers,
  nextUp,
  onAssignError,
  onDragging,
  onEdit,
}: {
  task: Task;
  blockers: BacklogBlocker[];
  /** Cancelled/failed tasks blocking this card, directly or up its chain. */
  deadBlockers: Task[];
  /** True on the item Foreman's autopilot would pick up next. */
  nextUp: boolean;
  onAssignError: (message: string) => void;
  onDragging: (repoRoot: string | null) => void;
  onEdit: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
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

  return (
    <article
      className={`bl-card${busy ? " is-busy" : ""}${blocked ? " is-blocked" : ""}${
        nextUp ? " is-next" : ""
      }${task.enabled ? "" : " is-disabled"}`}
      // Foreman's inferred edge remains overridable. An operator-declared dependency is
      // policy, so both drag-to-assign and launch are disabled until it completes.
      draggable={!busy && !declaredBlocked}
      onDragStart={(e) => {
        // The id travels in the payload (the only thing the drop needs); the repo goes
        // up to the board as state, because which tiles may accept this card has to be
        // decided in a render, not read off the DOM during one.
        e.dataTransfer.setData("application/x-mission-task", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragging(task.repoRoot);
      }}
      onDragEnd={() => onDragging(null)}
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

            Changing it re-sorts the column on the next snapshot (the list arrives
            through `backlogTasks`), so the card moves under your cursor - which is the
            feedback that makes it obvious the field does something.

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
          <Tooltip label={`Priority for "${task.title}" - decides where it sits in the backlog`}>
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
      <span className="bl-foot">
        <span className={`bl-kind bl-kind-${task.kind}`}>{task.kind}</span>
        <span className="bl-agent">{task.agent}</span>
        <span className="bl-added">{relativeTime(task.createdAt)}</span>
      </span>
      {blocked && (
        <Tooltip label={`Waiting on: ${blockers.map((b) => b.title).join(", ")}`}>
          <span className={`bl-blocked${needsYou(blockers) ? " is-stopped" : ""}`}>
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
      <button
        className="bl-launch"
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
 * The server re-checks in `TaskManager.assign` regardless, because a session can go
 * busy between the hover and the drop.
 */
export function canAcceptTask(
  session: Session,
  repoRoot: string | null,
  gateNeedsYou: boolean,
): boolean {
  if (!repoRoot) return false;
  if (!session.instrumented) return false;
  if (stateDisplay(session, gateNeedsYou).tone !== "idle") return false;
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
