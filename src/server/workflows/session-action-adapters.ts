import {
  SESSION_ACTION_COMPLETION_CAPABILITIES,
  SESSION_ACTION_COMPLETION_KINDS,
} from "@shared/workflow.ts";
import type {
  SessionActionCompletionCapability,
  SessionActionCompletionDecision,
  SessionActionCompletionKind,
  SessionActionContinuationExpectation,
  SessionActionSnapshot,
  WorkflowContextSnapshot,
} from "@shared/workflow.ts";
import type { Session } from "@shared/types.ts";

/**
 * What the generic observer has already PROVEN by the time an adapter is asked.
 *
 * Every field here is evidence, not a guess: the packet was confirmed sent, something newer
 * than the send anchor proved the session read it, and the session has since been settled
 * idle without a question outstanding. An adapter's job is to decide whether that is enough
 * for the proof its completion kind promises - never to re-derive the turn boundary.
 */
export interface SessionActionAdapterContext {
  snapshot: SessionActionSnapshot;
  session: Session;
  /** Transcript bytes at confirmed send, or null when this harness exposes no transcript. */
  anchorTranscriptBytes: number | null;
  deliveredAt: number;
  pickedUpAt: number;
  settledAt: number;
  now: number;
  /**
   * The bound checkout's own facts, or null when they could not be read this pass.
   *
   * Supplied rather than fetched, so an adapter stays a pure decision over stated evidence
   * and every git call lives where the rest of them do. Null is "we could not look", which
   * every adapter must treat as a reason to wait rather than as an answer.
   */
  repository: SessionActionRepositoryFacts | null;
  /**
   * Every pull request Mission Control has ADOPTED, as the ledger currently records it.
   *
   * A read of durable local state, never a provider call: the Inspector poller remains the
   * only thing that talks to GitHub, and this is what it wrote down. An adapter that wanted
   * fresher facts than these has to wait for the next poll, which is the whole reason
   * "waiting" is an arm of the decision.
   */
  adoptedPullRequests: readonly SessionActionAdoptedPullRequest[];
  /**
   * The head a continuation segment has ALREADY captured, or null when none has been.
   *
   * Present only on the re-check after a capture whose expectation was not met, and it is
   * what makes that re-check converge. The captured evidence is immutable, so re-deciding
   * against whatever the checkout has moved on to since would set an expectation the child
   * can never satisfy, and the action would wait forever while the head kept moving. Asked
   * this way, the question becomes "has the pull request caught up with what we captured",
   * which a push can answer.
   */
  capturedHeadOid: string | null;
}

/** What the bound session's checkout says about itself, resolved before the adapter runs. */
export interface SessionActionRepositoryFacts {
  /**
   * Which REPOSITORY this checkout belongs to - git's common directory, not the working tree.
   *
   * Mission Control dispatches agents into linked worktrees, so a bound session's toplevel is a
   * per-session path while the pull request it opens is adopted against the repository that
   * worktree was cut from. Comparing toplevels made those look like different repositories for
   * every dispatched session, and a `pull_request` action could then never complete.
   */
  repositoryId: string;
  /** The working tree's own toplevel. Diagnostics only; never the identity being compared. */
  root: string;
  /** The checked-out branch, or null on a detached HEAD. */
  branch: string | null;
  /** HEAD as a FULL object id, or null on an unborn branch. Never an abbreviation. */
  headOid: string | null;
}

/**
 * One row of the adoption ledger, narrowed to what a completion proof may consider.
 *
 * Deliberately smaller than `InspectorPr`. Review rounds, backoff ladders, failure kinds and
 * merge blocks are the Inspector's business; an adapter that could read them would start
 * making decisions about a review it does not own.
 */
