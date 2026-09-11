import { WorkflowInspectorGateStateSchema } from "./protocol.ts";
import type { WorkflowInspectorGateState } from "./workflow.ts";
import {
  WORKFLOW_RUN_SPENT_PHASES,
  WORKFLOW_RUN_TERMINAL_STATUSES,
  type WorkflowGateWaitReason,
  type WorkflowJson,
  type WorkflowRunStatus,
} from "./workflow.ts";

/*
 * One reading of a persisted workflow run's lifecycle, for the daemon and the dashboard
 * alike.
 *
 * A run row states its lifecycle in three columns that vary independently - `status`,
 * `current_phase`, and the free-form `gate_state_json` - and three subsystems used to
 * interpret them separately. The store decided which statuses block a write, the engine
 * decided which phase means a check may resume, and the manager decided which payloads are
 * a live GitHub Inspector gate. Each read the columns it cared about and ignored the rest,
 * so a combination none of them would ever write was still representable, and a lifecycle
 * change needed synchronized edits in three files with nothing failing typecheck if one was
 * missed.
 *
 * This module is the single answer to "what state is this run in". `decodeWorkflowRunLifecycle`
 * is TOTAL and DETERMINISTIC: every triple maps to exactly one variant, so two readers cannot
 * disagree. `workflowRunLifecycleViolation` states the combinations that must never be
 * persisted, and the store calls it on the way in.
 *
 * It lives above `workflow.ts` rather than inside it because the authoritative shape of the
 * GitHub Inspector gate is the Zod schema in `protocol.ts`, and `protocol.ts` imports
 * `workflow.ts`. Re-spelling that schema by hand here to avoid the layer would create the
 * second source of truth this module exists to remove.
 */

/**
 * The phase a run blocks in when a check node cannot be retried because its pooled worktree's
 * lease is still unresolved.
 *
 * Shared rather than engine-private because the phase is half of the resume condition: the
 * detail payload is only a check-cleanup block when the run is blocked IN THIS PHASE, and the
 * decoder below has to know that to keep `infrastructure_error` - which writes a payload of
 * the same three keys - from reading as a resumable cleanup block.
 */
export const WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE = "check_cleanup_unresolved";

/**
 * The phase a run blocks in when one round has spent its consecutive evidence-preflight
 * refinements without closing the readiness gaps.
 *
 * Named rather than spelled at its call sites because three of them have to agree: the store
 * writes it, the readiness override reads it to decide that a blocked run may still be
 * continued despite gaps, and the dashboard reads it to keep the operator's decision panel on
 * screen at the one moment the operator is being asked to make that decision. A run parked
 * here is waiting for a person, not for the session.
 */
export const WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE = "preflight_refinement_exhausted";

/**
 * Every phase the GitHub Inspector gate machinery may park a run in, as a closed registry.
 *
 * Closed because the phase is not decoration: `evaluateInspectorGate` and `recheckInspector`
 * both re-enter a blocked gate ONLY on `inspector_disabled`, so a phase this set does not
 * contain is a run the gate will never look at again. The registry existed implicitly, spread
 * across those two guards and the browser's label maps, and the gap it left was real - the
 * gate's entry path built its phase by interpolating the wait reason, so the `inspector_disabled`
 * reason produced `inspector_inspector_disabled` and stranded the run permanently.
 *
 * Naming the set once is what closes that: `WORKFLOW_INSPECTOR_ENTRY_PHASE` is keyed on it and
 * typed `WorkflowRunPhase`, so the doubled name is a compile error. The set is NOT used to
 * refuse unlisted `inspector_` phases at persistence - see `workflowRunLifecycleViolation` for
 * why that rule was removed rather than kept as belt and braces.
 */
export const WORKFLOW_INSPECTOR_GATE_PHASES = [
  "inspector_adapter_error",
  "inspector_awaiting_fresh_observation",
  "inspector_disabled",
  "inspector_findings",
  "inspector_gate_context_invalid",
  "inspector_head_mismatch",
  "inspector_missing_pr",
  "inspector_pr_closed",
  "inspector_pr_switch_refused",
  "inspector_review",
  "inspector_review_backoff",
  "inspector_review_error",
  "inspector_round_limit",
  "inspector_unadopted_pr",
  "inspector_working_tree_not_pushed",
] as const;

/**
 * The phase that names each GitHub Inspector wait reason, exhaustively.
 *
 * A total `Record` rather than the `inspector_${waitReason}` interpolation it replaces, so a
 * twelfth wait reason fails typecheck here instead of minting a phase string at runtime that
 * no reader recognises. Total rather than partial for the same reason: an entry with no phase
 * would need a fallback at the call site, and a fallback is exactly what let the doubled
 * `inspector_inspector_disabled` through. Every value is typed as a `WorkflowRunPhase`, so a
 * misspelled entry is a compile error rather than something the contract test has to catch.
 *
 * The four the gate ENTERS under are the first four; the rest are reached later, by
 * transitions that already name their phase directly and agree with this map.
 */
export const WORKFLOW_INSPECTOR_ENTRY_PHASE: Record<WorkflowGateWaitReason, WorkflowRunPhase> = {
  missing_pr: "inspector_missing_pr",
  unadopted_pr: "inspector_unadopted_pr",
  inspector_disabled: "inspector_disabled",
  awaiting_fresh_observation: "inspector_awaiting_fresh_observation",
  working_tree_not_pushed: "inspector_working_tree_not_pushed",
  head_mismatch: "inspector_head_mismatch",
  review_pending: "inspector_review",
  review_backoff: "inspector_review_backoff",
  review_error: "inspector_review_error",
  findings: "inspector_findings",
  pr_closed: "inspector_pr_closed",
};

/**
 * The statuses whose ONLY way out is the GitHub Inspector gate reading its own stored context.
 *
 * A run parked in one of these without a decodable gate is stranded with no observer: the
 * poller skips it for want of a gate, and no local machinery un-parks it. That is why the
 * violation below is a refusal rather than a warning.
 */
export const WORKFLOW_GATE_OWNED_STATUSES = [
  "waiting_for_pr",
  "waiting_for_inspector",
  "waiting_for_new_head",
] as const;

