import type { LlmRunnerId } from "@shared/llm.ts";
import type {
  EnsembleArtifactKind,
  EnsembleDriverKey,
  EnsembleEvaluation,
  EnsembleEvaluatorGuidance,
  EnsembleEvaluatorPolicy,
  EnsembleJson,
  EnsembleLlmCallState,
  EnsembleLlmPurpose,
  EnsemblePayloadEnvelope,
} from "@shared/ensemble.ts";
import type { ReviewScheduler } from "../../llm/review-scheduler.ts";

/**
 * The seam between the strategy-neutral engine and a versioned REVIEW driver.
 *
 * A review driver is the one place a run's evidence meets a model, and its authority is
 * deliberately tiny: it is handed immutable run facts, the ready artifacts and their evidence,
 * a guidance snapshot, a budget, an abort signal, and persistence callbacks - and it hands back
 * one advisory result. It cannot launch a member, select a winner, cancel a Task, bind a
 * Workflow, delete a ref, or move the run to another status. The engine dispatches to it by the
 * compiled plan's `driverKey`, never by asking whether a run is Best-of-N, which is the whole
 * reason the driver and the strategy are two different things.
 */

/** One ready artifact offered to a review, with everything needed to judge it and nothing more. */
export interface ReviewSubject {
  artifactId: string;
  kind: EnsembleArtifactKind;
  /** The versioned locator, for materializing the diff from the immutable private ref. */
  locator: EnsembleJson;
  /** Observed git facts recorded at capture - file stats, binary count, truncation, dirty. */
  observed: EnsembleJson;
  /** The member's REPORTED claims (summary, checks, testEvidence), labelled as claims to the model. */
  reported: EnsembleJson;
}

/** Bounded, on-demand diff material for one subject - re-derived from the immutable ref, never stored. */
export interface ReviewMaterial {
  files: Array<{ path: string; oldPath: string | null; insertions: number; deletions: number; binary: boolean }>;
  filesChanged: number;
  insertions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
  omittedBytes: number;
}

/** How runner and model were resolved for one review attempt, resolved at attempt time. */
export interface ReviewExecution {
  runnerId: LlmRunnerId;
  modelId: string;
  /** A configured runner id this build could not honour, else null - reported, never swallowed. */
  unknownRunner: string | null;
}

/**
 * The runner/model pins one evaluator call was compiled with, whatever named them.
 *
 * The ladder needs exactly two facts - an explicit runner and an explicit model, either of which
 * may be absent - and a comparative policy carries them at its top level while a panel carries one
 * pair per judge. Passing the PINS rather than the policy is what lets one resolver serve both
 * without knowing which arm of the union it is looking at.
 */
export interface ReviewExecutionPins {
  runner: LlmRunnerId | null;
  model: string | null;
}

/**
 * The provider call, model/runner resolution, diff materialization and scheduling around it,
 * all injected so a test drives the driver against a fake instead of a real model or real Git.
 */
export interface ReviewRuntime {
  /** The daemon-owned ceiling shared with Workflow review and compaction. */
  scheduler: ReviewScheduler;
  /** Resolve runner+model at attempt time from the explicit pins / guidance overrides / app ladder. */
  resolveExecution(guidance: EnsembleEvaluatorGuidance, pins: ReviewExecutionPins): ReviewExecution;
  /** The bound provider call. Tool-less by construction: no grant, cwd, shell, web, or terminal. */
  runModel(
    runnerId: LlmRunnerId,
    prompt: string,
    opts: { modelId: string; timeoutMs: number; schema?: Record<string, unknown> },
  ): Promise<string>;
  /** Whether this runner enforces the supplied JSON Schema at the provider boundary. */
  guaranteesSchema(runnerId: LlmRunnerId): boolean;
  /** Materialize one subject's bounded diff from its immutable ref, reading the run's repo. */
  materialize(subject: ReviewSubject, repoRoot: string, maxPatchBytes: number): Promise<ReviewMaterial>;
  now(): number;
  /** Per-attempt wall-clock budget for the provider call. */
  timeoutMs: number;
}

/**
 * The durable ledger the driver writes through. The engine backs each method with the store and
 * the run/stage ids it owns, so the driver records its own evaluation and per-call facts without
 * ever holding a reference to a Task, a member, or the run's status.
 */
export interface ReviewPersist {
  /**
   * Open one evaluation row BEFORE its provider call is made (persist-before-spawn), returning the
   * id every later call and the terminal write reference.
   *
   * `ordinal` identifies the row WITHIN this stage attempt and makes the call idempotent: a
   * comparison opens exactly one at ordinal 1, while a panel opens one for each judge that reaches
   * its provider call at that judge's compiled ordinal. Re-opening the same ordinal returns the
   * existing row rather than a second one. `method` is what actually judged, recorded on the row
   * so a reader can tell a ballot from a comparison without re-deriving it from the plan.
   */
  beginEvaluation(input: {
    ordinal: number;
    method: string;
    runnerId: string;
    modelId: string;
    inputFingerprint: string;
    subjectArtifactIds: string[];
  }): string;
  /** Open one llm-call row BEFORE the provider is asked, so an interrupted call is still on the ledger. */
  startCall(input: {
    evaluationId: string;
    /** What this call was for, recorded on the ledger row rather than assumed from the stage. */
    purpose: EnsembleLlmPurpose;
    attempt: number;
    runnerId: string;
    modelId: string;
    inputBytes: number;
    startedAt: number;
  }): string;
  finishCall(
    callId: string,
    input: {
      state: EnsembleLlmCallState;
      finishedAt: number;
      durationMs: number;
      /** The prompt's byte length, known at `start` and carried through so the row records it. */
      inputBytes: number;
      outputBytes: number;
      /** Null means the runner did not report a cost. Never coalesce it to zero. */
      costUsd: number | null;
      errorCode: string | null;
    },
  ): void;
}