export interface SessionActionAdoptedPullRequest {
  /** `owner/repo#number`. */
  key: string;
  url: string;
  number: number;
  /**
   * Which REPOSITORY it was adopted against, in the same spelling as
   * `SessionActionRepositoryFacts.repositoryId` - git's common directory, resolved.
   *
   * The ledger stores the repository ROOT a session was reached by, and that is not comparable
   * to the bound checkout as written. Two things make them differ, and both are the ordinary
   * case rather than an edge one: a dispatched session works in a linked worktree whose
   * toplevel is its own path, and a checkout behind a symlink - every `/tmp` and
   * `/var/folders` path on macOS - is spelled differently by git than by the process that
   * recorded it. Normalising both sides to the resolved common directory is what makes a
   * correct pull request compare as belonging to this repository.
   *
   * Null is UNKNOWN and is neither a match nor a mismatch: it cannot satisfy the proof, and it
   * cannot accuse an operator's session of opening a pull request somewhere else.
   */
  repositoryRoot: string | null;
  /** The branch the pull request is opened FROM, or null until the first poll. */
  branch: string | null;
  /** The remote head the last poll SAW, as a full object id, or null until the first poll. */
  observedHeadOid: string | null;
  /** What that poll saw the pull request's state to be, or null until the first poll. */
  observedState: "OPEN" | "CLOSED" | "MERGED" | null;
  /** When that poll happened, or null until the first one. */
  observedAt: number | null;
  /**
   * The session that opened it, or null - a pull request outlives the session, deliberately.
   *
   * Read for ONE purpose: telling "this turn produced no pull request" apart from "this turn
   * produced one somewhere else". It is never part of the positive proof - see
   * `matchesActionWork` for why an earlier session's pull request on this branch is still
   * this branch's pull request.
   */
  sessionId: string | null;
  /** When Mission Control adopted it. Bounds a mismatch to THIS action's turn. */
  adoptedAt: number;
}

/**
 * What a capture has to be checked against, with the abbreviation already resolved.
 *
 * `context.evidence.headSha` is `git rev-parse --short HEAD` and a pull request's head is a
 * full object id, so the two are not comparable as written. Resolving the abbreviation is a
 * git question, and the answer is handed in here for the same reason `repository` is: the
 * adapter decides, and the manager is what talks to git.
 */
export interface SessionActionCaptureFacts {
  context: WorkflowContextSnapshot;
  /**
   * The captured head as a full object id, or null when the abbreviation could not be
   * resolved to exactly one commit in this repository.
   */
  capturedHeadOid: string | null;
}

/**
 * One server-owned completion adapter.
 *
 * Server-owned and closed on purpose: a completion kind selects a PROOF, and a proof that an
 * operator could author would be a promise nothing keeps. The registry is keyed by the
 * append-only shared ids, so a published version always resolves to the adapter it named -
 * or to an explicit refusal, never to a substitute.
 */
export interface SessionActionAdapter extends SessionActionCompletionCapability {
  /**
   * Whether this snapshot is executable by this adapter at all, or one sentence saying why
   * not. Checked before a packet is prepared, so a version that cannot run refuses before
   * anything is typed rather than after.
   */
  validateSnapshot(snapshot: SessionActionSnapshot): string | null;
  /** The durable proof this adapter requires once the turn has settled. */
  decide(context: SessionActionAdapterContext): SessionActionCompletionDecision;
  /**
   * What the continuation capture must still be true of. Re-validated against the captured
   * context, which may happen after a daemon restart, so it is stated rather than implied.
   */
  validateCapture(
    expectation: SessionActionContinuationExpectation,
    capture: SessionActionCaptureFacts,
  ): string | null;
}

/**
 * The completion this build proves after a verified pickup and a settled turn, and nothing
 * more.
 *
 * "Nothing more" is the contract, not a shortcut: this adapter is what an operator selects
 * when the instruction's effect is the turn itself - a refactor, a cleanup, a note written
 * into the conversation. The generic observer has already done the hard part, so the honest
 * answer here is `complete` with no further expectation of the repository. An action may
 * legitimately change no local file at all, which is why continuation capture allows
 * unchanged evidence.
 */
const sessionTurn: SessionActionAdapter = {
  ...SESSION_ACTION_COMPLETION_CAPABILITIES.session_turn,
  validateSnapshot: () => null,
  decide: () => ({ kind: "complete", continuationExpectation: { kind: "none" } }),
  validateCapture: (expectation) =>
    expectation.kind === "none"
      ? null
      : "A session turn action does not constrain the continuation capture",
};

/**
 * Whether an adapter's decision can change without the session doing anything more.
 *
 * The observer sweeps every waiting attempt on a timer, but a `pull_request` action settles
 * long before its proof arrives - the poller looks every ninety seconds - so it also has to
 * be woken when the adoption ledger moves. This says which attempts that wakeup is for, so
 * an inspection update does not re-sweep every action in the fleet.
 */
export function completionWatchesPullRequests(kind: SessionActionCompletionKind): boolean {
  return kind === "pull_request";
}