/**
 * Every phase this build writes, as a closed registry.
 *
 * The phase COLUMN stays free text and this registry does not change that: `cancelRun` writes
 * a caller's reason code into it, `orphanBinding` and `pauseBinding` write theirs, and a row
 * from a newer daemon may name a phase this build has never heard of. All of those must keep
 * being stored and displayed - the browser already prints an unmapped code through a readable
 * fallback, and refusing them would make a legacy run unreadable rather than safe.
 *
 * What the registry decides is narrower and is the whole point: whether THIS BUILD KNOWS WHAT
 * THE PHASE MEANS. A record naming a phase absent from this list is a lifecycle state this
 * daemon cannot reason about, so `decodeWorkflowRunLifecycle` reports it as unrecognised and
 * refuses to call it executable - no matter how ordinary its status and detail look. Reading
 * an unknown phase as executable because its detail happened to be null was the gap this
 * closes: "no detail" and "a detail this build cannot interpret" are the same fact about a
 * phase nobody here declared.
 *
 * Appending to this list is how a new phase becomes actionable. That is deliberate rather
 * than incidental, and `WorkflowRunPhase` below is what makes it so: the authoritative
 * writers take the literal union rather than `string`, so a phase invented at a call site
 * fails typecheck HERE instead of persisting as a state nothing can act on. The registry and
 * the writers are one source of truth in the direction that matters - a new phase cannot be
 * written until it has been declared.
 */
export const WORKFLOW_RUN_PHASES = [
  "activating",
  "binding_archived",
  "capture_error",
  "capture_interrupted",
  "capturing",
  "check_cleanup_unresolved",
  "complete",
  "conversation_changed",
  "delivery_blocked",
  "delivery_prepare_error",
  "delivery_recovery_error",
  "delivery_refused",
  "delivery_uncertain",
  "evidence_readiness",
  "evidence_readiness_capture",
  "external_artifact_mismatch",
  "failed_outcome",
  "image_evidence_capture",
  "infrastructure_error",
  "invalid_version",
  "missing_workflow_version",
  "persona_feedback",
  "persona_review",
  "pr_handoff",
  "pr_handoff_prepare_error",
  "preflight_refinement_exhausted",
  "reattached_resubmit_required",
  "round_limit",
  "session_action",
  "session_action_blocked",
  "session_action_capture",
  "session_action_parallel_unsupported",
  "session_disappeared",
  "stale_capture",
  "unchanged_evidence",
  "unchanged_evidence_exhausted",
  "unchanged_repository",
  ...WORKFLOW_INSPECTOR_GATE_PHASES,
] as const;

/**
 * A phase this build declares - the shape every AUTHORITATIVE writer takes.
 *
 * This is the type half of the registry, and the two halves answer the two directions of the
 * same hazard. The runtime check below decides what to do with a phase already ON DISK, which
 * may come from a newer daemon or a build this one has never met. This type decides what a
 * writer in this build is allowed to MINT, and it is the one that removes the manual
 * synchronisation: `WORKFLOW_INSPECTOR_ENTRY_PHASE`, the delivery phase map, and
 * `setRunState` are all keyed on it, so adding a writer for an undeclared phase is a compile
 * error rather than a run that silently stops being executable.
 *
 * The persistence shape stays wider on purpose - see `setRunStateCarryingPhase`.
 */
export type WorkflowRunPhase = (typeof WORKFLOW_RUN_PHASES)[number];

/** Whether this build knows what the phase means, rather than merely being able to store it. */
export function workflowRunPhaseRecognized(phase: string): phase is WorkflowRunPhase {
  return (WORKFLOW_RUN_PHASES as readonly string[]).includes(phase);
}

/*
 * There is deliberately NO `workflowRunPhaseOr(phase, fallback)` helper here.
 *
 * One existed, and it was a hole in the boundary this module draws. Its callers were the
 * GitHub Inspector recovery and fresh-observation paths, which wanted to carry a run's phase
 * forward; for an unrecognised phase the fallback substituted a recognised one and the
 * transition then REWROTE the row. So a record the decoder had just reported as
 * non-executable was executed on anyway, and the only evidence of what the older daemon left
 * behind was overwritten. Carrying a legacy phase forward is not a defaulting problem, it is
 * a refusal: those paths now stop on `workflowRunPhaseRecognized` and leave the record alone.
 */

/**
 * The statuses each declared phase may be persisted under.
 *
 * The registry above says which phases exist; this says what each one MEANS as a lifecycle
 * state, and it is what makes "exactly one valid state per record" enforceable rather than
 * aspirational. Without it the validator constrained only a handful of special phases, so a
 * triple like `completed` + `delivery_refused` - a finished run parked on a delivery refusal -
 * was recognised, decoded cleanly, and persisted, because no rule happened to mention it.
 *
 * Most phases name exactly one status, because most describe one thing that happened. The
 * few with several are genuinely reached from several directions and each is deliberate:
 * `inspector_findings` parks a run for a new head, for the session, or blocks it depending on
 * the completion policy; `inspector_head_mismatch` is reached from the session wait, the
 * gate's own wait, and the block; `unchanged_repository` echoes back whichever of the two
 * statuses `resubmit` refused from.
 *
 * DETAIL is pinned separately, in `WORKFLOW_RUN_PHASE_DETAIL_KEYS` below, because it is a
 * different shape of rule: a phase names one set of statuses but its payload varies in which
 * OPTIONAL fields a given writer filled in.
 */
export const WORKFLOW_RUN_PHASE_STATUSES: Record<
  WorkflowRunPhase,
  readonly WorkflowRunStatus[]
