import type {
  WorkflowNodeAttempt,
  WorkflowRepeatOffender,
  WorkflowSubmission,
} from "@shared/workflow.ts";
import { normalizePersonaVerdict } from "./verdict.ts";

function newestAttemptsByNode(
  attempts: WorkflowNodeAttempt[],
): Map<string, WorkflowNodeAttempt> {
  const newest = new Map<string, WorkflowNodeAttempt>();
  for (const attempt of attempts) {
    const previous = newest.get(attempt.nodeId);
    if (previous && previous.attempt > attempt.attempt) continue;
    newest.set(attempt.nodeId, attempt);
  }
  return newest;
}

function failedPersona(attempt: WorkflowNodeAttempt | undefined): boolean {
  return attempt?.persona !== null
    && normalizePersonaVerdict(attempt?.verdict)?.verdict === "fail";
}

/**
 * Consecutive persona failures, anchored at the run's latest submission.
 *
 * A REPAIR ROUND is the unit, not a submission, and the two stopped being the same thing
 * once a session action could split one round into several evidence segments. Walking
 * submissions would see two rows of the same round, decide the sequence had broken, and
 * report a reviewer that has failed five rounds running as having failed one - which is
 * precisely the loop the alert exists to surface. So the rows are folded to one entry per
 * round first, keeping each node's NEWEST attempt across that round's segments: a node
 * re-run after an action within the same round ends the round on that later answer.
 */
export function repeatOffenders(
  submissions: WorkflowSubmission[],
  attempts: WorkflowNodeAttempt[],
): WorkflowRepeatOffender[] {
  const ordered = [...submissions].sort((left, right) =>
    right.round - left.round
    || right.segment - left.segment
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id));
  const latest = ordered[0];
  if (!latest) return [];

  const submissionRound = new Map(ordered.map((submission) => [submission.id, submission.round]));
  const segmentOf = new Map(ordered.map((submission) => [submission.id, submission.segment]));
  // Newest-first per round, so `newestAttemptsByNode` keeps the highest segment's answer.
  const byRound = new Map<number, WorkflowNodeAttempt[]>();
  for (const attempt of attempts) {
    const round = submissionRound.get(attempt.submissionId);
    if (round === undefined) continue;
    byRound.set(round, [...(byRound.get(round) ?? []), attempt]);
  }
  const attemptsByRound = new Map<number, Map<string, WorkflowNodeAttempt>>();
  for (const [round, roundAttempts] of byRound) {
    attemptsByRound.set(round, newestAttemptsByNode([...roundAttempts].sort((left, right) =>
      (segmentOf.get(left.submissionId) ?? 0) - (segmentOf.get(right.submissionId) ?? 0)
      || left.attempt - right.attempt)));
  }

  const latestAttempts = attemptsByRound.get(latest.round);
  if (!latestAttempts) return [];

  return [...latestAttempts.values()]
    .filter(failedPersona)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .flatMap((candidate): WorkflowRepeatOffender[] => {
      let rounds = 0;
      for (let round = latest.round; round >= 1; round -= 1) {
        const attempt = attemptsByRound.get(round)?.get(candidate.nodeId);
        if (!failedPersona(attempt)) break;
        rounds++;
      }
      if (rounds < 2) return [];
      return [{
        nodeId: candidate.nodeId,
        personaName: candidate.persona!.name,
        rounds,
      }];
    });
}
