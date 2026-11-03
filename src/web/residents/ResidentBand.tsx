import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import type { Session } from "@shared/types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { ResidentControlStatus } from "./ResidentControlStatus.tsx";
import { residentAccentStyle, residentMarkTitle, type ResidentReplacement, type ResidentSessionMark } from "./marker.ts";

/**
 * The Console header's resident band: which resident this session is, which Persona it plays,
 * and the revision it launched from - with a note when the profile has moved on since, because
 * nothing the run does follows that edit until it is launched again.
 *
 * Every fact here is the run's pinned revision. The loop's state and its Pause, Resume and Run
 * now controls join this band in a later phase; it is laid out as a row with a trailing action
 * cluster so they arrive without moving what is already here.
 *
 * When the pinned revision asks for session control, or the session holds it anyway, the band
 * says whether this conversation has it right now - the Registry's live grant, not the launch -
 * with the existing session control menu beside "control not granted".
 */
export function ResidentBand({
  mark,
  session,
  onOpenProfile,
}: {
  mark: ResidentSessionMark;
  session?: Session;
  onOpenProfile?: (profileId: string) => void;
}): React.JSX.Element {
  return (
    <div
      className="resident-band"
      style={residentAccentStyle(mark.colorId)}
      role="group"
      aria-label={`Resident ${mark.name}`}
    >
      <ResidentChip mark={mark} title={residentMarkTitle(mark)} />
      <span className="resident-band-word">Resident</span>
      <span className="resident-band-name">{mark.name}</span>
      <span className="resident-band-fact">
        {mark.personaName ? `${mark.personaName} · ` : ""}revision {mark.revision}
        {mark.pin ? " · pinned" : ""}
      </span>
      {mark.changedTo !== null && (
        <Tooltip label="This resident keeps running on the revision it launched from. Launch the profile again to use the edit.">
          <span className="resident-band-changed" role="status">
            Profile changed since launch (now revision {mark.changedTo})
          </span>
        </Tooltip>
      )}
      {mark.loop && <ResidentLoopStatusLine loop={mark.loop} />}
      <span className="resident-band-spacer" />
      <ResidentLoopControls mark={mark} />
      {session && (mark.controlOtherSessions || session.sessionControlEnabled === true) && (
        <ResidentControlStatus session={session} name={mark.name} />
      )}
      {onOpenProfile && (
        <Tooltip label={`Open ${mark.name} on the Residents page`}>
          <button type="button" className="btn btn-ghost resident-band-action" onClick={() => onOpenProfile(mark.profileId)}>
            Profile
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** What a replaced session's band says, for each place its replacement can be. */
export function residentReplacementSentence(replacement: ResidentReplacement): string {
  const revision = replacement.revision === null ? "a new profile revision" : `revision ${replacement.revision}`;
  const after = "This session no longer wakes.";
  switch (replacement.state) {
    case "live":
      return `Restarted on ${revision} in a new session. ${after}`;
    case "starting":
      return `Restarting on ${revision} in a new session. ${after}`;
    case "stopped":
      return `Restarted on ${revision}, but that session is no longer running. ${after}`;
    case "not-started":
      return `Restart ended this run, but the new session did not start. ${after}`;
  }
}

/**
 * The band a replaced resident session wears after Restart on new profile. Its run has ended, so
 * it no longer wakes, but Restart deliberately leaves its task open: the operator may still want
 * to read or finish this conversation, and is offered Complete here rather than having it closed
 * for them - until the task is done, even if the replacement has since ended or never started.
 * Open new session waits, disabled, while the replacement is starting, and stands down once there
 * is no replacement left to open.
 */
export function ResidentReplacedBand({
  replacement,
  onOpenSession,
  onComplete,
}: {
  replacement: ResidentReplacement;
  onOpenSession: (sessionId: string) => void;
  /** Absent when the session can no longer be completed from here. */
  onComplete?: () => void;
}): React.JSX.Element {
  const replacementId = replacement.sessionId;
  return (
    <div
      className="resident-band resident-band-replaced"
      style={replacement.colorId ? residentAccentStyle(replacement.colorId) : undefined}
      role="group"
      aria-label={`Replaced resident ${replacement.name}`}
    >
      <span className="resident-band-word">Resident</span>
      <span className="resident-band-name">{replacement.name}</span>
      <span className="resident-band-replaced-note" role="status">
        {residentReplacementSentence(replacement)}
      </span>
      <span className="resident-band-spacer" />
      {(replacement.state === "live" || replacement.state === "starting") && (
        <Tooltip label={replacementId ? `Open the session now running revision ${replacement.revision}` : "The new session is still starting"}>
          <button
            type="button"
            className="btn btn-ghost resident-band-action"
            disabled={!replacementId}
            onClick={() => replacementId && onOpenSession(replacementId)}
          >
            Open new session
          </button>
        </Tooltip>
      )}
      {onComplete && (
        <Tooltip label="Record an outcome for this replaced session's task and close it">
          <button type="button" className="btn btn-primary resident-band-action" onClick={onComplete}>
            Complete & close
          </button>
        </Tooltip>
      )}
    </div>
  );
}
