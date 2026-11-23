import type { ResidentProfile } from "@shared/residents.ts";

/**
 * What Dispatch's Resident mode holds while it is open: the profile, the repository set and
 * this run's instructions, plus the request id that makes its submit idempotent.
 *
 * Owned by `DispatchLayer` beside the Single and Ensemble drafts, so switching mode or closing
 * the form loses none of it.
 */
export interface ResidentDispatchDraft {
  profileId: string | null;
  /** The repository the operator typed or picked. Read only when `repoFromProfile` is false. */
  repoRoot: string;
  /**
   * The repositories the operator attached beside it. Read only when `repoFromProfile` is false:
   * the primary and its attachments are one choice, so changing either takes over both.
   */
  additionalRepoRoots: string[];
  /**
   * Whether the repository set is the selected profile's default rather than the operator's own
   * choice. A profile-sourced set is never copied into the draft: it is read from the profile's
   * CURRENT revision every time, so a default edited after the form was prefilled can never
   * launch a resident in the old repositories.
   */
  repoFromProfile: boolean;
  instructions: string;
  /**
   * Kept across a retry of an answer that did not arrive, so a second click replays the same
   * launch; replaced after a definitive outcome so the next launch is a new one.
   */
  requestId: string;
  /**
   * A launch that is outstanding: sent, and with no definitive answer yet - still starting, or
   * its answer lost to a network error. Its resident may already be running, so it is never
   * forgotten silently: an exact retry replays it (its repository frozen as sent, see
   * `residentDispatchRepo`), and a changed launch must first choose between retrying it and
   * starting a separate resident. Recorded when the launch is sent; cleared by any definitive
   * outcome.
   */
  uncertain: ResidentLaunchAttempt | null;
}

/** Exactly what one launch request carried. */
export interface ResidentLaunchAttempt {
  requestId: string;
  profileId: string;
  /** The profile's name when it was sent, to name the launch after the profile is archived. */
  profileName: string;
  /** The repository as it was sent, not as the profile's default reads now. */
  repoRoot: string;
  /** The attached repositories as they were sent. */
  additionalRepoRoots: string[];
  instructions: string;
}

export function freshResidentDispatchDraft(): ResidentDispatchDraft {
  return {
    profileId: null,
    repoRoot: "",
    additionalRepoRoots: [],
    repoFromProfile: true,
    instructions: "",
    requestId: crypto.randomUUID(),
    uncertain: null,
  };
}

/** Whether the form, as it stands, would send exactly what an earlier attempt sent. */
export function residentAttemptMatches(
  attempt: ResidentLaunchAttempt,
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): boolean {
  const attached = residentDispatchAttachedRepos(draft, profile);
  return attempt.profileId === draft.profileId
    && attempt.repoRoot === residentDispatchRepo(draft, profile).trim()
    && attempt.additionalRepoRoots.length === attached.length
    && attempt.additionalRepoRoots.every((path, index) => path === attached[index])
    && attempt.instructions.trim() === draft.instructions.trim();
}

/**
 * The outstanding launch the form can still retry although its profile has left the live
 * catalog - archived, perhaps in another window - or null. The daemon answers a request id it
 * already holds from that run alone, never from the profile as it is now, so an exact retry
 * needs nothing the archived profile took away. Anything other than that exact retry does.
 */
export function residentRetryWithoutProfile(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): ResidentLaunchAttempt | null {
  const attempt = draft.uncertain;
  if (profile || !attempt || attempt.requestId !== draft.requestId) return null;
  return residentAttemptMatches(attempt, draft, null) ? attempt : null;
}

/** Put the form back on an uncertain attempt, with its id, so Launch replays it exactly. */
export function retryResidentAttempt(
  draft: ResidentDispatchDraft,
  attempt: ResidentLaunchAttempt,
): ResidentDispatchDraft {
  return {
    ...draft,
    profileId: attempt.profileId,
    repoRoot: attempt.repoRoot,
    additionalRepoRoots: [...attempt.additionalRepoRoots],
    repoFromProfile: false,
    instructions: attempt.instructions,
    requestId: attempt.requestId,
  };
}

/**
 * The repository this draft would launch in. A profile-sourced repository follows the profile's
 * current default - except while this draft's own launch is outstanding: then it stays exactly
 * what was sent, so a default edited in the meantime cannot turn the replay of that launch into
 * a different request under the same id.
 */
export function residentDispatchRepo(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): string {
  if (!draft.repoFromProfile) return draft.repoRoot;
  const outstanding = draft.uncertain;
  if (outstanding && outstanding.requestId === draft.requestId && outstanding.profileId === draft.profileId) {
    return outstanding.repoRoot;
  }
  return profile?.settings.workspace.defaultRepoRoot ?? "";
}

/**
 * Select a profile. A repository the operator chose is kept; otherwise the draft follows the
 * new profile's default. An explicit no-repository choice remains the operator's choice.
 */
export function selectResidentProfile(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): ResidentDispatchDraft {
  return {
    ...draft,
    profileId: profile?.id ?? null,
    repoFromProfile: draft.repoFromProfile,
  };
}

/**
 * The repositories this draft would attach beside its primary, by the same rule as
 * `residentDispatchRepo`: the profile's current default, the outstanding launch's set while it
 * is outstanding, or the operator's own. Always empty without a primary, because attached
 * repositories need one.
 */
export function residentDispatchAttachedRepos(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): string[] {
  if (!residentDispatchRepo(draft, profile).trim()) return [];
  if (!draft.repoFromProfile) return draft.additionalRepoRoots.map((path) => path.trim()).filter(Boolean);
  const outstanding = draft.uncertain;
  if (outstanding && outstanding.requestId === draft.requestId && outstanding.profileId === draft.profileId) {
    return outstanding.additionalRepoRoots;
  }
  return profile?.settings.workspace.additionalRepoRoots ?? [];
}

/**
 * The operator typed or picked a repository: from now on the repository set is theirs. The
 * attachments shown with it come along, so taking over the primary never silently drops the
 * profile's attached repositories; choosing no repository detaches them all.
 */
export function chooseResidentRepo(
  draft: ResidentDispatchDraft,
  repoRoot: string,
  profile: ResidentProfile | null,
): ResidentDispatchDraft {
  const additionalRepoRoots = repoRoot.trim() ? residentDispatchAttachedRepos(draft, profile) : [];
  return { ...draft, repoRoot, additionalRepoRoots, repoFromProfile: false };
}

/** The operator attached or detached a repository: the whole set is now theirs. */
export function chooseResidentAttachedRepos(
  draft: ResidentDispatchDraft,
  additionalRepoRoots: string[],
  profile: ResidentProfile | null,
): ResidentDispatchDraft {
  return { ...draft, repoRoot: residentDispatchRepo(draft, profile), additionalRepoRoots, repoFromProfile: false };
}

/**
 * **Launch as a new resident**: a fresh launch of exactly the repository set the form shows.
 *
 * While a launch is outstanding, a profile-sourced set is displayed as it was sent, not as the
 * profile reads now. Clearing the outstanding launch would make the draft follow the profile
 * again, so a default edited in the meantime would launch repositories the operator never saw.
 * The displayed set is therefore taken over as the operator's own before the launch is cleared.
 */
export function separateResidentLaunch(
  draft: ResidentDispatchDraft,
  profile: ResidentProfile | null,
): ResidentDispatchDraft {
  return {
    ...draft,
    repoRoot: residentDispatchRepo(draft, profile),
    additionalRepoRoots: residentDispatchAttachedRepos(draft, profile),
    repoFromProfile: false,
    requestId: crypto.randomUUID(),
    uncertain: null,
  };
}
