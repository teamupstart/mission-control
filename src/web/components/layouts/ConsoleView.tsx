import { groupByTone } from "../../lib/tone.ts";
import { ConsoleDetail } from "./ConsoleDetail.tsx";
import { RailRow } from "./RailRow.tsx";
import type { SessionViewProps } from "./types.ts";

/**
 * Split-pane master/detail: a dense rail of every session, one always-open detail
 * beside it.
 *
 * The detail is a bespoke, tabbed reading of the session (see ConsoleDetail) - NOT the
 * grid's card dropped into a column. It's built from the same leaf pieces the card is
 * (transcript, work queue, gate strip, action bar, session-bits), arranged for a pane
 * that has room the card never does: the conversation is permanent, and the sections
 * that share a card's height in the grid get a tab each here.
 *
 * Selection means something stricter here than in the grid: the selected session IS the
 * mounted detail, and only a mounted ActionBar registers the handle the keyboard
 * shortcuts drive. Nothing selected means nothing to send into, so the pane says so
 * rather than silently swallowing a keystroke.
 */
export function ConsoleView(props: SessionViewProps): React.JSX.Element {
  const active = props.sessions.find((s) => s.id === props.selectedId) ?? null;
  const groups = groupByTone(props.sessions, props.gateAlerts).filter((g) => g.sessions.length > 0);

  // The zone only reads on screen once a session is open beside the rail; with an empty
  // pane there is no reader to hand focus to, so it always presents as the rail.
  const zone = active ? props.consoleZone : "rail";

  return (
    <div className="console" data-zone={zone}>
      <nav
        className="console-rail"
        aria-label="Sessions"
        onFocusCapture={() => props.onConsoleZoneChange("rail")}
      >
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
                registerEl={props.registerEl}
                workflowRun={props.workflowRunBySession?.get(s.id) ?? null}
                onOpenWorkflowRun={props.onOpenWorkflowRun}
                onOpenSchedule={props.onOpenSchedule}
                scheduleNameById={props.scheduleNameById}
                onOpenEnsemble={props.onOpenEnsemble}
              />
            ))}
          </div>
        ))}
      </nav>

      <section
        className="console-detail"
        onFocusCapture={() => props.onConsoleZoneChange("detail")}
      >
        {active ? (
          // Keyed by id so switching sessions remounts: the tab resets to the
          // conversation and the transcript starts clean, instead of showing the
          // previous session's Gate tab.
          <ConsoleDetail key={active.id} view={props} session={active} />
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
