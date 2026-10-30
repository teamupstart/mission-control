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
  repoRoot: string;
  instructions: string;
  /**
   * Kept across a retry of an answer that did not arrive, so a second click replays the same
   * launch; replaced after a definitive outcome so the next launch is a new one.
   */
  requestId: string;
}

export function freshResidentDispatchDraft(): ResidentDispatchDraft {
  return { profileId: null, repoRoot: "", instructions: "", requestId: crypto.randomUUID() };
}

/**
 * Select a profile, pre-filling its default repository unless the operator already chose one
 * of their own. A repository that was only the previous profile's default is replaced.
 */
export function selectResidentProfile(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
  previous: ResidentProfile | null,
): ResidentDispatchDraft {
  const typed = draft.repoRoot.trim();
  const previousDefault = previous?.settings.workspace.defaultRepoRoot ?? null;
  const keepRepo = typed.length > 0 && typed !== previousDefault;
  return {
    ...draft,
    profileId: profile?.id ?? null,
    repoRoot: keepRepo ? draft.repoRoot : profile?.settings.workspace.defaultRepoRoot ?? "",
  };
}
