import { randomUUID } from "node:crypto";
import { PersonaVerdictSchema, WorkflowContextSnapshotSchema } from "@shared/protocol.ts";
import type { LlmRunner } from "@shared/llm.ts";
import type {
  PersonaFeedbackSummary,
  PersonaVerdict,
  PublishedWorkflowGraph,
  PublishedWorkflowNode,
  WorkflowContextSnapshot,
  WorkflowEdge,
  WorkflowJson,
  WorkflowNodeAttempt,
  WorkflowRun,
  WorkflowSubmission,
  WorkflowVersion,
  PersonaExecutionView,
  WorkflowCheckOutcome,
  WorkflowConfig,
} from "@shared/workflow.ts";
import type { WorkflowVerdictNode } from "@shared/workflow.ts";
import {
  WORKFLOW_EXECUTION_LIMITS,
  checkOutcomePasses,
  isVerdictNode,
  verdictAuthor,
} from "@shared/workflow.ts";
import { envVar } from "../config.ts";
import { llmRunner } from "../llm/index.ts";
import { runStructured } from "../llm/structured.ts";
import type { StructuredAttemptObserver } from "../llm/structured.ts";
import { DEFAULT_REVIEW_CONCURRENCY, createReviewScheduler } from "../llm/review-scheduler.ts";
import type { ReviewScheduler } from "../llm/review-scheduler.ts";
import { buildPersonaPrompt } from "./prompt.ts";
import { resolvePersonaExecution } from "./personas.ts";
import { type WorkflowStore, workflowJson } from "./store.ts";
import { normalizePersonaVerdict, parsePersonaVerdict, verdictRequestedChanges } from "./verdict.ts";
import { workflowLog } from "./log.ts";
import { getWorkflowConfig } from "./config.ts";
import {
  DEFAULT_CHECK_CONCURRENCY,
  createCheckScheduler,
  runCheck,
  tailBounded,
  type CheckRunDeps,
  type CheckScheduler,
} from "./checks.ts";
import { killLiveCheckGroups } from "./check-group.ts";
import type { CheckAttemptRef } from "./check-runtime.ts";

const MAX_INFRA_ATTEMPTS = 3;
/**
 * How long ONE Persona call may run before the runner kills it and the attempt is recorded
 * as an infrastructure failure.
 *
 * Ten minutes, matching the Inspector's `INSPECTOR_TIMEOUT_MS`, because the two do the same
 * shape of work: read a context packet built from a diff and a transcript window, and answer
 * with a structured verdict. The two minutes this used to allow were sized for a much smaller
 * prompt, and a Persona reading a real submission routinely ran past it - the run then burned
 * `MAX_INFRA_ATTEMPTS` full-length calls before failing the submission, so the cost of the
 * budget being too SMALL is three timeouts rather than one.
 *
 * Passed explicitly rather than inherited, so `claude-cli.ts`'s own default never applies
 * here; `envVar` is what an operator turns when a model or a packet size moves, following the
 * `INSPECTOR_TIMEOUT_MS` precedent. The ceiling is real and not just a formality: the shared
 * review budget is three slots wide (`llm/review-scheduler.ts`), so a wedged call holds one
 * of them for the whole duration and everything queued behind it waits.
 */
const PERSONA_TIMEOUT_MS = Number(envVar("WORKFLOW_PERSONA_TIMEOUT_MS") ?? 600_000);
const RETRY_BASE_MS = 1_000;

/**
 * The phase a run blocks in when a check node cannot be retried because its lease is still
 * unresolved.
 *
 * Distinct from `infrastructure_error` on purpose: that phase says "we tried three times and
 * gave up", and this one says "we did not try, because trying would have taken a second pooled
 * worktree while something may still be writing into the first". The operator's next move
 * differs too - this one clears itself once reclamation proves the group gone, and the run
 * resumes rather than being debugged. See `resumeClearedCheckCleanup`.
 */
export const CHECK_CLEANUP_UNRESOLVED_PHASE = "check_cleanup_unresolved";

/** What `blockedByUnresolvedLease` stores in `gate_state_json`, read back for the resume. */
interface CheckCleanupBlock {
  nodeId: string;
  attempts: number;
  error: string;
}

/**
 * Narrow a run's stored gate state to the block detail, or `null` when it is anything else.
 *
 * `gateState` is free-form JSON that several phases write, and a resume driven off a shape
 * that merely looked right would reschedule against a node id from some other phase's state.
 */
function checkCleanupBlock(state: WorkflowJson | null): CheckCleanupBlock | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const { nodeId, attempts, error } = state;
  if (typeof nodeId !== "string" || nodeId === "") return null;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) return null;
  return { nodeId, attempts, error: typeof error === "string" ? error : "" };
}

export interface WorkflowEngineOptions {
  /**
   * The daemon's shared review budget. Injected from `src/server/index.ts` so Persona
   * attempts and context compaction cannot each spend a private ceiling of their own.
   */
  schedule?: ReviewScheduler;
  /** Only consulted when no scheduler is injected, which keeps test construction one line. */
  concurrency?: number;
  now?: () => number;
  retryBaseMs?: number;
  runnerFor?: (id: LlmRunner["id"]) => LlmRunner;
  resolveExecution?: (persona: Extract<PublishedWorkflowNode, { kind: "persona" }>["persona"]) => PersonaExecutionView;
  /** Called after the wait boundary is durable and before any later graph work can advance. */
  onSubmissionWaiting?: (submissionId: string) => void;
  /**
   * Called once, after a session action's waiting attempt is durable.
   *
   * The engine deliberately does not deliver: an action packet is a terminal write with a
   * consent gate, a repository allowlist, a pane lock and an uncertainty policy, all of which
   * the manager owns. The engine's whole job is to make the wait durable and say so.
   */
  onSessionActionWaiting?: (attemptId: string) => void;
  /** Claims a successful End for an external final gate. Returns true when claimed. */
  onSubmissionSucceeded?: (submissionId: string) => boolean;
  /**
   * The daemon's ceiling on check commands, which is NOT the review budget.
   *
   * Injected from `src/server/index.ts` beside the review scheduler for the same reason that
   * one is: a subsystem reaching for a private limiter is a subsystem whose "two" quietly
   * becomes four.
   */
  checkSchedule?: CheckScheduler;
  /** Only consulted when no check scheduler is injected. */
  checkConcurrency?: number;
  /**
   * The execution runtime a Check reaches, bound to the attempt it will run for.
   *
   * A factory rather than a value because a check's resources - its pooled worktree lease and
   * its supervisor's durable identity - are keyed by attempt id, and Contract E's
   * `CheckExecutionRequest` describes a COMMAND rather than an attempt. Binding at the call
   * site keeps the published request unchanged and keeps every other caller of `runCheck` from
   * having to supply an identity it has no reason to know.
   *
   * Absent in a build that ships no runtime, which is the shipped default: every configured
   * check then reports `unavailable` and passes with a note saying so.
   */
  checkDeps?: (attempt: CheckAttemptRef) => CheckRunDeps;
  /**
   * Contract R: does this check node still own a lease that has not resolved?
   *
   * Consulted before a retry is CREATED, not afterwards. A retry is a fresh attempt id, so it
   * carries a fresh holder token and would happily lease a DIFFERENT pooled worktree while the
   * first attempt's process group may still be writing into the first - there is no natural
   * collision to rely on, which is why this gate has to be explicit.
   *
   * Defaults to "no lease", which is correct for every build with no execution runtime and for
   * every persona node in every build.
   */
  unresolvedCheckLease?: (submissionId: string, nodeId: string) => boolean;
  /** Read per attempt, never cached, so a Settings edit lands on the next check. */
  workflowConfig?: () => WorkflowConfig;
}

