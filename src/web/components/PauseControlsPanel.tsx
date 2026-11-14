import { useMemo } from "react";
import {
  PAUSE_CARD_CONTROLS,
  PAUSE_CONSOLE_CONTROLS,
  type PauseCardControl,
  type PauseConsoleControl,
} from "@shared/pause.ts";
import type { Session } from "@shared/types.ts";
import { previewSession } from "../lib/board-card-preview.ts";
import {
  PAUSE_CARD_CONTROL_COPY,
  PAUSE_CONSOLE_CONTROL_COPY,
  PauseControlsPreview,
  setPauseCardControl,
  setPauseConsoleControl,
} from "../lib/pause-controls.ts";
import { useUiConfig } from "../lib/uiConfig.ts";
import { AgentDot, StateBadge } from "./session-bits.tsx";
import { SessionTile } from "./layouts/SessionTile.tsx";
import {
  BadgePauseHalf,
  ComposerPauseButton,
  ComposerPausedBand,
  PausedBand,
  PauseToolbarButton,
} from "./PauseControls.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Settings > Display > Pause controls: which pause controls the board card and the console
 * draw, any number of each, each with a live preview of that control alone.
 *
 * Every preview pins its own control through `PauseControlsPreview`, so it shows the option
 * whatever is stored; the checkbox beside it is what the board and the console obey. Card
 * previews mount the real `SessionTile`; console previews draw the console's own classes
 * around the real controls, for the reason `ConversationHeaderPreview` gives - the live
 * console has no fixture to mount against. Every stage is `inert`: the session behind it does
 * not exist, so nothing inside may be pressed.
 */

/** The preview session: running, and a twin frozen mid-turn for the controls that only show then. */
function usePreviewSessions(): { running: Session; paused: Session } {
  return useMemo(() => {
    const now = Date.now();
    const running = { ...previewSession(now), blocker: null } as Session;
    const paused: Session = {
      ...running,
      pause: { reason: "operator", phase: "frozen", since: now - 14 * 60_000, interrupted: running.activity ?? null, stopped: true },
    };
    return { running, paused };
  }, []);
}

function CardPreview({ control, session }: { control: PauseCardControl; session: Session }): React.JSX.Element {
  return (
    <PauseControlsPreview.Provider value={{ card: [control], console: [] }}>
      <div className={`pause-card-preview is-${control}`}>
        <SessionTile
          session={session}
          onOpen={() => {}}
          draggingRepo={null}
          onDropped={() => {}}
          onDropError={() => {}}
          onDropConfirm={() => {}}
        />
      </div>
    </PauseControlsPreview.Provider>
  );
}

function ConsolePreview({ control, session }: { control: PauseConsoleControl; session: Session }): React.JSX.Element {
  return (
    <PauseControlsPreview.Provider value={{ card: [], console: [control] }}>
      <div className="pause-console-preview cdetail">
        <header className="detail-head">
          <AgentDot agent={session.agent} />
          <div className="detail-title">
            <div className="detail-title-line">
              <h2 className="pause-preview-title">{session.name}</h2>
            </div>
          </div>
          {control === "badge" ? (
            <span className="badge-split">
              <StateBadge session={session} />
              <BadgePauseHalf session={session} />
            </span>
          ) : (
            <StateBadge session={session} />
          )}
        </header>
        {control === "badge" && <PausedBand session={session} />}
        <div className="detail-tabs" role="presentation">
          <span className="detail-tab on">Conversation</span>
          <span className="detail-tab">Diff</span>
          <span className="detail-tab">Files</span>
          <span className="pause-preview-spacer" />
          {control === "toolbar" && <PauseToolbarButton session={session} />}
        </div>
        {control === "composer" && (
          <div className="transcript-compose pause-preview-compose">
            <ComposerPausedBand session={session} />
            <div className="compose-row">
              <textarea className="transcript-input" readOnly rows={1} aria-label="Reply preview" placeholder="Message the agent…" />
              <ComposerPauseButton session={session} />
              <span className={`btn btn-send${session.pause ? " is-queue" : ""}`}>{session.pause ? "Queue" : "Send"}</span>
            </div>
          </div>
        )}
      </div>
    </PauseControlsPreview.Provider>
  );
}

export function PauseControlsPanel(): React.JSX.Element {
  const config = useUiConfig();
  const { running, paused } = usePreviewSessions();
  return (
    <section className="settings-section" data-anchor="display/pause-controls">
      <div className="settings-section-head">
        <h3>Pause controls</h3>
      </div>
      <p className="settings-hint settings-blurb">
        Where you pause and resume a session. Turn on as many as you like, or none - Pause all in the title bar
        works either way, and a paused session looks paused whichever are on.
      </p>

      <h4 className="settings-subhead">Board card</h4>
      <div className="pause-controls-options" role="group" aria-label="Board card pause controls">
        {PAUSE_CARD_CONTROLS.map((id) => {
          const copy = PAUSE_CARD_CONTROL_COPY[id];
          const on = config.pauseCardControls.includes(id);
          return (
            <div key={id} className={`pause-control-option${on ? " is-on" : ""}`}>
              <label className={`settings-toggle${on ? " is-on" : ""}`}>
                <Tooltip label={on ? `Stop drawing the ${copy.label.toLowerCase()} on cards` : `Draw the ${copy.label.toLowerCase()} on cards`}>
                  <input
                    type="checkbox"
                    aria-label={`Card: ${copy.label}`}
                    checked={on}
                    onChange={(e) => setPauseCardControl(config.pauseCardControls, id, e.target.checked)}
                  />
                </Tooltip>
                <span className="settings-toggle-text">
                  <span className="settings-toggle-label">{copy.label}</span>
                  <span className="settings-toggle-desc">{copy.description}</span>
                </span>
              </label>
              <div className="pause-control-preview" role="group" aria-label={`Preview: card ${copy.label.toLowerCase()}`}>
                <span className="board-card-preview-cap" aria-hidden>
                  Preview
                </span>
                <div className="pause-control-stage" inert>
                  <CardPreview control={id} session={running} />
                  <CardPreview control={id} session={paused} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <h4 className="settings-subhead">Console</h4>
      <div className="pause-controls-options" role="group" aria-label="Console pause controls">
        {PAUSE_CONSOLE_CONTROLS.map((id) => {
          const copy = PAUSE_CONSOLE_CONTROL_COPY[id];
          const on = config.pauseConsoleControls.includes(id);
          return (
            <div key={id} className={`pause-control-option${on ? " is-on" : ""}`}>
              <label className={`settings-toggle${on ? " is-on" : ""}`}>
                <Tooltip label={on ? `Stop drawing the ${copy.label.toLowerCase()} in the console` : `Draw the ${copy.label.toLowerCase()} in the console`}>
                  <input
                    type="checkbox"
                    aria-label={`Console: ${copy.label}`}
                    checked={on}
                    onChange={(e) => setPauseConsoleControl(config.pauseConsoleControls, id, e.target.checked)}
                  />
                </Tooltip>
                <span className="settings-toggle-text">
                  <span className="settings-toggle-label">{copy.label}</span>
                  <span className="settings-toggle-desc">{copy.description}</span>
                </span>
              </label>
              <div className="pause-control-preview" role="group" aria-label={`Preview: console ${copy.label.toLowerCase()}`}>
                <span className="board-card-preview-cap" aria-hidden>
                  Preview
                </span>
                <div className="pause-control-stage is-console" inert>
                  <ConsolePreview control={id} session={running} />
                  <ConsolePreview control={id} session={paused} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
