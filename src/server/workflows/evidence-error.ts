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
    /**
     * The registered item this refusal is about, when it is about one.
     *
     * Structured rather than spliced into `message`: the message is echoed verbatim to an
     * agent and persisted into phase detail, so every consumer would otherwise have to parse
     * the name back out of a sentence.
     */
    readonly item: WorkflowEvidenceItemIdentity | null = null,
  ) {
    super(message);
    this.name = "WorkflowImageEvidenceError";
  }
}

/** The registered evidence item a refusal is about, as a reader needs to name it. */
export interface WorkflowEvidenceItemIdentity {
  /** The human name the session registered, such as `steering-context.png`. */
  displayName: string;
  /** The id it was registered under, which is what re-registering it replaces. */
  clientItemId: string;
}

/**
 * The same refusal, now naming its item.
 *
 * Adds an identity and never replaces one, because these wrappers nest: an outer frame must
 * not relabel a refusal the inner frame already attributed to the right item.
 */
export function withEvidenceItem(
  error: WorkflowImageEvidenceError,
  item: WorkflowEvidenceItemIdentity,
): WorkflowImageEvidenceError {
  if (error.item) return error;
  return new WorkflowImageEvidenceError(error.code, error.message, error.status, item);
}
