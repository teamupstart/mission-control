import { useState } from "react";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import { stateDisplay, type Tone } from "../../lib/format.ts";
import { boardColumnModes, groupByTone } from "../../lib/tone.ts";
import { AssignResetModal } from "../AssignResetModal.tsx";
import { BacklogColumn } from "./BacklogColumn.tsx";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import { SessionTile } from "./SessionTile.tsx";
import type { SessionViewProps } from "./types.ts";
import { ColumnWidthToggle } from "../session-bits.tsx";
import { Tooltip } from "../Tooltip.tsx";

/** A drop waiting on the operator's yes: which task, onto which agent, and what it costs. */
interface PendingDrop {
  taskId: string;
  sessionId: string;
  confirm: AssignResetConfirm;
}

/**
 * Kanban by state that drills into the console.
 *
 * With nothing open the board is a column per tone: the ranking the grid spends on
 * an invisible sort becomes structure you can read - "how many need me" is answered
 * by a column's height instead of eight badges. In front of them sits the backlog,
 * so the work waiting to start is on the same screen as the agents free to start it.
 *
 * EMPTY COLUMNS. A column with nothing in it is not always the same kind of nothing,
 * so they aren't treated the same:
 *
 *  - "needs you" empty is the single most valuable sentence this screen can say, and
 *    it says it best out loud. It keeps its column and renders an explicit all-clear
 *    rather than a gap you have to notice the absence of. It does NOT keep an equal
 *    share of the width, though: 250px says "all clear" exactly as well as 700px
 *    does, and the columns holding actual sessions get the difference.
 *  - every other empty column is noise - four headed boxes reading "nothing here" is
 *    a board reporting on its own schema instead of your fleet. They leave, and the
 *    remaining columns expand into the space. A rail on the right keeps them one
 *    click from coming back, so an empty column is stowed rather than lost.
 *
 * Opening a tile doesn't slide a cramped drawer over the board; it morphs the board
 * INTO the console. The clicked column collapses everything either side of it, slides
 * to the left edge and becomes a console rail of exactly that column's sessions, and
 * the ConsoleDetail - the same tabbed conversation the console layout opens, with its
 * pinned reply box - grows into the freed space. The whole move is one animated flex
 * track (see styles.css), so it reverses for free: Escape, or the rail's back button,
 * returns you to the board you left with nothing reflowed.
 *
 * The board stays your chosen layout - this is a drill-in, not a layout switch. So the
 * overview is never lost: you use the board as the board, and the console as the desk.
 */