> = {
  activating: ["running"],
  binding_archived: ["cancelled"],
  capture_error: ["blocked"],
  capture_interrupted: ["blocked"],
  capturing: ["capturing"],
  check_cleanup_unresolved: ["blocked"],
  complete: ["completed"],
  conversation_changed: ["blocked"],
  delivery_blocked: ["blocked"],
  delivery_prepare_error: ["blocked"],
  delivery_recovery_error: ["blocked"],
  delivery_refused: ["blocked"],
  delivery_uncertain: ["blocked"],
  evidence_readiness: ["waiting_for_evidence_readiness"],
  evidence_readiness_capture: ["capturing"],
  external_artifact_mismatch: ["blocked"],
  failed_outcome: ["failed"],
  image_evidence_capture: ["blocked"],
  infrastructure_error: ["blocked"],
  invalid_version: ["failed"],
  missing_workflow_version: ["failed"],
  persona_feedback: ["waiting_for_session"],
  persona_review: ["running"],
  pr_handoff: ["waiting_for_session"],
  pr_handoff_prepare_error: ["blocked"],
  preflight_refinement_exhausted: ["blocked"],
  reattached_resubmit_required: ["waiting_for_session"],
  round_limit: ["blocked"],
  session_action: ["waiting_for_action"],
  session_action_blocked: ["blocked"],
  session_action_capture: ["capturing"],
  session_action_parallel_unsupported: ["failed"],
  session_disappeared: ["blocked"],
  stale_capture: ["blocked"],
  unchanged_evidence: ["waiting_for_session"],
  unchanged_evidence_exhausted: ["blocked"],
  unchanged_repository: ["waiting_for_session", "blocked"],
  inspector_adapter_error: ["waiting_for_inspector"],
  inspector_awaiting_fresh_observation: ["waiting_for_inspector"],
  inspector_disabled: ["blocked"],
  inspector_findings: ["waiting_for_new_head", "blocked", "waiting_for_session"],
  inspector_gate_context_invalid: ["blocked"],
  inspector_head_mismatch: ["waiting_for_session", "blocked", "waiting_for_inspector"],
  inspector_missing_pr: ["waiting_for_pr"],
  inspector_pr_closed: ["blocked"],
  inspector_pr_switch_refused: ["blocked"],
  inspector_review: ["waiting_for_inspector"],
  inspector_review_backoff: ["waiting_for_inspector"],
  inspector_review_error: ["waiting_for_inspector"],
  inspector_round_limit: ["blocked"],
  inspector_unadopted_pr: ["waiting_for_pr"],
  inspector_working_tree_not_pushed: ["waiting_for_session"],
};

/**
 * Why a stopped run stopped, as a short clause to hang off its status word.
 *
 * Deliberately a different grain from the whole-sentence maps on a run's own page: these are
 * three or four words for a triage column that is 240px of 10px mono. "Blocked" alone is the
 * complaint this map answers - it is true of thirty rows at once and actionable on none of
 * them.
 *
 * `phase` is a free `string` and NOT a union: `orphanBinding` and every `setRunState` caller
 * write their own reason code into it, and a row written by a newer daemon may name a phase
 * this build has never heard of. So the lookup FALLS BACK to `phase.replaceAll("_", " ")`,
 * and an unmapped code has to degrade to readable text rather than to `undefined`.
 *
 * It lives HERE, beside the phase registry, for two reasons that used to pull against each
 * other. The registry is what `blockedPhaseClauseGaps` walks, so the vocabulary and the
 * phases it must cover cannot drift into separate modules. And `alerts.ts` runs in the
 * daemon as well as the browser: while this map sat in `src/web/`, the notification fired at
 * the moment a run blocked printed the raw phase through its own hand-rolled copy of the
 * fallback, so the alert and the triage column disagreed about one field by construction.
 *
 * A clause that merely restates its own identifier is the defect wearing a map key, which is
 * why `blockedPhaseClauseGaps` rejects one. `delivery_blocked` and `delivery_refused` were
 * mapped for a release to values character-for-character identical to the fallback, and no
 * reader saw a difference.
 */
const BLOCKED_PHASE_CLAUSES: Record<string, string> = {
  session_disappeared: "session gone",
  round_limit: "out of rounds",
  // Written by the gate as an EVENT kind today rather than as a phase (the phase it sets is
  // `round_limit`), so this entry is insurance rather than a live case. It costs one line and
  // it means a later code change cannot silently produce "inspector round limit" prose.
  inspector_round_limit: "out of GitHub Inspector rounds",
  infrastructure_error: "provider call failed",
  inspector_findings: "GitHub Inspector findings",
  inspector_disabled: "GitHub Inspector off",
  inspector_pr_closed: "PR closed",
  inspector_head_mismatch: "head moved",
  inspector_gate_context_invalid: "gate context lost",
  // The gate is pinned to one pull request and the session now proposes another, so the
  // switch is refused rather than followed. Named for the STATE a reader has to resolve -
  // two pull requests, one of them pinned - not for the refusal, which the status word
  // beside it already carries.
  inspector_pr_switch_refused: "pinned to a different PR",
  // The three delivery blocks in one vocabulary, because their remedies differ and the
  // status word cannot tell them apart. `deliveryBlock` refuses BEFORE the first byte, so
  // nothing was typed; `delivery_refused` is the one case with positive evidence that an
  // attempted write did not land (`pasted === false`); uncertain is neither.
  delivery_blocked: "packet never sent",
  delivery_refused: "pane refused the write",
  delivery_uncertain: "delivery unconfirmed",
  // Both prepare paths failed while BUILDING a packet, before any destination was involved.
  // Spelled apart because the pull-request handoff is the one an operator can also perform
  // by hand, and a reader who cannot tell which packet failed cannot tell that.
  delivery_prepare_error: "packet not prepared",
  pr_handoff_prepare_error: "PR handoff not prepared",
  // `schedulePreparedDelivery` re-drives a packet that was already prepared - after a
  // restart, or when a sibling repository's turn frees up - and threw. The packet still
  // exists, which is what separates this from the two above.
  delivery_recovery_error: "packet resend failed",
  stale_capture: "evidence went stale",
  capture_error: "capture failed",
  // NOT "evidence image changed", which names one of the dozen codes
  // `WorkflowImageEvidenceError` carries - changed, missing, a symlink, an unsupported MIME
  // type, over the aggregate byte limit. What is true of every one of them is that capture
  // re-opened what a session registered and would not use it. Run detail names the specific
  // code; this column says which half of the run to look at.
  image_evidence_capture: "registered evidence refused",
  // `engine.recover` writes this for a run caught mid-capture, with the error "Evidence
  // capture was interrupted by daemon restart; submit again". The restart is the fact the
  // operator needs - nothing about the run or its evidence was wrong.
  capture_interrupted: "daemon restarted",
  // The manager's two refusals for an evidence snapshot that did not move between rounds. Both
  // were missing, so a run parked on either printed the raw phase code through the fallback
  // below - "unchanged evidence exhausted" - in the one column whose whole job is being read.
  unchanged_evidence: "evidence unchanged",
  unchanged_evidence_exhausted: "evidence never changed",
  // Borrowed verbatim from `runRefusedSentence`'s "same commit, same working tree" rather
  // than invented beside it: this is the same refusal said shorter, and two vocabularies for
  // one fact is what a reader has to reconcile.
  unchanged_repository: "same commit and tree",
  // The binding paused because the bound session started a different conversation, so the
  // turn this run was reviewing can no longer be attributed. "The session's conversation was
  // replaced" is already how `ACTION_BLOCK_SENTENCES` words it.
  conversation_changed: "conversation replaced",
  // A check node's retry is WITHHELD while its pooled worktree's lease is unresolved, and the
  // reclamation pass schedules it the moment it can. Named for the withheld retry rather than
  // the lease, which is internal machinery an operator has no handle on - and self-clearing,
  // so this is the rare clause that describes a wait rather than a dead end.
  check_cleanup_unresolved: "check retry withheld",
  // NOT "action could not run": half the codes reaching `blockSessionAction` are raised after
  // the packet was delivered and the turn began - `session_lost`, `conversation_changed`,
  // `capture_failed` - and only the other half (`prompt_too_large`, `adapter_unavailable`,
  // `delivery_refused`) mean it never started. What holds for all of them is that no result
  // came back.
  session_action_blocked: "action did not finish",
  // An externally sourced submission is refused when the checkout is not where its caller
  // promised: `expectationMismatch` compares HEAD and, when the caller asked for it, a clean
  // working tree. Both halves are named because restoring the commit and cleaning the tree
  // are different actions.
  external_artifact_mismatch: "wrong commit or dirty tree",
  // Stated as the budget it ran out of, matching `round_limit` above, because the cap and the
  // repair-round cap are the two an operator meets and telling them apart is the whole point.
  // "refinement" is this product's own word for the retry - the readiness card already prints
  // "This round has spent its evidence preflight refinements".
  preflight_refinement_exhausted: "out of evidence refinements",
  // Not a block at all: the binding was reattached to a live session and the run is parked
  // until somebody opens the next round. The clause says what HAPPENED; the remedy button
  // beside it says what to do about it, which is why this is not "reattached, needs
  // resubmit" - the second half would be the button repeating itself into a column that
  // cannot hold it.
  reattached_resubmit_required: "reattached",
};

