import { useEffect, useRef } from "react";
import type { Session } from "@shared/types.ts";
import { SessionCard } from "../SessionCard.tsx";
import { relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { groupByTone } from "../../lib/tone.ts";
import { cardProps, type SessionViewProps } from "./types.ts";

/**
 * Split-pane master/detail: a dense rail of every session, one always-open detail
 * beside it.
 *
 * The detail is a real SessionCard with `expanded` forced on - the same component
 * the grid renders, not a reimplementation of it. That is the whole reason this
 * layout is cheap: every chip, strip, gate button and action bar arrives for free
 * and can never drift from the grid's version of them.
 *
 * Consequently selection means something stricter here than in the grid: the
 * selected session IS the mounted card, and only a mounted card registers the
 * ActionBar handle the keyboard shortcuts drive. Nothing selected means nothing to
 * send into, so the pane says so rather than silently swallowing a keystroke.
 */
export function ConsoleView(props: SessionViewProps): React.JSX.Element {
  const active = props.sessions.find((s) => s.id === props.selectedId) ?? null;
  const groups = groupByTone(props.sessions).filter((g) => g.sessions.length > 0);

  return (
    <div className="console">
      <nav className="console-rail" aria-label="Sessions">
        {groups.map((g) => (
          <div key={g.tone}>
            <div className={`rail-group tone-${g.tone}`}>
              {g.label}
              <span className="rail-group-n">{g.sessions.length}</span>
            </div>
            {g.sessions.map((s) => (
              <RailRow
                key={s.id}
                session={s}
                selected={s.id === props.selectedId}
                gateNeedsYou={props.gateAlerts.has(s.id)}
                onSelect={() => props.onSelect(s.id)}
              />
            ))}
          </div>
        ))}
      </nav>

      <section className="console-detail">
        {active ? (
          // `selected` is deliberately off: the ring exists to tell one card apart from
          // eleven others in a grid. There is only ever one card here, and the rail
          // already shows which session it is. `expanded` isn't forced either - App
          // holds expandedId at the selection in this layout, so the card works it out.
          <SessionCard {...cardProps(props, active)} selected={false} canExpand={false} />
        ) : (
          <div className="console-empty">
            <p className="empty-title">No session selected</p>
            <p className="empty-sub">
              Pick one from the list, or press an arrow key. Its conversation, work queue and
              controls open here.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One line in the rail: enough to choose by, and nothing more. The goal is the
 * subtitle rather than the path, because the goal is what tells two worktrees of
 * the same repo apart.
 */
function RailRow({
  session,
  selected,
  gateNeedsYou,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  gateNeedsYou: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  const ref = useRef<HTMLButtonElement>(null);

  // Keep the selected row in view as the arrow keys walk the rail. Local to the row
  // because the rail scrolls independently of the detail beside it - App's map holds
  // the card element, which in this layout is the pane, not the row.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const marks: string[] = [];
  if (session.nomistakesGated) marks.push("◇");
  if (gateNeedsYou) marks.push("▮");
  if (session.note) marks.push("◆");
  if (session.queue && session.queue.openCount > 0) marks.push(`≡${session.queue.openCount}`);

  return (
    <button
      ref={ref}
      className={`rail-row tone-${st.tone}${selected ? " selected" : ""}`}
      aria-current={selected}
      onClick={onSelect}
    >
      <span className={`agent-dot agent-${session.agent}`} aria-hidden />
      <span className="rail-name">{session.name || "(unnamed)"}</span>
      <span className="rail-sub">{session.goal?.text ?? session.activity ?? ""}</span>
      {/* Two lines, never four: the state, then everything else on one line. Given a
          line each, the marks and the PR chip made a row as tall as three, and a rail
          you can only fit six sessions in has stopped being a rail. */}
      <span className="rail-right">
        <span className="rail-state">{st.label}</span>
        <span className="rail-meta">
          {marks.length > 0 && <span className="rail-marks">{marks.join(" ")}</span>}
          {session.prNumber && (
            <span className={`rail-pr pr-${session.prState ?? "open"}`}>#{session.prNumber}</span>
          )}
          <span className="rail-seen">
            {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}
