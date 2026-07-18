import type { Session } from "@shared/types.ts";
import { contextTone, relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { groupByTone } from "../../lib/tone.ts";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import type { SessionViewProps } from "./types.ts";

/**
 * Kanban by state that drills into the console.
 *
 * With nothing open the board is a column per tone: the ranking the grid spends on
 * an invisible sort becomes structure you can read - "how many need me" is answered
 * by a column's height instead of eight badges.
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
  const groups = groupByTone(props.sessions);
  const selected = props.sessions.find((s) => s.id === props.selectedId) ?? null;
  // The focused column follows the session, not the click: if the open session moves
  // tone (working -> needs input), its column re-scopes with it, and the rail's rows
  // change under a detail that - keyed by id in the aside - stays put.
  const focusedTone = selected ? stateDisplay(selected).tone : null;

  return (
    <main className="board" data-focus={focusedTone ?? "none"}>
      {groups.map((g) => {
        const isRail = focusedTone === g.tone;
        return (
          <section
            key={g.tone}
            className={`board-col tone-${g.tone}${isRail ? " is-rail" : ""}`}
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
            </header>
            <div className="board-col-body">
              {g.sessions.length === 0 ? (
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
                  />
                ))
              )}
            </div>
          </section>
        );
      })}

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

/**
 * A session shrunk to what you'd triage by: who it is, what it's for, how far its
 * gate has got, and whether it wants something. Everything else is one click away
 * in the console detail the tile opens.
 */
function SessionTile({
  session,
  gateNeedsYou,
  onOpen,
}: {
  session: Session;
  gateNeedsYou: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const ctx = session.meta?.contextPct;

  return (
    <button
      className={`tile tone-${st.tone}${st.tone === "attention" ? " attention" : ""}`}
      onClick={onOpen}
    >
      <span className="tile-head">
        <span className={`agent-dot agent-${session.agent}`} aria-hidden />
        <span className="tile-name">{session.name || "(unnamed)"}</span>
        {session.nomistakesGated && (
          <span className="gated" title="Gated by no-mistakes" aria-hidden>
            ◇
          </span>
        )}
      </span>

      {session.goal?.text && <span className="tile-goal">{session.goal.text}</span>}

      {/* The gate compressed to a hairline the tile can always afford. The full strip,
          with its findings and buttons, is in the console detail. */}
      {session.nomistakes && (
        <span className="tile-rail" aria-hidden>
          {session.nomistakes.steps.map((step) => (
            <span key={step.step} className={`tr-${step.status}`} />
          ))}
        </span>
      )}

      <span className="tile-marks">
        {gateNeedsYou && <span className="tile-flag tf-gate">gate</span>}
        {session.note && (
          <span className={`tile-flag tf-${session.note.disposition}`}>
            {session.note.disposition === "escalated" ? "◆ decision" : "✎ draft"}
          </span>
        )}
        {session.pendingReviews > 0 && <span className="tile-flag tf-review">review</span>}
        {session.queue && session.queue.openCount > 0 && (
          <span className="tile-flag tf-queue">{session.queue.openCount} queued</span>
        )}
        {session.prNumber && (
          <span className={`tile-flag pr-${session.prState ?? "open"}`}>
            #{session.prNumber}
            {session.prChecks === "failing" && " ⚠"}
          </span>
        )}
      </span>

      <span className="tile-foot">
        <span className="tile-branch">{session.gitBranch ?? session.nameSource}</span>
        {ctx != null && (
          <span className={`rt-ctx rt-ctx-${contextTone(ctx)}`} title={`${ctx}% of the context window used`}>
            <span className="rt-meter" aria-hidden>
              <span className="rt-meter-fill" style={{ width: `${Math.min(100, Math.max(0, ctx))}%` }} />
            </span>
          </span>
        )}
        <span className="tile-seen">
          {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
        </span>
      </span>
    </button>
  );
}
