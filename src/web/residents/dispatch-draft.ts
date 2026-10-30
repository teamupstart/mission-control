import type { ResidentProfile } from "@shared/residents.ts";

/**
 * What Dispatch's Resident mode holds while it is open: the profile, the repository and this
 * run's instructions, plus the request id that makes its submit idempotent.
 *
 * Owned by `DispatchLayer` beside the Single and Ensemble drafts, so switching mode or closing
 * the form loses none of it.
 */
export interface ResidentDispatchDraft {
  profileId: string | null;
  /** The repository the operator typed or picked. Read only when `repoFromProfile` is false. */
  repoRoot: string;
  /**
   * Whether the repository is the selected profile's default rather than the operator's own
   * choice. A profile-sourced repository is never copied into the draft: it is read from the
   * profile's CURRENT revision every time, so a default edited after the form was prefilled
   * can never launch a resident in the old repository.
   */
  repoFromProfile: boolean;
  instructions: string;
  /**
   * Kept across a retry of an answer that did not arrive, so a second click replays the same
   * launch; replaced after a definitive outcome so the next launch is a new one.
   */
  requestId: string;
}

export function freshResidentDispatchDraft(): ResidentDispatchDraft {
  return {
    profileId: null,
    repoRoot: "",
    repoFromProfile: true,
    instructions: "",
    requestId: crypto.randomUUID(),
  };
}

/** The repository this draft would launch in, against the profile as it is now. */
export function residentDispatchRepo(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): string {
  return draft.repoFromProfile
    ? profile?.settings.workspace.defaultRepoRoot ?? ""
    : draft.repoRoot;
}

/**
 * Select a profile. A repository the operator chose is kept; otherwise the draft follows the
 * new profile's default. An operator choice left empty hands the repository back to the profile.
 */
export function selectResidentProfile(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): ResidentDispatchDraft {
  return {
    ...draft,
    profileId: profile?.id ?? null,
    repoFromProfile: draft.repoFromProfile || draft.repoRoot.trim() === "",
  };
}

/** The operator typed or picked a repository: from now on it is theirs. */
export function chooseResidentRepo(draft: ResidentDispatchDraft, repoRoot: string): ResidentDispatchDraft {
  return { ...draft, repoRoot, repoFromProfile: false };
}
