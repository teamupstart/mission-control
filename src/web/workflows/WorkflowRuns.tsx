import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type {
  EvidenceRef,
  PersonaVerdict,
  WorkflowCheckOutcome,
  WorkflowExternalSource,
  WorkflowNodeAttempt,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowEventPage,
  WorkflowEvidenceCoverageClaim,
  WorkflowEvidenceImage,
  WorkflowEvidenceReadinessResult,
  WorkflowLlmCallPage,
  WorkflowUploadEvidenceLocator,
} from "@shared/workflow.ts";
import {
  WORKFLOW_LIMITS,
  formatCheckCommand,
  isVerdictNode,
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  workflowEvidenceReadinessPolicyEnforces,
} from "@shared/workflow.ts";
import { WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE } from "@shared/workflow-lifecycle.ts";
import { nodeLabel } from "@shared/workflow-stages.ts";
import { workflowRequest } from "./workflowApi.ts";
import { RunPipeline } from "./RunPipeline.tsx";
import { PersonaDirectiveEditor } from "./PersonaDirectiveEditor.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import type { SessionActionProgress } from "./run-model.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRunTone } from "../components/session-bits.tsx";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { formatBytes, relativeTime, repoLeaf } from "../lib/format.ts";
import type { WorkflowRunFilters } from "./useWorkflowRoute.ts";
import { requestWorkflowVersionOpen } from "./workflowSelection.ts";
import {
  useWorkflowEvidenceDraft,
  workflowBindingEvidenceOwner,
  workflowEvidenceScopes,
} from "./WorkflowEvidenceComposer.tsx";
import type { ChangeWorklistRow, ChangeWorklistState } from "./run-model.ts";
import {
  actionBlockSentence,
  actionWaitSentence,
  attemptStateLabel,
  cancelGateHint,
  cancelGateSentence,
  cancelReleasesGate,
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  continuationSourceAttempt,
  disabledStatusFor,
  endStatus,
  errorView,
  eventLine,
  eventsByRound,
  deliveryKindLabel,
  deliveryStateView,
  gateSummaryStatus,
  gateWaitSentence,
  inheritedAttempts,
  inheritedPasses,
  inspectorGateSentence,
  inspectorFooterStatus,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  readCapturedContext,
  reviewerAttempts,
  reviewerStatus,
  runChangeWorklist,
  runGrantNotice,
  runParkedSentence,
  evidenceChipLabel,
  openEvidenceTray,
  roundEvidenceCountLabel,
  roundFailedCaptureLabel,
  roundHoldsViewedSubmission,
  roundOpensEvidenceTray,
  runRefusedSentence,
  runRoundGroups,
  runRounds,
  runStalemates,
  runStatusLabel,
  segmentProvenanceSentence,
  selectedSubmission,
  provenPullRequest,
  sessionActionProgress,
  sessionActionStatus,
  shortSha,
  submissionStatus,
  spentInspectorGateCondition,
  spentInspectorGateStatus,
  verdictMeta,
  verdictOf,
  workflowCallCost,
  workflowFeedbackText,
  workflowRunLoadError,
} from "./run-model.ts";
import {
  copyFeedbackAction,
  deliveryResolutionActions,
  inspectorGateActions,
  refusedUnchangedRequestId,
  runActionTooltip,
  runNextMove,
  runNoMoveReason,
  type RunActionId,
  type RunNextMove,
} from "./run-actions.ts";
import { useRunActions } from "./run-action-store.ts";
import { createWorkflowLoadCommitBarrier } from "./workflow-load-commit.ts";
import { moveWorkflowRunSelection } from "./run-navigation.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";

/**
 * Watching a run.
 *
 * The rebuild's one idea: a run is read on the pipeline it was authored on. The strip is
 * drawn from the same `pipeline-bits.tsx` leaves the editor uses, fed the immutable
 * published graph and the runtime statuses this file already computed; the round scrubber
 * says which submission every scoped section is about; and every durable enum reaches the
 * screen as a sentence, with its machine code demoted to a detail affordance.
 *
 * Two rules the sections below keep, and they pull in opposite directions on purpose:
 *
 *  - The strip, the verdicts, the join packets and the timeline are SCOPED to the viewed
 *    round. An attempt from round 1 says nothing about round 3, and a reader that merged
 *    them showed a reviewer as passed while it was being re-run.
 *  - The Inspector gate, the completion claims, the deliveries and every recovery control
 *    reflect the LIVE run whatever round is being viewed, because they are the run's
 *    current state and acting on a stale copy of them is how a packet gets sent twice. A
 *    note says so whenever an older round is selected.
 *
 * Decision rules live in `run-model.ts` so they can be checked without rendering; this file
 * is the arrangement, the actions, and their enabling conditions.
 */