function isPersona(node: PublishedWorkflowNode): node is Extract<PublishedWorkflowNode, { kind: "persona" }> {
  return node.kind === "persona";
}

function isCheck(node: PublishedWorkflowNode): node is Extract<PublishedWorkflowNode, { kind: "check" }> {
  return node.kind === "check";
}

function jsonValue(value: unknown): WorkflowJson {
  return workflowJson(value);
}

function outcome(payload: WorkflowJson): "pass" | "fail" | null {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return null;
  return payload.outcome === "pass" || payload.outcome === "fail" ? payload.outcome : null;
}

function requestedChangePacket(
  verdict: PersonaVerdict,
  personaName: string,
): PersonaFeedbackSummary {
  return {
    personaName,
    summary: verdict.summary,
    requestedChanges: verdictRequestedChanges(verdict).map((item) => item.title),
  };
}

function edgesFrom(
  graph: PublishedWorkflowGraph,
  nodeId: string,
  port: "submitted" | "pass" | "fail" | "complete",
): WorkflowEdge[] {
  return graph.edges.filter((edge) => edge.source === nodeId && edge.sourcePort === port);
}

/**
 * The `complete` routes one action node authorizes, exported so the manager can seed exactly
 * these edges into the child segment rather than re-deriving the rule.
 */
export function sessionActionCompleteEdges(
  graph: PublishedWorkflowGraph,
  nodeId: string,
): WorkflowEdge[] {
  return edgesFrom(graph, nodeId, "complete");
}

/**
 * A check outcome as a verdict the rest of the engine already understands.
 *
 * `confidence: 1` is the honest figure and not a flourish: an exit code is not a judgement
 * a model might have got wrong, and a check that reported 0.8 would invite a reader to
 * discount it.
 *
 * The failing arm cites `kind: "check"`. A requested change must carry at least one
 * `EvidenceRef` (`verdict.ts`), and this phase answers that by ADDING a kind rather than
 * exempting check-authored changes: the requirement exists so a human can trace a claim to
 * its source, and a command's own output is exactly that source. Exempting the one author
 * whose evidence is machine-produced would have weakened the rule for its strongest case.
 *
 * Routed through `normalizePersonaVerdict` rather than trusted: it clips every field to the
 * same bounds a model's verdict is held to, and returns null if the result is still not
 * valid - which the caller turns into an infrastructure failure rather than a fail verdict.
 * A build log with an empty tail would otherwise produce an empty `rationale`, which the
 * strict schema refuses.
 */
function checkVerdict(outcome: WorkflowCheckOutcome): PersonaVerdict | null {
  const summary = outcome.note;
  if (checkOutcomePasses(outcome)) {
    return normalizePersonaVerdict({
      verdict: "pass",
      summary,
      approvalDetails: { reason: summary, evidence: [] },
      confidence: 1,
    });
  }
  const tail = tailBounded(outcome.output, WORKFLOW_EXECUTION_LIMITS.checkVerdictOutput);
  const quote = tail.text.trim() || "The command printed nothing before it failed.";
  const dropped = tail.droppedBytes + outcome.truncatedBytes;
  const rationale = dropped > 0
    ? `${quote}\n\n(${dropped} earlier bytes of output omitted.)`
    : quote;
  return normalizePersonaVerdict({
    verdict: "fail",
    summary,
    requestedChanges: [{
      title: `Fix the failing ${outcome.slot} check`,
      rationale,
      evidence: [{ kind: "check", quote }],
    }],
    confidence: 1,
  });
}

/**
 * The synthetic pass an operator-disabled node records instead of running.
 *
 * A real `PersonaVerdict`, for the reason `checkVerdict` is one: the Join reads outcomes,
 * the repair packet reads requested changes, and run detail reads both, so a disabled gate
 * that advanced through any other shape would need all three taught about it. The summary
 * says plainly that nothing ran - the verdict must never read as an earned approval - and
 * `confidence: 1` is honest here too: there is no doubt about what a disabled gate did.
 *
 * Routed through `normalizePersonaVerdict` like every other verdict so the strict schema
 * is the single door; with fixed prose the normalization cannot refuse, but the null arm
 * is still handled by every caller rather than asserted away.
 */
function disabledVerdict(node: WorkflowVerdictNode): PersonaVerdict | null {
  const summary =
    `${verdictAuthor(node)} is disabled for this run, so this gate auto-passed without running.`;
  return normalizePersonaVerdict({
    verdict: "pass",
    summary,
    approvalDetails: { reason: summary, evidence: [] },
    confidence: 1,
  });
}

/** The operator-disabled set, tolerant of rows written before the column existed. */
function disabledNodes(run: WorkflowRun): readonly string[] {
  return run.disabledNodeIds ?? [];
}

export class WorkflowEngine {
  private readonly limit: ReviewScheduler;
  private readonly now: () => number;
  private readonly retryBaseMs: number;
  private readonly runnerFor: (id: LlmRunner["id"]) => LlmRunner;
  private readonly resolveExecution: NonNullable<WorkflowEngineOptions["resolveExecution"]>;
  private readonly onSubmissionWaiting: NonNullable<WorkflowEngineOptions["onSubmissionWaiting"]>;
  private readonly onSessionActionWaiting:
    NonNullable<WorkflowEngineOptions["onSessionActionWaiting"]>;
  private readonly onSubmissionSucceeded: NonNullable<WorkflowEngineOptions["onSubmissionSucceeded"]>;
  private readonly checkLimit: CheckScheduler;
  private readonly checkDeps: NonNullable<WorkflowEngineOptions["checkDeps"]>;
  private readonly unresolvedCheckLease: NonNullable<WorkflowEngineOptions["unresolvedCheckLease"]>;
  private readonly workflowConfig: () => WorkflowConfig;
  private stopped = true;
  private pumping = false;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = new Set<Promise<void>>();
  private scheduledAttempts = new Set<string>();