/** The short cause for `phase`, or the phase code made readable when it is unmapped. */
export function blockedPhaseClause(phase: string): string {
  return BLOCKED_PHASE_CLAUSES[phase] ?? blockedPhaseFallback(phase);
}

/** What an unmapped phase renders as. One spelling, so no two surfaces can disagree. */
function blockedPhaseFallback(phase: string): string {
  return phase.replaceAll("_", " ");
}

/**
 * Every blocked-capable phase that still renders as its own identifier, with why.
 *
 * The guard behind the vocabulary, exported so a test can state the rule once rather than
 * re-deriving it. A phase is added to `WORKFLOW_RUN_PHASES` and `WORKFLOW_RUN_PHASE_STATUSES`
 * by whoever needs to write it, and nothing about that edit mentions this map - so the
 * DEFAULT for a new blocked phase is to ship unnamed, printing `preflight_refinement_exhausted`
 * at an operator through a fallback that is silent and plausible-looking.
 *
 * Two kinds of gap, because a key-existence check is known to be insufficient here rather
 * than suspected to be: `delivery_blocked` and `delivery_refused` carried entries whose value
 * was character-for-character what the fallback already produced, so mapping them changed
 * nothing a reader saw.
 *
 * ONE-DIRECTIONAL on purpose. The map legitimately holds `unchanged_evidence` and
 * `reattached_resubmit_required`, which are `waiting_for_session` phases rather than blocked
 * ones, because the triage column also renders parked runs. Every blocked-capable phase owes
 * a clause; not every clause owes a blocked-capable phase.
 */
export function blockedPhaseClauseGaps(): { phase: WorkflowRunPhase; problem: string }[] {
  const gaps: { phase: WorkflowRunPhase; problem: string }[] = [];
  for (const phase of WORKFLOW_RUN_PHASES) {
    if (!WORKFLOW_RUN_PHASE_STATUSES[phase].includes("blocked")) continue;
    const clause = BLOCKED_PHASE_CLAUSES[phase];
    if (clause === undefined) {
      gaps.push({
        phase,
        problem: `has no BLOCKED_PHASE_CLAUSES entry, so it renders as "${
          blockedPhaseFallback(phase)}". Add three or four words naming the CAUSE a reader `
          + "can act on, grounded in the code that writes the phase.",
      });
      continue;
    }
    if (clause === blockedPhaseFallback(phase)) {
      gaps.push({
        phase,
        problem: `is mapped to "${clause}", which is exactly what the unmapped fallback `
          + "already produces. An entry that restates its own identifier adds a map key and "
          + "changes nothing a reader sees; write one that beats the fallback.",
      });
    }
  }
  return gaps;
}

/**
 * The keys each declared phase's own detail may carry.
 *
 * The companion to the status contract, and the answer to the same question on the other
 * axis. Status was pinned first because it carries the loudest contradictions; leaving detail
 * unpinned meant a registered phase would still accept ANY object - `delivery_refused` with a
 * node id, `capture_error` with a delivery id - because the decoder classified anything it did
 * not recognise as `opaque` and no rule looked further. A phase that accepts arbitrary
 * payloads is not one lifecycle state, which is the whole property this model exists to hold.
 *
 * An ALLOWED-key whitelist rather than a required-key list, and the difference matters. Writers
 * for one phase legitimately differ in which optional fields they fill: `infrastructure_error`
 * is written with and without `attempts`, `image_evidence_capture` with and without `error`.
 * Requiring keys would refuse those honest writers; bounding the key SET refuses the
 * contradictions - a payload naming something this phase has no business recording - while
 * leaving every writer that says less than it could.
 *
 * An empty list means the phase records no detail of its own. Those runs may still carry the
 * sticky GitHub Inspector gate, which is stripped before this rule is applied because it is
 * never phase detail: `pr_handoff` and the `inspector_*` phases are exactly the ones whose
 * whole payload is the gate.
 */
/**
 * What a confirmed or operator-resolved delivery records on the run it lands on.
 *
 * Spread into every phase `DELIVERY_RUN_PHASE` can move a run into, because a delivery is not
 * a phase of its own: it confirms a packet and leaves the run in whatever state that packet
 * created. Two of those writers record the delivery directly, and the rest carry the run's
 * existing payload across the phase change - which is how an `evidence_readiness` run comes to
 * be holding the delivery blob an earlier uncertain send left behind.
 */
