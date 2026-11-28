import { isDeepStrictEqual } from "node:util";
import { PersonaVerdictSchema, SessionActionCompletedOutputSchema, WorkflowContextSnapshotSchema, WorkflowInspectorGateStateSchema } from "@shared/protocol.ts";
import type { WorkflowBinding, WorkflowRun } from "@shared/workflow.ts";
import { workflowRunIntentFingerprint } from "./intent-fingerprint.ts";
import { workflowPullRequestCiContract } from "./agent-contract.ts";
import { sanitizeWorkflowFeedback } from "./packet-text.ts";
import { workflowPublicationTree } from "@shared/workflow-publication.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { transcriptFor } from "../harness/index.ts";
import type { MergedCiWitness } from "../inspector/github.ts";
import type { WorkflowStore } from "./store.ts";

/** Only the daemon-authored portion of the delivered PR packet establishes its CI policy. */
export function deliveredCiAction(store: WorkflowStore, actionId: string) {
  const action = store.getAttempt(actionId);
  if (action?.sessionAction?.completion.kind !== "pull_request") return null;
  const prompt = sanitizeWorkflowFeedback(action.sessionAction.promptMarkdown);
  return store.listDeliveriesForAttempt(actionId).find(delivery => {
    if (delivery.kind !== "session_action" || delivery.state !== "delivered" || !delivery.deliveredAt
      || !prompt || !delivery.payload.endsWith(prompt)) return false;
    const header = delivery.payload.slice(0, -prompt.length);
    const runLine = header.indexOf(`\nRun: ${delivery.runId}\n`);
    return runLine >= 0 && header.indexOf(workflowPullRequestCiContract(), runLine) > runLine;
  }) ?? null;
}

/** Both reviews must actually have reached End through a completed publication on round one. */
function publishedReview(store: WorkflowStore, run: WorkflowRun, binding: WorkflowBinding, key: string, ci: MergedCiWitness) {
  if (run.triggerSource !== "foreman" || run.intentProvenance?.verdict !== "objective"
    || run.evidencePrunedAt || run.checkBudgetEpochRound || run.disabledNodeIds?.length || run.personaDirectives?.length) return null;
  const submissions = store.listSubmissions(run.id);
  if (submissions.some(s => s.round !== 1 || s.mode !== "full_workflow" || s.triggerSource === "manual" || s.readiness?.status === "overridden")) return null;
  const terminal = submissions.at(-1);
  if (terminal?.status !== "completed" || !terminal.continuationNodeAttemptId) return null;
  const attempts = store.listAttemptsForRun(run.id);
  if (attempts.some(a => {
    if (a.state !== "completed" || a.error || a.operatorDirective) return true;
    if (!a.persona && a.verdict === null) return false;
    const verdict = PersonaVerdictSchema.safeParse(a.verdict);
    return !verdict.success || verdict.data.verdict !== "pass";
  })) return null;
  const action = attempts.find(a => a.id === terminal.continuationNodeAttemptId);
  const completed = SessionActionCompletedOutputSchema.safeParse(action?.output);
  if (!action || action.sessionAction?.completion.kind !== "pull_request" || action.submissionId !== terminal.parentSubmissionId
    || !completed.success || completed.data.continuationSubmissionId !== terminal.id) return null;
  const expected = completed.data.expectation;
  const parsed = WorkflowContextSnapshotSchema.safeParse(terminal.context);
  if (expected?.kind !== "pull_request" || expected.pullRequestKey !== key || !expected.repositoryRoot
    || (expected.expectedHeadOid && expected.expectedHeadOid !== ci.headSha) || (expected.branch && expected.branch !== ci.branch)
    || !expected.acceptedContentTreeOid || !parsed.success || parsed.data.session.cwd !== binding.sessionCwd
    || parsed.data.session.branch !== ci.branch) return null;
  const evidence = parsed.data.evidence;
  if (!evidence.headSha || !evidence.contentTreeOid || evidence.workingTreeDirty || evidence.workingTreeStatusTruncated
    || evidence.publication?.pathsTruncated || evidence.publication?.unpublishedPaths.length
    || evidence.publication?.artifactProblems?.length || workflowPublicationTree(evidence) !== expected.acceptedContentTreeOid) return null;
  return { terminal, actionId: action.id, evidence, expected, agent: parsed.data.session.agent };
}

