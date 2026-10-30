import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { residentAccentStyle, residentMarkTitle, type ResidentSessionMark } from "./marker.ts";

/**
 * The Console header's resident band: which resident this session is, which Persona it plays,
 * and the revision it launched from - with a note when the profile has moved on since, because
 * nothing the run does follows that edit until it is launched again.
 *
 * Every fact here is the run's pinned revision. The loop's state and its Pause, Resume and Run
 * now controls join this band in a later phase; it is laid out as a row with a trailing action
 * cluster so they arrive without moving what is already here.
 */
export function ResidentBand({
  mark,
  onOpenProfile,
}: {
  mark: ResidentSessionMark;
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
      <span className="resident-band-spacer" />
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
