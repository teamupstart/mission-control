import type { TaskKindHeaderStyle } from "@shared/protocol.ts";
import { sessionWorkspaceRoot } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";

import { detailTabs } from "../lib/detailTabs.ts";
import { shortenCwd } from "../lib/format.ts";
import { AgentDot, GoalLine } from "./session-bits.tsx";
import { kindAccentStyle, TaskKindMark } from "./TaskKindMark.tsx";

/**
 * The Display panel's picture of the console header, for the Conversation header group.
 *
 * Before this the group had no picture at all: its Task type picker and its two band cells
 * were the only controls in Display that changed nothing on screen, so picking `Eyebrow`
 * over `Title badge` was a promise the operator could only check by leaving Settings.
 *
 * `ConsoleDetail` cannot be mounted here the way `SessionTile` is beside the card group: it
 * owns a live session's tabs, Foreman drawer, transcript and keyboard registration, and none
 * of that has a fixture. So this draws the header's three rows in the console's OWN classes
 * (`detail-head`, `detail-sub`, `detail-tabs`) and places the REAL `TaskKindMark` exactly
 * where `ConsoleDetail` places each style - the same arrangement `WorkingIndicatorPreview`
 * uses for the conversation log. The placement is what this preview exists to show, and
 * `test/task-kind-mark.test.ts` pins it against the console's own.
 */
export function ConversationHeaderPreview({
  session,
  kindStyle,
  showPath,
  showBranch,
}: {
  session: Session;
  kindStyle: TaskKindHeaderStyle;
  showPath: boolean;
  showBranch: boolean;
}): React.JSX.Element {
  // The same rule as the console: a session with no task, or the style set to `off`, draws
  // no mark anywhere.
  const kind = session.task?.kind;
  const mark = kind && kindStyle !== "off" ? kindStyle : null;
  const branch = session.workspace?.branch ?? session.gitBranch;
  const tabs = detailTabs({ queueCount: 0, fileReplyCount: 0 });
  return (
    <div className="conversation-header-preview">
      <header
        className={`detail-head${mark === "tile" ? " tk-edge" : ""}`}
        style={mark === "tile" ? kindAccentStyle(kind!) : undefined}
      >
        {mark === "tile" ? (
          <TaskKindMark kind={kind!} variant="tile">
            <AgentDot agent={session.agent} />
          </TaskKindMark>
        ) : (
          <AgentDot agent={session.agent} />
        )}
        <div className="detail-title">
          {mark === "eyebrow" && <TaskKindMark kind={kind!} variant="eyebrow" />}
          <div className="detail-title-line">
            {mark === "badge" && <TaskKindMark kind={kind!} variant="badge" />}
            <h2>{session.name}</h2>
          </div>
          <GoalLine session={session} />
        </div>
      </header>

      {/* Dropped whole when both cells are off, as the console drops it: the preview's task
          is named after its session, so there is no task chip to keep the band open. */}
      {(showPath || (showBranch && branch)) && (
        <dl className="detail-sub">
          {showPath && (
            <div className="kv">
              <dt>path</dt>
              <dd className="mono">{shortenCwd(sessionWorkspaceRoot(session))}</dd>
            </div>
          )}
          {showBranch && branch && (
            <div className="kv">
              <dt>branch</dt>
              <dd className="mono branch">{branch}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Spans rather than the console's buttons: the stage is `inert`, and a row of tabs
          that announce themselves as tabs would be a tablist that switches nothing. */}
      <div className="detail-tabs">
        {mark === "tabs" && <TaskKindMark kind={kind!} variant="tabs" />}
        {tabs.map((t) => (
          <span key={t.id} className={`detail-tab${t.id === "conversation" ? " on" : ""}`}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