export function duplicatePublicationProof(store: WorkflowStore, run: WorkflowRun, binding: WorkflowBinding,
  sessionId: string, key: string, ci: MergedCiWitness) {
  const prior = store.precedingPublicationClaim(run, sessionId, binding.noteKey);
  if (!prior || !(ci.startedAt <= prior.claimedAt && prior.claimedAt < ci.finishedAt
    && ci.finishedAt <= run.startedAt && run.startedAt < ci.mergedAt)) return null;
  const intent = run.intent;
  const earlier = prior.run.intent;
  if (!earlier?.intentSource || !intent?.intentSource || earlier.sourceNoteKey !== binding.noteKey
    || intent.sourceNoteKey !== binding.noteKey || earlier.intentSource.objectiveVersion !== intent.intentSource.objectiveVersion
    || earlier.intentSource.promptRevision !== intent.intentSource.promptRevision
    || earlier.intentSource.resolvedPromptRevision !== earlier.intentSource.promptRevision) return null;
  const gate = WorkflowInspectorGateStateSchema.safeParse(prior.run.gateState);
  if (!gate.success || gate.data.prKey !== key || gate.data.targetHeadSha !== ci.headSha
    || gate.data.observedHeadSha !== ci.headSha || gate.data.waitReason || gate.data.failedHeadSha
    || gate.data.reviewPosture !== "live" || gate.data.findingFingerprints.length || gate.data.grantObservation) return null;
  if (!store.listEvents(prior.run.id).some(event => event.kind === "inspector_gate_clean")) return null;
  const accepted = publishedReview(store, prior.run, binding, key, ci);
  const duplicate = publishedReview(store, run, binding, key, ci);
  if (!accepted || !duplicate || accepted.expected.acceptedContentTreeOid !== duplicate.expected.acceptedContentTreeOid
    || accepted.expected.repositoryRoot !== duplicate.expected.repositoryRoot
    || accepted.evidence.headSha !== duplicate.evidence.headSha || accepted.evidence.contentTreeOid !== duplicate.evidence.contentTreeOid
    || !store.deliveredActionOwnsPrompt(prior.run.id, sessionId, prior.episodeId, prior.promptedAt,
      earlier.intentSource.promptRevision, accepted.actionId)) return null;
  const delivery = deliveredCiAction(store, accepted.actionId);
  if (!delivery) return null;
  // Some historical captures classified the workflow's own PR packet as a human decision.
  // Only the exact confirmed message id of that delivery may be removed from the comparison.
  if (earlier.fingerprint !== intent.fingerprint || !isDeepStrictEqual(earlier.decisions, intent.decisions)) {
    const delivered = store.listEvents(prior.run.id).find(event => {
      const p = event.payload;
      return event.kind === "delivery_delivered" && p && typeof p === "object" && !Array.isArray(p)
        && p.deliveryId === delivery.id && p.submitVerified === true;
    })?.payload;
    if (!delivered || Array.isArray(delivered) || typeof delivered !== "object" || typeof delivered.clientMessageId !== "string") return null;
    const agent = AGENT_TYPES.find(type => type === duplicate.agent);
    const transcriptText = agent && transcriptFor({ agent })?.userMessageText?.(delivery.payload);
    const sentText = delivery.payload.trim();
    const decisions = intent.decisions.filter(d => !(d.source.kind === "transcript" && d.source.id === delivered.clientMessageId
      && d.rationale === null && (d.decision === sentText || d.decision === transcriptText)));
    if (workflowRunIntentFingerprint({ ...intent, decisions }) !== earlier.fingerprint
      || !isDeepStrictEqual(earlier.decisions, decisions)) return null;
  }
  // Catch a duplicate whose root was a different checkout and only returned to the old head during publication.
  const root = WorkflowContextSnapshotSchema.safeParse(store.listSubmissions(run.id)[0]?.context);
  if (!root.success || root.data.session.cwd !== binding.sessionCwd || root.data.session.branch !== ci.branch
    || root.data.evidence.workingTreeDirty || root.data.evidence.headSha !== accepted.evidence.headSha
    || root.data.evidence.contentTreeOid !== accepted.evidence.contentTreeOid) return null;
  return { accepted, duplicate, prior };
}