/**
 * Whether one adopted row is a pull request for THIS work.
 *
 * Three facts, and each one closes a way the wrong pull request could be adopted as proof:
 *
 *  - the same repository root, so a session that has several checkouts open cannot satisfy
 *    one repository's action with another repository's pull request;
 *  - the same head branch, so a pull request that merely CONTAINS this commit - a stacked
 *    branch, a release branch someone cherry-picked onto - is not mistaken for the pull
 *    request this branch's work belongs to;
 *  - the exact head object id, which is what makes the whole thing a proof rather than a
 *    guess. A commit id is not something a session can be mistaken about.
 *
 * The row's `sessionId` is deliberately NOT required to be the bound session. Adoption is
 * already Mission Control's own record of "we opened this", and the plan's already-open case
 * is exactly a pull request some earlier session opened for this branch: refusing it would
 * mean opening a second pull request for work that already has one.
 */
function matchesActionWork(
  pr: SessionActionAdoptedPullRequest,
  repositoryId: string,
  branch: string,
  headOid: string,
): boolean {
  return pr.repositoryRoot === repositoryId
    && pr.branch === branch
    && pr.observedHeadOid === headOid;
}

/** Whether an adopted row is on this branch at all, whatever its head has reached. */
function belongsToBranch(
  pr: SessionActionAdoptedPullRequest,
  repositoryId: string,
  branch: string,
): boolean {
  return pr.repositoryRoot === repositoryId && pr.branch === branch;
}

/**
 * Whether this action's own turn is what produced a pull request.
 *
 * Both halves are load-bearing, and they are what make a mismatch a FACT rather than an
 * inference from absence. The bound session is the only one this action typed into, and the
 * delivery instant is what separates the pull request this turn opened from one the same
 * session opened for earlier work - which is still on the branch it belonged to and is not
 * evidence of anything going wrong here.
 *
 * A row whose session link is null fails it, and that is the right way round: an adoption
 * nobody can attribute must not be reported to an operator as their session's mistake.
 */
function openedByThisTurn(
  pr: SessionActionAdoptedPullRequest,
  sessionId: string,
  deliveredAt: number,
): boolean {
  return pr.sessionId === sessionId && pr.adoptedAt >= deliveredAt;
}

/**
 * The completion that requires a real, open, adopted pull request at the reviewed commit.
 *
 * The generic observer has already proven the turn ran and settled. That is the easy half and
 * it is emphatically not the guarantee: an agent can finish a turn having failed to push,
 * having opened the pull request against the wrong base, or having said it opened one and not.
 * So the turn boundary buys nothing here on its own, and every arm below is written to prefer
 * WAITING over completing.
 *
 * What it never does:
 *
 *  - read `Session.prUrl`. It is a live convenience that disappears across an SDK restart and
 *    proves nothing about what is on the remote;
 *  - talk to GitHub. The Inspector poller is the only thing that does, and this reads what it
 *    durably wrote down. A second poll loop would double the API cost of every open pull
 *    request to answer a question the first one already answers;
 *  - infer success from a pull request merely EXISTING, from the branch name, or from the
 *    agent's own account of what it did.
 */
