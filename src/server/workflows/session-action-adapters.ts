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
    context: WorkflowContextSnapshot,
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
 * Registered, addressable, and explicitly UNAVAILABLE until its durable proof exists.
 *
 * A registered refusal rather than an absent entry or a placeholder that returns success.
 * Absent, the registry lookup would throw somewhere unhelpful and a published version naming
 * it would be unreadable rather than refused. Succeeding, a `pull_request` action would
 * complete on the generic turn boundary alone - claiming a pull request was opened, adopted
 * and matched against the captured head when none of those were checked, which is the whole
 * of the guarantee this adapter exists to make.
 */
const pullRequest: SessionActionAdapter = {
  ...SESSION_ACTION_COMPLETION_CAPABILITIES.pull_request,
  validateSnapshot: () => SESSION_ACTION_COMPLETION_CAPABILITIES.pull_request.unavailableReason,
  decide: () => ({
    kind: "blocked",
    code: "adapter_unavailable",
    detail: SESSION_ACTION_COMPLETION_CAPABILITIES.pull_request.unavailableReason
      ?? "This completion adapter is not available in this build.",
  }),
  validateCapture: () => "This completion adapter is not available in this build.",
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