/**
 * The Persona verdict packet a graph edge carries, as the engine composes it.
 *
 * Written verbatim by the three phases that record a verdict: the repair hand-back, and the
 * two End outcomes. Named once rather than spelled three times, because it is one shape and a
 * fourth key added to the packet must reach all three at once.
 */
const PERSONA_VERDICT_KEYS = ["outcome", "persona", "verdict", "requestedChanges"] as const;

const DELIVERY_CARRIED_KEYS = [
  "deliveryId",
  "reason",
  "transcriptAnchor",
  "resolvedByOperator",
] as const;

export const WORKFLOW_RUN_PHASE_DETAIL_KEYS: Record<WorkflowRunPhase, readonly string[]> = {
  activating: [],
  binding_archived: ["reason"],
  capture_error: ["error", "code"],
  capture_interrupted: ["error"],
  capturing: [],
  check_cleanup_unresolved: ["nodeId", "attempts", "error"],
  complete: [...PERSONA_VERDICT_KEYS, "label", "completionPolicy"],
  conversation_changed: ["reason"],
  delivery_blocked: ["deliveryId", "reason"],
  delivery_prepare_error: ["submissionId", "error"],
  delivery_recovery_error: ["deliveryId", "error"],
  delivery_refused: ["deliveryId", "reason"],
  delivery_uncertain: ["deliveryId", "reason"],
  evidence_readiness: ["submissionId", "gapCodes", ...DELIVERY_CARRIED_KEYS],
  evidence_readiness_capture: [],
  external_artifact_mismatch: [
    "expectedHeadSha",
    "headSha",
    "headMatches",
    "workingTreeDirty",
    "requireCleanWorktree",
  ],
  failed_outcome: [...PERSONA_VERDICT_KEYS, "label", "completionPolicy"],
  // Allowed, never required, so a row written before the identity existed keeps decoding.
  image_evidence_capture: ["error", "code", "itemName", "itemClientId"],
  infrastructure_error: ["nodeId", "attempts", "error"],
  invalid_version: ["error"],
  missing_workflow_version: ["error"],
  // Three writers: the Persona's verdict packet, the delivery confirmation, and the
  // operator's manual resolution of an uncertain send.
  persona_feedback: [...PERSONA_VERDICT_KEYS, ...DELIVERY_CARRIED_KEYS],
  persona_review: [],
  pr_handoff: [...DELIVERY_CARRIED_KEYS],
  pr_handoff_prepare_error: ["submissionId", "error"],
  // The run stays parked on the submission that is still waiting for readiness, so the
  // delivery keys ride along for the same reason `evidence_readiness` carries them: a
  // packet confirmed while the round is parked here lands on this phase.
  preflight_refinement_exhausted: ["submissionId", "round", "refinements", ...DELIVERY_CARRIED_KEYS],
  reattached_resubmit_required: ["priorNoteKey", "noteKey"],
  round_limit: ["maxRepairRounds", "parkedPhase"],
  session_action: ["nodeId", "attemptId", "action", ...DELIVERY_CARRIED_KEYS],
  session_action_blocked: ["nodeId", "attemptId", "code", "detail"],
  session_action_capture: ["nodeId", "attemptId", "submissionId"],
  session_action_parallel_unsupported: ["error"],
  session_disappeared: ["reason"],
  stale_capture: ["error"],
  unchanged_evidence: ["evidenceFingerprint", "unchangedRefusals", ...DELIVERY_CARRIED_KEYS],
  unchanged_evidence_exhausted: ["evidenceFingerprint", "unchangedRefusals"],
  unchanged_repository: ["round", "evidenceFingerprint"],
  inspector_adapter_error: [],
  inspector_awaiting_fresh_observation: [],
  inspector_disabled: [],
  inspector_findings: [...DELIVERY_CARRIED_KEYS],
  inspector_gate_context_invalid: ["error"],
  inspector_head_mismatch: [],
  inspector_missing_pr: [],
  inspector_pr_closed: [],
  inspector_pr_switch_refused: [],
  inspector_review: [],
  inspector_review_backoff: [],
  inspector_review_error: [],
  inspector_round_limit: ["maxRepairRounds", "parkedPhase"],
  inspector_unadopted_pr: [],
  inspector_working_tree_not_pushed: [],
};

/** The reserved key a phase detail carries the sticky gate under. See `withInspectorGate`. */
export const WORKFLOW_GATE_DETAIL_KEY = "gate";

/** Longest phase a caller may persist. Generous against every literal; a bound on the blobs. */
export const WORKFLOW_RUN_PHASE_MAX = 200;

/** What a run has spent, recorded on the way into a round-limit block so a grant can undo it. */
export interface WorkflowRoundLimitBudget {
  /** The budget in force when the run stopped, or null on a record that predates it. */
  maxRepairRounds: number | null;
  /** The phase the run was parked in before the block, or null when it was never recorded. */
  parkedPhase: string | null;
}

/** The withheld check retry a resolved worktree lease lets `resumeClearedCheckCleanup` schedule. */
export interface WorkflowCheckCleanupBlock {
  nodeId: string;
  attempts: number;
  error: string;
}

/**
 * Every phase a run blocks in when evidence capture refused the round, as a closed set.
 *
 * `external_artifact_mismatch` is deliberately absent: it records the two commits it compared
 * rather than an `error` sentence, so it is explained from other fields.
 */
export const WORKFLOW_CAPTURE_FAILURE_PHASES = [
  "capture_error",
  "capture_interrupted",
  "image_evidence_capture",
  "stale_capture",
] as const satisfies readonly WorkflowRunPhase[];

/**
 * Why evidence capture refused a round. `error` is required - a payload with no cause decodes
 * `opaque` rather than becoming a refusal a header would print as a blank claim.
 */
export interface WorkflowCaptureFailure {
  error: string;
  code: string | null;
  /** Null together on a row written before the throw site attached them; degrade, never guess. */
  itemName: string | null;
  itemClientId: string | null;
}

/**
 * The closed set of PHASE-SCOPED detail payloads, tagged.
 *
 * Phase-scoped is the distinction that makes this a union at all. `gate_state_json` carries
 * two things that vary independently: whatever the current phase recorded about itself, and
 * the GitHub Inspector gate context, which outlives any single phase. Folding both into one
 * union is what let a writer with both in hand persist one and destroy the other. So the
 * detail is a union and the gate is a field beside it, and a record can carry either, both,
 * or neither.
 *
 * `opaque` is the point of the union rather than its escape hatch: a phase detail nobody
 * declared - a legacy row, a reason blob, an end node's output - stays readable under
 * `detail`, and every accessor below refuses to hand it to an executable path.
 */
