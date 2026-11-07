import { residentProfileChoiceName, type ResidentProfile } from "@shared/residents.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { residentProfileMark } from "./marker.ts";
import type { ResidentLaunchState } from "./useResidentLaunches.ts";

/**
 * The live profiles with a Launch each, and what each launch is doing. One list for the
 * Residents dock and the Residents drawer's footer, drawn from the one launch state App owns,
 * so the two surfaces cannot come to describe the same launch differently.
 */
export function ResidentProfileLaunchList({ profiles, launches, onLaunch }: {
  profiles: readonly ResidentProfile[];
  launches: Readonly<Record<string, ResidentLaunchState>>;
  onLaunch: (profile: ResidentProfile) => void;
}): React.JSX.Element {
  return (
    <ul className="residents-pop-list residents-pop-profiles">
      {profiles.map((profile) => {
        const state = launches[profile.id];
        const mark = residentProfileMark(profile);
        const repo = profile.settings.workspace.defaultRepoRoot;
        return (
          <li key={profile.id} className="residents-pop-row">
            <ResidentChip mark={mark} />
            <span className="residents-pop-name">
              <span className="residents-pop-name-text">{profile.name}</span>
              {profile.builtin && <em className="resident-builtin-tag">built-in</em>}
            </span>
            <span className="residents-pop-state" role="status">
              {state?.busy
                ? "starting…"
                : state?.stillStarting ? "still starting" : state?.launched ? "launched" : ""}
            </span>
            <Tooltip
              label={state?.outstanding
                ? `Check on the launch of ${profile.name} in ${state.outstanding.repoRoot}`
                : repo
                  ? `Launch ${profile.name} in ${repo}`
                  : `Choose a repository for ${profile.name} in Dispatch`}
            >
              <button
                type="button"
                className="btn residents-pop-action"
                aria-label={`Launch ${residentProfileChoiceName(profile)}`}
                disabled={state?.busy}
                onClick={() => onLaunch(profile)}
              >
                {repo || state?.outstanding ? "Launch" : "Launch…"}
              </button>
            </Tooltip>
            {/* Its own line across the row, not the state cell: a reason is a
                sentence, and an ellipsized one says nothing. */}
            {state?.error && (
              <p className="residents-pop-error" role="alert">{state.error}</p>
            )}
            {state?.stillStarting && (
              <p className="residents-pop-note">
                Taking longer than usual to start. Launch checks on this same launch; it
                never starts a second resident.
              </p>
            )}
            {state?.controlReport === "not-granted" && (
              <p className="residents-pop-note" role="status">
                Started without session control: only a Launch click in the Mission
                Control desktop app grants it.
              </p>
            )}
            {state?.controlReport === "pending" && (
              <p className="residents-pop-note" role="status">
                Started; session control is not granted yet. It is given once the
                session is ready, and its live card shows Control when it is.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
