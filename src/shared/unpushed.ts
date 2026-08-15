// Whether a checkout is holding commits its remote has never seen, and what a person may
// be TOLD about that.
//
// This exists for one silence in particular. A workflow run parked in
// `waiting_for_new_head` clears only when the Inspector poller observes a head that was
// PUSHED, so from the daemon's side a session that fixed the findings, committed, and
// stopped looks exactly like a session that did nothing at all. Both are quiet, both have a
// parked run, and the stall sentence that covers them can only say "waiting for a pushed
// head" - which is a description of the wait rather than an instruction.
//
// A local, read-only count of commits the upstream does not have is what separates the two,
// and it is the whole reason this type is a tri-state rather than a number. The observation
// is made by the daemon (`src/server/git/unpushed.ts`, which shells out); this module is the
// browser-safe half - the shape that crosses the boundary and the one sentence derived from
// it - so the rule that decides what to say and the surface that renders it cannot drift
// into disagreeing about what "not pushed" meant.

/**
 * Why no claim can be made about this checkout.
 *
 * Every one of these is "we do not know", never "nothing is unpushed", and the distinction
 * is the point rather than pedantry: telling a session it forgot to push when its branch
 * simply has no remote is worse than saying nothing, because it sends a person to look for
 * a mistake that was never made. The reasons are separated only so a log line can say which
 * silence this was; every one of them produces the same absence of a sentence.
 */
export type UnpushedUnknownReason =
  /** No checkout path to read - nothing was bound, or the binding never captured one. */
  | "no_checkout"
  /** The path is not inside a git repository, or the repository has no commits yet. */
  | "not_a_repo"
  /** HEAD is not on a branch, so there is no upstream to be ahead OF. */
  | "detached_head"
  /**
   * The branch tracks nothing. Overwhelmingly the ordinary case for a branch that was
   * never pushed with `-u`, and precisely the case that must not read as an accusation:
   * "ahead of nothing" is not a number, it is a missing question.
   */
  | "no_upstream"
  /** git ran and failed, timed out, or was killed. An answer we did not get. */
  | "git_failed"
  /** git answered, and the answer was not a count. Treated as no answer at all. */
  | "unreadable";

/**
 * What the bound checkout says about commits the remote does not have.
 *
 * `pushed` and `unknown` are deliberately different states rather than one falsy value.
 * `pushed` is a positive observation - there IS an upstream, and HEAD is not ahead of it -
 * which means the missing step is something other than a push. `unknown` is the absence of
 * an observation. A caller that collapsed them would turn "we could not look" into "there is
 * nothing there", which is the exact mistake this whole type exists to prevent.
 */
export type UnpushedCommits =
  | {
    state: "ahead";
    /** How many commits HEAD holds that its configured upstream does not. Always 1 or more. */
    commits: number;
    /** The branch HEAD is on, for a sentence that can name it. */
    branch: string;
    /**
     * The ref that branch tracks, abbreviated the way a person writes it.
     *
     * Both the GATE that allowed a claim to be made and the ref the count was measured
     * against - `commits` is `@{upstream}..HEAD`. One ref rather than two because the caller
     * speaks for an Inspector waiting on one branch, so commits that reached some other ref
     * have not reached the one being waited on.
     */
    upstream: string;
  }
  | { state: "pushed"; branch: string; upstream: string }
  | { state: "unknown"; why: UnpushedUnknownReason };

/** The one state that supports an instruction. Everything else is a wait. */
export function hasUnpushedCommits(obs: UnpushedCommits | null | undefined): boolean {
  return obs?.state === "ahead";
}

/**
 * The clause naming the missing step, or null when nothing may be claimed.
 *
 * Null for BOTH `pushed` and `unknown`, and a caller is expected to fall back to whatever
 * it was already saying about the wait. That is the conservative direction on purpose: this
 * sentence is read as an accusation ("you did not finish the job"), so it is spoken only
 * when a local count positively supports it. A checkout with no upstream, a detached HEAD,
 * or a git call that errored all keep their mouths shut.
 *
 * `pushed` says nothing for a subtler reason worth keeping written down: HEAD being level
 * with its upstream does NOT prove the head the Inspector is waiting for exists. The branch
 * may have been pushed somewhere else, or the pull request may point at a different one. The
 * honest reading of `pushed` is only "a push is not the step that is missing", which is a
 * fact about what NOT to say rather than something to say.
 */
export function unpushedClause(obs: UnpushedCommits | null | undefined): string | null {
  if (obs?.state !== "ahead") return null;
  const plural = obs.commits === 1 ? "commit that is" : "commits that are";
  return `you have ${obs.commits} ${plural} not pushed`;
}