const pullRequest: SessionActionAdapter = {
  ...SESSION_ACTION_COMPLETION_CAPABILITIES.pull_request,
  // Any snapshot is executable. The required skill is checked by the generic delivery path,
  // twice, and demanding a particular skill id here would be a second source of truth about
  // what the action needs - one that a duplicated-and-customized action would fail for a
  // reason that has nothing to do with whether its pull request can be proven.
  validateSnapshot: () => null,

  decide: (context) => {
    const repository = context.repository;
    // Cannot look is not an answer. A checkout that has gone away, a git call that failed, a
    // detached HEAD with no branch to match a pull request against: none of them is evidence
    // about a pull request, so none of them may complete or block the action.
    if (!repository || !repository.branch) {
      return { kind: "waiting", reason: "awaiting_proof" };
    }
    // The head a capture already fixed wins over whatever the checkout has moved on to. See
    // `capturedHeadOid`: re-deciding against a moving HEAD never converges.
    const target = context.capturedHeadOid ?? repository.headOid;
    if (!target) return { kind: "waiting", reason: "awaiting_proof" };

    const onBranch = context.adoptedPullRequests.filter(
      (pr) => belongsToBranch(pr, repository.repositoryId, repository.branch!),
    );
    const matching = onBranch.filter(
      (pr) => matchesActionWork(pr, repository.repositoryId, repository.branch!, target),
    );
    const open = matching.filter((pr) => pr.observedState === "OPEN");
    if (open.length > 0) {
      // Deterministic when a branch somehow carries two matching open pull requests: the
      // lowest number is the one that was opened first, and the one an operator would call
      // "the" pull request for this branch.
      const chosen = open.reduce((best, pr) => (pr.number < best.number ? pr : best));
      return {
        kind: "complete",
        continuationExpectation: {
          kind: "pull_request",
          pullRequestKey: chosen.key,
          pullRequestUrl: chosen.url,
          pullRequestNumber: chosen.number,
          repositoryRoot: repository.repositoryId,
          branch: repository.branch,
          expectedHeadOid: target,
          observedAt: chosen.observedAt ?? context.now,
        },
      };
    }
    // A pull request at the right commit that is closed or merged is the one durable
    // contradiction here: waiting cannot reopen it, and completing would hand downstream
    // stages a pull request nobody can review. Everything else below waits.
    if (matching.length > 0) {
      const closed = matching[0]!;
      return {
        kind: "blocked",
        code: "pull_request_closed",
        detail:
          `${closed.url} is at the reviewed commit but is ${
            closed.observedState === "MERGED" ? "already merged" : "closed"
          }. Reopen it, or start a new pull request for this branch, and retry this action.`,
      };
    }
    // On this branch but not at this commit. The remedy is a push, and saying so is the whole
    // reason this is its own wait reason rather than a generic "verifying".
    if (onBranch.some((pr) => pr.observedState === "OPEN")) {
      return { kind: "waiting", reason: "awaiting_pushed_head" };
    }
    // Nothing on this branch. Before reporting that as "no pull request yet", ask whether this
    // turn opened one SOMEWHERE ELSE, because those two states look identical from here and
    // are opposite problems: one is waiting for work that has not finished, the other is work
    // that finished and landed off target. Reported as a wait rather than a block because a
    // later adoption can still put the right pull request on this branch - a block would end
    // the run for a turn that opened a stray pull request first and the right one second.
    const strays = context.adoptedPullRequests.filter(
      (pr) => openedByThisTurn(pr, context.session.id, context.deliveredAt),
    );
    // Repository first: a pull request in another repository is the larger mistake, and a
    // branch comparison across two repositories would be meaningless anyway.
    //
    // Both tests demand a KNOWN value that DIFFERS, never merely one that fails to match.
    // A row the poller has not reached yet carries a null branch and a null head, and reading
    // that as "not this branch" would report a pull request opened seconds ago - the ordinary
    // case - as an operator's mistake. Unknown is unknown, and unknown waits.
    if (strays.some((pr) => pr.repositoryRoot !== null && pr.repositoryRoot !== repository.repositoryId)) {
      return { kind: "waiting", reason: "pull_request_wrong_repository" };
    }
    if (strays.some((pr) => pr.branch !== null && pr.branch !== repository.branch)) {
      return { kind: "waiting", reason: "pull_request_wrong_branch" };
    }
    // Nothing adopted for this branch at all - including the ordinary case where the pull
    // request was opened moments ago and the poller has not looked yet.
    return { kind: "waiting", reason: "awaiting_pull_request" };
  },

  validateCapture: (expectation, capture) => {
    if (expectation.kind !== "pull_request") {
      return "A pull request action requires a pull request continuation expectation";
    }
    if (!capture.capturedHeadOid) {
      return "The commit this continuation captured could not be identified in the repository";
    }
    // The one check this whole adapter exists to make survive a restart. The pull request was
    // proven to be at `expectedHeadOid`; if the capture is at any other commit then the
    // evidence downstream stages would read is work the pull request does not contain.
    if (capture.capturedHeadOid !== expectation.expectedHeadOid) {
      return `The captured commit ${capture.capturedHeadOid.slice(0, 12)} is not the commit `
        + `${expectation.expectedHeadOid.slice(0, 12)} that ${expectation.pullRequestUrl} was `
        + "proven to be at";
    }
    return null;
  },
};

export const SESSION_ACTION_ADAPTERS: Record<SessionActionCompletionKind, SessionActionAdapter> = {
  session_turn: sessionTurn,
  pull_request: pullRequest,
};

export function sessionActionAdapter(kind: SessionActionCompletionKind): SessionActionAdapter {
  return SESSION_ACTION_ADAPTERS[kind];
}

/**
 * The build's answer for every adapter, in the append-only tuple's order.
 *
 * The one source the capability route serves and the graph validator reads, so the browser
 * never invents support: an adapter offered by a surface that the daemon then refuses is a
 * workflow an operator can publish and never run.
 */
export function sessionActionCapabilities(): SessionActionCompletionCapability[] {
  return SESSION_ACTION_COMPLETION_KINDS.map((kind) => {
    const adapter = SESSION_ACTION_ADAPTERS[kind];
    return {
      kind: adapter.kind,
      available: adapter.available,
      label: adapter.label,
      unavailableReason: adapter.unavailableReason,
    };
  });
}