export type WorkflowGateDetail =
  | { kind: "none" }
  | { kind: "round_limit"; budget: WorkflowRoundLimitBudget }
  | { kind: "check_cleanup"; block: WorkflowCheckCleanupBlock }
  | { kind: "capture_failure"; failure: WorkflowCaptureFailure }
  | { kind: "opaque"; detail: WorkflowJson };

export type WorkflowGateDetailKind = WorkflowGateDetail["kind"];

/** The three persisted columns, as any caller can supply them. */
export interface WorkflowRunLifecycleRecord {
  status: WorkflowRunStatus;
  phase: string;
  gateState: WorkflowJson | null;
}

export interface WorkflowRunLifecycle {
  status: WorkflowRunStatus;
  phase: string;
  /** What this phase recorded about itself. */
  detail: WorkflowGateDetail;
  /**
   * The GitHub Inspector gate the run holds, wherever the record stored it.
   *
   * Beside the detail rather than inside it, because it is sticky: a run keeps the pull
   * request it is gated on across a refusal, a delivery block, and a spent repair budget, all
   * of which want to record something of their own in the same column.
   */
  gate: WorkflowInspectorGateState | null;
  /**
   * Whether this build knows what the phase means - see `WORKFLOW_RUN_PHASES`.
   *
   * Reported separately from `executable` so an unrecognised state stays fully INSPECTABLE.
   * A surface can say "this run is in a state this build does not know" and still show the
   * phase, the status, the gate and the raw detail, which is exactly what a legacy row or a
   * row from a newer daemon needs.
   */
  phaseRecognized: boolean;
  /**
   * The keys this phase's OWN detail carries, with the sticky gate excluded.
   *
   * Surfaced rather than recomputed by each caller because it is what the detail contract is
   * checked against, and because "what did this phase actually record" is a question a
   * diagnostic surface asks of an unrecognised record too.
   */
  detailKeys: readonly string[];
  /**
   * Whether an engine path may act on this record.
   *
   * THREE conditions, and the third is the one that is easy to leave out. False for a
   * finished run, false for an `opaque` payload, and false for a phase this build does not
   * recognise - including one whose detail is null or otherwise perfectly well formed. A null
   * detail under an unknown phase is not "nothing to misread"; it is a lifecycle state whose
   * MEANING is unknown, and the executable paths are keyed on phase rather than on payload,
   * so treating it as actionable is the same mistake as trusting an unreadable payload.
   *
   * A legacy or unrecognised record therefore stays fully inspectable - `phaseRecognized`
   * names the situation and the raw JSON is right there under `detail` - while being
   * structurally incapable of being mistaken for a block to resume or a budget to restore.
   *
   * The gate is deliberately NOT covered by this flag: it parsed against its own schema or it
   * is null, so there is no unrecognised gate for anything to act on, and a finished or
   * unknown-phase run must still be able to say which pull request it was reviewing.
   */
  executable: boolean;
}

function asRecord(value: WorkflowJson | null | undefined): { [key: string]: WorkflowJson } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as { [key: string]: WorkflowJson };
}

function inspectorGate(value: unknown): WorkflowInspectorGateState | null {
  const parsed = WorkflowInspectorGateStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isSpentPhase(phase: string): boolean {
  return (WORKFLOW_RUN_SPENT_PHASES as readonly string[]).includes(phase);
}

function roundLimitBudget(detail: { [key: string]: WorkflowJson }): WorkflowRoundLimitBudget | null {
  const budget = detail.maxRepairRounds;
  const parked = detail.parkedPhase;
  const maxRepairRounds = typeof budget === "number" && Number.isInteger(budget) && budget >= 0
    ? budget
    : null;
  // A parked phase that is itself a spent phase is no restore target: it would put a granted
  // run back into the very block it is leaving.
  const parkedPhase = typeof parked === "string" && parked.length > 0 && !isSpentPhase(parked)
    ? parked
    : null;
  if (maxRepairRounds === null && parkedPhase === null) return null;
  return { maxRepairRounds, parkedPhase };
}

function checkCleanupBlock(
  detail: { [key: string]: WorkflowJson },
): WorkflowCheckCleanupBlock | null {
  const { nodeId, attempts, error } = detail;
  if (typeof nodeId !== "string" || nodeId === "") return null;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) return null;
  return { nodeId, attempts, error: typeof error === "string" ? error : "" };
}

