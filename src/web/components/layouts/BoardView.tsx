import { useState } from "react";
import type { Session } from "@shared/types.ts";
import { backlogTasks } from "@shared/session.ts";
import { stateDisplay, type Tone } from "../../lib/format.ts";
import { boardColumnModes, groupByTone } from "../../lib/tone.ts";
import { BacklogColumn } from "./BacklogColumn.tsx";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import { SessionTile } from "./SessionTile.tsx";
import type { SessionViewProps } from "./types.ts";

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
  // The repo of the backlog card currently in the air. Drives which tiles light up as
  // targets, so it has to be state - a tile decides whether it may accept during a
  // render, and nothing about a native drag re-renders the board on its own.
  const [draggingRepo, setDraggingRepo] = useState<string | null>(null);

  const groups = groupByTone(props.sessions);
  const backlog = backlogTasks(props.tasks);
  const selected = props.sessions.find((s) => s.id === props.selectedId) ?? null;
  // The focused column follows the session, not the click: if the open session moves
  // tone (working -> needs input), its column re-scopes with it, and the rail's rows
  // change under a detail that - keyed by id in the aside - stays put.
  const focusedTone = selected ? stateDisplay(selected).tone : null;

  const modes = boardColumnModes(groups, revealed, focusedTone != null);
  const stashed = groups.filter((g) => modes.get(g.tone) === "stashed");

  return (
    <main
      className="board"
      data-focus={focusedTone ?? "none"}
      data-dragging={draggingRepo != null ? "task" : undefined}
    >
      <BacklogColumn tasks={backlog} onAssignError={setDropError} onDragging={setDraggingRepo} />

      {groups
        .filter((g) => modes.get(g.tone) !== "stashed")
        .map((g) => {
          const isRail = focusedTone === g.tone;
          const calm = modes.get(g.tone) === "calm";
          return (
            <section
              key={g.tone}
              className={`board-col tone-${g.tone}${isRail ? " is-rail" : ""}${calm ? " is-calm" : ""}`}
              inert={focusedTone != null && !isRail}
            >
              <header className="board-col-head">
                {isRail && (
                  <button
                    className="board-back"
                    aria-label="Back to the board"
                    title="Back to the board (Esc)"
                    onClick={props.onDeselect}
                  >
                    ‹
                  </button>
                )}
                <span className="board-swatch" aria-hidden />
                <h2>{g.label}</h2>
                <span className="board-col-n">{g.sessions.length}</span>
                {/* A revealed column can be put back where it came from. Only offered
                    on empty ones - a column with sessions in it is not stashable. */}
                {modes.get(g.tone) === "revealed" && revealed.has(g.tone) && (
                  <button
                    className="board-restash"
                    aria-label={`Hide the empty ${g.label} column`}
                    title="Hide again"
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
                    />
                  ))
                ) : (
                  g.sessions.map((s) => (
                    <SessionTile
                      key={s.id}
                      session={s}
                      gateNeedsYou={props.gateAlerts.has(s.id)}
                      onOpen={() => props.onSelect(s.id)}
                      draggingRepo={draggingRepo}
                      onDropped={() => setDraggingRepo(null)}
                      onDropError={setDropError}
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
            <button
              key={g.tone}
              className={`board-stash-chip tone-${g.tone}`}
              title={`Show the empty ${g.label} column`}
              onClick={() => setRevealed((prev) => new Set(prev).add(g.tone))}
            >
              <span className="board-swatch" aria-hidden />
              {g.label}
            </button>
          ))}
        </div>
      )}

      {dropError && (
        <p className="board-drop-error" role="status">
          {dropError}
          <button onClick={() => setDropError(null)} aria-label="Dismiss">
            ×
          </button>
        </p>
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
