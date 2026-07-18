import { useEffect, useRef } from "react";
import type { Session } from "@shared/types.ts";
import { SessionCard } from "../SessionCard.tsx";
import { contextTone, relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { groupByTone } from "../../lib/tone.ts";
import { cardProps, type SessionViewProps } from "./types.ts";

/**
 * Kanban by state: a column per tone, the detail in a slide-over drawer.
 *
 * The ranking the grid spends on an invisible sort becomes the structure - "how
 * many need me" is answered by a column's height instead of by reading eight
 * badges. Tiles carry only what you'd triage by; the drawer carries the same
 * SessionCard the grid renders, so nothing is lost by shrinking the tile.
 *
 * The drawer opens over the board rather than in it: expanding a card in place is
 * what makes the grid reflow around you, and a board whose columns jump when you
 * open something would give up the one thing it's for.
 */
export function BoardView(props: SessionViewProps): React.JSX.Element {
  const groups = groupByTone(props.sessions);
  const open = props.sessions.find((s) => s.id === props.selectedId) ?? null;

  return (
    <>
      <main className="board">
        {groups.map((g) => (
          <section key={g.tone} className={`board-col tone-${g.tone}`}>
            <header className="board-col-head">
              <span className="board-swatch" aria-hidden />
              <h2>{g.label}</h2>
              <span className="board-col-n">{g.sessions.length}</span>
            </header>
            <div className="board-col-body">
              {g.sessions.length === 0 ? (
                <p className="board-col-empty">Nothing here</p>
              ) : (
                g.sessions.map((s) => (
                  <SessionTile
                    key={s.id}
                    session={s}
                    open={s.id === props.selectedId}
                    gateNeedsYou={props.gateAlerts.has(s.id)}
                    onOpen={() => props.onSelect(s.id)}
                  />
                ))
              )}
            </div>
          </section>
        ))}
      </main>

      {open && (
        <>
          <div className="board-scrim" onClick={props.onDeselect} />
          <aside className="board-drawer" aria-label={`${open.name} detail`}>
            <div className="board-drawer-head">
              <span className="board-drawer-title">{open.name || "(unnamed)"}</span>
              <button className="icon-btn" aria-label="Close detail" onClick={props.onDeselect}>
                ✕
              </button>
            </div>
            <div className="board-drawer-body">
              <SessionCard {...cardProps(props, open)} selected={false} canExpand={false} />
            </div>
          </aside>
        </>
      )}
    </>
  );
}

/**
 * A session shrunk to what you'd triage by: who it is, what it's for, how far its
 * gate has got, and whether it wants something. Everything else is one click away
 * in the drawer.
 */
function SessionTile({
  session,
  open,
  gateNeedsYou,
  onOpen,
}: {
  session: Session;
  open: boolean;
  gateNeedsYou: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const ref = useRef<HTMLButtonElement>(null);
  const ctx = session.meta?.contextPct;

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <button
      ref={ref}
      className={`tile tone-${st.tone}${st.tone === "attention" ? " attention" : ""}${open ? " open" : ""}`}
      aria-current={open}
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
          with its findings and buttons, is in the drawer. */}
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
