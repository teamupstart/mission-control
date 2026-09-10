/**
 * The one refusal type every workflow-evidence path raises.
 *
 * It lives in a leaf module rather than in `images.ts` because the store raises it too, and
 * `images.ts` already imports `store.ts` for `frozenEvidenceId`. Defining it here is what keeps
 * the two from importing each other.
 *
 * A refusal carrying a code is the difference between an agent that can repair its next call
 * and one that retries the same payload: the route echoes `message` and `code` only for this
 * type, and reports anything else as an opaque `workflow_evidence_failed`. So a deliberate,
 * actionable refusal belongs here, and a genuinely unexpected throw belongs in the fallback.
 */
export class WorkflowImageEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 = 409,
  ) {
    super(message);
    this.name = "WorkflowImageEvidenceError";
  }
}
