import { useState } from "react";
import type { BacklogBlocker } from "@shared/backlog.ts";
import type { BacklogPlan, Session, Task, TaskPriority } from "@shared/types.ts";
import { backlogIndex, blockersIn, nextUpTaskId } from "@shared/backlog.ts";
import { PRIORITY_LABELS, TASK_PRIORITIES } from "@shared/task.ts";
import { api } from "../../lib/api.ts";
import { relativeTime, stateDisplay } from "../../lib/format.ts";
import { LabelChips } from "../session-bits.tsx";

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
 * chip has to stay a chip - and the full list is in the `title` either way.
 */
function blockedLabel(blockers: BacklogBlocker[]): string {
  const stopped = blockers.filter((b) => b.state === "stopped");
  // A dependency that was cancelled or failed will never clear on its own, so it is a
  // different message from "wait your turn" - it is the one that needs you.
  if (stopped.length > 0) return `needs you - ${stopped[0]!.title} didn't finish`;
  if (blockers.length === 1) return `after ${blockers[0]!.title}`;
  return `after ${blockers[0]!.title} +${blockers.length - 1}`;
}

function BacklogCard({
  task,
  blockers,
  nextUp,
  onAssignError,
  onDragging,
  onEdit,
}: {
  task: Task;
  blockers: BacklogBlocker[];
  /** True on the item Foreman's autopilot would pick up next. */
  nextUp: boolean;
  onAssignError: (message: string) => void;
  onDragging: (repoRoot: string | null) => void;
  onEdit: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const blocked = blockers.length > 0;

  async function launch(): Promise<void> {
    setBusy(true);
    const r = await api.dispatchBacklog(task.id);
    if (!r.ok) onAssignError(r.error ?? "could not dispatch");
    setBusy(false);
  }

  return (
    <article
      className={`bl-card${busy ? " is-busy" : ""}${blocked ? " is-blocked" : ""}${
        nextUp ? " is-next" : ""
      }`}
      // Blocked cards stay draggable and launchable on purpose. Foreman's dependency
      // read is a model's opinion, and the human overruling it is a legitimate,
      // one-gesture answer - the card only has to be honest about what it thinks.
      draggable={!busy}
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
      title={task.intent}
    >
      {/* The real, focusable control behind the card-wide click: a card is not a button
          (it contains one), so the title carries the keyboard route in. */}
      <button className="bl-title" onClick={onEdit} title="Open this task for editing">
        {task.title}
      </button>
      <span className="bl-marks">
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
        <span
          className={`bl-blocked${blockers.some((b) => b.state === "stopped") ? " is-stopped" : ""}`}
          title={`Waiting on: ${blockers.map((b) => b.title).join(", ")}`}
        >
          {blockedLabel(blockers)}
        </span>
      )}
      {nextUp && !blocked && (
        <span className="bl-next" title="Foreman's autopilot would pick this up next">
          next up
        </span>
      )}
      <button
        className="bl-launch"
        onClick={(e) => {
          // Launching is not opening: without this the card's own handler would fire
          // too and drop the modal over a task that is already on its way out.
          e.stopPropagation();
          void launch();
        }}
        disabled={busy}
        title={
          blocked
            ? "Launch it anyway, ahead of what Foreman thinks it's waiting on"
            : "Dispatch into a fresh worktree"
        }
      >
        {busy ? "dispatching…" : blocked ? "launch anyway" : "launch new agent"}
      </button>
    </article>
  );
}

/**
 * Whether a session can accept the task currently being dragged.
 *
 * Idle is judged by the session's TONE, not its raw `state`, so the tiles that light
 * up are exactly the ones sitting in the board's Idle column - which is what the
 * gesture promises. The two disagree in both directions and the tone is right both
 * times: an uninstrumented session reports `idle` while we have no idea what it's
 * doing (it shows as Unconfirmed), and a session with a review waiting on you reports
 * `idle` while already needing you (it shows under Needs you). Neither should be
 * handed more work.
 *
 * The server re-checks in `TaskManager.assign` regardless, because a session can go
 * busy between the hover and the drop.
 */
export function canAcceptTask(session: Session, repoRoot: string | null): boolean {
  if (!repoRoot) return false;
  if (stateDisplay(session).tone !== "idle") return false;
  return session.repoRoot != null && session.repoRoot === repoRoot;
}

/** Hand a dragged task to a session, reporting any refusal to the caller. */
export async function dropTaskOnSession(
  e: React.DragEvent,
  session: Session,
  onError: (message: string) => void,
): Promise<void> {
  const id = e.dataTransfer.getData("application/x-mission-task");
  if (!id) return;
  const r = await api.assignTask(id, session.id);
  if (!r.ok) onError(r.error ?? "could not hand that to the agent");
}