export function BoardView(props: SessionViewProps): React.JSX.Element {
  // Empty columns the operator pulled back out of the stash. Deliberately local and
  // un-persisted: it's a "let me look at that for a second", not a setting, and it
  // should not still be in force tomorrow morning.
  const [revealed, setRevealed] = useState<ReadonlySet<Tone>>(() => new Set());
  // A refused drop (agent went busy, wrong repo, pane locked). Shown on the board
  // rather than swallowed, because the card silently staying in the backlog looks
  // identical to a drag that simply missed.
  const [dropError, setDropError] = useState<string | null>(null);
  // A drop the daemon refused pending a yes: the handover would reset an agent that is
  // holding a work queue or a branch. Held here rather than on the tile because the
  // dialog outlives the drag - the tile it came from can re-render (or move column)
  // while the operator is reading it.
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  // The repo of the backlog card currently in the air. Drives which tiles light up as
  // targets, so it has to be state - a tile decides whether it may accept during a
  // render, and nothing about a native drag re-renders the board on its own.
  const [draggingRepo, setDraggingRepo] = useState<string | null>(null);
  // The column the operator widened to read, by id ("backlog" or a tone). ONE at a
  // time: widening is "let me look at that properly", and a board with three wide
  // columns is not a wider column, it is a board you have to scroll to use. Local and
  // un-persisted for the same reason `revealed` above is - it is a gesture, not a
  // setting, and it should not still be in force tomorrow morning.
  const [wideCol, setWideCol] = useState<string | null>(null);
  const toggleWide = (id: string): void => setWideCol((prev) => (prev === id ? null : id));

  const groups = groupByTone(props.sessions, props.gateAlerts);
  // The dialog's target, resolved fresh every render: `null` here retires a confirm whose
  // agent has since disappeared, rather than leaving a dialog up over a session that is
  // no longer on the board.
  const pendingTarget = pendingDrop
    ? (() => {
        const session = props.sessions.find((s) => s.id === pendingDrop.sessionId);
        if (!session) return null;
        const task = props.tasks.find((t) => t.id === pendingDrop.taskId);
        return { ...pendingDrop, session, title: task?.title ?? null };
      })()
    : null;
  const selected = props.sessions.find((s) => s.id === props.expandedId) ?? null;
  // The focused column follows the session, not the click: if the open session moves
  // tone (working -> needs input), its column re-scopes with it, and the rail's rows
  // change under a detail that - keyed by id in the aside - stays put.
  const focusedTone = selected
    ? stateDisplay(selected, props.gateAlerts.has(selected.id)).tone
    : null;

  const modes = boardColumnModes(groups, revealed, focusedTone != null);
  const stashed = groups.filter((g) => modes.get(g.tone) === "stashed");

  return (
    <main
      className="board"
      data-focus={focusedTone ?? "none"}
      data-dragging={draggingRepo != null ? "task" : undefined}
    >
      <BacklogColumn
        wide={wideCol === "backlog"}
        onToggleWide={() => toggleWide("backlog")}
        tasks={props.backlog}
        // The FULL task list as well as the backlog slice: a dependency very often
        // points at a task that has already left the backlog (it is running, or done),
        // and a column that could only see the backlog would report those as
        // unsatisfied forever.
        allTasks={props.tasks}
        plan={props.backlogPlan}
        onAssignError={setDropError}
        onDragging={setDraggingRepo}
        onEdit={props.onEditTask}
        onOpenSchedule={props.onOpenSchedule}
        scheduleNameById={props.scheduleNameById}
      />

      {groups
        .filter((g) => modes.get(g.tone) !== "stashed")
        .map((g) => {
          const isRail = focusedTone === g.tone;
          const calm = modes.get(g.tone) === "calm";
          const wide = wideCol === g.tone;
          return (
            <section
              key={g.tone}
              className={`board-col tone-${g.tone}${isRail ? " is-rail" : ""}${calm ? " is-calm" : ""}${
                wide ? " is-wide" : ""
              }`}
              inert={focusedTone != null && !isRail}
            >
              {/* Double-click the head to widen, the gesture asked for. On the HEAD
                  rather than on the title alone: the head is the column's handle, the
                  title is a word inside it, and a 40px target is not one. It sits
                  beside the toggle rather than instead of it - the same reveal the
                  `×` restash uses, so neither gesture is the only way in.

                  Not while this column IS the drill-in rail: the rail is a fixed-width
                  console fixture, so the gesture would record a width nothing draws and
                  then surprise you with it on the way back to the board. */}
              <header
                className="board-col-head"
                onDoubleClick={isRail ? undefined : () => toggleWide(g.tone)}
              >
                {isRail && (
                  <Tooltip label="Back to the board (Esc)">
                    <button
                      className="board-back"
                      aria-label="Back to the board"
                      onClick={props.onDeselect}
                    >
                      ‹
                    </button>
                  </Tooltip>
                )}
                <span className="board-swatch" aria-hidden />
                <h2>{g.label}</h2>
                {/* BEFORE the count, not after it. The count carries `margin-left: auto`
                    and sat flush against the head's right edge; a control placed after it
                    reserves its 22px even while transparent, so every column's count
                    quietly moved inboard to hold a gap for a button nobody had hovered.
                    Here it lands in the dead space the head already had.

                    Not while drilled in: the rail is a fixed-width console fixture, and
                    a widen control there would offer to move something that cannot. */}
                {!isRail && (
                  <ColumnWidthToggle
                    wide={wide}
                    label={g.label}
                    onToggle={() => toggleWide(g.tone)}
                  />
                )}
                <span className="board-col-n">{g.sessions.length}</span>
                {/* A revealed column can be put back where it came from. Only offered
                    on empty ones - a column with sessions in it is not stashable. */}
                {modes.get(g.tone) === "revealed" && revealed.has(g.tone) && (
                  <Tooltip label={`Hide the empty ${g.label} column again`}>
                  <button
                    className="board-restash"
                    aria-label={`Hide the empty ${g.label} column`}
                    onClick={() =>
                      setRevealed((prev) => {
                        const next = new Set(prev);
                        next.delete(g.tone);
                        return next;
                      })
                    }
                  >
                    ×
                  </button>
                  </Tooltip>
                )}
              </header>
              <div className="board-col-body">
                {calm ? (
                  <p className="board-allclear">
                    <span className="board-allclear-tick" aria-hidden>
                      ✓
                    </span>
                    <b>All clear</b>
                    <span>Nothing is waiting on you</span>
                  </p>
                ) : g.sessions.length === 0 ? (
                  <p className="board-col-empty">Nothing here</p>
                ) : isRail ? (
                  // The clicked column, now a console rail: the same RailRow the console
                  // uses, so opening a column and switching to the console read alike.
                  g.sessions.map((s) => (
                    <RailRow
                      key={s.id}
                      session={s}
                      selected={s.id === props.selectedId}
                      gateNeedsYou={props.gateAlerts.has(s.id)}
                      onSelect={() => props.onSelect(s.id)}
                      // Register the element like the console rail does, so Shift+Tab/Escape
                      // out of the reader can land focus back on the selected row here.
                      registerEl={props.registerEl}
                      workflowRun={props.workflowRunBySession?.get(s.id) ?? null}
                      onOpenWorkflowRun={props.onOpenWorkflowRun}
                      onOpenSchedule={props.onOpenSchedule}
                      scheduleNameById={props.scheduleNameById}
                    />
                  ))
                ) : (
                  g.sessions.map((s) => (
                    <SessionTile
                      key={s.id}
                      session={s}
                      selected={s.id === props.selectedId}
                      gateNeedsYou={props.gateAlerts.has(s.id)}
                      onOpen={() => props.onSelect(s.id)}
                      registerEl={props.registerEl}
                      draggingRepo={draggingRepo}
                      onDropped={() => setDraggingRepo(null)}
                      onDropError={setDropError}
                      onDropConfirm={(p) => setPendingDrop({ ...p, sessionId: s.id })}
                      workflowRun={props.workflowRunBySession?.get(s.id) ?? null}
                      onOpenWorkflowRun={props.onOpenWorkflowRun}
                      onOpenSchedule={props.onOpenSchedule}
                      scheduleNameById={props.scheduleNameById}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}

      {stashed.length > 0 && (
        <div className="board-stash">
          <span className="board-stash-label">empty</span>
          {stashed.map((g) => (
            <Tooltip key={g.tone} label={`Show the empty ${g.label} column`}>
              <button
                className={`board-stash-chip tone-${g.tone}`}
                onClick={() => setRevealed((prev) => new Set(prev).add(g.tone))}
              >
                <span className="board-swatch" aria-hidden />
                {g.label}
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      {dropError && (
        <p className="board-drop-error" role="status">
          {dropError}
          <Tooltip label="Dismiss this message">
            <button onClick={() => setDropError(null)} aria-label="Dismiss">
              ×
            </button>
          </Tooltip>
        </p>
      )}

      {/* Reconciled against the live lists rather than trusted: a session that went away
          (or a task that left the backlog) while the dialog was open would otherwise be
          confirmed against something that no longer exists. */}
      {pendingTarget && (
        <AssignResetModal
          session={pendingTarget.session}
          taskId={pendingTarget.taskId}
          taskTitle={pendingTarget.title}
          confirm={pendingTarget.confirm}
          onClose={() => setPendingDrop(null)}
        />
      )}

      {/* A flex track that's collapsed to nothing until a session is open, then grows to
          fill the board. Kept in the tree across the morph so both directions animate;
          the ConsoleDetail inside mounts only when there's a session to read, and is
          clipped while the track is closed. Keyed by id so switching sessions remounts,
          exactly as the console does. */}
      <aside className="board-detail" aria-hidden={selected == null}>
        {selected && <ConsoleDetail key={selected.id} view={props} session={selected} />}
      </aside>
    </main>
  );
}