/** Everything a review driver is given. Nothing here lets it launch, select, cancel, or delete. */
export interface ReviewDriverContext {
  runId: string;
  stageId: string;
  stageAttemptId: string;
  /** The original task/acceptance intent, verbatim - fenced as untrusted data by the driver. */
  intent: string;
  /** The one pinned base every subject is diffed against. */
  baseSha: string;
  /** The repository holding the immutable refs - read for diffs, never written. */
  repoRoot: string;
  /**
   * The compiled evaluator, which is where a driver reads its own GUIDANCE from.
   *
   * Guidance is not a separate field beside this, deliberately: a comparison has exactly one
   * snapshot and a panel has one per judge, so a context that promised "the guidance" would have
   * had to invent an answer for the panel - and whichever judge it picked would have been wrong.
   */
  policy: EnsembleEvaluatorPolicy;
  /** The declared ready artifacts, already verified by the engine. */
  subjects: ReviewSubject[];
  runtime: ReviewRuntime;
  persist: ReviewPersist;
  /** Aborts the pending parse retry when the run is cancelled/withdrawn/superseded. */
  signal: AbortSignal;
  /** Whether the evaluation may still proceed - re-read from durable state on every attempt. */
  stillActive(): boolean;
}

export type ReviewFailureKind = "empty_evidence" | "invalid_output" | "infrastructure" | "interrupted";

/**
 * One evaluation row this attempt opened, and how the engine must settle it.
 *
 * A LIST of these rather than a single id, because how many models a review asks is the driver's
 * business and not the engine's: a comparison opens one, while a panel may open one per judge and
 * legitimately settle some `succeeded` and some `failed` in the same attempt. The engine writes
 * every one of them under the run lock, in one pass, after the last call has landed - so a run
 * cancelled mid-panel finds every row `interrupted` rather than a half-committed ledger.
 */
export interface ReviewEvaluationRecord {
  evaluationId: string;
  /** What actually ran for this row, or null when it failed before a runner was resolved. */
  execution: ReviewExecution | null;
  status: "succeeded" | "failed" | "interrupted";
  /** The validated, de-anonymised body. Non-null exactly when `status` is `succeeded`. */
  result: EnsemblePayloadEnvelope | null;
  error: string | null;
}

/**
 * The advisory outcome. `ok` carries every evaluation row the attempt produced and the label the
 * stage advertises on the compact summary. A failure names WHY, so the engine can distinguish an
 * interrupted call (retryable against the same evidence) from a malformed one (a failure the
 * operator must see), and neither ever becomes a recommendation.
 */
export type ReviewOutcome =
  | {
      ok: true;
      evaluations: ReviewEvaluationRecord[];
      /** A short human label for the compact SSE summary, e.g. "recommends Submission B". */
      resultLabel: string;
    }
  | {
      ok: false;
      kind: ReviewFailureKind;
      detail: string;
      /** Rows already opened when the attempt failed; empty when it failed before any. */
      evaluations: ReviewEvaluationRecord[];
    };

/**
 * What a driver makes of the evaluation rows a crash left behind on ONE running stage attempt.
 *
 * Null - the common answer - means the attempt is unfinished and the generic interrupt-and-retry
 * path owns it. A non-null answer is the narrow case where the effect already happened and only
 * the receipt is missing: the rows are settled and their result is durable, so completing the
 * stage from them is strictly better than spending the model calls again. It is the DRIVER's
 * question because only it knows how many rows an attempt was supposed to produce and how many
 * have to have succeeded.
 */
export interface ReviewRecovery {
  evaluationIds: string[];
  resultLabel: string | null;
}

/** A versioned review driver, registered by the exact `driverKey` a compiled plan may name. */
export interface ReviewDriver {
  driverKey: EnsembleDriverKey;
  /**
   * How this driver's provider calls appear on the durable cost ledger.
   *
   * Declared by the driver rather than hard-coded by the engine, because the engine dispatches on
   * the compiled plan's driver key and must not hold a second table mapping keys to purposes -
   * that second table is where a new evaluator's calls end up filed under the old one's name. The
   * evaluation row's `method` is a different fact and comes from the PLAN (`evaluator.kind`),
   * which is what the run was compiled to do rather than what this build happens to run it with.
   */
  llmPurpose: EnsembleLlmPurpose;
  resultLabel(input: {
    result: EnsemblePayloadEnvelope;
    subjectArtifactIds: string[];
  }): string | null;
  /**
   * Whether the evaluations left on a running stage attempt already ARE a completed review.
   *
   * Given the compiled evaluator policy and every evaluation row belonging to that one stage
   * attempt, in creation order.
   */
  recover(input: {
    policy: EnsembleEvaluatorPolicy;
    evaluations: EnsembleEvaluation[];
  }): ReviewRecovery | null;
  run(context: ReviewDriverContext): Promise<ReviewOutcome>;
}
