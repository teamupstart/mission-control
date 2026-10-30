import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import type { Session } from "@shared/types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { ResidentControlStatus } from "./ResidentControlStatus.tsx";
import { residentAccentStyle, residentMarkTitle, type ResidentSessionMark } from "./marker.ts";

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
        {mark.personaName} · revision {mark.revision}
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