  constructor(
    readonly store: WorkflowStore,
    private readonly onRunChanged: (runId: string) => void = () => {},
    options: WorkflowEngineOptions = {},
  ) {
    this.limit = options.schedule
      ?? createReviewScheduler(options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY);
    this.now = options.now ?? Date.now;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.runnerFor = options.runnerFor ?? llmRunner;
    this.resolveExecution = options.resolveExecution ?? resolvePersonaExecution;
    this.onSubmissionWaiting = options.onSubmissionWaiting ?? (() => {});
    this.onSessionActionWaiting = options.onSessionActionWaiting ?? (() => {});
    this.onSubmissionSucceeded = options.onSubmissionSucceeded ?? (() => false);
    this.checkLimit = options.checkSchedule
      ?? createCheckScheduler(options.checkConcurrency ?? DEFAULT_CHECK_CONCURRENCY);
    this.checkDeps = options.checkDeps ?? (() => ({}));
    this.unresolvedCheckLease = options.unresolvedCheckLease ?? (() => false);
    this.workflowConfig = options.workflowConfig ?? getWorkflowConfig;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    // Cancel live check groups BEFORE awaiting the attempts that own them. A check attempt is
    // a build, and `allSettled` on its own would wait out the command's whole timeout - up to
    // ten minutes of daemon shutdown for one test suite somebody left running.
    //
    // This is the supervisor's own hard-exit teardown, called deliberately early rather than a
    // gentler variant of it: the same signal is going to reach these groups from the `exit`
    // hook moments later whatever we do here, and the only thing a grace period would buy at
    // shutdown is flushed output nobody is left to read. Signalling is all it does - each
    // attempt then settles through the ordinary path, proves its group empty, and hands its
    // pooled worktree back, which is what the `allSettled` below is waiting for.
    //
    // Inert in every build with no execution runtime, and in every daemon with no check
    // running: the watched set is empty and this returns immediately.
    //
    // `src/server/index.ts` calls this from `shutdown()` BEFORE it stops the pool reaper, so
    // the returns issued here still run under a live reaper and its lock. Do not reorder that.
    killLiveCheckGroups();
    await Promise.allSettled([...this.inFlight]);
  }

  wake(): void {
    if (this.stopped || this.pumping) return;
    queueMicrotask(() => void this.pump());
  }

