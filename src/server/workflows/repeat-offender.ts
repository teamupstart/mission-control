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

/** Consecutive persona failures, anchored at the run's latest submission. */
export function repeatOffenders(
  submissions: WorkflowSubmission[],
  attempts: WorkflowNodeAttempt[],
): WorkflowRepeatOffender[] {
  const ordered = [...submissions].sort((left, right) =>
    right.round - left.round
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id));
  const latest = ordered[0];
  if (!latest) return [];

  const attemptsBySubmission = new Map<string, Map<string, WorkflowNodeAttempt>>();
  for (const submission of ordered) {
    attemptsBySubmission.set(
      submission.id,
      newestAttemptsByNode(
        attempts.filter((attempt) => attempt.submissionId === submission.id),
      ),
    );
  }

  const latestAttempts = attemptsBySubmission.get(latest.id);
  if (!latestAttempts) return [];

  return [...latestAttempts.values()]
    .filter(failedPersona)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
    .flatMap((candidate): WorkflowRepeatOffender[] => {
      let rounds = 0;
      let expectedRound = latest.round;
      for (const submission of ordered) {
        if (submission.round !== expectedRound) break;
        const attempt = attemptsBySubmission.get(submission.id)?.get(candidate.nodeId);
        if (!failedPersona(attempt)) break;
        rounds++;
        expectedRound--;
      }
      if (rounds < 2) return [];
      return [{
        nodeId: candidate.nodeId,
        personaName: candidate.persona!.name,
        rounds,
      }];
    });
}