function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function LazyWorkflowEvidenceImage({
  runId,
  image,
}: {
  runId: string;
  image: WorkflowEvidenceImage;
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (load || image.availability !== "retained") return;
    const node = frame.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLoad(true);
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [image.availability, load]);
  useEffect(() => {
    if (!load || image.availability !== "retained") return;
    let live = true;
    void fetch(
      `/api/workflow-runs/${encodeURIComponent(runId)}/images/${encodeURIComponent(image.id)}`,
    ).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Image body could not be loaded (${response.status})`);
      }
      return response.blob();
    }).then((blob) => {
      const next = URL.createObjectURL(blob);
      if (!live) {
        URL.revokeObjectURL(next);
        return;
      }
      setUrl(next);
    }).catch((caught) => {
      if (live) setError(caught instanceof Error ? caught.message : "Image body could not be loaded");
    });
    return () => { live = false; };
  }, [image.availability, image.id, load, runId]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return (
    <div ref={frame} className="wf-image-frame">
      {image.availability === "pruned" ? (
        <span className="wf-image-pruned" aria-label={`${image.displayName} body pruned`}>Body pruned</span>
      ) : url ? (
        <img src={url} alt={image.caption} />
      ) : error ? (
        <span className="wf-image-error" role="alert">{error}</span>
      ) : (
        <Tooltip label={`Load the retained body for ${image.displayName}`}>
          <button type="button" className="text-btn" onClick={() => setLoad(true)}>
            {load ? "Loading image…" : "Load image"}
          </button>
        </Tooltip>
      )}
    </div>
  );
}

function SubmissionImageEvidence({
  runId,
  images,
  scopeOptions,
  canRestage,
  onRestage,
}: {
  runId: string;
  images: WorkflowEvidenceImage[];
  scopeOptions: readonly { value: string; label: string }[];
  canRestage: boolean;
  onRestage?: (image: WorkflowEvidenceImage, clientItemId: string) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [restaged, setRestaged] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const itemIds = useRef(new Map<string, string>());
  const scopeLabel = (scope: string): string =>
    scopeOptions.find((option) => option.value === scope)?.label ?? scope;
  return (
    <section className="wf-run-section wf-image-evidence">
      <header className="wf-run-section-head">
        <h4>Image evidence</h4>
        <span className="wf-run-meta">
          {images.length} image{images.length === 1 ? "" : "s"} frozen for this submission
        </span>
      </header>
      {images.length === 0 ? (
        <p className="wf-run-empty">No image evidence was attached to this submission.</p>
      ) : (
        <ol className="wf-image-ledger">
          {images.map((image) => (
            <li key={image.id} className={`wf-image-record is-${image.availability}`}>
              <LazyWorkflowEvidenceImage runId={runId} image={image} />
              <div className="wf-image-record-body">
                <div className="wf-image-record-head">
                  <strong>{image.caption}</strong>
                  <span className={`workflow-chip workflow-${image.availability === "retained" ? "completed" : "stopped"}`}>
                    {image.availability}
                  </span>
                </div>
                <p>{image.displayName}</p>
                <dl>
                  <div><dt>Scope</dt><dd>{scopeLabel(image.repositoryScope)}</dd></div>
                  <div><dt>Type</dt><dd>{image.mimeType}</dd></div>
                  <div><dt>Size</dt><dd>{formatBytes(image.bytes)}</dd></div>
                  <div><dt>Digest</dt><dd><code>{image.sha256}</code></dd></div>
                </dl>
                {image.availability === "pruned" && (
                  <p className="wf-run-pruned">
                    Raw body pruned {image.prunedAt ? when(image.prunedAt) : "by retention policy"}.
                    Caption, scope, MIME, size, and SHA-256 remain auditable.
                  </p>
                )}
                {image.availability === "retained" && canRestage && onRestage && (
                  <Tooltip label="Stage these exact retained bytes, caption, and scope for the next fresh review">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy === image.id || restaged.has(image.id)}
                      onClick={() => {
                        let clientItemId = itemIds.current.get(image.id);
                        if (!clientItemId) {
                          clientItemId = `history-${crypto.randomUUID()}`;
                          itemIds.current.set(image.id, clientItemId);
                        }
                        setBusy(image.id);
                        setError(null);
                        void onRestage(image, clientItemId).then(
                          () => setRestaged((current) => new Set(current).add(image.id)),
                          (caught) => setError(caught instanceof Error ? caught.message : "Could not stage retained image"),
                        ).finally(() => setBusy(null));
                      }}
                    >
                      {restaged.has(image.id) ? "Ready for next review" : "Use in next review"}
                    </button>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="wf-run-error" role="alert">{error}</p>}
    </section>
  );
}

function SubmissionEvidenceReadiness({
  coverage,
  readiness,
  enforced = false,
  waiting = false,
  refinementsExhausted = false,
  overrideReason = null,
  onRetry,
  onOverride,
}: {
  coverage: readonly WorkflowEvidenceCoverageClaim[];
  readiness: WorkflowEvidenceReadinessResult | null | undefined;
  enforced?: boolean;
  waiting?: boolean;
  /** The run is parked on this submission because the round spent its refinement cap. */
  refinementsExhausted?: boolean;
  overrideReason?: string | null;
  onRetry?: () => Promise<void>;
  onOverride?: (reason: string) => Promise<void>;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"retry" | "override" | null>(null);
  return (
    <section className="wf-run-section wf-evidence-readiness" aria-label="Evidence readiness">
      <header className="wf-run-section-head">
        <h4>Evidence readiness</h4>
        <span className={`workflow-chip workflow-${readiness?.status === "ready" ? "passed" : readiness ? "waiting" : "stopped"}`}>
          {readiness?.status.replaceAll("_", " ") ?? "not evaluated"}
        </span>
      </header>
      <p className="wf-run-meta">{enforced
        ? "Structural only. Test Evidence Auditor still judges whether the proof is relevant and sufficient."
        : "Advisory only. This result did not block workflow execution."}</p>
      {coverage.length === 0 ? (
        <p className="wf-run-empty">No acceptance criterion coverage was frozen for this submission.</p>
      ) : (
        <div className="wf-coverage-ledger">
          <h5>Frozen author claims</h5>
          {coverage.map((claim) => (
            <article key={claim.clientCriterionId} className="wf-run-card">
              <header className="wf-run-card-head">
                <strong>{claim.criterion}</strong>
                <span>{claim.proofClass.replaceAll("_", " ")}</span>
              </header>
              <p className="wf-run-meta">{claim.repositoryScope}</p>
              <div className="wf-evidence-links">
                {claim.links.length === 0 ? <span className="workflow-chip workflow-waiting">No evidence linked</span> : claim.links.map((link) => (
                  <span className="workflow-chip workflow-completed" key={`${link.clientItemId}:${link.role}`}>
                    {link.role.replaceAll("_", " ")}: {link.clientItemId}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {readiness?.status === "unavailable" && (
        <p className="wf-run-error" role="alert">Unavailable: {readiness.unavailableReason ?? "Context compaction did not return canonical criteria."}</p>
      )}
      {readiness && readiness.criteria.length > 0 && (
        <div className="wf-coverage-ledger">
          <h5>Canonical reconciliation</h5>
          {readiness.criteria.map((criterion) => (
            <article key={criterion.criterionId} className="wf-run-card">
              <header className="wf-run-card-head">
                <strong>{criterion.criterion}</strong>
                <span>{criterion.material ? "material" : "supporting"}</span>
              </header>
              {criterion.gaps.length > 0 && (
                <p className="wf-run-error">Gaps: {criterion.gaps.map((gap) => gap.replaceAll("_", " ")).join(", ")}</p>
              )}
              {criterion.warnings.length > 0 && (
                <p className="wf-run-notice">Warnings: {criterion.warnings.map((warning) => warning.replaceAll("_", " ")).join(", ")}</p>
              )}
              <div className="wf-evidence-links">
                {criterion.links.map((link) => (
                  <span className="workflow-chip workflow-completed" key={`${link.evidenceId}:${link.role}`}>
                    {link.role.replaceAll("_", " ")}: {link.clientItemId}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
      {overrideReason && (
        <p className="wf-run-notice" role="status">
          Operator continued despite gaps: {overrideReason}
        </p>
      )}
      {waiting && onOverride && (
        <div className="wf-readiness-override" role="region" aria-label="Evidence readiness override">
          <h5>Continue despite gaps</h5>
          {refinementsExhausted && (
            <p className="wf-run-notice" role="status">
              This round has spent its evidence preflight refinements without closing these gaps,
              so the run is blocked for you rather than refining again. Continue despite gaps to
              review this packet as it stands, or start a new round.
            </p>
          )}
          <label>
            Reason
            <textarea
              value={reason}
              maxLength={WORKFLOW_LIMITS.readinessOverrideReason}
              placeholder="Why this structurally incomplete packet should continue"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="wf-checkbox-label">
            <Tooltip label="Acknowledge that readiness gaps remain visible to the Test Evidence Auditor">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
            </Tooltip>
            Test Evidence Auditor may still reject this packet.
          </label>
          <div className="wf-run-actions">
            {onRetry && (
              <Tooltip label="Capture newly staged evidence and evaluate this round again">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy("retry");
                    void onRetry().finally(() => setBusy(null));
                  }}
                >
                  {busy === "retry" ? "Retrying…" : "Retry evidence preflight"}
                </button>
              </Tooltip>
            )}
            <Tooltip label="Record this reason and continue the current submission despite readiness gaps">
              <button
                type="button"
                className="btn"
                disabled={busy !== null || !acknowledged || reason.trim().length === 0}
                onClick={() => {
                  setBusy("override");
                  void onOverride(reason.trim()).finally(() => setBusy(null));
                }}
              >
                {busy === "override" ? "Continuing…" : "Continue despite gaps"}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </section>
  );
}

const EXTERNAL_SOURCE_LABELS: Record<WorkflowExternalSource["kind"], string> = {
  ensemble: "Ensemble",
};

/**
 * The rail's quick filters, mapped onto the ONE status the run list query accepts.
 *
 * Each chip is exactly one durable status rather than a client-side union: history is
 * cursor-paginated by the daemon, so a filter the browser applied after the fact would
 * silently drop rows out of a page and report the wrong count. The full `State` select
 * below the chips still reaches every status, so nothing is unreachable - the chips are the
 * four an operator asks for all day.
 */
const RUN_FILTER_CHIPS: {
  label: string;
  status: WorkflowRunStatus | undefined;
  hint: string;
}[] = [
  { label: "All", status: undefined, hint: "Every run in history" },
  { label: "Running", status: "running", hint: "Runs whose reviewers are working right now" },
  {
    label: "Needs you",
    status: "waiting_for_session",
    hint: "Runs waiting for you to repair the work and resubmit",
  },
  { label: "Done", status: "completed", hint: "Runs that completed" },
];

/**
 * Where a run came from, when something other than an operator started it.
 *
 * An Ensemble source deep-links to that run's detail under the Ensembles tab (the route landed
 * with the Phase 7 dashboard). If the ensemble was since deleted, the id lands on the Ensembles
 * list rather than a fabricated run - the same rule a deleted-run id follows. Ensemble and
 * Workflow states stay separate: this link never implies the ensemble is approved or shipped.
 */
function ExternalProvenance({
  source,
}: {
  source: WorkflowExternalSource;
}): React.JSX.Element {
  const href =
    source.kind === "ensemble"
      ? `#/ensembles/${encodeURIComponent(source.sourceId)}`
      : null;
  return (
    <p className="wf-run-provenance">
      Started by {EXTERNAL_SOURCE_LABELS[source.kind]}{" "}
      {href ? (
        <Tooltip label="Open the ensemble run that started this workflow">
          <a href={href}>
            <code>{source.sourceId}</code>
          </a>
        </Tooltip>
      ) : (
        <code>{source.sourceId}</code>
      )}
      {" · "}{when(source.createdAt)}
    </p>
  );
}

/** A durable error as a sentence, with its machine code kept beside it, never instead of it. */
function ErrorLine({
  raw,
  alert = false,
}: {
  raw: string | null | undefined;
  alert?: boolean;
}): React.JSX.Element | null {
  const view = errorView(raw);
  if (!view) return null;
  return (
    <p className="wf-run-error" {...(alert ? { role: "alert" } : {})}>
      {view.sentence}
      {view.code && <code className="wf-run-code">{view.code}</code>}
    </p>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }): React.JSX.Element | null {
  if (evidence.length === 0) return null;
  return (
    <ul className="wf-run-evidence">
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${item.path ?? ""}:${item.line ?? ""}:${index}`}>
          <code>{item.kind}{item.path ? ` · ${item.path}` : ""}{item.line ? `:${item.line}` : ""}</code>
          <span>{item.quote}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A Check node's own card.
 *
 * Separate from `VerdictCard` because a check answers different questions. It has no
 * Persona, so that card's `attempt.persona?.name ?? "Missing persona"` would accuse an
 * exit-code gate of pointing at a deleted reviewer; it has no runner, model or cost, so
 * three quarters of that meta line would read "cost unavailable" about a subprocess; and
 * the fact a reader wants first is the exit code, which a verdict only ever paraphrases.
 *
 * The four statuses reach the screen as sentences from `run-model.ts`, never as their
 * durable spellings.
 */
/**
 * One check's chip, derived from the OUTCOME - the fact that also picks its segment.
 *
 * Shared by the rail row and the card behind it, because they were deriving it twice and
 * disagreeing. The card asked `outcome.status === "failed" ? failed : passed`, which paints a
 * gate that NEVER RAN in the green of one that ran and succeeded - the exact false assurance
 * `CHECK_OUTCOME_STATUSES` exists to prevent, and the opposite of what the row beside it said.
 * Routed through `checkStatus`, `skipped` and `unavailable` keep the degraded amber they are
 * entitled to, and the four labels are unchanged.
 */
const checkChip = (outcome: WorkflowCheckOutcome): PipelineStatus =>
  checkStatus(outcome.status === "failed" ? "fail" : "pass", outcome.status);

function CheckCard({
  attempt,
  outcome,
}: {
  attempt: WorkflowNodeAttempt;
  outcome: WorkflowCheckOutcome;
}): React.JSX.Element {
  const view = checkStatusView(outcome.status);
  const chip = checkChip(outcome);
  const parts = [
    outcome.command ? formatCheckCommand(outcome.command) : "no command configured",
    outcome.exitCode === null ? null : `exit ${outcome.exitCode}`,
    `attempt ${attempt.attempt}`,
  ].filter((part): part is string => part !== null);
  return (
    <article className={`wf-run-card wf-run-check is-${outcome.status}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${chip.tone}`}>{chip.label}</span>
        <strong>Command · {outcome.slot}</strong>
      </header>
      <p className="wf-run-summary">{outcome.note}</p>
      <p className="wf-run-check-sentence">{view.sentence}</p>
      {outcome.output && (
        <div className="wf-run-card-body">
          <h5>Command output</h5>
          {/* The TAIL, which is what the runner kept: a build prints its failure last. The
              omitted count is stated rather than implied by an ellipsis, so nobody reads a
              bounded log as the whole one. */}
          <pre className="wf-run-check-output">{outcome.output}</pre>
          {outcome.truncatedBytes > 0 && (
            <p className="wf-run-meta">
              Earlier {outcome.truncatedBytes} bytes of output were omitted.
            </p>
          )}
        </div>
      )}
      <p className="wf-run-meta">{parts.join(" · ")}</p>
    </article>
  );
}

/**
 * How much of an authored instruction the run view will print inline.
 *
 * The prompt is bounded at authoring time, but 58,000 bytes inside a run card is a wall an
 * operator has to scroll past to reach the delivery beneath it. The whole text is one click
 * away in the version's snapshot detail, which is the surface that exists to be exact.
 */
const ACTION_PREVIEW_CHARS = 1200;

/**
 * One session action attempt.
 *
 * Its own card, not a Persona card with the words changed, because every field a verdict card
 * carries is a claim this one must not make: there is no verdict, no confidence, no requested
 * change and no repair packet. What it reports instead is a LIFECYCLE - what was sent, what
 * proved the session read it, and what the run is waiting for - plus the immutable snapshot
 * that says which instruction was sent, so an audit trail does not stop at "an action ran".
 */
function SessionActionCard({
  attempt,
  status,
  state,
  verifiedShipping,
}: {
  attempt: WorkflowNodeAttempt;
  status: PipelineStatus;
  state: SessionActionProgress | null;
  verifiedShipping: boolean;
}): React.JSX.Element {
  const snapshot = attempt.sessionAction;
  const blocked = state?.blocked ?? null;
  const proven = provenPullRequest(state);
  const prompt = snapshot?.promptMarkdown ?? "";
  const clipped = prompt.length > ACTION_PREVIEW_CHARS;
  return (
    <article className="wf-run-card wf-run-action">
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${status.tone}`}>{status.label}</span>
        <strong>{snapshot?.name ?? "Session action"}</strong>
      </header>
      {/* The wait reason first: it is the answer to "why is nothing happening", which is the
          question that brought the reader here. A block replaces it, because a blocked action
          is not waiting for anything. */}
      {/* The wait, the block, or - once it is over - what it accomplished. The last arm is
          the one every finished action shows, and the first draft of this card fell through
          it to `attemptStateLabel`, which printed the bare word "completed" under a heading
          that had just said the same thing. */}
      <p className="wf-run-summary">
        {blocked
          ? actionBlockSentence(blocked.code)
          : state?.wait
            ? actionWaitSentence(state.wait)
            : state?.complete
              ? verifiedShipping
                ? "The pull request was verified open at the captured commit, its content matched the prior review, and the workflow reached End."
                : "The turn finished, and the fresh evidence the stages below it review was captured."
              : attemptStateLabel(attempt.state)}
      </p>
      {blocked && <ErrorLine raw={blocked.detail} />}
      <p className="wf-run-meta">
        {[
          snapshot ? sessionActionSkillLabel(snapshot.requiredSkillId) : null,
          snapshot ? `Completes when ${sessionActionCompletionLabel(snapshot.completion)
            .toLocaleLowerCase("en-US")}` : null,
          snapshot ? `Snapshot revision ${snapshot.sourceRevision}` : null,
          `attempt ${attempt.attempt}`,
        ].filter(Boolean).join(" · ")}
      </p>
      {state?.anchor && (
        <p className="wf-run-meta">
          Sent {when(state.anchor.deliveredAt)}
          {state.pickedUpAt === null ? "" : ` · picked up ${when(state.pickedUpAt)}`}
          {state.settledAt === null ? "" : ` · turn finished ${when(state.settledAt)}`}
        </p>
      )}
      {/* What the proof actually WAS, for the one adapter that has one.
          Shown only once it exists, because until then there is no pull request to link and
          no commit to name - and a link rendered early is the "Open PR" affordance the plan
          refuses, offering to open something nothing has verified. The commit is printed
          because it is the whole claim: this pull request, at this commit, is what the stages
          below were allowed to read fresh evidence for. */}
      {proven && (
        <p className="wf-run-meta wf-run-action-pr">
          <Tooltip label="The pull request this action proved, at the commit it was proved at">
            <a href={proven.pullRequestUrl} target="_blank" rel="noreferrer">
              #{proven.pullRequestNumber}
            </a>
          </Tooltip>
          {` on ${proven.branch}, verified at ${proven.expectedHeadOid.slice(0, 8)}`}
        </p>
      )}
      {snapshot && (
        <details className="wf-run-packet">
          <Tooltip label="Show the exact instruction this version froze for this action">
            <summary>Instruction sent</summary>
          </Tooltip>
          <pre>{clipped ? `${prompt.slice(0, ACTION_PREVIEW_CHARS)}…` : prompt}</pre>
          {clipped && (
            <p className="wf-run-meta">
              First {ACTION_PREVIEW_CHARS} characters. The published version carries the exact
              text.
            </p>
          )}
        </details>
      )}
      <ErrorLine raw={attempt.error} />
    </article>
  );
}

function VerdictCard({
  attempt,
  verdict,
  meta,
}: {
  attempt: WorkflowNodeAttempt;
  verdict: PersonaVerdict;
  meta: ReturnType<typeof verdictMeta>;
}): React.JSX.Element {
  const parts = [
    meta.runner && meta.model ? `${meta.runner} · ${meta.model}` : null,
    meta.durationMs === null ? null : `${Math.round(meta.durationMs / 1000)}s`,
    meta.costUsd === null ? "cost unavailable" : `$${meta.costUsd.toFixed(4)}`,
    `attempt ${attempt.attempt}`,
    attempt.persona ? `Persona revision ${attempt.persona.sourceRevision}` : null,
  ].filter((part): part is string => part !== null);
  return (
    <article className={`wf-run-card wf-run-verdict is-${verdict.verdict}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${verdict.verdict === "pass" ? "passed" : "failed"}`}>
          {verdict.verdict === "pass" ? "Passed" : "Changes requested"}
        </span>
        <strong>{attempt.persona?.name ?? "Missing persona"}</strong>
        <span className="wf-run-confidence">{Math.round(verdict.confidence * 100)}% confident</span>
      </header>
      <p className="wf-run-summary">{verdict.summary}</p>
      {verdict.verdict === "pass" ? (
        <div className="wf-run-card-body">
          <h5>Approval rationale</h5>
          <p>{verdict.approvalDetails.reason}</p>
          <EvidenceList evidence={verdict.approvalDetails.evidence} />
        </div>
      ) : (
        <div className="wf-run-card-body">
          <h5>Requested changes</h5>
          <ol className="wf-run-changes">
            {verdict.requestedChanges.map((change, index) => (
              <li key={`${change.title}:${index}`}>
                <strong>{change.title}</strong>
                <p>{change.rationale}</p>
                {change.path && <code>{change.path}{change.line ? `:${change.line}` : ""}</code>}
                <EvidenceList evidence={change.evidence} />
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="wf-run-meta">{parts.join(" · ")}</p>
    </article>
  );
}

/**
 * A reviewer this round produced no readable opinion for.
 *
 * Extracted from the old verdict list unchanged, class name included, because it is the one
 * card that says something the pipeline strip above cannot: the durable `error` string behind
 * a provider failure, and the runner and revision that were resolved for the attempt that
 * failed.
 */
function AttemptCard({
  attempt,
  name,
}: {
  attempt: WorkflowNodeAttempt;
  name: string;
}): React.JSX.Element {
  return (
    <article className="wf-run-card wf-run-attempt">
      <header className="wf-run-card-head">
        <strong>{name}</strong>
        <span>{attemptStateLabel(attempt.state)} · attempt {attempt.attempt}</span>
      </header>
      <p className="wf-run-meta">
        {[
          attempt.runner && attempt.model ? `${attempt.runner} · ${attempt.model}` : null,
          attempt.persona ? `Persona revision ${attempt.persona.sourceRevision}` : null,
        ].filter(Boolean).join(" · ")}
      </p>
      <ErrorLine raw={attempt.error} />
    </article>
  );
}

/**
 * One selectable line in the worklist rail.
 *
 * A DISCRIMINATED UNION rather than a bare key, because `Blocking` holds two unrelated id
 * spaces at once: a `ChangeWorklistRow.key` is `nodeId + path + title`, and a check is
 * identified by its attempt id. Nothing stops those colliding as raw strings, so the keys are
 * namespaced by kind and every consumer branches on `kind` instead of sniffing the shape.
 */
export type WorklistItem =
  | { kind: "change"; key: string; row: ChangeWorklistRow }
  | { kind: "check"; key: string; attempt: WorkflowNodeAttempt; outcome: WorkflowCheckOutcome }
  | { kind: "verdict"; key: string; attempt: WorkflowNodeAttempt; verdict: PersonaVerdict }
  | { kind: "attempt"; key: string; attempt: WorkflowNodeAttempt; name: string };

export type WorklistSegment = "blocking" | "passed" | "archive";

/*
 * A row's identity is its ID SPACE, never its kind.
 *
 * Two spaces reach this rail and nothing stops them colliding as raw strings, so each is
 * prefixed: `ChangeWorklistRow.key` is `nodeId + path + title`, and everything else is an
 * attempt row. That is the whole reason the prefixes exist.
 *
 * It has to be the SPACE and not the KIND, because a row changes kind under a reader without
 * changing identity. An attempt keeps its id for its whole lifecycle - `store.ts` writes the
 * verdict with `UPDATE workflow_node_attempts ... WHERE id = ?`, and only a retry ever inserts
 * a new row - so a reviewer selected while it is still reporting nothing is `attempt` one
 * moment and `verdict` the next, and a Command is `attempt` until its outcome lands and `check`
 * after. Keyed by kind, the selection stopped resolving at exactly that moment and snapped to
 * the head of the list: the reader watching a reviewer resolve lost it the instant it did.
 */
const attemptKey = (attempt: WorkflowNodeAttempt): string => `attempt:${attempt.id}`;
const changeKey = (row: ChangeWorklistRow): string => `change:${row.key}`;

/** The reviewer a row belongs to, whichever of the two id spaces the row came from. */
const nodeOf = (item: WorklistItem): string =>
  item.kind === "change" ? item.row.nodeId : item.attempt.nodeId;

const SEGMENTS = ["blocking", "passed", "archive"] as const;

/** The first worklist row owned by any requested pipeline node, in displayed priority. */
export function worklistSelectionForNodes(
  nodeIds: readonly string[],
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  const requested = new Set(nodeIds);
  for (const segment of SEGMENTS) {
    const item = bySegment[segment].find((candidate) => requested.has(nodeOf(candidate)));
    if (item) return { segment, item };
  }
  return null;
}

/** The first worklist row owned by one pipeline node, in the worklist's displayed priority. */
export function worklistSelectionForNode(
  nodeId: string,
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  return worklistSelectionForNodes([nodeId], bySegment);
}

/**
 * Where a selection went when the row holding it stopped existing.
 *
 * One key namespace per id space is enough while a row stays in its own space, and a reviewer
 * that reports a PASS does: it is `attempt:<id>` pending and `attempt:<id>` afterwards. A
 * reviewer that reports a FAIL changes space entirely. Its attempt stops being an item at all -
 * a parseable fail verdict is represented by the changes it raised, not by itself - so the row
 * a reader was watching becomes one or more `change:` rows, in `Blocking` rather than `Passed`.
 * No key rewrite can bridge that; the successor has a different identity because it IS a
 * different thing.
 *
 * So the selection follows the REVIEWER. The attempt row survives in `detail.attempts` with its
 * id and its node, and the changes it raised carry that node too, which is the thread between
 * them. When the followed row lives in another segment the rail goes there, because a selection
 * pointing somewhere the reader cannot see is not a selection.
 *
 * Only ever when the key resolves NOWHERE. A key that still resolves in another segment is a
 * reader who moved segments with a row still selected behind them, and dragging them back would
 * overrule a choice rather than preserve one.
 */
export function followSelection(
  selectedKey: string,
  attempts: readonly WorkflowNodeAttempt[],
  bySegment: Record<WorklistSegment, WorklistItem[]>,
): { segment: WorklistSegment; item: WorklistItem } | null {
  const prefix = "attempt:";
  if (!selectedKey.startsWith(prefix)) return null;
  const nodeId = attempts.find((attempt) => attempt.id === selectedKey.slice(prefix.length))?.nodeId;
  if (nodeId === undefined) return null;
  // Pre-sorted, so the first row this reviewer owns is the one it leads with.
  return worklistSelectionForNode(nodeId, bySegment);
}

/**
 * What each state of a requested change CLAIMS, in a chip and a colour.
 *
 * `unconfirmed` is the one worth reading twice, and both halves of it are load-bearing. It is
 * NOT green: green would tell an operator a reviewer is satisfied while the stalemate card at
 * the foot of the same rail says that reviewer has failed every round. And it is not worded as
 * *rephrased* either, which is the opposite error and just as wrong - a reviewer that stops
 * raising a change BECAUSE it is fixed, while separately raising something unrelated, lands in
 * this same state, and telling that operator their fix was merely reworded is a false claim
 * about their own work. The state means *not known*, so the chip says not known.
 */
const CHANGE_STATE_CHIPS: Record<ChangeWorklistState, { label: string; tone: string }> = {
  open: { label: "Blocker", tone: "failed" },
  unconfirmed: { label: "Unconfirmed", tone: "waiting" },
  resolved: { label: "Resolved", tone: "passed" },
};

/**
 * A reviewer that produced no readable opinion and is not going to.
 *
 * `error` is a provider failure with no retry left - the engine only leaves a row in that state
 * once it has stopped scheduling successors - and a `completed` attempt with no verdict is a
 * reply the parser rejected. Both stop the run, and both carry a durable string that is the only
 * explanation on the page. Everything else verdict-less (queued, running, retrying, cancelled)
 * has simply not reported, which is a different claim and a different segment.
 *
 * "Carries an error string" is deliberately NOT part of this. A scheduled retry is inserted
 * `retry_wait` WITH one - `Retry scheduled after infrastructure failure: …` - so testing the
 * field would file every node that is about to try again under the heading for the ones that
 * cannot. The reason still reaches the reader: the row prints that sentence under its `Retrying`
 * chip, and the card behind it prints the whole thing.
 */
function stalledReviewer(attempt: WorkflowNodeAttempt): boolean {
  return attempt.state === "error" || attempt.state === "completed";
}

/**
 * The file a change cites, or null - and EMPTY IS ABSENT.
 *
 * `WorkflowRequestedChangeSchema.path` is `.optional()` with no `.min(1)`, so a reviewer may
 * legally emit `path: ""`, and `change.path ?? null` keeps it: `??` coalesces null and undefined,
 * not the empty string. Read directly, the row and the copy text called it absent while the
 * detail pane drew an `Open file` button with nothing in its tooltip that revealed an empty path
 * in the Files tab. One rule in one place, so the four readers cannot disagree again.
 */
const citedPath = (row: ChangeWorklistRow): string | null =>
  row.path === null || row.path === "" ? null : row.path;

/** The exact repair text one change copies, so a session gets the ask rather than the page. */
function changeCopyText(row: ChangeWorklistRow): string {
  const path = citedPath(row);
  return [
    row.title,
    path === null ? null : `${path}${row.line === null ? "" : `:${row.line}`}`,
    "",
    row.rationale,
  ].filter((part) => part !== null).join("\n");
}

/**
 * The attempt that last raised one change, for the reviewer's own summary and meta line.
 *
 * `ChangeWorklistRow` deliberately carries the CHANGE rather than the verdict around it, so
 * the summary has to be looked back up - at `row.lastRound`, which is the round the row's
 * wording came from, never the viewed round: a change carried forward from round 4 into a
 * round its reviewer has not re-run would otherwise show no summary at all.
 *
 * The fold matches `foldRun`'s to the letter - ascending segment, then ascending attempt, with
 * the guard that keeps a higher-numbered attempt from an earlier segment - because a summary
 * read off a different attempt than the one the row was accumulated from is the two-derivations
 * disagreement this whole surface is built to avoid.
 */
function raisingAttempt(
  detail: WorkflowRunDetail,
  nodeId: string,
  round: number,
): WorkflowNodeAttempt | null {
  const segmentOf = new Map(detail.submissions
    .filter((submission) => submission.round === round)
    .map((submission) => [submission.id, submission.segment]));
  let newest: WorkflowNodeAttempt | null = null;
  const ordered = detail.attempts
    .filter((candidate) => candidate.nodeId === nodeId && segmentOf.has(candidate.submissionId))
    .sort((left, right) =>
      (segmentOf.get(left.submissionId) ?? 0) - (segmentOf.get(right.submissionId) ?? 0)
      || left.attempt - right.attempt);
  for (const candidate of ordered) {
    if (newest && newest.attempt > candidate.attempt) continue;
    newest = candidate;
  }
  return newest;
}

/** One rail line. The chip is the row's own claim; the lines under it are its provenance. */
function WorklistRailRow({
  item,
  selected,
  onSelect,
}: {
  item: WorklistItem;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const view = ((): {
    chip: { label: string; tone: string };
    title: string;
    lines: string[];
    hint: string;
  } => {
    switch (item.kind) {
      case "change": {
        const { row } = item;
        const path = citedPath(row);
        return {
          chip: CHANGE_STATE_CHIPS[row.state],
          title: row.title,
          hint: `Show what ${row.personaName} asked for, in full`,
          lines: [
            ...(path === null ? [] : [path]),
            row.state === "resolved" && row.resolvedRound !== null
              ? `Resolved in round ${row.resolvedRound}`
              : row.state === "unconfirmed"
                ? `Last raised in round ${row.lastRound}`
                : `${row.personaName} · round ${row.firstRound}`,
            // The reviewer is never dropped from an archived row either: two reviewers can ask
            // for the same thing on the same file, so the name is what tells the two rows apart.
            ...(row.state === "unconfirmed"
              ? [`${row.personaName} has not passed since, so this was never confirmed fixed.`]
              : row.state === "resolved"
                ? [row.personaName]
                : []),
          ],
        };
      }
      case "check": {
        /*
         * The OUTCOME decides the chip, because the outcome decides the segment.
         *
         * A check's attempt also carries a synthetic verdict, and reading the chip off that -
         * which is what the pipeline strip above does, correctly, since it has no segment to
         * agree with - would let a row sitting in `Blocking` because the command exited
         * non-zero draw itself "Passed" whenever the two disagree. `checkStatus` still gets the
         * outcome as well, so `skipped` and `unavailable` keep their degraded amber chips
         * rather than being flattened into the green of a command that really ran.
         */
        const status = checkChip(item.outcome);
        return {
          chip: { label: status.label, tone: status.tone },
          title: `Command · ${item.outcome.slot}`,
          hint: `Show the ${item.outcome.slot} Command's result, output included`,
          lines: [
            item.outcome.command
              ? formatCheckCommand(item.outcome.command)
              : "no command configured",
            ...(item.outcome.exitCode === null ? [] : [`exit ${item.outcome.exitCode}`]),
          ],
        };
      }
      case "verdict":
        return {
          chip: {
            label: item.verdict.verdict === "pass" ? "Passed" : "Changes requested",
            tone: item.verdict.verdict === "pass" ? "passed" : "failed",
          },
          title: item.attempt.persona?.name ?? "Missing persona",
          hint: item.verdict.verdict === "pass"
            ? "Show this reviewer's approval rationale and the evidence behind it"
            : "Show this reviewer's whole verdict",
          lines: [item.verdict.summary],
        };
      case "attempt": {
        const status = reviewerStatus(item.attempt.state);
        return {
          chip: { label: status.label, tone: status.tone },
          title: item.name,
          hint: `Show what is recorded for ${item.name} in this round`,
          lines: item.attempt.error ? [errorView(item.attempt.error)?.sentence ?? ""] : [],
        };
      }
    }
  })();
  return (
    <li>
      <Tooltip label={view.hint}>
        <button
          type="button"
          /* The tone comes off the SAME chip the row draws, so the left accent and the word
             beside it can never disagree about what this row is. `is-{kind}` and the change's
             `is-{state}` stay for the selectors the specs read; neither carries a colour. */
          className={`wf-run-worklist-row is-${item.kind}${
            item.kind === "change" ? ` is-${item.row.state}` : ""
          } is-tone-${view.chip.tone}${selected ? " active" : ""}`}
          aria-current={selected}
          onClick={onSelect}
        >
          <span className="wf-run-worklist-row-head">
            <span className={`workflow-chip workflow-${view.chip.tone}`}>{view.chip.label}</span>
            <strong>{view.title}</strong>
          </span>
          {view.lines.filter(Boolean).map((line) => (
            <span className="wf-run-worklist-row-line" key={line}>{line}</span>
          ))}
        </button>
      </Tooltip>
    </li>
  );
}

/**
 * The Blocker Worklist: what this run is asking for, and what it is no longer asking for.
 *
 * This replaces a section that rendered every reviewer's whole card whether it had anything to
 * say or not - measured at 11,445 characters to convey about 480 on a live ten-round run. The
 * reorganisation is the point: a PASS costs one line here and its full card only when somebody
 * asks for it, while a change gets a row of its own carrying the round it was first raised in,
 * which no round-scoped card could say at all.
 *
 * Everything in here answers for the ROUND THE SCRUBBER POINTS AT, the stalemate card included.
 * `runChangeWorklist` and `runStalemates` both take that round, so scrubbing back moves all
 * three segment counts and the card together; nothing in this section may state a fact from a
 * round later than the one being viewed.
 */
function RunWorklist({
  detail,
  round,
  attempts,
  calls,
  nameOfNode,
  inspectorOnly,
  reviewerlessVersion,
  personaNodeIds,
  disabledNodeIds,
  initialNodeIds = [],
  onOpenFile,
  onCopyChange,
  changeCopied = false,
  onOpenPersonaDirective,
  onToggleNodesDisabled,
}: {
  detail: WorkflowRunDetail;
  /** The viewed round. `null` means the latest submission's round. */
  round: number | null;
  /** This round's non-action attempts, with the structural nodes already filtered out. */
  attempts: readonly WorkflowNodeAttempt[];
  calls: NonNullable<WorkflowRunDetail["llmCalls"]>;
  nameOfNode: (nodeId: string) => string | null;
  inspectorOnly: boolean;
  reviewerlessVersion: boolean;
  personaNodeIds: ReadonlySet<string>;
  disabledNodeIds: readonly string[];
  /** Settled pipeline nodes requested before this keyed worklist instance mounted. */
  initialNodeIds?: readonly string[];
  onOpenFile?: (path: string) => void;
  onCopyChange?: (text: string) => void;
  changeCopied?: boolean;
  onOpenPersonaDirective?: (nodeId: string) => void;
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
}): React.JSX.Element {
  const worklist = runChangeWorklist(detail, round);
  const stalemates = runStalemates(detail, round);

  /*
   * Checks never flow through the change model and never will - a row keyed on a title cannot
   * carry an exit code or an output tail. So `checkOutcomeOf` is asked FIRST, exactly as the
   * old section asked it, and the outcome's own `status` picks the segment: `failed` is a
   * blocker because it is why the run stopped, and `passed`, `skipped` and `unavailable` are
   * passes - the last two degraded ones, which keep their amber chip rather than being drawn
   * green for a command that never ran.
   */
  const checks: { attempt: WorkflowNodeAttempt; outcome: WorkflowCheckOutcome }[] = [];
  const verdicts: { attempt: WorkflowNodeAttempt; verdict: PersonaVerdict }[] = [];
  const bare: WorkflowNodeAttempt[] = [];
  for (const attempt of attempts) {
    // The check is asked FIRST, because a check also carries a verdict - a synthetic one, so
    // the join and the repair packet need no special case. Asking the verdict first would draw
    // every command gate as a Persona row with no Persona in it.
    const outcome = checkOutcomeOf(attempt);
    if (outcome) {
      checks.push({ attempt, outcome });
      continue;
    }
    const verdict = verdictOf(attempt);
    if (verdict) verdicts.push({ attempt, verdict });
    else bare.push(attempt);
  }

  const open = worklist.filter((row) => row.state === "open");
  const archived = worklist.filter((row) => row.state !== "open");
  /*
   * A fail verdict this round that produced no row is not dropped on the floor.
   *
   * `runChangeWorklist` reads verdicts through the strict schema and skips a durable row it
   * cannot parse, and it skips an attempt with no Persona snapshot; the display cast here is
   * looser. Either gap would silently delete a reviewer's whole objection from the one section
   * that is supposed to list it, so anything that failed at the viewed round without landing a
   * row keeps its full verdict card in `Blocking`.
   *
   * The dedupe is per (NODE, VIEWED ROUND), and the round half is the load-bearing part. Keyed
   * on the node alone it also matched a row carried forward from an EARLIER round, so a
   * reviewer with a round-1 objection still open whose round-2 reply the strict parser rejected
   * had that reply swallowed: no card for it, and the model cannot update the round-1 row from
   * a verdict it could not read either, so the page showed a stale objection with no sign the
   * reviewer had answered at all. `round` needs no clamping to compare against `lastRound` -
   * it IS the viewed submission's round, and when it is null there are no submissions and
   * therefore no attempts to classify.
   */
  const raisedInViewedRound = new Set(
    worklist.filter((row) => row.lastRound === round).map((row) => row.nodeId),
  );
  const unmodelledFailures = verdicts.filter(({ attempt, verdict }) =>
    verdict.verdict === "fail" && !raisedInViewedRound.has(attempt.nodeId));

  const blocking: WorklistItem[] = [
    ...checks
      .filter(({ outcome }) => outcome.status === "failed")
      .map(({ attempt, outcome }): WorklistItem => ({
        kind: "check",
        key: attemptKey(attempt),
        attempt,
        outcome,
      })),
    /*
     * A reviewer that errored, or that answered in a shape the verdict parser rejected, is a
     * blocker with no change attached: the run cannot pass it and its durable error string is
     * the only thing on the page saying why. It sorts up here with the failed commands for the
     * same reason they do - a stage that could not run is why the run stopped, and the
     * objections underneath it are from a round that is no longer moving.
     */
    ...bare
      .filter(stalledReviewer)
      .map((attempt): WorklistItem => ({
        kind: "attempt",
        key: attemptKey(attempt),
        attempt,
        name: attempt.persona?.name ?? nameOfNode(attempt.nodeId) ?? "Reviewer",
      })),
    ...open.map((row): WorklistItem => ({ kind: "change", key: changeKey(row), row })),
    ...unmodelledFailures.map(({ attempt, verdict }): WorklistItem => ({
      kind: "verdict",
      key: attemptKey(attempt),
      attempt,
      verdict,
    })),
  ];
  const passed: WorklistItem[] = [
    ...verdicts
      .filter(({ verdict }) => verdict.verdict === "pass")
      .map(({ attempt, verdict }): WorklistItem => ({
        kind: "verdict",
        key: attemptKey(attempt),
        attempt,
        verdict,
      })),
    ...checks
      .filter(({ outcome }) => outcome.status !== "failed")
      .map(({ attempt, outcome }): WorklistItem => ({
        kind: "check",
        key: attemptKey(attempt),
        attempt,
        outcome,
      })),
  ];
  /*
   * Reviewers this round has not heard from yet, kept OUT of the `Passed` count.
   *
   * They are in the `Passed` panel because they are not blocking anything - the changes still
   * open while they re-review are already carried into `Blocking` by the model above. But a
   * queued reviewer counted as a pass would be the surface claiming an outcome nobody reached,
   * which is the one thing every chip in this app refuses to do, so the count is over real
   * passes and these sit under their own label with their own chips.
   */
  const pending: WorklistItem[] = bare
    .filter((attempt) => !stalledReviewer(attempt))
    .map((attempt): WorklistItem => ({
      kind: "attempt",
      key: attemptKey(attempt),
      attempt,
      name: attempt.persona?.name ?? nameOfNode(attempt.nodeId) ?? "Reviewer",
    }));
  const archive: WorklistItem[] = archived
    .map((row): WorklistItem => ({ kind: "change", key: changeKey(row), row }));
  const bySegment: Record<WorklistSegment, WorklistItem[]> = {
    blocking,
    passed: [...passed, ...pending],
    archive,
  };
  const initialSelection = worklistSelectionForNodes(initialNodeIds, bySegment);

  /** The reader's own pick, and the round they made it in. Both, for the scrub rule below. */
  const [chosenSegment, setChosenSegment] = useState<
    { segment: WorklistSegment; round: number | null } | null
  >(initialSelection ? { segment: initialSelection.segment, round } : null);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelection?.item.key ?? null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const counts: Record<WorklistSegment, number> = {
    blocking: blocking.length,
    passed: passed.length + pending.length,
    archive: archive.length,
  };
  /*
   * The first segment that has anything in it, and then whatever the reader picked.
   *
   * A run with nothing outstanding opens on `Passed` rather than on an empty agenda, and one
   * whose reviewers have all gone quiet opens on `Archive` rather than on two empty panes. The
   * final fallback is `Passed`, which is where the three empty-state sentences live.
   *
   * A PICK HOLDS IN THE ROUND IT WAS MADE IN, and survives a scrub only while it still has
   * something to show. Held unconditionally it strands the reader: pick `Archive` on round 10,
   * scrub to round 1, and the counts beside them update while the pane stays empty - which
   * reads as "round 1 asked for nothing" on the very control built to say what a round is
   * asking for. Cleared unconditionally it would break comparing one segment across rounds,
   * which is what the scrubber is for. Scoping it to the round keeps both, and keeps clicking
   * an empty segment doing exactly what it says - the reader who wants to look at `Archive 0`
   * gets `Archive 0`, and only a scrub can overrule them.
   *
   * This is the same shape `selectedKey` already has: the reader's choice, with a fallback for
   * when the round it belongs to no longer holds it.
   *
   * Selection is LOCAL state, exactly like the round - there is no precedent for a sub-run
   * selection in `MissionRoute`, and deep-linking one change is a deliberate non-goal.
   */
  const autoSegment: WorklistSegment = counts.blocking > 0
    ? "blocking"
    : counts.passed > 0 ? "passed" : counts.archive > 0 ? "archive" : "passed";
  const picked = chosenSegment === null
    ? autoSegment
    : chosenSegment.round === round || counts[chosenSegment.segment] > 0
      ? chosenSegment.segment
      : autoSegment;
  /*
   * A selection that no longer resolves ANYWHERE is followed to whatever now represents its
   * reviewer - but only inside THIS ROUND, and the scoping is the whole correctness of it.
   *
   * A key stops resolving for two unrelated reasons, and only one of them is a reviewer
   * reporting. The other is the reader scrubbing: `selectedKey` deliberately carries no round,
   * so a row selected in round 10 names nothing in round 4. Handed every attempt in the run, the
   * follow resolved that stale id to its node anyway and matched it against whatever that node
   * owns in the round now on screen - dropping the reader onto a row and a segment they never
   * chose there, as though a verdict had just landed, when all they did was scrub.
   *
   * Scoped to the viewed round, an id from another round simply is not found, so the follow says
   * nothing and the round's own rules decide. Every attempt of the round is included rather than
   * the newest per node, so a row superseded by a retry is still followed to its successor.
   */
  const viewedSubmissions = new Set(detail.submissions
    .filter((submission) => submission.round === round)
    .map((submission) => submission.id));
  const roundAttempts = detail.attempts
    .filter((attempt) => viewedSubmissions.has(attempt.submissionId));
  const followed = selectedKey !== null
    && !SEGMENTS.some((entry) => bySegment[entry].some((item) => item.key === selectedKey))
    ? followSelection(selectedKey, roundAttempts, bySegment)
    : null;
  const segment = followed?.segment ?? picked;
  const items = bySegment[segment];
  /*
   * Resolved rather than stored, so scrubbing keeps a change that exists in both rounds
   * selected and falls back to the head of the list when it does not - never to an empty pane.
   */
  const selected = items.find((item) => item.key === selectedKey)
    ?? followed?.item
    ?? items[0]
    ?? null;
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  /*
   * Moving the selection PINS the segment it moved within, and every control that moves it goes
   * through here.
   *
   * A follow is transient by construction: it holds only while `selectedKey` names a row that
   * resolves nowhere. The instant any control writes a live key the follow stops firing, and
   * without this the segment fell back to whatever the reader had picked BEFORE the follow moved
   * them - so `Next` from a followed row in `Blocking` wrote a real Blocking key, the rail
   * snapped back to `Passed`, and the reader landed on an unrelated row instead of the next
   * blocker.
   *
   * Pinning the DISPLAYED segment is the honest reading of the gesture: whatever moved the
   * reader here, they are acting on the list in front of them. The segment buttons keep their
   * own handler, because picking a segment clears the selection rather than moving it.
   */
  const selectIn = (key: string | null): void => {
    setSelectedKey(key);
    setChosenSegment({ segment, round });
  };

  const terminalRun = ["completed", "cancelled", "failed"].includes(detail.run.status);
  const segments: { id: WorklistSegment; label: string; count: number; hint: string }[] = [
    {
      id: "blocking",
      label: "Blocking",
      count: blocking.length,
      hint: "The changes and failed commands this run is still asking for",
    },
    {
      id: "passed",
      label: "Passed",
      count: passed.length,
      hint: "Reviewers and commands that are not asking for anything in this round",
    },
    {
      id: "archive",
      label: "Archive",
      count: archive.length,
      hint: "Changes that stopped being raised, and what is known about why",
    },
  ];

  return (
    <div className="wf-run-worklist">
      <div className="wf-run-worklist-rail">
        <div className="wf-run-worklist-seg" role="group" aria-label="Worklist segment">
          {segments.map((entry) => (
            <Tooltip key={entry.id} label={entry.hint}>
              <button
                type="button"
                className={segment === entry.id ? "active" : ""}
                aria-pressed={segment === entry.id}
                onClick={() => {
                  setChosenSegment({ segment: entry.id, round });
                  setSelectedKey(null);
                }}
              >
                {entry.label} {entry.count}
              </button>
            </Tooltip>
          ))}
        </div>

        <div className="wf-run-worklist-list">
          {items.length === 0 && (
            <p className="wf-run-empty">
              {segment === "blocking"
                ? "Nothing is blocking this run in this round."
                : segment === "archive"
                  ? "No change has stopped being raised as of this round."
                  // The three arms the old section had, scoped to `Passed`, where they are
                  // still true. "This Inspector repair round ran no Personas" is NOT true of
                  // `Blocking`, which legitimately carries forward what is still outstanding.
                  : inspectorOnly
                    ? "This GitHub Inspector repair round ran no Personas."
                    : reviewerlessVersion
                      ? "This workflow has no reviewers - nothing in it produces a verdict."
                      : "No reviewer has been activated in this round yet."}
            </p>
          )}
          {(segment === "passed" ? passed : items).length > 0 && (
            <ul className="wf-run-worklist-rows">
              {(segment === "passed" ? passed : items).map((item) => (
                <WorklistRailRow
                  key={item.key}
                  item={item}
                  selected={selected?.key === item.key}
                  onSelect={() => selectIn(item.key)}
                />
              ))}
            </ul>
          )}
          {segment === "passed" && pending.length > 0 && (
            <>
              <p className="wf-run-worklist-group">No verdict in this round yet</p>
              <ul className="wf-run-worklist-rows">
                {pending.map((item) => (
                  <WorklistRailRow
                    key={item.key}
                    item={item}
                    selected={selected?.key === item.key}
                    onSelect={() => selectIn(item.key)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* The fact that never reached this page. `detail.repeatOffenders` is computed over the
            run's whole submission list and anchored on its newest one, so it cannot be
            re-scoped by the viewed round; `runStalemates` is its windowed twin, and the
            sentence is the ladder's own so one fact is worded one way on both surfaces. */}
        {stalemates.length > 0 && (
          <div className="wf-run-worklist-stalemate" role="status">
            <strong>Stalemate</strong>
            {stalemates.map((offender) => (
              <p key={offender.nodeId}>
                {offender.personaName} has failed {offender.rounds} rounds running.
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Deliberately EMPTY rather than repeating the rail: an empty segment already says what
          it is, and printing "nothing outstanding" beside "nothing is blocking this run" is one
          fact stated twice on a surface whose whole complaint is duplication. */}
      <div className="wf-run-worklist-detail">
        {selected !== null && (
          <>
            <div className="wf-run-worklist-detail-body">
              {selected.kind === "check" && (
                <CheckCard attempt={selected.attempt} outcome={selected.outcome} />
              )}
              {selected.kind === "verdict" && (
                <VerdictCard
                  attempt={selected.attempt}
                  verdict={selected.verdict}
                  meta={verdictMeta(selected.attempt, calls)}
                />
              )}
              {selected.kind === "attempt" && (
                <AttemptCard attempt={selected.attempt} name={selected.name} />
              )}
              {selected.kind === "change" && (
                <ChangeDetail
                  row={selected.row}
                  attempt={raisingAttempt(detail, selected.row.nodeId, selected.row.lastRound)}
                  calls={calls}
                  disabled={disabledNodeIds.includes(selected.row.nodeId)}
                  copied={changeCopied && copiedKey === selected.key}
                  onCopy={onCopyChange
                    ? () => {
                        setCopiedKey(selected.key);
                        onCopyChange(changeCopyText(selected.row));
                      }
                    : undefined}
                  onOpenFile={onOpenFile}
                  onOpenPersonaDirective={!terminalRun
                    && onOpenPersonaDirective
                    && personaNodeIds.has(selected.row.nodeId)
                    ? onOpenPersonaDirective
                    : undefined}
                  onToggleNodesDisabled={!terminalRun && onToggleNodesDisabled
                    ? onToggleNodesDisabled
                    : undefined}
                />
              )}
            </div>
            {/* Previous and next walk the CURRENT segment across every kind in it, so a reader
                can page from a failed command straight into the objections underneath it
                without changing segment. */}
            <div className="wf-run-worklist-walk">
              <span className="wf-run-meta">{selectedIndex + 1} of {items.length}</span>
              <Tooltip label="Show the previous item in this segment">
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Previous item"
                  disabled={selectedIndex <= 0}
                  onClick={() => selectIn(items[selectedIndex - 1]?.key ?? null)}
                >
                  ← Previous
                </button>
              </Tooltip>
              <Tooltip label="Show the next item in this segment">
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label="Next item"
                  disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
                  onClick={() => selectIn(items[selectedIndex + 1]?.key ?? null)}
                >
                  Next →
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One requested change in full, with the four things a person can do about it.
 *
 * The two MUTATING actions are withheld rather than disabled once the run is terminal, matching
 * the per-node menus on the strip: a finished run can no longer be affected, and a greyed-out
 * button that could never become enabled is a worse answer than no button. `Open file` is
 * withheld for the same reason when the change cites none - the type makes `path` optional and
 * plenty of real changes carry none.
 */
function ChangeDetail({
  row,
  attempt,
  calls,
  disabled,
  copied,
  onCopy,
  onOpenFile,
  onOpenPersonaDirective,
  onToggleNodesDisabled,
}: {
  row: ChangeWorklistRow;
  /** The attempt that last raised it, for the reviewer's own summary and meta. */
  attempt: WorkflowNodeAttempt | null;
  calls: NonNullable<WorkflowRunDetail["llmCalls"]>;
  disabled: boolean;
  copied: boolean;
  onCopy?: () => void;
  onOpenFile?: (path: string) => void;
  onOpenPersonaDirective?: (nodeId: string) => void;
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
}): React.JSX.Element {
  const chip = CHANGE_STATE_CHIPS[row.state];
  const meta = attempt ? verdictMeta(attempt, calls) : null;
  const summary = attempt ? verdictOf(attempt)?.summary ?? null : null;
  const path = citedPath(row);
  return (
    <article className={`wf-run-card wf-run-change is-${row.state}`}>
      <header className="wf-run-card-head">
        <span className={`workflow-chip workflow-${chip.tone}`}>{chip.label}</span>
        <strong>{row.personaName}</strong>
        <span className="wf-run-confidence">{Math.round(row.confidence * 100)}% confident</span>
        {meta?.runner && meta.model && (
          <span className="wf-run-meta">{meta.runner} · {meta.model}</span>
        )}
      </header>
      <h5 className="wf-run-change-title">{row.title}</h5>
      {summary && <p className="wf-run-summary">{summary}</p>}
      <dl className="wf-run-facts-list">
        <div>
          <dt>File</dt>
          <dd>
            {path === null
              ? "No file cited"
              : <code>{path}{row.line === null ? "" : `:${row.line}`}</code>}
          </dd>
        </div>
        <div>
          <dt>First raised</dt>
          <dd>Round {row.firstRound}</dd>
        </div>
        <div>
          {/* A count of the rounds that RAISED it, never the span between them, so it cannot
              claim a round its reviewer stayed silent in. */}
          <dt>Rounds open</dt>
          <dd>{row.roundsOpen}</dd>
        </div>
        <div>
          <dt>Evidence refs</dt>
          <dd>{row.evidence.length}</dd>
        </div>
        {row.state === "resolved" && row.resolvedRound !== null && (
          <div>
            <dt>Resolved in</dt>
            <dd>Round {row.resolvedRound}</dd>
          </div>
        )}
        {row.state === "unconfirmed" && (
          <div>
            <dt>Last raised</dt>
            <dd>Round {row.lastRound}</dd>
          </div>
        )}
      </dl>
      <div className="wf-run-card-body">
        <h5>What the reviewer wants</h5>
        <p>{row.rationale}</p>
      </div>
      {row.evidence.length > 0 && (
        <div className="wf-run-card-body">
          <h5>Cited evidence</h5>
          <EvidenceList evidence={row.evidence} />
        </div>
      )}
      <div className="wf-run-change-acts">
        {onCopy && (
          <Tooltip label="Copy this one change - its title, file and rationale - to the clipboard">
            <button className="btn" type="button" onClick={onCopy}>
              {copied ? COPY_FEEDBACK_LABEL : "Copy this change"}
            </button>
          </Tooltip>
        )}
        {onOpenFile && path !== null && (
          <Tooltip label={`Open ${path} in the bound session's Files tab`}>
            <button className="btn btn-ghost" type="button" onClick={() => onOpenFile(path)}>
              Open file
            </button>
          </Tooltip>
        )}
        {onOpenPersonaDirective && (
          <Tooltip label={`Give ${row.personaName} feedback that applies to every later round`}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => onOpenPersonaDirective(row.nodeId)}
            >
              Give this reviewer feedback
            </button>
          </Tooltip>
        )}
        {onToggleNodesDisabled && (
          <Tooltip label={`${disabled ? "Enable" : "Disable"} ${row.personaName} for this workflow run`}>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => onToggleNodesDisabled([row.nodeId], !disabled)}
            >
              {disabled ? `Enable ${row.personaName}` : `Disable ${row.personaName}`}
            </button>
          </Tooltip>
        )}
      </div>
    </article>
  );
}

export function WorkflowRunView({
  detail,
  roundId = null,
  onRound = () => {},
  onNextMove = () => {},
  onCancel,
  onConfirm = () => {},
  onCopyFeedback = () => {},
  onCopyRunId = () => {},
  onCopyChange,
  feedbackCopied = false,
  runIdCopied = false,
  changeCopied = false,
  onOpenFile,
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
  onRestartFull = async () => {},
  onRetryDelivery = async () => {},
  onResolveDelivery = async () => {},
  onRetryEvidenceReadiness = async () => {},
  onOverrideEvidenceReadiness = async () => {},
  onLoadEvents = async () => {},
  onLoadCalls = async () => {},
  onToggleNodesDisabled,
  onSetPersonaDirective,
  onRemovePersonaDirective,
  evidenceScopeOptions = [{ value: "repo-01", label: "Primary repository" }],
  onRestageImage,
  actionError = null,
  isActionPending = () => false,
}: {
  detail: WorkflowRunDetail;
  /** The submission being read. `null` means the newest one. */
  roundId?: string | null;
  onRound?: (submissionId: string) => void;
  /**
   * Dispatch the ONE move `runNextMove` derived for this run - the only run-advancing intent
   * this header offers, so the host wires one callback rather than one per control.
   *
   * The descriptor carries its own `path` and `body`, so the host sends it uniformly through the
   * shared action store. Two arms need more than that and the host owns both: the resubmission
   * family, because the page resolves the request id that keeps an unchanged resubmit inside its
   * round, and `run-again`, because the run it creates is a different one to route to.
   */
  onNextMove?: (move: RunNextMove, evidence?: WorkflowUploadEvidenceLocator[]) => void;
  onCancel: () => Promise<void>;
  /** Destructive confirmations, hosted by the overlay registry rather than `window.confirm`. */
  onConfirm?: (request: WorkflowConfirmRequest) => void;
  /**
   * Ask the host to copy. A callback rather than a `copyText()` call in here because the
   * clipboard can refuse, and the sentence saying so belongs on the page's own error surface,
   * which the host owns.
   */
  onCopyFeedback?: () => void;
  /** Copy the durable run id. Same division of labour as `onCopyFeedback`. */
  onCopyRunId?: () => void;
  /**
   * Whether each copy is inside its confirmation hold, from the host's `useCopyFeedback`.
   *
   * A PROP rather than state in here, which is what makes the `Copied` flip honest: the flag
   * and the `copyText` call it reports on now belong to one hook in the host, so a copy that
   * refused cannot flip it. This view used to hold both flags and set them after awaiting the
   * callback, which worked only as long as that callback remembered to re-throw - and then
   * swallowed the reason in a bare `catch`. `WorkflowLadder` already took `feedbackCopied`
   * this way; these two are the same arrangement.
   */
  feedbackCopied?: boolean;
  runIdCopied?: boolean;
  /**
   * Copy ONE requested change, rather than the whole repair packet the header copies.
   *
   * Its own callback for `onCopyFeedback`'s reason - the clipboard can refuse, and the sentence
   * saying so belongs on the page's error surface, which the host owns.
   */
  onCopyChange?: (text: string) => void;
  changeCopied?: boolean;
  /**
   * Reveal a cited file in the bound session's Files tab. Absent on a host with no Files
   * surface, in which case the worklist withholds the control rather than drawing a dead one.
   */
  onOpenFile?: (path: string) => void;
  onOpenSession?: () => void;
  onOpenInspectorSettings?: () => void;
  onRestartFull?: (confirmation?: string) => Promise<void>;
  onRetryDelivery?: (deliveryId: string) => Promise<void>;
  onResolveDelivery?: (
    deliveryId: string,
    resolution: "mark_delivered" | "discard_and_new_round",
    confirmation?: string,
  ) => Promise<void>;
  onRetryEvidenceReadiness?: (submissionId: string) => Promise<void>;
  onOverrideEvidenceReadiness?: (submissionId: string, reason: string) => Promise<void>;
  onLoadEvents?: () => Promise<void>;
  onLoadCalls?: () => Promise<void>;
  /**
   * Toggle the per-run auto-pass on verdict nodes. Optional so read-only hosts render the
   * disabled set without offering the switch; the view itself withholds it once the run is
   * terminal, because a finished run can no longer be affected.
   */
  onToggleNodesDisabled?: (nodeIds: string[], disabled: boolean) => void;
  onSetPersonaDirective?: (nodeId: string, feedback: string, intentKey: string) => void;
  onRemovePersonaDirective?: (nodeId: string, revision: number) => void;
  evidenceScopeOptions?: readonly { value: string; label: string }[];
  onRestageImage?: (
    image: WorkflowEvidenceImage,
    clientItemId: string,
  ) => Promise<void>;
  actionError?: string | null;
  isActionPending?: (id: RunActionId) => boolean;
}): React.JSX.Element {
  const version = detail.version;
  // Declared before the scrubber rather than beside the timeline, because a continuation
  // entry names the action it came from and a published action node carries its own snapshot
  // name - so the resolver is the one thing standing between "evidence 2" and "evidence 2,
  // after Open the pull request".
  const nodeById = new Map((version?.graph.nodes ?? []).map((node) => [node.id, node]));
  // Which nodes can actually take a directive. The worklist offers "Give this reviewer
  // feedback" off a row's own node, and a row whose node is not a Persona - an older run whose
  // version no longer carries it - would otherwise open an editor with nothing to save to.
  const personaNodeIds = new Set((version?.graph.nodes ?? [])
    .filter((node) => node.kind === "persona")
    .map((node) => node.id));
  /** The guided tour's handle on the worklist. Inert unless a tour is running. */
  const tourWorklistRef = useTourTargetRef<HTMLElement>("library:run-worklist");
  const [directiveNodeId, setDirectiveNodeId] = useState<string | null>(null);
  const [worklistFocus, setWorklistFocus] = useState<{
    runId: string;
    nodeIds: readonly string[];
    sequence: number;
  } | null>(null);
  useEffect(() => setDirectiveNodeId(null), [detail.run.id]);
  const currentWorklistFocus = worklistFocus?.runId === detail.run.id ? worklistFocus : null;
  const directiveNode = directiveNodeId ? nodeById.get(directiveNodeId) : null;
  const directiveTarget = directiveNode?.kind === "persona" ? directiveNode : null;
  const activeDirective = directiveTarget
    ? (detail.run.personaDirectives ?? []).find((item) => item.nodeId === directiveTarget.id) ?? null
    : null;
  const nameOfNode = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    return node && version ? nodeLabel(version.graph, node, []) : null;
  };
  const rounds = runRounds(detail, nameOfNode);
  const roundGroups = runRoundGroups(rounds);
  const viewed = selectedSubmission(detail, roundId);
  // Which round's tray is open. Declared beside `viewed` because it IS a fact about the
  // viewed submission, not a second piece of disclosure state a reader could get out of sync.
  const openTray = openEvidenceTray(roundGroups, viewed?.id ?? null);
  const viewedRound = rounds.find((round) => round.submissionId === viewed?.id) ?? null;
  const latest = rounds.at(-1) ?? null;
  const isLatest = viewed === null || viewed.id === latest?.submissionId;
  // The refinement cap parks the run on a submission that is still waiting for readiness, so
  // this is a fact about the RUN's state rather than the submission's - see the readiness
  // section below, which owns the decision this block asks the operator to make.
  const preflightExhausted = detail.run.status === "blocked"
    && detail.run.currentPhase === WORKFLOW_PREFLIGHT_REFINEMENT_EXHAUSTED_PHASE;
  /**
   * Two different questions, and they were one variable until the Inspector caught it.
   *
   * `inspectorOnly` describes the round BEING READ - it is what the bypass notice and the
   * "ran no Personas" line are about, and scrubbing is exactly how an operator reaches them.
   * `liveInspectorRepair` describes the run RIGHT NOW, and it is what may enable a recovery
   * action: with the live submission Inspector-only and the run waiting on Inspector rather
   * than on a new head, reading round 1 made Restart full workflow disappear - a live control
   * withdrawn by a view choice, which is the one thing the scrubber must never do.
   */
  const inspectorOnly = viewed?.mode === "inspector_only";
  const liveInspectorRepair = detail.submissions.some((submission) =>
    submission.id === latest?.submissionId && submission.mode === "inspector_only");
  const bypassSourceHead = inspectorOnly
    && viewed.context !== null
    && typeof viewed.context === "object"
    && !Array.isArray(viewed.context)
    && typeof viewed.context.failedHeadSha === "string"
    ? viewed.context.failedHeadSha
    : null;
  // Scoped to the VIEWED round, and validated rather than cast: `contextState` answers for
  // the run (the newest full submission's kind, or corrupt if any is), so it cannot say
  // whether the round a scrubber selected is readable. When it is not, the round says so
  // instead of rendering nothing.
  const contextRound = viewed?.mode === "full_workflow" ? viewed : null;
  const context = contextRound && detail.contextState === "captured"
    ? readCapturedContext(contextRound.context)
    : null;
  const contextUnreadable = contextRound !== null
    && detail.contextState === "captured"
    && context === null;
  const submissionImages = viewed
    ? detail.evidenceImages?.find((group) => group.submissionId === viewed.id)?.images ?? []
    : [];
  const submissionCoverage = viewed
    ? detail.evidenceCoverage?.find((group) => group.submissionId === viewed.id)?.coverage ?? []
    : [];
  const inspectorGate = detail.inspectorGate;
  const spentGateCondition = spentInspectorGateCondition(detail);
  const spentGateStatus = spentInspectorGateStatus(detail);
  const roundAttempts = detail.attempts.filter((attempt) => attempt.submissionId === viewed?.id);
  // Split by what the attempt IS, read off the durable snapshot column the runtime writes for
  // exactly this kind - never guessed from the absence of a verdict, which is also what an
  // errored reviewer looks like.
  //
  // The action that AUTHORIZED this segment is shown with it even though it belongs to the
  // parent, because a segment whose own provenance is invisible reads as a round that started
  // from nowhere. It is the one deliberate cross-submission read, and the runtime wrote the
  // link.
  const continuationSource = continuationSourceAttempt(detail, viewed?.id ?? null);
  const actionAttempts = [
    ...(continuationSource ? [continuationSource] : []),
    ...roundAttempts.filter((attempt) => attempt.sessionAction !== null),
  ];
  const latestAttemptByNode = latestAttemptsFor(detail, viewed?.id ?? null);
  /*
   * Session actions leave; the Session, join and End attempts never belonged here at all - see
   * `reviewerAttempts`, which is also what keeps a queued or errored reviewer in the list.
   *
   * ONE ATTEMPT PER NODE, the newest, which is the same rule the strip above reads and for the
   * same reason: it is the only one whose state is current. A retry does not replace the row it
   * retries - `engine.ts` marks that row `error` and INSERTS a successor at `attempt + 1` in
   * the same submission - so both survive, and classifying every row put one reviewer in two
   * segments at once. A transient provider error followed by a pass on the automatic retry
   * counted as a blocker AND as a pass in the same round, which is the one thing `Blocking` may
   * not say. Nothing is hidden by this: the strip carries every node's live state, the card
   * prints which attempt it is, and the audit disclosure keeps the whole record.
   */
  const reviewAttempts = reviewerAttempts(
    [...latestAttemptByNode.values()].filter((attempt) => attempt.sessionAction === null),
    version?.graph,
  );
  /** A published graph that CANNOT produce a verdict, which is a different empty than "not yet". */
  const reviewerlessVersion = version ? !version.graph.nodes.some(isVerdictNode) : false;
  // Every pass this round carries rather than re-earns, with the round each came from. One
  // derivation for both shapes that produce them - a continuation segment and an
  // Inspector-only round - so the two cannot drift into two ways of saying "did not run here".
  const inherited = inheritedPasses(detail, viewed);
  // The wider set behind it, for rows that need the nearest recorded OUTCOME rather than a pass.
  const inheritedOutcomes = inheritedAttempts(detail, viewed);
  const statuses = nodeStatusesForSubmission(detail, viewed?.id ?? null);
  const calls = detail.llmCalls ?? [];
  const completionClaims = detail.events.flatMap((event) => {
    if (
      event.kind !== "workflow_completion_claimed"
      || !event.payload
      || Array.isArray(event.payload)
      || typeof event.payload !== "object"
    ) return [];
    const { completionKind, marker, summary, state } = event.payload;
    if (
      typeof completionKind !== "string"
      || typeof marker !== "string"
      || typeof summary !== "string"
      || typeof state !== "string"
    ) return [];
    return [{ id: event.id, completionKind, marker, summary, state }];
  });
  const feedbackAction = copyFeedbackAction(detail, feedbackCopied);
  /**
   * The one thing to do about this run, and the sentence for when there is nothing.
   *
   * Exactly one of the two is ever non-null - `runNoMoveReason` returns `null` whenever a move
   * exists - so the header cannot show a primary and an excuse for not having one at once.
   */
  const nextMove = runNextMove(detail);
  const noMoveReason = runNoMoveReason(detail);
  // No `!`: `inspectorGateActions` pushes `open-pr` only when there is a pull request to open,
  // so this is `undefined` on every run with no adopted one - which is most of them.
  const openPrAction = inspectorGateActions(detail)
    .find((action) => action.kind === "open-pr");
  const totalCost = workflowCallCost(
    calls,
    detail.llmCallCount ?? calls.length,
    detail.nextLlmCallAfter,
  );
  const timeline = eventsByRound(detail);
  const roundOfSubmission = (submissionId: string): number | null =>
    detail.submissions.find((submission) => submission.id === submissionId)?.round ?? null;
  const uncertainDeliveries = detail.deliveries.filter((delivery) => delivery.state === "uncertain");
  const uncertainIds = uncertainDeliveries.map((delivery) => delivery.id).sort().join(",");
  const previousUncertainIds = useRef("");
  const [uncertainAnnouncement, setUncertainAnnouncement] = useState("");
  useEffect(() => {
    if (uncertainIds && uncertainIds !== previousUncertainIds.current) {
      setUncertainAnnouncement(
        `${uncertainDeliveries.length} workflow delivery outcome${uncertainDeliveries.length === 1 ? " is" : "s are"} uncertain`,
      );
    }
    previousUncertainIds.current = uncertainIds;
  }, [uncertainDeliveries.length, uncertainIds]);

  const preview = detail.binding.deliveryMode !== "live";
  /**
   * Whether the binding still names a live conversation.
   *
   * ONE field answers it for every control that needs a session - the header's link and the
   * two send-side delivery recoveries. `summary.sessionId` reads the same column today, but
   * a second source for one fact is how a link stays enabled onto a session that is gone.
   */
  const sessionBound = detail.binding.sessionId !== null;
  const parkedSentence = runParkedSentence(detail);
  const refusedSentence = runRefusedSentence(detail);
  /*
   * The grant's result, drawn and announced.
   *
   * Every other primary on this page produces something a person can see: a round starts, a
   * status changes, a section fills in. The grant produces one larger integer, and its only
   * visible consequence was the button quietly becoming a different button - which reads
   * exactly like a click that did nothing, and was reported as one.
   *
   * `runGrantNotice` is the derived, self-clearing half. This announcement is the half a
   * screen reader needs, and it fires on the TRANSITION rather than on the notice being
   * present, so arriving at an already-granted run does not read a stale result aloud.
   */
  const grantNotice = runGrantNotice(detail);
  const announcedGrant = useRef<string | null>(null);
  const [grantAnnouncement, setGrantAnnouncement] = useState("");
  useEffect(() => {
    if (announcedGrant.current === grantNotice) return;
    const first = announcedGrant.current === null;
    announcedGrant.current = grantNotice;
    if (first || !grantNotice) return;
    setGrantAnnouncement(`${grantNotice} ${parkedSentence ?? "The review can continue."}`);
  }, [grantNotice, parkedSentence]);
  return (
    <section className="wf-run-detail">
      <p className="sr-only" aria-live="assertive">{uncertainAnnouncement}</p>
      <p className="sr-only" aria-live="polite">{grantAnnouncement}</p>
      <header className="wf-run-head">
        <div className="wf-run-identity">
          <p className="workflow-eyebrow">
            {preview ? "Preview" : "Live"} · round {detail.summary.round} of {detail.summary.maxRepairRounds + 1}
          </p>
          <h3>{detail.summary.workflowName}</h3>
          <p className="wf-run-facts">
            {/* The badge IS the link to the composer. It already displayed the version, so a
                separate `Open version` button in the action row was a second control for the
                same fact, competing with the ones that change the run. */}
            <Tooltip label={version
              ? `Open workflow version ${version.version} in the composer`
              : "The immutable published version is missing or corrupt"}>
              <button
                className="wf-run-version"
                aria-label={`Open workflow version ${detail.summary.workflowVersion} in the composer`}
                disabled={!version}
                onClick={() => {
                  if (!version) return;
                  // The version to reveal is handed over in session storage (the builder reads
                  // it as it mounts); the hash names the WORKFLOW, so the link is a real deep
                  // link rather than "the builder, on whatever it had open last".
                  requestWorkflowVersionOpen(version.workflowId, version.version);
                  window.location.hash =
                    `#/library/workflows/${encodeURIComponent(version.workflowId)}`;
                }}
              >
                v{detail.summary.workflowVersion}
              </button>
            </Tooltip>
            <span className={`workflow-chip workflow-${workflowRunTone(detail.summary)}`}>
              {runStatusLabel(detail.run.status)}
            </span>
            <Tooltip label={sessionBound
              ? "Jump to the session this run is reviewing"
              : "The bound session is no longer available"}>
              <button
                className="wf-run-session"
                disabled={!sessionBound}
                onClick={onOpenSession}
              >
                {detail.binding.sessionName}
              </button>
            </Tooltip>
            {/* One run is one repository, and a conversation running a multi-repo task has a
                sibling run reviewing a different one. Named beside the session rather than
                instead of it: which conversation and which checkout are different facts, and
                only the pair identifies this run. */}
            {detail.summary.repoRoot && (
              <Tooltip label={`This run reviews ${detail.summary.repoRoot}`}>
                <span className="wf-run-repo">{repoLeaf(detail.summary.repoRoot)}</span>
              </Tooltip>
            )}
          </p>
          {/* The sentence that replaces a disabled button.
              A stopped run's reason belongs in the page, not in a tooltip on a control that
              refuses - and naming where the decision lives is what keeps the header from
              pretending one button settles an Inspector finding or an uncertain delivery. It
              renders only when `runNextMove` found nothing, so it never argues with a primary. */}
          {noMoveReason && (
            <p className="wf-run-why">
              <b>{noMoveReason.cause}</b> {noMoveReason.consequence}
            </p>
          )}
          {/* What the grant just did, then why the run is still standing still.
              Both sit BELOW the no-move sentence and neither replaces it: that one explains
              why there is no button, and these explain what happened and what is being waited
              on. A run can legitimately want all three - it was just granted rounds, it is
              parked, the observer is withholding, and the header still offers a manual round.
              In that order, because it is the order the events happened in. */}
          {grantNotice && <p className="wf-run-granted">{grantNotice}</p>}
          {refusedSentence && <p className="wf-run-refused">{refusedSentence}</p>}
          {parkedSentence && <p className="wf-run-parked">{parkedSentence}</p>}
          {detail.externalSource && <ExternalProvenance source={detail.externalSource} />}
          <small>Started {when(detail.run.startedAt)} · updated {relativeTime(detail.run.updatedAt)}</small>
        </div>

        <div className="wf-run-actions">
          {/* ONE next move, derived rather than assembled.
              This row used to offer every control the run might accept - five conditional
              blocks, all `btn` and `btn-ghost` peers, with the one that resolved the run last
              and furthest right. `runNextMove` answers the question the reader actually has, and
              because it returns at most one descriptor there is no arrangement of state in which
              two primaries can appear. */}
          {nextMove && (
            <Tooltip label={runActionTooltip(nextMove, isActionPending(nextMove.id))}>
              <button
                className="btn btn-primary"
                disabled={isActionPending(nextMove.id)}
                onClick={() => {
                  if (!nextMove.confirm) {
                    onNextMove(nextMove);
                    return;
                  }
                  onConfirm({
                    ...nextMove.confirm,
                    onConfirm: (evidence) => onNextMove(nextMove, evidence),
                  });
                }}
              >
                {nextMove.label}
              </button>
            </Tooltip>
          )}
          <Tooltip label={feedbackAction.tooltip}>
            <button
              className="btn btn-ghost"
              disabled={feedbackAction.disabled}
              onClick={onCopyFeedback}
            >
              {feedbackAction.label}
            </button>
          </Tooltip>
          {/* Absent, not disabled, when there is no pull request to open - which is what the
              descriptor's own existence now means. A greyed-out `Open PR` was the header
              repeating a fact the Inspector gate section states properly a few sections down,
              and it stood on the `waiting_for_pr` runs that are parked precisely BECAUSE no
              pull request is adopted yet. */}
          {openPrAction && (
            <Tooltip label={openPrAction.tooltip}>
              <a
                className="btn btn-ghost"
                href={openPrAction.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {openPrAction.label}
              </a>
            </Tooltip>
          )}
          {/* The run id and both JSON downloads are NOT here: they answer nobody reading a run,
              so they sit in `.wf-run-audit` at the foot of the page beside the Timeline. This
              row is for controls that change the run, plus the two links that reach the work. */}
        </div>

        {/* The two that cannot be undone, kept apart from the rest and never filled red:
            they sit beside actions an operator clicks all day. */}
        <div className="wf-run-actions wf-run-actions-danger">
          {inspectorGate && (liveInspectorRepair || detail.run.status === "waiting_for_new_head") && (
            <Tooltip label="Abandon this repair path and rerun every Persona from fresh evidence">
              <button
                className="btn btn-danger-ghost"
                onClick={() => onConfirm({
                  title: "Restart the full workflow",
                  body: "This abandons the GitHub Inspector-only repair and reruns every Persona against"
                    + " freshly captured evidence. The audited repair submissions stay in history.",
                  confirmLabel: "Restart full workflow",
                  confirmHint: "Abandons the GitHub Inspector-only repair and reruns every Persona",
                  danger: true,
                  requirePhrase: "RESTART FULL WORKFLOW",
                  onConfirm: () => void onRestartFull("RESTART FULL WORKFLOW"),
                })}
              >
                Restart full workflow
              </button>
            </Tooltip>
          )}
          {!["completed", "cancelled", "failed"].includes(detail.run.status) && (
            <Tooltip label="Stop this run - it will not resume">
              <button
                className="btn btn-danger-ghost"
                onClick={() => onConfirm({
                  title: "Cancel this run",
                  body: `Stop ${detail.summary.workflowName} v${detail.summary.workflowVersion} on`
                    + ` ${detail.binding.sessionName}? It will not resume, and its evidence and`
                    + " verdicts stay in history."
                    // The RETIRE half of the two controls that clear a spent gate, and the
                    // one the Merge queue sends people here for - "open the run to grant more
                    // rounds or retire it". Through the same derivation the drawer's Dismiss
                    // uses, so the two cannot disagree about whether stopping this run
                    // touches a pull request.
                    + cancelGateSentence(cancelReleasesGate(detail.summary)),
                  confirmLabel: "Cancel run",
                  confirmHint: cancelGateHint(cancelReleasesGate(detail.summary)),
                  danger: true,
                  onConfirm: () => void onCancel(),
                })}
              >
                Cancel run
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      {rounds.length > 0 && (
        <section className="wf-run-rounds" aria-label="Rounds">
          {/* One tile per ROUND. Eleven captures in one repair round is a detail OF that
              round, and drawn as eleven tiles it claimed eleven rounds had happened - so the
              tile carries a COUNT, and the captures themselves live in a tray below that
              opens for the round being read. One tray at a time, so the strip stays three
              tiles on one row whatever a round spent getting its evidence. */}
          <div className="wf-run-scrubber" role="group" aria-label="Select a round">
            {roundGroups.map((group) => {
              // Both facts come from the model, which is also what `openEvidenceTray` above
              // is built from - so the tile's pressed, active, badge and `aria-expanded`
              // states cannot disagree with which tray is actually rendered.
              const ownsViewed = roundHoldsViewedSubmission(group, viewed?.id ?? null);
              const opens = roundOpensEvidenceTray(group);
              // Only the OPEN round draws a tray, so a failure that happened mid-round is
              // invisible while a different round is being read. The marker is what keeps it
              // on the collapsed tile.
              const failed = roundFailedCaptureLabel(group);
              return (
                <Tooltip
                  key={group.round}
                  label={[
                    `${group.label}: ${group.status.label}`,
                    opens
                      ? `Captured evidence ${group.segments.length} times;`
                        + " opens the newest and lists them all."
                      : null,
                    failed ? `${failed} of this round's captures.` : null,
                  ].filter(Boolean).join(". ")}
                >
                  <button
                    className={`wf-run-round workflow-${group.status.tone}${
                      ownsViewed ? " active" : ""}`}
                    // The ROUND is pressed whichever of its snapshots is being read: this
                    // selects the newest, and a reader who then picked a chip is still
                    // reading this round. `aria-expanded` is what says the tray is theirs.
                    aria-pressed={ownsViewed}
                    {...(opens ? { "aria-expanded": ownsViewed } : {})}
                    onClick={() => onRound(group.head.submissionId)}
                  >
                    <span className="wf-run-round-line">
                      <span className="wf-run-round-name">{group.label}</span>
                      {opens && (
                        <span className="wf-run-round-count">
                          {roundEvidenceCountLabel(group)}
                        </span>
                      )}
                      {/* Drawn whether or not the round opens a tray: a single-capture round
                          that failed is still a failure a reader must see from the strip. */}
                      {failed && (
                        <span className="wf-run-round-failed workflow-failed">{failed}</span>
                      )}
                    </span>
                    <span className="wf-run-round-state">{group.status.label}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {/* The open round's captures. Below the strip rather than inside a tile, because a
              tray inside one would either widen that tile past its neighbours or wrap the
              strip - and the strip staying one row is the whole point of the tile above. */}
          {openTray && (
            <div
              className="wf-run-tray"
              role="group"
              aria-label={`Select evidence in round ${openTray.round}`}
            >
              <p className="wf-run-tray-label">
                {`Round ${openTray.round} evidence`}
              </p>
              <div className="wf-run-tray-chips">
                {openTray.segments.map((segment) => (
                  <Tooltip
                    key={segment.submissionId}
                    // The provenance ADDS to the snapshot and its status rather than
                    // replacing them: a continuation is still an entry whose state a
                    // reader wants, and the chip prints only a short form of it.
                    label={[
                      `${segment.label}: ${segment.status.label}`,
                      segmentProvenanceSentence(segment),
                    ].filter(Boolean).join(". ")}
                  >
                    <button
                      className={`wf-run-tray-chip workflow-${segment.status.tone}${
                        segment.submissionId === viewed?.id ? " active" : ""}`}
                      aria-pressed={segment.submissionId === viewed?.id}
                      onClick={() => onRound(segment.submissionId)}
                    >
                      <span className="wf-run-tray-chip-name">
                        {evidenceChipLabel(segment)}
                      </span>
                      <span className="wf-run-tray-chip-state">{segment.status.label}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
          {/* Said under the scrubber rather than only in a tooltip: a second entry under one
              round looks exactly like a repair, and the whole point of the segment model is
              that it is not one. */}
          {viewedRound && segmentProvenanceSentence(viewedRound) && (
            <p className="wf-run-notice" role="status">
              {segmentProvenanceSentence(viewedRound)}
            </p>
          )}
          {!isLatest && (
            <p className="wf-run-stale" role="status">
              Viewing an earlier round. The pipeline, verdicts and timeline below are that
              round's; the Inspector gate, deliveries and every recovery action are always the
              live run's.
            </p>
          )}
        </section>
      )}

      {version ? (
        <RunPipeline
          version={version}
          statuses={statuses}
          session={viewed
            ? submissionStatus(viewed, roundAttempts.some((attempt) => verdictOf(attempt)?.verdict === "fail"))
            : { tone: "waiting", label: "No submission yet" }}
          end={endStatus(detail, viewed, isLatest)}
          metaFor={(nodeId) => {
            // The NEWEST attempt, the same one the chip above it reads: a retry resolves the
            // provider again, so the first attempt's runner and model describe a call that is
            // over.
            const attempt = latestAttemptByNode.get(nodeId);
            return attempt?.runner && attempt.model ? `${attempt.runner} · ${attempt.model}` : null;
          }}
          checkOutcomeFor={(nodeId) => {
            // Read from the attempt's recorded outcome, never inferred from its verdict: a
            // check that was skipped or could not run passes the gate, so the verdict says
            // "pass" for a command that never executed.
            // The wider `inheritedAttempts` rather than the carried PASSES, because an
            // unconfigured command records `skipped` and never `passed`: reading this from the
            // pass map would drop the sentence explaining why the row is amber.
            const attempt = latestAttemptByNode.get(nodeId);
            const previous = inheritedOutcomes.get(nodeId)?.attempt;
            return attempt
              ? checkOutcomeOf(attempt)?.status ?? null
              : previous ? checkOutcomeOf(previous)?.status ?? null : null;
          }}
          inherited={inherited}
          onOpenRound={onRound}
          actionWaitFor={(nodeId) => {
            // The attempt's OWN durable state, not `summary.actionWait`. A repair round can
            // run several actions in turn and the summary carries one; scrubbing to an
            // earlier segment would otherwise paint the live wait onto a finished action.
            const attempt = latestAttemptByNode.get(nodeId);
            return attempt ? sessionActionProgress(attempt)?.wait ?? null : null;
          }}
          inspectorStatus={isLatest
            ? spentGateStatus ?? inspectorFooterStatus(detail.summary.gate)
            : null}
          inspectorDetail={isLatest && inspectorGate
            ? inspectorGateSentence(detail)
            : null}
          repair={detail.summary.maxRepairRounds > 0
            ? "Any fail returns the submission to Session for repair, then the whole pipeline runs again."
            : null}
          disabledNodeIds={detail.run.disabledNodeIds ?? []}
          disabledChipFor={(nodeId) =>
            // Scoped to the VIEWED round via `latestAttemptByNode`: scrubbing to an
            // earlier round shows that round's real outcomes under the red row treatment.
            disabledStatusFor(detail.run.disabledNodeIds, nodeId, latestAttemptByNode.get(nodeId))}
          onToggleNodes={onToggleNodesDisabled
            && !["completed", "cancelled", "failed"].includes(detail.run.status)
            ? onToggleNodesDisabled
            : undefined}
          directiveFor={(nodeId) => (detail.run.personaDirectives ?? [])
            .some((directive) => directive.nodeId === nodeId)}
          onOpenPersonaDirective={onSetPersonaDirective
            && onRemovePersonaDirective
            && !["completed", "cancelled", "failed"].includes(detail.run.status)
            ? setDirectiveNodeId
            : undefined}
          onOpenNode={(nodeId) => setWorklistFocus((current) => ({
            runId: detail.run.id,
            nodeIds: [nodeId],
            sequence: (current?.sequence ?? 0) + 1,
          }))}
          onOpenStage={(nodeIds) => setWorklistFocus((current) => ({
            runId: detail.run.id,
            nodeIds: [...nodeIds],
            sequence: (current?.sequence ?? 0) + 1,
          }))}
        />
      ) : (
        <p className="wf-run-error" role="alert">
          The immutable workflow version is missing or corrupt. This run cannot be resumed.
        </p>
      )}

      {inspectorOnly && (
        <p className="wf-run-notice" role="status">
          <strong>Persona review bypassed for GitHub Inspector repair.</strong>
          {" "}The audited repair submission moved from {shortSha(bypassSourceHead) ?? "an earlier head"} to{" "}
          {shortSha(viewed.prHeadSha) ?? "a newly observed head"} without Persona attempts.
        </p>
      )}

      {/* Its own section, above the verdicts. An action is what a round DID rather than what
          it decided, and folding it in under "Reviewer verdicts" would file a stage that
          returns no verdict under a heading that promises one. */}
      {actionAttempts.length > 0 && (
        <section className="wf-run-section">
          <h4>Session actions</h4>
          <div className="wf-run-cards">
            {actionAttempts.map((attempt) => {
              const state = sessionActionProgress(attempt);
              return (
                <SessionActionCard
                  key={attempt.id}
                  attempt={attempt}
                  state={state}
                  status={sessionActionStatus(attempt.state, state?.wait ?? null)}
                  verifiedShipping={Boolean(
                    viewedRound?.verifiedShipping
                    && continuationSourceAttempt(detail, viewedRound.submissionId)?.id === attempt.id
                  )}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="wf-run-section" aria-label="Review worklist" ref={tourWorklistRef}>
        <h4>Review worklist</h4>
        {/* Keyed on the run so selecting another run resets the list, and on a pipeline-tile
            request so repeated clicks remount with that node as the initial worklist choice. */}
        <RunWorklist
          key={`${detail.run.id}:${currentWorklistFocus?.sequence ?? 0}`}
          detail={detail}
          round={viewed?.round ?? null}
          attempts={reviewAttempts}
          calls={calls}
          nameOfNode={nameOfNode}
          inspectorOnly={inspectorOnly}
          reviewerlessVersion={reviewerlessVersion}
          personaNodeIds={personaNodeIds}
          disabledNodeIds={detail.run.disabledNodeIds ?? []}
          initialNodeIds={currentWorklistFocus?.nodeIds ?? []}
          onOpenFile={onOpenFile}
          onCopyChange={onCopyChange}
          changeCopied={changeCopied}
          onOpenPersonaDirective={onSetPersonaDirective && onRemovePersonaDirective
            ? setDirectiveNodeId
            : undefined}
          onToggleNodesDisabled={onToggleNodesDisabled}
        />
        {version?.graph.nodes.filter((node) => node.kind === "all_pass").map((join) => {
          const incoming = version.graph.edges.filter((edge) => edge.target === join.id);
          const received = detail.receipts.filter((receipt) =>
            receipt.submissionId === viewed?.id
            && incoming.some((edge) => edge.id === receipt.edgeId));
          return (
            <details className="wf-run-packet" key={join.id}>
              <Tooltip label="Show the payloads each reviewer in this stage handed its join">
                <summary>
                  {nodeLabel(version.graph, join, [])} · {received.length} of{" "}
                  {new Set(incoming.map((edge) => edge.source)).size} reviewers reported
                </summary>
              </Tooltip>
              <pre>{JSON.stringify(received.map((receipt) => receipt.payload), null, 2)}</pre>
            </details>
          );
        }) ?? null}
        {detail.run.gateState && (
          <details className="wf-run-packet">
            <Tooltip label="Show the raw join and final-gate state for this run">
              <summary>Join and gate packet</summary>
            </Tooltip>
            <pre>{JSON.stringify(detail.run.gateState, null, 2)}</pre>
          </details>
        )}
      </section>

      {inspectorGate && (
        <section className={`wf-run-section wf-run-gate is-${detail.summary.gate}`}>
          <header className="wf-run-section-head">
            <h4>GitHub Inspector final gate</h4>
            <span className={`workflow-chip workflow-${(spentGateStatus ?? gateSummaryStatus(detail.summary.gate)).tone}`}>
              {(spentGateStatus ?? gateSummaryStatus(detail.summary.gate)).label}
            </span>
          </header>
          <p className="wf-run-sentence">{inspectorGateSentence(detail)}</p>
          {spentGateCondition ? (
            <div className="wf-run-gate-ledgers">
              <section className="wf-run-gate-ledger is-history" aria-label="Last workflow observation">
                <h5>Last workflow observation</h5>
                <dl className="wf-run-facts-list">
                  <div>
                    <dt>Pull request</dt>
                    <dd>
                      {inspectorGate.state.prUrl ? (
                        <Tooltip label="Open the adopted pull request on GitHub">
                          <a href={inspectorGate.state.prUrl} target="_blank" rel="noreferrer">
                            #{inspectorGate.inspection?.number ?? detail.summary.gatePrNumber ?? "unknown"}
                          </a>
                        </Tooltip>
                      ) : "not resolved"}
                    </dd>
                  </div>
                  <div><dt>Failed head</dt><dd><code>{shortSha(inspectorGate.state.failedHeadSha ?? inspectorGate.state.targetHeadSha) ?? "not pinned"}</code></dd></div>
                  <div><dt>Observed head</dt><dd><code>{shortSha(inspectorGate.state.observedHeadSha) ?? "not observed"}</code></dd></div>
                  <div><dt>Stopped on</dt><dd>{gateWaitSentence(inspectorGate.state.waitReason)}</dd></div>
                  <div><dt>Observed</dt><dd>{inspectorGate.state.lastObservedAt ? when(inspectorGate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
                  <div><dt>Historical findings</dt><dd>{inspectorGate.state.findingFingerprints.length}</dd></div>
                </dl>
                {inspectorGate.state.findingFingerprints.length > 0 && (
                  <ul className="wf-run-gate-fingerprints" aria-label="Historical finding fingerprints">
                    {inspectorGate.state.findingFingerprints.map((fingerprint) => {
                      const finding = inspectorGate.findings.find((row) => row.fingerprint === fingerprint);
                      return (
                        <li key={fingerprint}>
                          <span>{finding?.title ?? "Finding not present in current ledger"}</span>
                          <code>{fingerprint}</code>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="wf-run-gate-ledger is-current" aria-label="Current Inspector">
                <h5>Current Inspector</h5>
                <dl className="wf-run-facts-list">
                  <div><dt>Adopted provenance</dt><dd>{inspectorGate.inspection?.source === "hook" ? "hook" : inspectorGate.inspection?.source === "pipeline" ? "pipeline" : inspectorGate.inspection ? "legacy import" : "not adopted"}</dd></div>
                  <div><dt>Current posture</dt><dd>{inspectorGate.inspector.enabled ? inspectorGate.inspector.mode : "disabled"} · {inspectorGate.inspector.posture ?? "unknown posture"}</dd></div>
                  <div><dt>Review posture</dt><dd>{inspectorGate.inspection?.reviewPosture ?? "not reviewed"}</dd></div>
                  <div><dt>Review round</dt><dd>{inspectorGate.inspection?.round ?? 0}</dd></div>
                  <div><dt>Observed head</dt><dd><code>{shortSha(inspectorGate.inspection?.observedHeadSha) ?? "not observed"}</code></dd></div>
                  <div><dt>Reviewed head</dt><dd><code>{shortSha(inspectorGate.inspection?.headSha) ?? "not reviewed"}</code></dd></div>
                  <div><dt>Pull request state</dt><dd>{inspectorGate.inspection?.observedState ?? "not observed"}</dd></div>
                  <div><dt>Open findings</dt><dd>{inspectorGate.inspection?.openFindings ?? "unknown"}</dd></div>
                  <div><dt>Resolved findings</dt><dd>{inspectorGate.inspection?.resolvedFindings ?? "unknown"}</dd></div>
                  <div><dt>Backoff</dt><dd>{inspectorGate.inspection?.nextAttemptAt ? when(inspectorGate.inspection.nextAttemptAt) : "none"}</dd></div>
                </dl>
                <ErrorLine raw={inspectorGate.inspection?.lastError} alert />
              </section>
            </div>
          ) : (
            <>
              <dl className="wf-run-facts-list">
                <div>
                  <dt>Pull request</dt>
                  <dd>
                    {inspectorGate.state.prUrl ? (
                      <Tooltip label="Open the adopted pull request on GitHub">
                        <a href={inspectorGate.state.prUrl} target="_blank" rel="noreferrer">
                          #{inspectorGate.inspection?.number ?? detail.summary.gatePrNumber ?? "unknown"}
                        </a>
                      </Tooltip>
                    ) : "not resolved"}
                  </dd>
                </div>
                <div><dt>Adopted provenance</dt><dd>{inspectorGate.inspection?.source === "hook" ? "hook" : inspectorGate.inspection?.source === "pipeline" ? "pipeline" : inspectorGate.inspection ? "legacy import" : "not adopted"}</dd></div>
                <div><dt>GitHub Inspector</dt><dd>{inspectorGate.inspector.enabled ? inspectorGate.inspector.mode : "disabled"} · {inspectorGate.inspector.posture ?? "unknown posture"}</dd></div>
                <div><dt>Review round</dt><dd>{inspectorGate.inspection?.round ?? 0}</dd></div>
                <div><dt>Target head</dt><dd><code>{shortSha(inspectorGate.state.targetHeadSha) ?? "not pinned"}</code></dd></div>
                <div><dt>Observed head</dt><dd><code>{shortSha(inspectorGate.state.observedHeadSha) ?? "not observed"}</code></dd></div>
                <div><dt>Reviewed head</dt><dd><code>{shortSha(inspectorGate.inspection?.headSha) ?? "not reviewed"}</code></dd></div>
                <div><dt>Observed</dt><dd>{inspectorGate.state.lastObservedAt ? when(inspectorGate.state.lastObservedAt) : "waiting for post-entry observation"}</dd></div>
                <div><dt>Backoff</dt><dd>{inspectorGate.inspection?.nextAttemptAt ? when(inspectorGate.inspection.nextAttemptAt) : "none"}</dd></div>
              </dl>
              <ErrorLine raw={inspectorGate.inspection?.lastError} alert />
            </>
          )}
          <p className="wf-run-meta">
            Findings policy: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.onFindings.replaceAll("_", " ")
              : "none"}</strong>
            {" · "}Missing PR: <strong>{version?.completionPolicy.kind === "inspector"
              ? version.completionPolicy.missingPrAction.replaceAll("_", " ")
              : "wait"}</strong>
          </p>
          <Tooltip label="Open GitHub Inspector settings to review its enablement, mode, and allowlist">
            <button className="btn btn-ghost" onClick={onOpenInspectorSettings}>Open GitHub Inspector settings</button>
          </Tooltip>
          <div className="wf-run-findings" aria-label={spentGateCondition ? "Current Inspector findings" : undefined}>
            {inspectorGate.findings.length === 0 ? (
              <p className="wf-run-empty">No findings are recorded for this adopted pull request.</p>
            ) : inspectorGate.findings.map((finding) => (
              <article key={finding.id} className={`wf-run-card wf-run-finding is-${finding.severity}`}>
                <header className="wf-run-card-head">
                  <strong>{finding.severity} · {finding.title}</strong>
                  <span>{finding.status}</span>
                </header>
                <code>{finding.path ?? "general"}{finding.line ? `:${finding.line}` : ""}</code>
                <p>{finding.body ?? "Legacy finding: detail was not persisted by the GitHub Inspector version that created this row."}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {completionClaims.length > 0 && (
        <section className="wf-run-section">
          <h4>Foreman completion claim</h4>
          <div className="wf-run-cards">
            {completionClaims.map((claim) => (
              <article className="wf-run-card" key={claim.id}>
                <header className="wf-run-card-head">
                  <strong>{claim.completionKind} completion</strong>
                  <span>{claim.state.replaceAll("_", " ")}</span>
                </header>
                <p>{claim.summary}</p>
                <p className="wf-run-meta">Once-only guard <code>{claim.marker.slice(0, 12)}</code></p>
              </article>
            ))}
          </div>
        </section>
      )}

      {detail.deliveries.length > 0 && (
        <section className="wf-run-section">
          {/* "Repair delivery" was true while every packet was a repair. A session action's
              instruction travels this same path and is the opposite of a repair, so the
              heading follows what is actually in the list rather than naming one kind of it. */}
          <h4>
            {detail.deliveries.some((delivery) => delivery.kind === "session_action")
              ? "Deliveries to the session"
              : "Repair delivery"}
          </h4>
          <div className="wf-run-cards">
            {detail.deliveries.map((delivery) => {
              const view = deliveryStateView(delivery.state);
              return (
                <article className={`wf-run-card wf-run-delivery is-${delivery.state}`} key={delivery.id}>
                  <header className="wf-run-card-head">
                    <span className={`workflow-chip workflow-${
                      delivery.state === "delivered" ? "passed"
                        : delivery.state === "uncertain" || delivery.state === "refused" ? "failed"
                          : "waiting"}`}>
                      {view.label}
                    </span>
                    <strong>Round {roundOfSubmission(delivery.submissionId) ?? "?"}</strong>
                    <span>{deliveryKindLabel(delivery.kind)}</span>
                  </header>
                  <p className="wf-run-sentence">{view.sentence}</p>
                  <ErrorLine raw={delivery.error} />
                  <dl className="wf-run-facts-list">
                    <div><dt>Conversation</dt><dd>{delivery.noteKey}</dd></div>
                    <div><dt>Payload hash</dt><dd><code>{delivery.payloadSha256.slice(0, 16)}</code></dd></div>
                    <div><dt>Prepared</dt><dd>{when(delivery.createdAt)}</dd></div>
                    <div><dt>Last transition</dt><dd>{when(delivery.updatedAt)}</dd></div>
                    <div><dt>Delivered</dt><dd>{delivery.deliveredAt ? when(delivery.deliveredAt) : "not confirmed"}</dd></div>
                  </dl>
                  {delivery.payloadPrunedAt ? (
                    <p className="wf-run-pruned">
                      Payload pruned {when(delivery.payloadPrunedAt)}. SHA-256 and transition
                      metadata remain available.
                    </p>
                  ) : <pre>{delivery.payload}</pre>}
                  {delivery.state === "refused" && (
                    <Tooltip label={sessionBound
                      ? "Retry this packet after a positive delivery refusal"
                      : "The bound session is gone, so there is nowhere to send this packet"}>
                      <button
                        className="btn"
                        disabled={!sessionBound}
                        onClick={() => void onRetryDelivery(delivery.id)}
                      >
                        Retry refused delivery
                      </button>
                    </Tooltip>
                  )}
                  {delivery.state === "uncertain" && (
                    <div className="wf-run-recovery">
                      {deliveryResolutionActions(delivery, sessionBound).map((action) => {
                        const pending = isActionPending(action.id);
                        return (
                          <Tooltip
                            key={action.id}
                            label={runActionTooltip(action, pending)}
                          >
                            <button
                              className={action.confirm.danger
                                ? "btn btn-danger-ghost"
                                : "btn"}
                              disabled={action.disabled || pending}
                              onClick={() => onConfirm({
                                ...action.confirm,
                                onConfirm: () => void onResolveDelivery(
                                  action.deliveryId,
                                  action.resolution,
                                  action.confirm.requirePhrase,
                                ),
                              })}
                            >
                              {action.label}
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {detail.contextState === "not_captured" && (
        <section className="wf-run-section">
          <h4>Intent and evidence not captured</h4>
          <p className="wf-run-empty">This submission stopped before its immutable context snapshot was recorded.</p>
        </section>
      )}
      {viewed && (
        <SubmissionImageEvidence
          runId={detail.run.id}
          images={submissionImages}
          scopeOptions={evidenceScopeOptions}
          canRestage={detail.binding.state === "active" && !detail.externalSource}
          onRestage={onRestageImage}
        />
      )}
      {viewed && (submissionCoverage.length > 0 || viewed.readiness != null) && (
        <SubmissionEvidenceReadiness
          key={viewed.id}
          coverage={submissionCoverage}
          readiness={viewed.readiness}
          enforced={workflowEvidenceReadinessPolicyEnforces(version?.evidenceReadinessPolicy)}
          waiting={isLatest
            && viewed.status === "waiting_for_evidence_readiness"
            && (detail.run.status === "waiting_for_evidence_readiness" || preflightExhausted)}
          /*
           * The block is what stopped the refinements, so the button that asks for another one
           * is withdrawn with it. The override below stays, because the decision the block
           * exists to ask for is exactly the one that button records.
           */
          refinementsExhausted={preflightExhausted}
          overrideReason={(detail.readinessOverrides ?? [])
            .filter((entry) => entry.submissionId === viewed.id)
            .at(-1)?.reason ?? null}
          onRetry={preflightExhausted ? undefined : () => onRetryEvidenceReadiness(viewed.id)}
          onOverride={(reason) => onOverrideEvidenceReadiness(viewed.id, reason)}
        />
      )}
      {detail.contextState === "corrupt" && (
        <section className="wf-run-section">
          <h4>Captured intent and evidence are corrupt</h4>
          <p className="wf-run-error" role="alert">
            The durable context does not match its submission mode. Check daemon logs or restore it from backup.
          </p>
        </section>
      )}
      {contextUnreadable && (
        <section className="wf-run-section">
          <h4>Captured intent and evidence</h4>
          <p className="wf-run-error" role="alert">
            This round's captured context is not readable by this build, though the run's
            newest one is. Check daemon logs or restore it from backup.
          </p>
        </section>
      )}
      {context && (
        <section className="wf-run-section wf-run-context">
          <header className="wf-run-section-head">
            <h4>Captured intent and evidence</h4>
            <span className="wf-run-meta">
              {context.compaction.status === "model" ? "Context compacted" : "Deterministic fallback"}
            </span>
            {context.evidence.retention?.state === "pruned" && (
              <span className="wf-run-pruned">
                Raw evidence pruned {when(context.evidence.retention.prunedAt)}
              </span>
            )}
          </header>
          <h5>Original goal</h5>
          <pre>{context.primaryGoal.rawPrompt || "(No captured goal)"}</pre>
          {context.primaryGoal.refined && <p><strong>Refined:</strong> {context.primaryGoal.refined}</p>}
          <h5>Human decisions and rationale</h5>
          {context.humanDecisions.length === 0 ? <p className="wf-run-empty">None captured.</p> : (
            <ul className="wf-run-decisions">
              {context.humanDecisions.map((decision) => (
                <li key={`${decision.source.kind}:${decision.source.id}`}>
                  <p>{decision.decision}</p>
                  {decision.rationale && <small>Rationale: {decision.rationale}</small>}
                  <code>{decision.source.kind}:{decision.source.id}</code>
                </li>
              ))}
            </ul>
          )}
          {context.constraints.length > 0 && (
            <><h5>Compacted constraints</h5><ul>{context.constraints.map((item) => <li key={item}>{item}</li>)}</ul></>
          )}
          {context.acceptanceCriteria.length > 0 && (
            <><h5>Acceptance criteria</h5><ul>{context.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul></>
          )}
          {context.compaction.status === "fallback" && context.compaction.error && (
            <p className="wf-run-meta">Compaction fallback: {context.compaction.error}</p>
          )}
          <details>
            <Tooltip label="Show the exact repository state this review was given">
              <summary>Evidence snapshot</summary>
            </Tooltip>
            <dl className="wf-run-facts-list">
              <div><dt>HEAD</dt><dd>{shortSha(context.evidence.headSha) ?? "unavailable"}</dd></div>
              <div>
                <dt>Working tree</dt>
                <dd>
                  {context.evidence.workingTreeDirty ? "dirty" : "clean"}
                  {context.evidence.workingTreeStatusTruncated ? " · status truncated" : ""}
                </dd>
              </div>
              <div><dt>Fingerprint</dt><dd><code>{viewed?.evidenceFingerprint}</code></dd></div>
              <div><dt>Diff</dt><dd>{context.evidence.diffTruncated ? "truncated" : "complete"}</dd></div>
              <div><dt>Transcript</dt><dd>{context.evidence.transcriptTruncated ? "truncated" : "complete"}</dd></div>
              <div><dt>Standards</dt><dd>{context.evidence.standardsTruncated ? "truncated" : "complete"}</dd></div>
            </dl>
            {context.evidence.retention?.state === "pruned" ? (
              <p>
                Raw diff, transcript, status paths, and standards bodies were pruned.
                Fingerprints, counts, caps, HEAD, branch, decisions, constraints, verdicts,
                and audit history remain.
              </p>
            ) : context.evidence.workingTreeStatus.length > 0 && (
              <pre>{context.evidence.workingTreeStatus.join("\n")}</pre>
            )}
            {context.evidence.retention?.state !== "pruned" && (
              <pre>{context.evidence.diff || "(No diff)"}</pre>
            )}
          </details>
        </section>
      )}

      <section className="wf-run-section">
        <header className="wf-run-section-head">
          <h4>Workflow-owned model calls</h4>
          <strong>
            {totalCost === null
              ? "Cost unavailable from this runner"
              : `$${totalCost.toFixed(4)}`}
          </strong>
        </header>
        {calls.length === 0 ? (
          <p className="wf-run-empty">No workflow-owned model calls are recorded for this run.</p>
        ) : (
          <div className="wf-run-table">
            <table>
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>Runner / model</th>
                  <th>Attempt</th>
                  <th>State</th>
                  <th>Failure class</th>
                  <th>Duration</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td>{call.purpose.replaceAll("_", " ")}</td>
                    <td>{call.runner} / {call.model}</td>
                    <td>{call.attempt}</td>
                    <td>{call.state}</td>
                    <td>{call.errorCode ?? "none"}</td>
                    <td>{call.durationMs === null ? "unavailable" : `${call.durationMs} ms`}</td>
                    <td>{call.inputBytes} B</td>
                    <td>{call.outputBytes} B</td>
                    <td>{call.costUsd === null ? "unavailable" : `$${call.costUsd.toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.nextLlmCallAfter && (
          <Tooltip label="Load the next page of durable model-call accounting">
            <button className="btn btn-ghost" onClick={() => void onLoadCalls()}>
              Load more model calls
            </button>
          </Tooltip>
        )}
      </section>

      <section className="wf-run-section wf-run-timeline">
        <h4>Timeline</h4>
        {[...timeline.entries()]
          .filter(([round]) => round === 0 || round === viewed?.round)
          .sort(([a], [b]) => a - b)
          .map(([round, events]) => (
            <section key={round} className="wf-run-timeline-round">
              <h5>{round === 0 ? "Run-level events" : `Round ${round}`}</h5>
              <ol>
                {[...events].sort((a, b) => a.id - b.id).map((event) => {
                  const line = eventLine(
                    event,
                    { node: nameOfNode, round: roundOfSubmission },
                    round,
                  );
                  return (
                    <li key={event.id}>
                      <time>{when(event.timestamp)}</time>
                      <strong>{line.title}</strong>
                      {line.detail && <span>{line.detail}</span>}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        {detail.nextEventAfter && (
          <Tooltip label="Load the next page of durable workflow events">
            <button className="btn btn-ghost" onClick={() => void onLoadEvents()}>
              Load more events ({detail.events.length} of {detail.eventCount ?? detail.events.length})
            </button>
          </Tooltip>
        )}
      </section>

      {directiveTarget && onSetPersonaDirective && onRemovePersonaDirective && (
        <PersonaDirectiveEditor
          workflowName={detail.summary.workflowName}
          runId={detail.run.id}
          round={detail.summary.round}
          personaName={directiveTarget.persona.name}
          directive={activeDirective}
          pendingFor={(intentKey) =>
            isActionPending(`set-persona-directive:${directiveTarget.id}:${intentKey}`)
            || isActionPending(`remove-persona-directive:${directiveTarget.id}:${activeDirective?.revision ?? 0}`)}
          error={actionError}
          onSave={(feedback, intentKey) => onSetPersonaDirective(
            directiveTarget.id,
            feedback,
            intentKey,
          )}
          onRemove={() => onRemovePersonaDirective(
            directiveTarget.id,
            activeDirective?.revision ?? 0,
          )}
          onClose={() => setDirectiveNodeId(null)}
        />
      )}

      {/*
        Developer material, named for who it is for.

        None of these three answers any question a person reading a run has - is it moving, why
        did it stop, what do I do, where is the work. The id has no filter to be pasted into
        (the rail filters by state, workflow and session) and the route already carries it; the
        two exports have no importer anywhere in the product by deliberate design, so both are
        bug-report attachments. Attachments do not belong beside `Cancel run`, and they are not
        worth deleting either - hence a disclosure, collapsed, beside the Timeline, where the
        rest of the audit material already lives.
      */}
      <details className="wf-run-audit">
        <Tooltip label="The run id and the JSON a bug report needs, out of the way of the run's own controls">
          <summary>
            Audit and bug reports
            <span> - the run id and the complete JSON records</span>
          </summary>
        </Tooltip>
        <dl className="wf-run-audit-body">
          <div className="wf-run-audit-row">
            <dt>Run id</dt>
            <dd className="wf-run-audit-id">{detail.run.id}</dd>
            <dd className="wf-run-audit-act">
              <Tooltip label="Copy this durable workflow run id">
                <button className="btn btn-ghost" onClick={onCopyRunId}>
                  {runIdCopied ? COPY_FEEDBACK_LABEL : "Copy"}
                </button>
              </Tooltip>
            </dd>
          </div>
          <div className="wf-run-audit-row">
            <dt>Run history</dt>
            <dd>Every retained event, verdict, delivery and model call</dd>
            <dd className="wf-run-audit-act">
              <Tooltip label="Download this run's complete retained audit history as JSON">
                {/* Two things this anchor carries beyond its href. The `download` name matches
                    the route's own `Content-Disposition`, which `test/workflows-http.test.ts`
                    pins - a file must not be named two ways. And the `aria-label` names it
                    apart from the version download below, which reads identically on screen:
                    two controls called only "Download JSON" are one control to anybody
                    listening to the page rather than looking at it. */}
                <a
                  className="btn btn-ghost"
                  aria-label="Download the run history as JSON"
                  href={`/api/workflow-runs/${encodeURIComponent(detail.run.id)}/export`}
                  download={`workflow-run-${detail.run.id}.json`}
                >
                  Download JSON
                </a>
              </Tooltip>
            </dd>
          </div>
          <div className="wf-run-audit-row">
            <dt>Workflow v{detail.summary.workflowVersion}</dt>
            <dd>The immutable published definition this run was pinned to</dd>
            <dd className="wf-run-audit-act">
              {version ? (
                <Tooltip label={`Download immutable workflow version ${version.version} as JSON`}>
                  <a
                    className="btn btn-ghost"
                    aria-label={`Download workflow version ${version.version} as JSON`}
                    href={`/api/workflows/${encodeURIComponent(version.workflowId)}/versions/${version.version}/export`}
                    download={`workflow-version-${version.version}.json`}
                  >
                    Download JSON
                  </a>
                </Tooltip>
              ) : (
                /* Disabled rather than absent: the row is what says this run HAS a pinned
                   version, and a missing definition is a fault to see, not to hide. */
                <Tooltip label="The immutable published version is missing or corrupt">
                  <button
                    className="btn btn-ghost"
                    aria-label={`Download workflow version ${detail.summary.workflowVersion} as JSON`}
                    disabled
                  >
                    Download JSON
                  </button>
                </Tooltip>
              )}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

/**
 * Nothing has run yet.
 *
 * Its own component because the sentence it replaced ("Bind an immutable published version
 * to a session, then submit a manual Preview.") was an instruction with nothing to click:
 * the binding dialog App already owns is two surfaces away, and an operator who has just
 * published their first workflow is exactly the person reading this.
 */
export function WorkflowRunsEmpty({
  onBindWorkflow,
}: {
  onBindWorkflow?: () => void;
}): React.JSX.Element {
  return (
    <section className="workflow-empty">
      <span className="workflow-empty-mark" aria-hidden>↻</span>
      <h3>No workflow runs yet</h3>
      <p>Bind a published version to a session, then submit a Preview to watch it here.</p>
      {onBindWorkflow && (
        <Tooltip label="Pick a session and a published version to run a workflow against">
          <button className="btn" onClick={onBindWorkflow}>Bind to a session…</button>
        </Tooltip>
      )}
    </section>
  );
}

export function WorkflowRuns({
  runs,
  sessions = [],
  selectedRunId,
  filters,
  onSelectRun,
  onFilters = () => {},
  onOpenSession = () => {},
  onOpenSessionPath,
  onOpenInspectorSettings = () => {},
  onBindWorkflow,
}: {
  runs: WorkflowRunSummary[];
  /** Live session projections issue the primary-first repository slots used by evidence scope. */
  sessions?: Session[];
  selectedRunId: string | null;
  filters?: WorkflowRunFilters;
  onSelectRun: (id: string) => void;
  onFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onOpenSession?: (id: string) => void;
  /**
   * Reveal a path in the bound session's Files surface, for the worklist's "Open file".
   *
   * Takes the session as well as the path because the host that owns the Files tab is keyed by
   * session, and a run names its own binding rather than whatever session happens to be
   * selected. Optional, so a host with no Files surface simply withholds the control.
   */
  onOpenSessionPath?: (sessionId: string, path: string) => void;
  onOpenInspectorSettings?: () => void;
  /** Opens the binding dialog with nothing pinned - the empty state's only affordance. */
  onBindWorkflow?: () => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<WorkflowRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  // Which round the reader is scoped to. Owned here rather than inside the view so that
  // selecting another run resets it in the same commit the detail is cleared - a submission
  // id from the previous run would otherwise survive one render into the next one.
  const [roundId, setRoundId] = useState<string | null>(null);
  const [committedLoadGeneration, setCommittedLoadGeneration] = useState(0);
  const filterKey = JSON.stringify(filters ?? {});
  const ordered = useMemo(
    () => [...history].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
    [history],
  );
  const loadGeneration = useRef(0);
  const loadCommit = useRef(createWorkflowLoadCommitBarrier());
  const mounted = useRef(false);
  const listGeneration = useRef(0);
  const selectedIndex = useRef(0);
  const page = useRef<HTMLElement>(null);
  const runRows = useRef(new Map<string, HTMLButtonElement>());
  const pendingKeyboardFocus = useRef<string | null>(null);
  const selected = selectedRunId ?? ordered[0]?.id ?? null;
  const selectedSummary = ordered.find((run) => run.id === selected) ?? null;
  const evidenceSession = sessions.find((session) => session.id === detail?.binding.sessionId) ?? null;
  const evidenceScopeSet = useMemo(
    () => workflowEvidenceScopes(evidenceSession, detail?.summary.repoRoot),
    [evidenceSession, detail?.summary.repoRoot],
  );
  const evidenceDraft = useWorkflowEvidenceDraft(
    workflowBindingEvidenceOwner(detail?.binding.id),
    evidenceScopeSet.defaultScope,
  );
  const listPage = async (cursor: string | null, append: boolean): Promise<void> => {
    const generation = ++listGeneration.current;
    setListLoading(true);
    if (!append) setListError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.workflowId) params.set("workflowId", filters.workflowId);
    if (filters?.session) params.set("session", filters.session);
    try {
      const page = await workflowRequest<WorkflowRunPage>(`/api/workflow-runs?${params}`);
      if (generation !== listGeneration.current) return;
      setHistory((current) => append
        ? [...new Map([...current, ...page.items].map((run) => [run.id, run])).values()]
        : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation === listGeneration.current) {
        setListError(caught instanceof Error ? caught.message : "Could not load workflow runs");
      }
    } finally {
      if (generation === listGeneration.current) setListLoading(false);
    }
  };
  useEffect(() => {
    setHistory([]);
    setNextCursor(null);
    void listPage(null, false);
    return () => { listGeneration.current++; };
  }, [filterKey]);

  useEffect(() => {
    const live = new Map(runs.map((run) => [run.id, run]));
    setHistory((current) => {
      const reconciled = current
        .filter((run) => live.has(run.id))
        .map((run) => live.get(run.id) ?? run);
      for (const run of runs) {
        if (reconciled.some((item) => item.id === run.id)) continue;
        const matches = (!filters?.status || run.status === filters.status)
          && (!filters?.workflowId || run.workflowId === filters.workflowId)
          && (!filters?.session || run.sessionId === filters.session || run.noteKey === filters.session);
        if (
          matches
          && !["completed", "cancelled", "failed"].includes(run.status)
        ) reconciled.unshift(run);
      }
      return reconciled;
    });
  }, [runs, filterKey]);
  useEffect(() => {
    const index = selectedRunId
      ? ordered.findIndex((run) => run.id === selectedRunId)
      : -1;
    if (index >= 0) selectedIndex.current = index;
  }, [ordered, selectedRunId]);
  useEffect(() => {
    if (
      !selectedRunId
      || detail?.run.id !== selectedRunId
      || runs.some((run) => run.id === selectedRunId)
      || ordered.some((run) => run.id === selectedRunId)
      || ordered.length === 0
    ) return;
    onSelectRun(ordered[Math.min(selectedIndex.current, ordered.length - 1)]!.id);
  }, [detail?.run.id, onSelectRun, ordered, runs, selectedRunId]);
  /**
   * The Runs page owns its two keyboard zones while it is mounted. Vertical arrows on the rail
   * select and load a run immediately; Tab on that selected row crosses into the first authored
   * stage. Once focus is in the reader, the pipeline owns its own arrows and tabs.
   *
   * Inputs keep their native arrows, and a dialog owns every key while it is open. The global
   * App handler deliberately stands down off the Fleet, so this listener has no competing
   * session cursor to suppress.
   */
  useEffect(() => {
    const ids = ordered.map((run) => run.id);
    function onKey(event: KeyboardEvent): void {
      if (
        event.defaultPrevented
        || confirm !== null
      ) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) {
        return;
      }
      if (
        event.key === "Tab"
        && !event.shiftKey
        && !event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && target?.closest(".wf-run-row") === (selected ? runRows.current.get(selected) : null)
      ) {
        const firstStage = page.current?.querySelector<HTMLElement>(
          '.wf-run-reader [data-focus-key="run-stage:0"]',
        );
        if (!firstStage) return;
        event.preventDefault();
        firstStage.focus({ preventScroll: true });
        firstStage.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || target?.closest(".wf-run-reader")
      ) return;
      if (ids.length === 0) return;
      const next = moveWorkflowRunSelection(ids, selected, event.key);
      event.preventDefault();
      if (!next || next === selected) return;
      pendingKeyboardFocus.current = next;
      onSelectRun(next);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, onSelectRun, ordered, selected]);
  // Keep route, DOM focus, and the independently scrolling rail on the same row after a key.
  // Non-keyboard arrivals still scroll a bookmarked or palette-selected run into view, but do
  // not steal focus from the control that opened it.
  useEffect(() => {
    if (!selected) return;
    const row = runRows.current.get(selected);
    row?.scrollIntoView({ block: "nearest" });
    if (pendingKeyboardFocus.current !== selected || !row) return;
    pendingKeyboardFocus.current = null;
    row.focus({ preventScroll: true });
  }, [ordered.length, selected]);
  useEffect(() => {
    loadCommit.current.commit(committedLoadGeneration);
  }, [committedLoadGeneration]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadGeneration.current++;
      loadCommit.current.release();
    };
  }, []);
  /**
   * `keepError` is what makes a refused action VISIBLE.
   *
   * Every mutation reloads the run afterwards, including the failing ones - the daemon may
   * have moved the run before refusing. But this reload cleared the message the failure had
   * just set, in the same React batch, so the operator saw a button do nothing at all: no
   * error, no state change, no clue that the daemon said no. The failing path keeps its
   * sentence until the next successful action clears it.
   */
  const load = (clear = false, keepError = false): Promise<void> => {
    // A shared action can finish after this page has unmounted. It still succeeded, but there
    // is no Runs detail left to refresh and no future commit that could settle a new waiter.
    if (!mounted.current) return Promise.resolve();
    const generation = ++loadGeneration.current;
    // `waitFor` transfers every older waiter to this generation. Selection changes and SSE
    // summary updates can supersede a request, but the action remains guarded until their
    // replacement detail has actually committed.
    const committed = loadCommit.current.waitFor(generation);
    if (clear) setDetail(null);
    if (!selected) {
      setDetail(null);
      setCommittedLoadGeneration(generation);
      return committed;
    }
    if (!keepError) setError(null);
    void workflowRequest<WorkflowRunDetail>(
      `/api/workflow-runs/${encodeURIComponent(selected)}`,
    )
      .then((next) => {
        if (loadGeneration.current !== generation) return;
        setDetail(next);
        setCommittedLoadGeneration(generation);
      })
      .catch((caught) => {
        if (loadGeneration.current !== generation) return;
        setDetail(null);
        setError(workflowRunLoadError(caught));
        setCommittedLoadGeneration(generation);
      });
    return committed;
  };
  // A DIFFERENT run is being read: drop the previous one's detail and round in the same commit,
  // because a submission id from the old run must not survive one render into the new one.
  useEffect(() => {
    setRoundId(null);
    setConfirm(null);
    void load(true);
    return () => { loadGeneration.current++; };
  }, [selected]);
  /**
   * The SAME run's summary moved. Refresh IN PLACE.
   *
   * This shared the effect above until the audit disclosure made it visible, and sharing it
   * meant every summary bump ran `load(true)` - which nulls the detail, and the view is
   * rendered under `{detail && …}`, so the whole reader was destroyed and rebuilt. Everything
   * the reader had opened closed: the audit disclosure, the evidence and gate-packet
   * disclosures, and the scrubbed round, which snapped back to the newest. On a live run that
   * happens on every SSE bump, and even on a finished one it happens about a second after
   * arrival, when the first list page lands and gives the selected run a summary at last.
   *
   * News about the run is not a new run. The guard is what keeps them apart: it fires only for
   * the run already on screen, so first mount (no detail yet) is left to the effect above and
   * does not fetch twice.
   */
  useEffect(() => {
    if (!selectedSummary || selectedSummary.id !== detail?.run.id) return;
    void load();
  }, [selectedSummary]);
  const actionController = useRunActions(selected ?? "", () => load());

  const mutate = async (path: string, body: object): Promise<boolean> => {
    setError(null);
    try {
      await workflowRequest(path, { method: "POST", body: JSON.stringify(body) });
      void load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow action failed");
      void load(false, true);
      return false;
    }
  };

  const resubmit = async (
    unchanged: boolean,
    evidence: WorkflowUploadEvidenceLocator[] = [],
    actionId = "resubmit",
  ): Promise<void> => {
    if (!detail) return;
    /*
     * Replaying the refused submission's own request id is what keeps an unchanged resubmission
     * INSIDE its round - the daemon finds that submission by trigger key and revives it, where a
     * fresh id opens a repair round and spends one of the binding's.
     *
     * That id is DERIVED from the run rather than remembered from the request that earned the
     * refusal. A `useRef` here was empty after any reload, and the header went on offering to
     * review "this snapshot" while the daemon quietly opened a new round instead - a promise the
     * label made and the mechanism could not keep. `refusedUnchangedRequestId` reads it off the
     * refused submission's trigger key, so it survives a remount, a new tab, and a second
     * operator arriving at the same run.
     *
     * `null` means no revivable submission, which is a correct answer rather than a failure: a
     * fresh id is what the daemon accepts there.
    */
    if (!unchanged) {
      actionController.run(actionId, async (requestId) => {
        await workflowRequest(`/api/workflow-runs/${detail.run.id}/resubmit`, {
          method: "POST",
          body: JSON.stringify({ requestId, resubmitUnchanged: false, evidence }),
        });
        evidenceDraft.clear();
      });
      return;
    }
    const replay = refusedUnchangedRequestId(detail);
    const requestId = replay ?? crypto.randomUUID();
    setError(null);
    try {
      await workflowRequest(`/api/workflow-runs/${detail.run.id}/resubmit`, {
        method: "POST",
        body: JSON.stringify({ requestId, resubmitUnchanged: unchanged }),
      });
      void load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Workflow resubmission failed");
      void load(false, true);
    }
  };

  /*
   * Both clipboard controls on this page, hosted here rather than in the view.
   *
   * `useCopyFeedback` owns the write and the confirmation together, so `Copied` cannot flip on
   * a copy that did not happen. That used to be a contract rather than a structure: the view
   * held the flag, this host held the `copyText` call, and only a documented re-throw across
   * the prop boundary connected them - with the view's `catch` then swallowing the reason.
   * The flag comes down as a prop now, which is the arrangement `WorkflowLadder` already had.
   *
   * The failure sentence still lands in this page's own `error` slot, read off `copy()`'s
   * return. It keeps naming WHICH copy failed, because the reason `copyText` throws ("The
   * browser refused the clipboard copy") describes the mechanism and not the button that was
   * pressed.
   *
   * Both clear that slot before they attempt, which is what actually makes it last-write-wins:
   * writing only on failure leaves a refusal on screen through every later copy that worked,
   * and the audit disclosure on a finished run may never fire another action to clear it. That
   * is `mutate` and the resubmit handler's own pattern above, and `WorkflowLadder`'s.
   *
   * `resetOn` is load-bearing and not decoration. The view used to hold these flags and
   * `setDetail(null)` unmounted it on every run change, so selecting another run cleared them
   * for free; this host stays mounted across that, so without the reset a run nobody copied
   * would read `Copied` for the rest of the previous run's hold.
   *
   * TWO instances, deliberately, and they do NOT share a generation counter.
   *
   * They copy different things, so each reports its own outcome and neither speaks for the
   * other. Clicking Copy on the run id, then Copy feedback while the first is still stalled on
   * a permission prompt, can leave `Copied` on the header button while the error line says the
   * RUN ID copy failed - and every part of that is true: the feedback copy did succeed, the
   * run-id button is sitting at its resting label claiming nothing, and the sentence names
   * which copy it is about. That naming is why it reads as two outcomes rather than as a
   * contradiction.
   *
   * A shared generation across the two would suppress the later-settling one, which here is a
   * REAL failure of a copy the reader asked for - reintroducing exactly the silent-copy class
   * this whole change exists to delete. One shared controller would be worse still: the two
   * would share `copied`, so a successful feedback copy would flip the run-id button to
   * `Copied` when nothing had been written for it.
   *
   * What the shared `error` slot genuinely costs is a message, not a lie: whichever copy
   * settles last owns the line, and either one's `setError(null)` can clear a refusal the
   * reader has not read yet. Fixing THAT means an error surface per control, the way
   * `ReportPanel` and `FileWorkspace` render `error` beside their own buttons - new UI on this
   * page, which this phase ships none of. Recorded as follow-up rather than done here.
   */
  const feedbackCopy = useCopyFeedback({ resetOn: selected });
  const runIdCopy = useCopyFeedback({ resetOn: selected });
  const changeCopy = useCopyFeedback({ resetOn: selected });

  const copyFeedback = (): void => {
    if (!detail) return;
    setError(null);
    void feedbackCopy.copy(() => workflowFeedbackText(detail))
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy workflow feedback. ${caught}`);
      });
  };

  /**
   * The audit disclosure's run-id copy.
   *
   * Through `copyText()` - via the hook - like every other clipboard control in the app. The
   * button it replaced called `navigator.clipboard.writeText` behind a `void`, so in the
   * Electron renderer, where the async Clipboard API can be permission-blocked even after a
   * direct click, it copied nothing and said nothing.
   */
  const copyRunId = (): void => {
    if (!detail) return;
    setError(null);
    void runIdCopy.copy(() => detail.run.id)
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy the run id. ${caught}`);
      });
  };

  /**
   * The worklist's per-change copy, kept apart from the header's repair packet.
   *
   * Its own `useCopyFeedback` because the two confirmations are independent controls that can
   * be up at once, and sharing one would flip `Copied` on a button nobody pressed.
   */
  const copyChange = (text: string): void => {
    setError(null);
    void changeCopy.copy(text)
      .then(({ error: caught }) => {
        if (caught !== null) setError(`Could not copy this change. ${caught}`);
      });
  };

  const loadMoreEvents = async (): Promise<void> => {
    const current = detail;
    if (!current?.nextEventAfter) return;
    try {
      const page = await workflowRequest<WorkflowEventPage>(
        `/api/workflow-runs/${encodeURIComponent(current.run.id)}/events?after=${current.nextEventAfter}&limit=200`,
      );
      setDetail((value) => value?.run.id === current.run.id
        ? {
            ...value,
            events: [...value.events, ...page.items],
            nextEventAfter: page.nextAfter,
          }
        : value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more workflow events");
    }
  };

  const loadMoreCalls = async (): Promise<void> => {
    const current = detail;
    if (!current?.nextLlmCallAfter) return;
    try {
      const page = await workflowRequest<WorkflowLlmCallPage>(
        `/api/workflow-runs/${encodeURIComponent(current.run.id)}/calls?after=${encodeURIComponent(current.nextLlmCallAfter)}&limit=200`,
      );
      setDetail((value) => value?.run.id === current.run.id
        ? {
            ...value,
            llmCalls: [...(value.llmCalls ?? []), ...page.items],
            nextLlmCallAfter: page.nextAfter,
          }
        : value);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load more workflow model calls");
    }
  };

  if (ordered.length === 0 && listLoading) {
    return <section className="workflow-empty" aria-live="polite"><p>Loading workflow runs…</p></section>;
  }

  if (ordered.length === 0 && !filters && !selectedRunId && !listError) {
    return <WorkflowRunsEmpty onBindWorkflow={onBindWorkflow} />;
  }

  return (
    <section ref={page} className="workflow-runs">
      <aside className="wf-run-rail">
        {listError && <p className="wf-run-error" role="alert">{listError}</p>}
        <div className="wf-run-chips" role="group" aria-label="Filter runs by state">
          {RUN_FILTER_CHIPS.map((chip) => (
            <Tooltip key={chip.label} label={chip.hint}>
              <button
                className={`wf-run-chip${filters?.status === chip.status ? " active" : ""}`}
                aria-pressed={filters?.status === chip.status}
                onClick={() => {
                  const next = { ...filters, status: chip.status };
                  onFilters(Object.values(next).some(Boolean) ? next : undefined);
                }}
              >
                {chip.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <form
          className="wf-run-filters"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Filter workflow runs"
        >
          <label>
            State
            <Tooltip label="Limit history to runs in one current state">
              <select
                value={filters?.status ?? ""}
                onChange={(event) => onFilters({
                  ...filters,
                  status: event.target.value
                    ? event.target.value as WorkflowRunSummary["status"]
                    : undefined,
                })}
              >
                <option value="">All states</option>
                {[
                  "capturing", "running", "waiting_for_session", "waiting_for_pr",
                  "waiting_for_inspector", "waiting_for_new_head", "blocked",
                  "completed", "cancelled", "failed",
                ].map((status) => (
                  <option key={status} value={status}>
                    {runStatusLabel(status as WorkflowRunStatus)}
                  </option>
                ))}
              </select>
            </Tooltip>
          </label>
          <label>
            Workflow id
            <input
              maxLength={200}
              value={filters?.workflowId ?? ""}
              onChange={(event) => onFilters({
                ...filters,
                workflowId: event.target.value || undefined,
              })}
            />
          </label>
          <label>
            Session
            <input
              maxLength={200}
              value={filters?.session ?? ""}
              onChange={(event) => onFilters({
                ...filters,
                session: event.target.value || undefined,
              })}
            />
          </label>
          {filters && (
            <Tooltip label="Show Workflow history without state, workflow, or session filters">
              <button className="btn btn-ghost" onClick={() => onFilters(undefined)}>
                Clear filters
              </button>
            </Tooltip>
          )}
        </form>
        {ordered.length === 0 && (
          <div className="wf-run-empty-filter">
            <strong>No runs match these filters.</strong>
            <p>Clear a filter or wait for a matching run.</p>
          </div>
        )}
        <div className="wf-run-list" role="list" aria-label="Workflow runs">
          {ordered.map((run) => (
            <div role="listitem" key={run.id}>
              <Tooltip label={`Open this ${run.workflowName} run - ${runStatusLabel(run.status)}`}>
                <button
                  ref={(node) => {
                    if (node) runRows.current.set(run.id, node);
                    else runRows.current.delete(run.id);
                  }}
                  aria-current={selected === run.id}
                  className={`wf-run-row${selected === run.id ? " active" : ""}`}
                  onClick={() => onSelectRun(run.id)}
                >
                  <span className="wf-run-row-head">
                    <strong>{run.workflowName}</strong>
                    <span className="wf-run-version">v{run.workflowVersion}</span>
                  </span>
                  <span className={`workflow-chip workflow-${workflowRunTone(run)}`}>
                    {runStatusLabel(run.status)}
                  </span>
                  <span className="wf-run-row-session">{run.noteKey}</span>
                  {run.repoRoot && (
                    <span className="wf-run-row-repo">{repoLeaf(run.repoRoot)}</span>
                  )}
                  {run.gate !== "none" && (
                    <span className="wf-run-row-gate">
                      GitHub Inspector: {run.gate.replaceAll("_", " ")}
                      {run.gatePrNumber ? ` · #${run.gatePrNumber}` : ""}
                      {run.gateHeadShort ? ` · ${run.gateHeadShort}` : ""}
                    </span>
                  )}
                  <small>{relativeTime(run.updatedAt)}</small>
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
        {nextCursor && (
          <Tooltip label="Load the next page of Workflow run history">
            <button
              className="btn btn-ghost wf-run-more"
              disabled={listLoading}
              onClick={() => void listPage(nextCursor, true)}
            >
              {listLoading ? "Loading…" : "Load more runs"}
            </button>
          </Tooltip>
        )}
      </aside>
      <div className="wf-run-reader">
        {(error || actionController.error) && (
          <p className="wf-run-error" role="alert">{error ?? actionController.error}</p>
        )}
        {!detail && !error && !actionController.error && selected
          ? <p>Loading run…</p>
          : !detail && !error && !actionController.error
            ? <p>Select a workflow run to inspect its audit history.</p>
            : null}
        {detail && (
          <WorkflowRunView
            detail={detail}
            roundId={roundId}
            onRound={setRoundId}
            onConfirm={setConfirm}
            /*
             * One dispatch for the one derived move.
             *
             * Every arm but the resubmissions goes through the shared action store from the
             * descriptor's own `path` and `body`, which is what keeps `RunNextMove` POST-only:
             * there is no kind this site special-cases, so a new row in `runNextMove` needs no
             * new wiring here.
             *
             * The resubmission family is routed to the page's own handler rather than sent from
             * here, and NOT for tidiness: that handler resolves the request id that keeps an
             * unchanged resubmission inside the round it is repairing. Sending it generically
             * would mint a fresh id and burn a repair round every time.
             */
            onNextMove={(move, evidence = []) => {
              if (move.kind === "resubmit" || move.kind === "resubmit-unchanged") {
                void resubmit(move.kind === "resubmit-unchanged", evidence, move.id);
                return;
              }
              /*
               * The only move whose success lands on a DIFFERENT run.
               *
               * Every other arm advances the run being read, so settling it means reloading this
               * page. This one asks the BINDING for a new run, so the run it returns is the one
               * the reader now wants: staying put would leave them on the finished run they just
               * asked to repeat, watching nothing happen.
               *
               * Through the shared store like every other arm, and not for symmetry - it is what
               * retains the request id across a failed response. A network error here with a
               * fresh id per click is how one intent becomes two runs and two rounds of model
               * spend; replaying the same id is answered idempotently with the run already made.
               * `run_active` and `inactive_binding` cannot be ruled out from run detail alone
               * (it carries no sibling runs), and they surface as the daemon's own sentence on
               * the page's error line.
               *
               * `onSelectRun` rather than a hash write: it is the router's own entry point, so
               * this leaves a history step back to the finished run and honours the same
               * navigation gate every other move on this page does.
               */
              if (move.kind === "run-again") {
                actionController.run(move.id, async (requestId) => {
                  // `idempotent: true` arrives on a replay and is not an error - the run in the
                  // body is the one this intent made, so it is the one to open.
                  const started = await workflowRequest<{ run: { id: string } }>(move.path, {
                    method: "POST",
                    body: JSON.stringify({ requestId, ...move.body, evidence }),
                  });
                  evidenceDraft.clear();
                  onSelectRun(started.run.id);
                });
                return;
              }
              actionController.run(move.id, (requestId) =>
                workflowRequest(move.path, {
                  method: "POST",
                  body: JSON.stringify({ requestId, ...move.body }),
                }));
            }}
            onCancel={async () => {
              await mutate(`/api/workflow-runs/${detail.run.id}/cancel`, {
                requestId: crypto.randomUUID(),
              });
            }}
            onCopyFeedback={copyFeedback}
            onCopyRunId={copyRunId}
            onCopyChange={copyChange}
            feedbackCopied={feedbackCopy.copied}
            runIdCopied={runIdCopy.copied}
            changeCopied={changeCopy.copied}
            // The BINDING's session, for `onOpenSession`'s reason: it is the column that goes
            // null when a session disappears, and a file cannot be revealed in a pane that is
            // gone.
            onOpenFile={onOpenSessionPath && detail.binding.sessionId
              ? (path) => onOpenSessionPath(detail.binding.sessionId!, path)
              : undefined}
            onLoadEvents={loadMoreEvents}
            onLoadCalls={loadMoreCalls}
            onRestartFull={async (confirmation) => {
              await mutate(`/api/workflow-runs/${detail.run.id}/restart-full`, {
                requestId: crypto.randomUUID(),
                ...(confirmation ? { confirmation } : {}),
              });
            }}
            onOpenInspectorSettings={onOpenInspectorSettings}
            onRetryDelivery={async (deliveryId) => {
              if (!detail.binding.sessionId) return;
              await mutate(`/api/workflow-deliveries/${deliveryId}/retry`, {
                requestId: crypto.randomUUID(),
                expectedSessionId: detail.binding.sessionId,
                expectedNoteKey: detail.binding.noteKey,
              });
            }}
            onResolveDelivery={async (deliveryId, resolution, confirmation) => {
              const delivery = detail.deliveries.find((item) => item.id === deliveryId);
              const action = delivery
                ? deliveryResolutionActions(
                    delivery,
                    detail.binding.sessionId !== null,
                  ).find((candidate) => candidate.resolution === resolution)
                : null;
              if (!action || action.disabled) return;
              actionController.run(action.id, (requestId) =>
                workflowRequest(`/api/workflow-deliveries/${deliveryId}/resolve`, {
                  method: "POST",
                  body: JSON.stringify({
                    requestId,
                    resolution,
                    ...(confirmation ? { confirmation } : {}),
                    ...(resolution === "discard_and_new_round" && detail.binding.sessionId
                      ? {
                          expectedSessionId: detail.binding.sessionId,
                          expectedNoteKey: detail.binding.noteKey,
                        }
                      : {}),
                  }),
                }));
            }}
            onRetryEvidenceReadiness={async (submissionId) => {
              await mutate(
                `/api/workflow-runs/${detail.run.id}/submissions/${submissionId}/evidence-readiness/retry`,
                { requestId: crypto.randomUUID() },
              );
            }}
            onOverrideEvidenceReadiness={async (submissionId, reason) => {
              await mutate(
                `/api/workflow-runs/${detail.run.id}/submissions/${submissionId}/evidence-readiness/override`,
                { requestId: crypto.randomUUID(), reason, acknowledgedRisk: true },
              );
            }}
            onToggleNodesDisabled={(nodeIds, disabled) => {
              // One action id per target set AND direction. The action store retains a
              // request id across a failed response so a retry of the SAME intent replays
              // idempotently - but disable and enable are different intents, and a shared
              // key would replay the old request id, which the daemon would then correctly
              // ignore as already applied.
              actionController.run(
                `set-nodes-disabled:${disabled}:${nodeIds.join(",")}`,
                (requestId) =>
                  workflowRequest(`/api/workflow-runs/${detail.run.id}/set-nodes-disabled`, {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeIds, disabled }),
                  }),
              );
            }}
            onSetPersonaDirective={(nodeId, feedback, intentKey) => {
              actionController.run(
                `set-persona-directive:${nodeId}:${intentKey}`,
                (requestId) => workflowRequest(
                  `/api/workflow-runs/${detail.run.id}/set-persona-directive`,
                  {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeId, feedback }),
                  },
                ),
              );
            }}
            onRemovePersonaDirective={(nodeId, revision) => {
              actionController.run(
                `remove-persona-directive:${nodeId}:${revision}`,
                (requestId) => workflowRequest(
                  `/api/workflow-runs/${detail.run.id}/remove-persona-directive`,
                  {
                    method: "POST",
                    body: JSON.stringify({ requestId, nodeId }),
                  },
                ),
              );
            }}
            evidenceScopeOptions={evidenceScopeSet.options}
            onRestageImage={async (image, clientItemId) => {
              await workflowRequest(
                `/api/workflow-bindings/${encodeURIComponent(detail.binding.id)}/evidence/reattach`,
                {
                  method: "POST",
                  body: JSON.stringify({
                    imageId: image.id,
                    clientItemId,
                    caption: image.caption,
                    repositoryScope: image.repositoryScope,
                  }),
                },
              );
              evidenceDraft.refreshStaged();
            }}
            actionError={error ?? actionController.error}
            isActionPending={actionController.isPending}
            onOpenSession={() => {
              // The BINDING's session, which is the one that goes null when a session
              // disappears. The summary carries the same column today, but it is also the
              // shape SSE caches per run, and offering to open a session that has gone is
              // the failure that costs an operator a click and a wrong selection.
              if (detail.binding.sessionId) onOpenSession(detail.binding.sessionId);
            }}
          />
        )}
      </div>
      {confirm && (
        <WorkflowConfirmModal
          request={confirm}
          onClose={() => setConfirm(null)}
          evidence={confirm.captureEvidence
            ? { controller: evidenceDraft, scopes: evidenceScopeSet.options }
            : undefined}
        />
      )}
    </section>
  );
}