/** A string that is actually there. */
function optionalText(value: WorkflowJson | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function captureFailure(
  detail: { [key: string]: WorkflowJson },
): WorkflowCaptureFailure | null {
  const { error, code, itemName, itemClientId } = detail;
  if (typeof error !== "string" || error === "") return null;
  return {
    error,
    code: optionalText(code),
    itemName: optionalText(itemName),
    itemClientId: optionalText(itemClientId),
  };
}

/**
 * Read one run's three lifecycle columns as exactly one state.
 *
 * Phase-first for the detail, and that ordering is the contract. `infrastructure_error` and
 * `check_cleanup_unresolved` persist the same three keys, so a payload-first decoder would
 * hand an exhausted node to the cleanup resume path; asking the phase first is what keeps the
 * two apart. Total: every triple lands somewhere, and a payload that matches nothing lands on
 * `opaque` rather than on a guess.
 */
export function decodeWorkflowRunLifecycle(
  record: WorkflowRunLifecycleRecord,
): WorkflowRunLifecycle {
  const raw = record.gateState;
  const rawRecord = asRecord(raw);
  // A record that is ONLY the gate is the shape every gate transition writes, and the shape
  // its compare-and-set statements compare against byte for byte. It stays exactly that.
  const bare = inspectorGate(raw);
  const gate = bare ?? inspectorGate(rawRecord?.[WORKFLOW_GATE_DETAIL_KEY]);
  // The phase's own detail is what the RAW record holds beyond the keys the gate consumed,
  // and computing it from the raw object rather than from the parse is the whole point. The
  // gate schema is non-strict, so it accepts a payload that is a valid gate PLUS strays and
  // returns only the gate; but SQLite stores the object it was handed, strays and all. Reading
  // the parse would therefore report no phase detail on a record that persists one, which is
  // exactly how a phase declaring no detail of its own could be written carrying `error`.
  const consumed = new Set<string>([
    ...(bare ? Object.keys(bare) : []),
    WORKFLOW_GATE_DETAIL_KEY,
  ]);
  const own = rawRecord
    ? Object.fromEntries(
        Object.entries(rawRecord).filter(([key]) => !consumed.has(key)),
      ) as { [key: string]: WorkflowJson }
    : null;
  const detail = decodeDetail(record, own, gate !== null);
  const phaseRecognized = workflowRunPhaseRecognized(record.phase);
  return {
    status: record.status,
    phase: record.phase,
    detail,
    gate,
    phaseRecognized,
    detailKeys: own ? Object.keys(own) : [],
    executable: phaseRecognized
      && detail.kind !== "opaque"
      && !(WORKFLOW_RUN_TERMINAL_STATUSES as readonly string[]).includes(record.status),
  };
}

function decodeDetail(
  record: WorkflowRunLifecycleRecord,
  own: { [key: string]: WorkflowJson } | null,
  gated: boolean,
): WorkflowGateDetail {
  if (record.gateState === null) return { kind: "none" };
  if (!own) {
    // Not a JSON object at all, so it cannot be phase detail.
    return gated ? { kind: "none" } : { kind: "opaque", detail: record.gateState };
  }
  // Nothing beyond the gate: the record carries no phase detail of its own.
  if (Object.keys(own).length === 0) return { kind: "none" };
  if (isSpentPhase(record.phase)) {
    const budget = roundLimitBudget(own);
    return budget ? { kind: "round_limit", budget } : { kind: "opaque", detail: own };
  }
  if (record.phase === WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE && record.status === "blocked") {
    const block = checkCleanupBlock(own);
    return block ? { kind: "check_cleanup", block } : { kind: "opaque", detail: own };
  }
  // Phase-first, like the branch above: `capture_error` and `image_evidence_capture` persist
  // the same two keys, so only the phase tells them apart.
  if (
    (WORKFLOW_CAPTURE_FAILURE_PHASES as readonly string[]).includes(record.phase)
    && record.status === "blocked"
  ) {
    const failure = captureFailure(own);
    return failure ? { kind: "capture_failure", failure } : { kind: "opaque", detail: own };
  }
  return { kind: "opaque", detail: own };
}

/**
 * The live GitHub Inspector gate this run holds, or null.
 *
 * Finds it wherever the record kept it - alone in the column, or beside a phase detail under
 * the reserved key - which is the point: a run that is refused a resubmission, blocked on an
 * uncertain delivery, or out of repair budget keeps the pull request, the entry time, and the
 * finding fingerprints it was reviewing, instead of having them overwritten by the note the
 * phase wanted to leave. A terminal run keeps its gate readable here because the gate is what
 * a finished review's result IS; `executable` is the flag that says nothing may act on it.
 */
export function workflowInspectorGate(
  record: WorkflowRunLifecycleRecord,
): WorkflowInspectorGateState | null {
  return decodeWorkflowRunLifecycle(record).gate;
}

/** The withheld check retry, only on a run actually blocked in the cleanup phase. */
export function workflowCheckCleanupBlock(
  record: WorkflowRunLifecycleRecord,
): WorkflowCheckCleanupBlock | null {
  const lifecycle = decodeWorkflowRunLifecycle(record);
  return lifecycle.executable && lifecycle.detail.kind === "check_cleanup"
    ? lifecycle.detail.block
    : null;
}

/**
 * Why capture refused this round, only on a run actually blocked in a capture phase.
 *
 * The one typed reader of a capture-family phase detail: add readers here rather than
 * re-parsing `gateState` at a call site, so two surfaces cannot disagree about one row.
 */
export function workflowCaptureFailure(
  record: WorkflowRunLifecycleRecord,
): WorkflowCaptureFailure | null {
  const lifecycle = decodeWorkflowRunLifecycle(record);
  return lifecycle.executable && lifecycle.detail.kind === "capture_failure"
    ? lifecycle.detail.failure
    : null;
}

/** What a spent run recorded on the way into its block, for the grant that undoes it. */
export function workflowRoundLimitBudget(
  record: WorkflowRunLifecycleRecord,
): WorkflowRoundLimitBudget | null {
  const lifecycle = decodeWorkflowRunLifecycle(record);
  return lifecycle.executable && lifecycle.detail.kind === "round_limit"
    ? lifecycle.detail.budget
    : null;
}

/**
 * The phase a spent run was parked in before its budget ran out, or null if never recorded.
 *
 * A run that spends its budget otherwise loses the only record of what it was waiting for:
 * the block overwrites `current_phase` with `round_limit`. That was survivable while a grant
 * only handed the run to a human's next click, and is not now that a grant may hand it back
 * to the resumption observer - `pr_handoff` takes a different branch there than an ordinary
 * repair round does. So the phase rides along in the same payload as the budget, written by
 * the one store helper every round-limit writer goes through, and is deliberately NOT
 * re-recorded on a second block: a run blocked, granted, resumed and blocked again must keep
 * pointing at the round it was parked in rather than at `round_limit` itself.
 *
 * Absence is meaningful and is why this returns `null` rather than a default. A run blocked
 * by a build that predates the field cannot say what it was doing, and guessing would restore
 * it into a phase whose branch never ran; those runs keep the behaviour they were blocked
 * under, where the grant raises the budget and the operator resumes by hand.
 */
export function workflowRoundLimitParkedPhase(record: WorkflowRunLifecycleRecord): string | null {
  return workflowRoundLimitBudget(record)?.parkedPhase ?? null;
}

/**
 * Attach the run's sticky gate to a phase detail that is about to replace it.
 *
 * `gate_state_json` carries two things that vary independently: the phase's own detail, and
 * the GitHub Inspector gate context, which outlives any single phase. Every writer that had
 * both in hand wrote one and destroyed the other - a parked `pr_handoff` run that spent its
 * budget lost its pull request permanently, and no later grant could give it back. Writers
 * with a gate to keep call this; the decoder reads the reserved key back under every phase.
 *
 * A record with no phase detail of its own stays the BARE gate rather than an envelope around
 * it. That is not tidiness: the gate transitions compare-and-set on the exact JSON of the
 * column, so wrapping a gate that had nothing to sit beside would silently stop every one of
 * those updates from matching.
 */
export function withInspectorGate(
  detail: { [key: string]: WorkflowJson },
  gate: WorkflowInspectorGateState | null,
): WorkflowJson {
  if (!gate) return detail as WorkflowJson;
  // A detail with nothing in it is not a detail, and wrapping the gate in an envelope for the
  // sake of an empty object is exactly the shape the doc above warns against: the gate
  // transitions compare-and-set on the column's exact JSON, so `{ gate: {...} }` where the
  // bare gate belongs would silently stop those updates from matching. No caller passes an
  // empty detail today; this keeps the promise for the first one that does.
  if (Object.keys(detail).length === 0) return gate as unknown as WorkflowJson;
  return { ...detail, [WORKFLOW_GATE_DETAIL_KEY]: gate as unknown as WorkflowJson } as WorkflowJson;
}

/**
 * Why this triple must not be persisted, or null when it is a state the daemon can be in.
 *
 * Every rule here is a combination that no writer produces and that no reader could recover
 * from - a run stranded with no observer, a resume path armed over the wrong payload, a
 * finished run still advertising work to do. They are refusals rather than repairs on purpose:
 * a caller reaching one has a bug at the call site, and silently normalising it would persist
 * a state its author did not mean and nobody would ever look for.
 */
export function workflowRunLifecycleViolation(
  record: WorkflowRunLifecycleRecord,
): string | null {
  if (record.phase.length === 0) return "a run phase must not be empty";
  if (record.phase.length > WORKFLOW_RUN_PHASE_MAX) {
    return `a run phase must not exceed ${WORKFLOW_RUN_PHASE_MAX} characters`;
  }
  // There is deliberately NO rule refusing an `inspector_`-prefixed phase this build does not
  // declare. One existed, to catch the doubled `inspector_inspector_disabled` an interpolation
  // once minted, and it was wrong twice over. Every REGISTERED `inspector_` phase is a member
  // of the gate list by construction, so the rule could only ever fire on an UNRECOGNISED
  // phase - which made it the exact opposite of the contract this file states: a row from a
  // newer daemon may name anything and must stay storable. A foreign `inspector_` phase being
  // uniquely un-carryable meant an unrelated delivery landing on such a run threw, while the
  // same delivery on a run named `a_phase_from_a_newer_daemon` succeeded.
  //
  // The typo it was built for is now impossible earlier and more completely: `WorkflowRunPhase`
  // makes an undeclared phase a compile error at every authoritative writer and in every
  // phase-producing map. A runtime string check cannot improve on that, and here it only cost
  // the legacy guarantee.
  // The declared contract for a declared phase, checked before any of the special rules
  // below. Those rules cover the payloads something ACTS on; this covers the other forty-odd
  // phases, which previously had no rule at all - so a finished run could be persisted in a
  // delivery-refusal phase, or a running one in a capture phase, and nothing objected.
  const allowed = workflowRunPhaseRecognized(record.phase)
    ? WORKFLOW_RUN_PHASE_STATUSES[record.phase]
    : null;
  if (allowed && !allowed.includes(record.status)) {
    return `${record.phase} is persisted as ${allowed.join(" or ")}, not ${record.status}`;
  }
  const lifecycle = decodeWorkflowRunLifecycle(record);
  // The other axis of the same contract. Without it a registered phase accepted any object at
  // all, because the decoder called whatever it did not recognise `opaque` and nothing looked
  // further - so a delivery refusal could be persisted carrying a node id, and a capture
  // failure carrying a delivery id, each a phase recording something it has no business
  // knowing. The gate is already excluded from `detailKeys`; it is never phase detail.
  if (workflowRunPhaseRecognized(record.phase)) {
    const permitted = WORKFLOW_RUN_PHASE_DETAIL_KEYS[record.phase];
    const stray = lifecycle.detailKeys.filter((key) => !permitted.includes(key));
    if (stray.length > 0) {
      return permitted.length === 0
        ? `${record.phase} records no detail of its own, but carries ${stray.sort().join(", ")}`
        : `${record.phase} records ${permitted.join(", ")}, not ${stray.sort().join(", ")}`;
    }
  }
  const terminal = (WORKFLOW_RUN_TERMINAL_STATUSES as readonly string[]).includes(record.status);
  if (isSpentPhase(record.phase)) {
    if (record.status !== "blocked") {
      return `${record.phase} is a spent-budget block and requires the blocked status`;
    }
    // Budget OR gate: the two ways a spent run can still be granted out of its block. The
    // budget names the ceiling to raise and the phase to restore; a bare gate is the older
    // GitHub Inspector-only shape, revived through the `waiting_for_new_head` arm instead. A
    // block recording neither is one no grant can undo.
    if (lifecycle.detail.kind !== "round_limit" && !lifecycle.gate) {
      return `${record.phase} must record the budget it spent or the gate it still holds`;
    }
  }
  if (record.phase === WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE) {
    if (record.status !== "blocked") {
      return `${WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE} requires the blocked status`;
    }
    if (lifecycle.detail.kind !== "check_cleanup") {
      return `${WORKFLOW_CHECK_CLEANUP_UNRESOLVED_PHASE} must name the node and attempt to resume`;
    }
  }
  if ((WORKFLOW_GATE_OWNED_STATUSES as readonly string[]).includes(record.status)) {
    if (!lifecycle.gate) {
      return `${record.status} is un-parked only by the GitHub Inspector gate and requires its state`;
    }
    // Only for a phase this build declares. For an unrecognised one there is nothing to
    // compare against - this build cannot say whether a newer daemon's phase is a gate phase -
    // and the decoder has already reported the record non-executable, so the gate will not act
    // on it either way. Refusing the write would only make the legacy row unstorable.
    if (
      workflowRunPhaseRecognized(record.phase)
      && !(WORKFLOW_INSPECTOR_GATE_PHASES as readonly string[]).includes(record.phase)
    ) {
      return `${record.status} requires a GitHub Inspector gate phase, not ${record.phase}`;
    }
  }
  if (record.status === "waiting_for_action" && record.phase !== "session_action") {
    return "waiting_for_action is the session action wait and requires the session_action phase";
  }
  if (
    terminal
    && (lifecycle.detail.kind === "round_limit" || lifecycle.detail.kind === "check_cleanup")
  ) {
    return `a ${record.status} run must not carry a ${lifecycle.detail.kind} payload to resume`;
  }
  return null;
}
