import { useState } from "react";
import type { Session, Task } from "@shared/types.ts";
import { api } from "../../lib/api.ts";
import { relativeTime, stateDisplay } from "../../lib/format.ts";

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
 */
export function BacklogColumn({
  tasks,
  onAssignError,
  onDragging,
}: {
  tasks: Task[];
  onAssignError: (message: string) => void;
  /** The repo of the card now in the air, or null when nothing is being dragged. */
  onDragging: (repoRoot: string | null) => void;
}): React.JSX.Element {
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
            <BacklogCard key={t.id} task={t} onAssignError={onAssignError} onDragging={onDragging} />
          ))
        )}
      </div>
    </section>
  );
}

function BacklogCard({
  task,
  onAssignError,
  onDragging,
}: {
  task: Task;
  onAssignError: (message: string) => void;
  onDragging: (repoRoot: string | null) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  async function launch(): Promise<void> {
    setBusy(true);
    const r = await api.dispatchBacklog(task.id);
    if (!r.ok) onAssignError(r.error ?? "could not dispatch");
    setBusy(false);
  }

  return (
    <article
      className={`bl-card${busy ? " is-busy" : ""}`}
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
      title={task.intent}
    >
      <span className="bl-title">{task.title}</span>
      <span className="bl-foot">
        <span className={`bl-kind bl-kind-${task.kind}`}>{task.kind}</span>
        <span className="bl-agent">{task.agent}</span>
        <span className="bl-added">{relativeTime(task.createdAt)}</span>
      </span>
      <button className="bl-launch" onClick={launch} disabled={busy} title="Dispatch into a fresh worktree">
        {busy ? "dispatching…" : "launch new agent"}
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