  /** Activate all structurally ready nodes from durable receipts before any provider call. */
  activateSubmission(submissionId: string): void {
    const submission = this.store.getSubmission(submissionId);
    if (!submission) return;
    const run = this.store.getRun(submission.runId);
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    if (!run || !version) {
      if (run) {
        this.store.setRunState(run.id, "failed", "missing_workflow_version", {
          error: "The immutable workflow version is missing or corrupt",
        });
        this.onRunChanged(run.id);
      }
      return;
    }
    this.store.setSubmissionState(submission.id, "running", this.now());
    this.store.setRunState(run.id, "running", "persona_review", null, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
    this.wake();
  }

  private advanceStructure(submission: WorkflowSubmission, version: WorkflowVersion): void {
    const graph = version.graph;
    const sessionNode = graph.nodes.find((node) => node.kind === "session");
    if (!sessionNode) {
      this.blockSubmission(submission, "invalid_version", "Published workflow has no Session node");
      return;
    }
    // A CONTINUATION segment does not re-submit from Session. Its evidence was captured
    // because one action finished, and the only work it authorizes is that action's own
    // downstream route - already seeded as a receipt by the continuation transaction.
    // Seeding Session here would activate the whole first wave again on the child evidence,
    // which is exactly the "restart the graph" behaviour a repair round means and a
    // continuation must not.
    const seedSession = submission.segment === 0;
    let changed = true;
    while (changed) {
      changed = false;
      const latestSubmission = this.store.getSubmission(submission.id);
      const run = this.store.getRun(submission.runId);
      if (!latestSubmission || !run || latestSubmission.status !== "running" || run.status !== "running") return;

      if (seedSession) {
        let sessionAttempt = this.store.latestAttemptForNode(submission.id, sessionNode.id);
        if (!sessionAttempt) {
          sessionAttempt = this.store.insertAttempt({
            id: randomUUID(),
            submissionId: submission.id,
            nodeId: sessionNode.id,
            attempt: 1,
            state: "completed",
            persona: null,
            inputFingerprint: submission.evidenceFingerprint,
            now: this.now(),
          });
          this.store.finishAttempt(sessionAttempt.id, {
            state: "completed",
            output: { outcome: "submitted" },
          }, this.now());
        }
        for (const edge of edgesFrom(graph, sessionNode.id, "submitted")) {
          if (this.store.addReceipt(submission.id, edge.id, sessionAttempt.id, {
            outcome: "submitted",
          }, this.now())) changed = true;
        }
      }

      // A completed verdict and its matching receipts normally commit together.
      // Reasserting the receipts makes recovery safe for databases stopped between older
      // Phase 3 development builds that did not yet make that transaction atomic.
      for (const verdictNode of graph.nodes.filter(isVerdictNode)) {
        const completed = this.store.latestAttemptForNode(submission.id, verdictNode.id);
        const parsed = PersonaVerdictSchema.safeParse(completed?.verdict);
        if (!completed || completed.state !== "completed" || !parsed.success) continue;
        const verdict: PersonaVerdict = parsed.data;
        const packet = jsonValue({
          outcome: verdict.verdict,
          persona: verdictAuthor(verdictNode),
          verdict,
          requestedChanges: verdictRequestedChanges(verdict).map((item) => item.title),
        });
        for (const edge of edgesFrom(graph, verdictNode.id, verdict.verdict)) {
          if (this.store.addReceipt(submission.id, edge.id, completed.id, packet, this.now())) {
            changed = true;
          }
        }
      }

      const currentReceipts = this.store.listReceipts(submission.id);
      // At most ONE action attempt waits per submission at a time. The bound session has one
      // pane and one turn, so two concurrently delivered instructions would interleave into
      // a conversation neither of them expects. Serialized by the version's stable node
      // order below, so which one goes first is a property of the published graph rather
      // than of whichever edge this loop reached first.
      const activatedActions: string[] = [];
      for (const edge of graph.edges) {
        const receipt = currentReceipts.find((item) => item.edgeId === edge.id);
        if (!receipt) continue;
        const target = graph.nodes.find((node) => node.id === edge.target);
        if (!target) continue;
        // A session action activates as ONE waiting attempt and nothing else: no runnable
        // work is enqueued, no verdict is written, and no outgoing receipt exists until the
        // action turn finishes and its continuation segment is captured. The manager owns
        // the delivery that follows.
        if (target.kind === "session_action") {
          const latest = this.store.latestAttemptForNode(submission.id, target.id);
          if (latest && latest.state !== "cancelled") continue;
          activatedActions.push(target.id);
          continue;
        }
        // One arm for both runnable kinds: they differ only in whether the attempt row
        // carries a Persona snapshot. A Check has none, because its command is not part of
        // the version and there is nothing about it to freeze.
        if (target.kind === "persona" || target.kind === "check") {
          const latest = this.store.latestAttemptForNode(submission.id, target.id);
          if (!latest || latest.state === "cancelled") {
            this.store.insertAttempt({
              id: randomUUID(),
              submissionId: submission.id,
              nodeId: target.id,
              attempt: (latest?.attempt ?? 0) + 1,
              state: "queued",
              persona: target.kind === "persona" ? target.persona : null,
              inputFingerprint: `${submission.evidenceFingerprint}:${target.id}`,
              now: this.now(),
            });
            changed = true;
          }
          continue;
        }
        if (target.kind === "session" && edge.targetPort === "return_for_changes") {
          const packet = outcome(receipt.payload) === "fail" ? receipt.payload : {
            outcome: "fail",
            requestedChanges: [],
          };
          this.store.setSubmissionState(submission.id, "waiting_for_session", this.now());
          this.store.setRunState(submission.runId, "waiting_for_session", "persona_feedback", packet, this.now());
          for (const attempt of this.store.listAttempts(submission.id)) {
            if (attempt.state === "queued" || attempt.state === "retry_wait") {
              this.store.finishAttempt(attempt.id, {
                state: "cancelled",
                error: "Submission is waiting for a fresh human resubmission",
              }, this.now());
            }
          }
          this.store.appendEvent(submission.runId, "submission_waiting_for_session", {
            submissionId: submission.id,
            edgeId: edge.id,
            receiptId: receipt.id,
          }, this.now());
          this.onSubmissionWaiting(submission.id);
          this.onRunChanged(submission.runId);
          return;
        }
      }

      // Re-read AFTER the receipt loop, which may have queued this wave's reviewers a few
      // lines ago. Two conditions have to hold before an action may take the pane:
      //
      //  - no action is already waiting, because the bound session has one turn and two
      //    delivered instructions would interleave into a conversation neither expects;
      //  - no evaluator is still pending, because once the action's packet is live the run
      //    parks in `waiting_for_action` and a queued reviewer would sit there unclaimed
      //    until the continuation - reviewing evidence that has since changed, if it ever
      //    ran at all.
      //
      // Deferring costs nothing: `advanceStructure` runs again after every attempt finishes,
      // so the action activates the moment the wave drains.
      const pending = this.store.listAttempts(submission.id);
      const actionBusy = pending.some((attempt) =>
        ["waiting", "queued", "running", "retry_wait"].includes(attempt.state));
      if (!actionBusy && activatedActions.length > 0) {
        // Stable node order, and the graph's own array IS that order: node ids are reused
        // across every publish of a workflow, so two authors of the same pipeline get the
        // same sequence. Sorting by id or by edge order would make the sequence depend on a
        // spelling or on which receipt landed first.
        const ordered = graph.nodes
          .filter((node) => activatedActions.includes(node.id))
          .filter((node) => node.kind === "session_action");
        // Two actions ready AT ONCE is a branching shape this phase does not execute, and it
        // is REFUSED rather than serialized. Running the first and holding the rest looks
        // safe and silently loses them: the continuation seeds the child segment with only
        // the completed action's `complete` edges, so the held sibling's activating receipt
        // stays behind in the parent and it is never delivered at all. A linear pipeline
        // cannot produce this - `A -> B` in sequence is fine, and covered - so the honest
        // answer is a diagnosable block naming both nodes.
        if (ordered.length > 1) {
          this.blockSubmission(
            submission,
            "session_action_parallel_unsupported",
            "Two session actions became ready at the same time. One bound session has one "
            + "turn, and this build runs them one after another rather than at once, so a "
            + `graph that activates ${ordered.map((node) => node.id).join(" and ")} together `
            + "cannot be executed. Chain them instead, so each one's completion activates the "
            + "next.",
          );
          return;
        }
        const first = ordered[0];
        if (first && first.kind === "session_action") {
          const previous = this.store.latestAttemptForNode(submission.id, first.id);
          const attempt = this.store.insertAttempt({
            id: randomUUID(),
            submissionId: submission.id,
            nodeId: first.id,
            attempt: (previous?.attempt ?? 0) + 1,
            state: "waiting",
            persona: null,
            sessionAction: first.action,
            sessionActionState: {
              wait: "preparing",
              deliveryId: null,
              anchor: null,
              pickedUpAt: null,
              settledAt: null,
              expectation: null,
              continuationSubmissionId: null,
              blocked: null,
            },
            inputFingerprint: `${submission.evidenceFingerprint}:${first.id}`,
            now: this.now(),
          });
          this.store.appendEvent(submission.runId, "session_action_waiting", {
            submissionId: submission.id,
            nodeId: first.id,
            attemptId: attempt.id,
            action: first.action.name,
            completion: first.action.completion.kind,
            // Named rather than silently dropped: a branching graph that made two actions
            // ready at once is a shape this phase does not execute in parallel, and a reader
            // has to be able to see that one of them is being held rather than lost.
            deferred: ordered.slice(1).map((node) => node.id),
          }, this.now());
          changed = true;
          this.onSessionActionWaiting(attempt.id);
        }
      }

      for (const join of graph.nodes.filter((node) => node.kind === "all_pass")) {
        const existingJoin = this.store.latestAttemptForNode(submission.id, join.id);
        if (existingJoin?.state === "completed") {
          const existingOutcome = outcome(existingJoin.output);
          if (existingOutcome) {
            for (const outgoing of edgesFrom(graph, join.id, existingOutcome)) {
              if (this.store.addReceipt(
                submission.id,
                outgoing.id,
                existingJoin.id,
                existingJoin.output ?? { outcome: existingOutcome },
                this.now(),
              )) changed = true;
            }
          }
          continue;
        }
        if (existingJoin) continue;
        const incoming = graph.edges.filter((edge) => edge.target === join.id);
        const predecessors = [...new Set(incoming.map((edge) => edge.source))];
        const grouped = predecessors.map((source) => {
          const sourceEdges = incoming.filter((edge) => edge.source === source);
          const sourceReceipt = currentReceipts.find((receipt) =>
            sourceEdges.some((edge) => edge.id === receipt.edgeId));
          return { source, receipt: sourceReceipt };
        });
        if (grouped.length === 0 || grouped.some((item) => !item.receipt)) continue;
        const failed = grouped
          .map((item) => item.receipt!)
          .filter((receipt) => outcome(receipt.payload) === "fail");
        const joinOutcome = failed.length === 0 ? "pass" : "fail";
        const packet = joinOutcome === "pass"
          ? { outcome: "pass" as const }
          : {
              outcome: "fail" as const,
              requestedChanges: failed.map((receipt) => receipt.payload),
            };
        const attempt = this.store.insertAttempt({
          id: randomUUID(),
          submissionId: submission.id,
          nodeId: join.id,
          attempt: 1,
          state: "completed",
          persona: null,
          inputFingerprint: `${submission.evidenceFingerprint}:${join.id}`,
          now: this.now(),
        });
        this.store.finishAttempt(attempt.id, {
          state: "completed",
          output: jsonValue(packet),
        }, this.now());
        for (const outgoing of edgesFrom(graph, join.id, joinOutcome)) {
          if (this.store.addReceipt(
            submission.id,
            outgoing.id,
            attempt.id,
            jsonValue(packet),
            this.now(),
          )) changed = true;
        }
      }

      const afterJoinReceipts = this.store.listReceipts(submission.id);
      for (const end of graph.nodes.filter((node) => node.kind === "end")) {
        const existingEnd = this.store.latestAttemptForNode(submission.id, end.id);
        if (existingEnd?.state === "completed") {
          const existingOutcome = outcome(existingEnd.output);
          if (existingOutcome) {
            if (
              existingOutcome === "pass"
              && version.completionPolicy.kind === "inspector"
              && this.onSubmissionSucceeded(submission.id)
            ) {
              this.onRunChanged(submission.runId);
              return;
            }
            this.store.setSubmissionState(
              submission.id,
              existingOutcome === "pass" ? "completed" : "failed",
              this.now(),
            );
            this.store.setRunState(
              submission.runId,
              existingOutcome === "pass" ? "completed" : "failed",
              existingOutcome === "pass" ? "complete" : "failed_outcome",
              existingEnd.output,
              this.now(),
            );
            this.onRunChanged(submission.runId);
            return;
          }
          continue;
        }
        if (existingEnd) continue;
        const incoming = graph.edges.filter((edge) => edge.target === end.id);
        const receipt = afterJoinReceipts.find((item) => incoming.some((edge) => edge.id === item.edgeId));
        if (!receipt) continue;
        const edge = incoming.find((item) => item.id === receipt.edgeId)!;
        const endOutcome = edge.sourcePort === "fail" ? "fail" : "pass";
        const attempt = this.store.insertAttempt({
          id: randomUUID(),
          submissionId: submission.id,
          nodeId: end.id,
          attempt: 1,
          state: "completed",
          persona: null,
          inputFingerprint: `${submission.evidenceFingerprint}:${end.id}`,
          now: this.now(),
        });
        const packet = { outcome: endOutcome, label: end.outcome };
        this.store.finishAttempt(attempt.id, {
          state: "completed",
          output: packet,
        }, this.now());
        this.store.appendEvent(submission.runId, "workflow_end", packet, this.now());
        if (
          endOutcome === "pass"
          && version.completionPolicy.kind === "inspector"
          && this.onSubmissionSucceeded(submission.id)
        ) {
          this.onRunChanged(submission.runId);
          return;
        }
        this.store.setSubmissionState(submission.id, endOutcome === "pass" ? "completed" : "failed", this.now());
        this.store.setRunState(
          submission.runId,
          endOutcome === "pass" ? "completed" : "failed",
          endOutcome === "pass" ? "complete" : "failed_outcome",
          {
            ...packet,
            completionPolicy: "none",
          },
          this.now(),
        );
        this.onRunChanged(submission.runId);
        return;
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.pumping) return;
    this.pumping = true;
    try {
      const schedulingNow = this.now();
      const ready = this.store.listRunnableAttempts(schedulingNow);
      for (const attempt of ready) {
        if (this.scheduledAttempts.has(attempt.id)) continue;
        this.scheduledAttempts.add(attempt.id);
        // The limiter is chosen HERE, from the node kind, before either is acquired - not
        // inside `runAttempt`. This gate wraps the whole attempt, so an inner check limiter
        // would still have made every waiting and running check occupy one of the three
        // tool-less model-review slots, which is exactly what a separate budget is for.
        const target = this.targetNode(attempt);
        const gate = target?.kind === "check" ? this.checkLimit : this.limit;
        const promise = gate(() => this.runAttempt(attempt))
          .catch((error) => workflowLog("error", {
            event: "attempt_failed",
            call: attempt.id,
            error: error instanceof Error ? error.name : "unknown",
          }))
          .finally(() => {
            this.inFlight.delete(promise);
            this.scheduledAttempts.delete(attempt.id);
            this.wake();
          });
        this.inFlight.add(promise);
      }
      const next = this.store.listAttemptsDueAfter(schedulingNow);
      if (next !== null && !this.stopped) {
        if (this.wakeTimer) clearTimeout(this.wakeTimer);
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          this.wake();
        }, Math.max(1, next - this.now()));
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * The node an attempt belongs to, resolved through its submission, run and pinned version.
   *
   * Always the version the run PINNED, never the workflow's current draft: a check that
   * looked up its slot in a graph an operator has since edited would run a different gate
   * from the one this submission was reviewed against.
   */
  private resolveAttempt(attempt: WorkflowNodeAttempt): {
    submission: WorkflowSubmission;
    run: WorkflowRun;
    version: WorkflowVersion;
    node: PublishedWorkflowNode;
  } | null {
    const submission = this.store.getSubmission(attempt.submissionId);
    const run = submission ? this.store.getRun(submission.runId) : null;
    const version = run ? this.store.getWorkflowVersionById(run.workflowVersionId) : null;
    const node = version?.graph.nodes.find((candidate) => candidate.id === attempt.nodeId);
    if (!submission || !run || !version || !node) return null;
    return { submission, run, version, node };
  }

  private targetNode(attempt: WorkflowNodeAttempt): PublishedWorkflowNode | null {
    return this.resolveAttempt(attempt)?.node ?? null;
  }

  private async runAttempt(initial: WorkflowNodeAttempt): Promise<void> {
    const resolved = this.resolveAttempt(initial);
    if (!resolved) return;
    const { submission, run, version, node } = resolved;
    // The operator disabled this node for this run: auto-pass instead of running it.
    // Checked HERE, at claim time, rather than at attempt creation, so ONE synthesis site
    // covers both halves of the promise - a node disabled before a round starts and a node
    // disabled while its attempt is already queued. `resolveAttempt` re-read the run just
    // now, so the set is current; an attempt that already started keeps its real outcome,
    // which is exactly the "has not reached that phase yet" boundary.
    if (isVerdictNode(node) && disabledNodes(run).includes(node.id)) {
      const verdict = disabledVerdict(node);
      if (verdict) {
        this.runDisabledAttempt(initial, submission, run, version, node, verdict);
        return;
      }
    }
    if (isCheck(node)) {
      await this.runCheckAttempt(initial, submission, run, version, node);
      return;
    }
    if (!isPersona(node)) return;
    const execution = this.resolveExecution(node.persona);
    const claimed = this.store.claimAttempt(initial.id, execution.runner.id, execution.model.id, this.now());
    if (!claimed) return;
    const context = WorkflowContextSnapshotSchema.safeParse(submission.context);
    if (!context.success) {
      this.handleInfrastructureFailure(claimed, run.id, "The persisted workflow context is invalid");
      return;
    }
    const prompt = buildPersonaPrompt(node.persona, context.data, claimed.operatorDirective ?? null);
    let runner: LlmRunner;
    try {
      runner = this.runnerFor(execution.runner.id);
    } catch (error) {
      this.handleInfrastructureFailure(claimed, run.id, String(error));
      return;
    }
    const callIds = new Map<number, string>();
    const observer: StructuredAttemptObserver = {
      start: (attempt, request) => {
        if (
          this.store.getRun(run.id)?.status !== "running"
          || this.store.getSubmission(submission.id)?.status !== "running"
        ) {
          return false;
        }
        const id = randomUUID();
        callIds.set(attempt, id);
        this.store.insertLlmCall({
          id,
          runId: run.id,
          submissionId: submission.id,
          nodeAttemptId: claimed.id,
          purpose: "persona_review",
          runner: execution.runner.id,
          model: execution.model.id,
          attempt,
          state: "running",
          startedAt: this.now(),
          finishedAt: null,
          durationMs: null,
          inputBytes: Buffer.byteLength(request),
          outputBytes: 0,
          costUsd: null,
          errorCode: null,
        });
      },
      finish: (attempt, callResult) => {
        const id = callIds.get(attempt);
        if (!id) return;
        this.store.finishLlmCall(
          id,
          callResult.parsed ? "succeeded" : "failed",
          callResult.raw ? Buffer.byteLength(callResult.raw) : 0,
          callResult.error
            ? "persona_infrastructure"
            : callResult.parsed
              ? null
              : "persona_parse",
          this.now(),
        );
      },
    };
    const result = await runStructured(
      (request) => runner.run(request, {
        model: execution.model.id,
        timeoutMs: PERSONA_TIMEOUT_MS,
      }),
      prompt,
      parsePersonaVerdict,
      `${node.persona.name} Persona`,
      observer,
    );
    if (result.kind === "failed") {
      this.handleInfrastructureFailure(claimed, run.id, result.reason);
      return;
    }
    const verdict = result.value;
    const latestRun = this.store.getRun(run.id);
    const latestSubmission = this.store.getSubmission(submission.id);
    const packet = requestedChangePacket(verdict, node.persona.name);
    const canEmit = latestRun?.status === "running" && latestSubmission?.status === "running";
    if (!canEmit) {
      this.store.finishAttempt(claimed.id, {
        state: "cancelled",
        verdict: jsonValue(verdict),
        output: jsonValue(packet),
        error: "Audit-only result after the submission stopped",
      }, this.now());
      this.onRunChanged(run.id);
      return;
    }
    const receiptPayload = jsonValue({
        outcome: verdict.verdict,
        persona: node.persona.name,
        verdict,
      });
    this.store.finishAttemptWithReceipts(claimed.id, {
      verdict: jsonValue(verdict),
      output: jsonValue(packet),
      receipts: edgesFrom(version.graph, node.id, verdict.verdict).map((edge) => ({
        edgeId: edge.id,
        payload: receiptPayload,
      })),
    }, this.now());
    this.store.appendEvent(run.id, "persona_verdict", {
      nodeId: node.id,
      persona: node.persona.name,
      verdict: verdict.verdict,
    }, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
  }

  /**
   * Record the auto-pass for an operator-disabled node without running anything.
   *
   * The same claim -> stopped-submission guard -> atomic verdict-plus-receipts sequence a
   * real attempt follows, so recovery, the round scrubber, and the repair packet read a
   * disabled gate exactly the way they read every other finished attempt. `output_json`
   * carries `disabled: true` beside the outcome so run detail can say why this "pass"
   * exists without parsing the verdict's prose back apart.
   */
  private runDisabledAttempt(
    initial: WorkflowNodeAttempt,
    submission: WorkflowSubmission,
    run: WorkflowRun,
    version: WorkflowVersion,
    node: WorkflowVerdictNode,
    verdict: PersonaVerdict,
  ): void {
    // Null runner and model, as a Check records: no provider was ever asked.
    const claimed = this.store.claimAttempt(initial.id, null, null, this.now());
    if (!claimed) return;
    const author = verdictAuthor(node);
    const latestRun = this.store.getRun(run.id);
    const latestSubmission = this.store.getSubmission(submission.id);
    if (latestRun?.status !== "running" || latestSubmission?.status !== "running") {
      this.store.finishAttempt(claimed.id, {
        state: "cancelled",
        verdict: jsonValue(verdict),
        error: "Audit-only result after the submission stopped",
      }, this.now());
      this.onRunChanged(run.id);
      return;
    }
    const receiptPayload = jsonValue({
      outcome: verdict.verdict,
      persona: author,
      verdict,
    });
    this.store.finishAttemptWithReceipts(claimed.id, {
      verdict: jsonValue(verdict),
      output: jsonValue({ outcome: verdict.verdict, disabled: true }),
      receipts: edgesFrom(version.graph, node.id, verdict.verdict).map((edge) => ({
        edgeId: edge.id,
        payload: receiptPayload,
      })),
    }, this.now());
    this.store.appendEvent(run.id, "disabled_node_auto_passed", {
      nodeId: node.id,
      persona: author,
      submissionId: submission.id,
    }, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
  }

  /**
   * Run one Check node and write its outcome as an ordinary verdict.
   *
   * A SYNTHETIC `PersonaVerdict`, deliberately, rather than a second verdict shape: the
   * Join reads outcomes, the repair packet reads requested changes, and run detail reads
   * both. Giving a check its own shape would mean teaching all three about it, and the
   * first one anybody forgot would be a gate whose failure silently never reached the
   * Session. The raw `WorkflowCheckOutcome` goes to `output_json` beside it, so run detail
   * can print an exit code without parsing it back out of prose.
   */
  private async runCheckAttempt(
    initial: WorkflowNodeAttempt,
    submission: WorkflowSubmission,
    run: WorkflowRun,
    version: WorkflowVersion,
    node: Extract<PublishedWorkflowNode, { kind: "check" }>,
  ): Promise<void> {
    // Null runner and model: a check is not a model call, and stamping it with a provider it
    // never used would put a fiction in front of whoever reads the run.
    const claimed = this.store.claimAttempt(initial.id, null, null, this.now());
    if (!claimed) return;

    const binding = this.store.getBinding(run.bindingId);
    if (!binding) {
      this.handleInfrastructureFailure(claimed, run.id, "This run's binding no longer exists");
      return;
    }
    const context = WorkflowContextSnapshotSchema.safeParse(submission.context);
    if (!context.success) {
      this.handleInfrastructureFailure(claimed, run.id, "The persisted workflow context is invalid");
      return;
    }

    let result: Awaited<ReturnType<typeof runCheck>>;
    try {
      result = await runCheck({
        slot: node.slot,
        config: this.workflowConfig(),
        cwd: binding.sessionCwd,
        repoRoot: binding.sessionRepoRoot,
        headSha: submission.prHeadSha ?? context.data.evidence.headSha,
        // Bound to THIS attempt: the execution runtime keys its pooled lease and its
        // supervisor's durable identity by attempt id, and `claimed.id` is that id.
      }, this.checkDeps({
        attemptId: claimed.id,
        submissionId: submission.id,
        nodeId: node.id,
      }));
    } catch (error) {
      // A throw out of the runner is infrastructure by definition: nothing about the change
      // under review can be concluded from a gate that could not be asked.
      this.handleInfrastructureFailure(claimed, run.id, error instanceof Error ? error.message : String(error));
      return;
    }
    if (result.kind === "infrastructure") {
      this.handleInfrastructureFailure(claimed, run.id, result.reason);
      return;
    }

    const { outcome: checkOutcome } = result;
    const verdict = checkVerdict(checkOutcome);
    if (!verdict) {
      this.handleInfrastructureFailure(
        claimed,
        run.id,
        `The ${node.slot} check produced an outcome that is not a valid verdict`,
      );
      return;
    }
    const author = verdictAuthor(node);
    const packet = requestedChangePacket(verdict, author);
    const latestRun = this.store.getRun(run.id);
    const latestSubmission = this.store.getSubmission(submission.id);
    if (latestRun?.status !== "running" || latestSubmission?.status !== "running") {
      this.store.finishAttempt(claimed.id, {
        state: "cancelled",
        verdict: jsonValue(verdict),
        output: jsonValue(checkOutcome),
        error: "Audit-only result after the submission stopped",
      }, this.now());
      this.onRunChanged(run.id);
      return;
    }
    const receiptPayload = jsonValue({
      outcome: verdict.verdict,
      persona: author,
      verdict,
    });
    this.store.finishAttemptWithReceipts(claimed.id, {
      verdict: jsonValue(verdict),
      output: jsonValue(checkOutcome),
      receipts: edgesFrom(version.graph, node.id, verdict.verdict).map((edge) => ({
        edgeId: edge.id,
        payload: receiptPayload,
      })),
    }, this.now());
    this.store.appendEvent(run.id, "check_outcome", {
      nodeId: node.id,
      slot: node.slot,
      status: checkOutcome.status,
      exitCode: checkOutcome.exitCode,
    }, this.now());
    this.advanceStructure(submission, version);
    this.onRunChanged(run.id);
  }

  private handleInfrastructureFailure(
    attempt: WorkflowNodeAttempt,
    runId: string,
    reason: string,
  ): void {
    const currentRun = this.store.getRun(runId);
    const currentSubmission = this.store.getSubmission(attempt.submissionId);
    if (currentRun?.status !== "running" || currentSubmission?.status !== "running") {
      this.store.finishAttempt(attempt.id, {
        state: "cancelled",
        error: `Audit-only infrastructure result after the submission stopped: ${reason}`,
      }, this.now());
      this.onRunChanged(runId);
      return;
    }
    this.store.finishAttempt(attempt.id, {
      state: "error",
      error: reason,
    }, this.now());
    if (this.blockedByUnresolvedLease(attempt, runId, reason)) return;
    if (attempt.attempt < MAX_INFRA_ATTEMPTS) {
      const retryAt = this.now() + this.retryBaseMs * 4 ** (attempt.attempt - 1);
      this.store.insertAttempt({
        id: randomUUID(),
        submissionId: attempt.submissionId,
        nodeId: attempt.nodeId,
        attempt: attempt.attempt + 1,
        state: "retry_wait",
        persona: attempt.persona,
        inputFingerprint: attempt.inputFingerprint,
        retryAt,
        error: `Retry scheduled after infrastructure failure: ${reason}`,
        now: this.now(),
      });
      this.store.appendEvent(runId, "persona_retry_scheduled", {
        nodeId: attempt.nodeId,
        attempt: attempt.attempt + 1,
        retryAt,
        error: reason,
      }, this.now());
      this.onRunChanged(runId);
      this.wake();
      return;
    }
    const submission = this.store.getSubmission(attempt.submissionId);
    if (submission) this.store.setSubmissionState(submission.id, "failed", this.now());
    this.store.setRunState(runId, "blocked", "infrastructure_error", {
      nodeId: attempt.nodeId,
      attempts: attempt.attempt,
      error: reason,
    }, this.now());
    this.store.appendEvent(runId, "persona_infrastructure_exhausted", {
      nodeId: attempt.nodeId,
      attempts: attempt.attempt,
      error: reason,
    }, this.now());
    this.onRunChanged(runId);
  }

  /**
   * Contract R's gate: refuse to retry a check node that still owns an unresolved lease.
   *
   * Placed where the RETRY is created rather than inside the execution runtime, because the
   * runtime's published result type has three variants and none of them is "do not retry me" -
   * and inventing a fourth would put a retry policy inside an executor. The rule it enforces
   * is not conservative housekeeping: a retry is a fresh attempt id, therefore a fresh holder
   * token, therefore a lease on a DIFFERENT pooled worktree - so nothing about the pool would
   * stop the second attempt building while the first attempt's process group is still writing
   * into the first tree. Two writers, two trees, and a verdict from whichever finished last.
   *
   * Blocking is visible and self-clearing rather than terminal: the reclamation pass keeps
   * asking whether that group has gone, hands the tree back when it can prove it, and
   * `resumeClearedCheckCleanup` then schedules the retry this withheld. Answering "no lease"
   * is the whole of the cost in every build with no execution runtime and for every persona
   * node in every build.
   */
  private blockedByUnresolvedLease(
    attempt: WorkflowNodeAttempt,
    runId: string,
    reason: string,
  ): boolean {
    if (!this.unresolvedCheckLease(attempt.submissionId, attempt.nodeId)) return false;
    const now = this.now();
    const detail = {
      nodeId: attempt.nodeId,
      attempts: attempt.attempt,
      error: reason,
    };
    this.store.setSubmissionState(attempt.submissionId, "failed", now);
    this.store.setRunState(runId, "blocked", CHECK_CLEANUP_UNRESOLVED_PHASE, detail, now);
    this.store.appendEvent(runId, "check_cleanup_unresolved", detail, now);
    this.onRunChanged(runId);
    return true;
  }

  /**
   * Resume every run whose check cleanup has since resolved.
   *
   * This is the second half of the block above, and it was missing: `blockedByUnresolvedLease`
   * withholds the retry while the first attempt's process group may still be writing into the
   * first worktree, and the reclamation pass hands that tree back once it can prove the group
   * gone. Nothing then continued the run, so a run whose fault had ALREADY cleared sat blocked
   * until an operator found the resubmit route by hand - a self-clearing block that never did.
   *
   * Polled rather than driven from the lease manager, which is deliberately isolated from the
   * store, the engine and the manager. Giving it a seam to reach back through would undo that
   * separation to save a question that costs one indexed row lookup, asked only about runs
   * already blocked in this one phase.
   */
  resumeClearedCheckCleanup(): void {
    for (const run of this.store.listRuns()) {
      if (run.status !== "blocked" || run.currentPhase !== CHECK_CLEANUP_UNRESOLVED_PHASE) continue;
      try {
        this.resumeCheckCleanup(run);
      } catch (error) {
        workflowLog("error", {
          event: "check_cleanup_resume_failed",
          run: run.id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  private resumeCheckCleanup(run: WorkflowRun): void {
    const gate = checkCleanupBlock(run.gateState);
    if (!gate) return;
    const submission = this.store.latestSubmission(run.id);
    if (!submission || submission.status !== "failed") return;
    // The whole gate. Until the tree is accounted for, the block is still telling the truth.
    if (this.unresolvedCheckLease(submission.id, gate.nodeId)) return;
    const failed = this.store.latestAttemptForNode(submission.id, gate.nodeId);
    if (!failed || failed.state !== "error") return;
    const now = this.now();
    if (failed.attempt >= MAX_INFRA_ATTEMPTS) {
      // The cleanup cleared, but this node had already spent every infrastructure attempt.
      // Hand it to the phase that OWNS exhaustion rather than granting a fourth attempt here:
      // that phase is also the one an operator can retry by hand from the run header.
      const detail = { nodeId: gate.nodeId, attempts: failed.attempt, error: gate.error };
      this.store.setRunState(run.id, "blocked", "infrastructure_error", detail, now);
      this.store.appendEvent(run.id, "persona_infrastructure_exhausted", detail, now);
      this.onRunChanged(run.id);
      return;
    }
    // Revive BEFORE restoring the run: the submission is `failed`, `setSubmissionState` refuses
    // that transition outright, and a running run over a failed submission is invisible to
    // `listRunnableAttempts` - the run would look alive and never execute another attempt.
    // A null here means another pass or an operator got there first, which is the whole guard.
    if (!this.store.reviveFailedSubmission(submission.id, run.id, CHECK_CLEANUP_UNRESOLVED_PHASE, now)) {
      return;
    }
    const retryAt = now + this.retryBaseMs * 4 ** (failed.attempt - 1);
    this.store.insertAttempt({
      id: randomUUID(),
      submissionId: submission.id,
      nodeId: gate.nodeId,
      attempt: failed.attempt + 1,
      state: "retry_wait",
      persona: failed.persona,
      inputFingerprint: failed.inputFingerprint,
      retryAt,
      error: `Retry scheduled after the check cleanup resolved: ${gate.error}`,
      now,
    });
    this.store.setRunState(run.id, "running", "persona_review", null, now);
    this.store.appendEvent(run.id, "check_cleanup_resolved", {
      nodeId: gate.nodeId,
      attempt: failed.attempt + 1,
      retryAt,
    }, now);
    this.onRunChanged(run.id);
    this.wake();
  }

  private blockSubmission(submission: WorkflowSubmission, phase: string, error: string): void {
    this.store.setSubmissionState(submission.id, "failed", this.now());
    this.store.setRunState(submission.runId, "failed", phase, { error }, this.now());
    this.store.appendEvent(submission.runId, "workflow_failed", { phase, error }, this.now());
    this.onRunChanged(submission.runId);
  }

  private recover(): void {
    for (const run of this.store.listRuns()) {
      if (["completed", "cancelled", "failed"].includes(run.status)) continue;
      this.store.interruptRunningLlmCalls(run.id, this.now());
      if (run.status === "capturing") {
        const submission = this.store.latestSubmission(run.id);
        if (submission?.status === "capturing") {
          this.store.setSubmissionState(submission.id, "failed", this.now());
        }
        this.store.setRunState(run.id, "blocked", "capture_interrupted", {
          error: "Evidence capture was interrupted by daemon restart; submit again",
        }, this.now());
        this.store.appendEvent(run.id, "capture_interrupted", {
          submissionId: submission?.id ?? null,
        }, this.now());
        this.onRunChanged(run.id);
        continue;
      }
      const version = this.store.getWorkflowVersionById(run.workflowVersionId);
      if (!version) {
        this.store.setRunState(run.id, "failed", "missing_workflow_version", {
          error: "The immutable workflow version is missing or corrupt",
        }, this.now());
        this.onRunChanged(run.id);
        continue;
      }
      for (const submission of this.store.listSubmissions(run.id)) {
        for (const attempt of this.store.listAttempts(submission.id)) {
          if (attempt.state !== "running") continue;
          this.store.finishAttempt(attempt.id, {
            state: "error",
            error: "Interrupted by daemon restart",
          }, this.now());
          // The same gate as the live path, and this is where it matters most: a daemon that
          // died mid-check leaves a lease its startup reconciliation could not prove empty,
          // and rolling the attempt over here is exactly how a second tree would be leased
          // behind a build that outlived us.
          if (this.blockedByUnresolvedLease(attempt, run.id, "Interrupted by daemon restart")) {
            continue;
          }
          if (attempt.attempt < MAX_INFRA_ATTEMPTS) {
            this.store.insertAttempt({
              id: randomUUID(),
              submissionId: attempt.submissionId,
              nodeId: attempt.nodeId,
              attempt: attempt.attempt + 1,
              state: "retry_wait",
              persona: attempt.persona,
              inputFingerprint: attempt.inputFingerprint,
              retryAt: this.now(),
              error: "Retrying interrupted tool-less call",
              now: this.now(),
            });
          } else {
            this.store.setSubmissionState(submission.id, "failed", this.now());
            this.store.setRunState(run.id, "blocked", "infrastructure_error", {
              nodeId: attempt.nodeId,
              error: "Interrupted call exhausted its retry budget",
            }, this.now());
          }
        }
        const currentSubmission = this.store.getSubmission(submission.id);
        const currentRun = this.store.getRun(run.id);
        if (currentSubmission?.status !== "running" || currentRun?.status !== "running") {
          continue;
        }
        const errored = version.graph.nodes.filter(isVerdictNode).flatMap((node) => {
          const attempt = this.store.latestAttemptForNode(submission.id, node.id);
          return attempt?.state === "error" ? [attempt] : [];
        });
        const exhausted = errored.find((attempt) => attempt.attempt >= MAX_INFRA_ATTEMPTS);
        if (exhausted) {
          const error = exhausted.error ?? "Infrastructure failure exhausted its retry budget";
          const now = this.now();
          this.store.setSubmissionState(submission.id, "failed", now);
          this.store.setRunState(run.id, "blocked", "infrastructure_error", {
            nodeId: exhausted.nodeId,
            attempts: exhausted.attempt,
            error,
          }, now);
          this.store.appendEvent(run.id, "persona_infrastructure_exhausted", {
            nodeId: exhausted.nodeId,
            attempts: exhausted.attempt,
            error,
          }, now);
          continue;
        }
        for (const attempt of errored) {
          if (this.blockedByUnresolvedLease(attempt, run.id, attempt.error ?? "Recovered infrastructure failure")) {
            break;
          }
          const now = this.now();
          this.store.insertAttempt({
            id: randomUUID(),
            submissionId: attempt.submissionId,
            nodeId: attempt.nodeId,
            attempt: attempt.attempt + 1,
            state: "retry_wait",
            persona: attempt.persona,
            inputFingerprint: attempt.inputFingerprint,
            retryAt: now,
            error: "Retrying recovered infrastructure failure",
            now,
          });
          this.store.appendEvent(run.id, "persona_retry_scheduled", {
            nodeId: attempt.nodeId,
            attempt: attempt.attempt + 1,
            retryAt: now,
            error: attempt.error ?? "Recovered infrastructure failure",
          }, now);
        }
        if (this.store.getRun(run.id)?.status === "running") {
          this.advanceStructure(submission, version);
        }
      }
      this.onRunChanged(run.id);
    }
  }
}
