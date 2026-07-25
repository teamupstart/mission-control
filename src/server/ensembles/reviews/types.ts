import type { LlmRunnerId } from "@shared/llm.ts";
import type {
  EnsembleArtifactKind,
  EnsembleDriverKey,
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
 * The provider call, model/runner resolution, diff materialization and scheduling around it,
 * all injected so a test drives the driver against a fake instead of a real model or real Git.
 */
export interface ReviewRuntime {
  /** The daemon-owned ceiling shared with Workflow review and compaction. */
  scheduler: ReviewScheduler;
  /** Resolve runner+model at attempt time from the guidance overrides / app+job ladder. */
  resolveExecution(guidance: EnsembleEvaluatorGuidance, policy: EnsembleEvaluatorPolicy): ReviewExecution;
  /** The bound provider call. Tool-less by construction: no grant, cwd, shell, web, or terminal. */
  runModel(runnerId: LlmRunnerId, prompt: string, opts: { modelId: string; timeoutMs: number }): Promise<string>;
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
   * Open the evaluation row BEFORE the provider is asked (persist-before-spawn), returning the id
   * every later call and the terminal write reference. Idempotent for a given stage attempt.
   */
  beginEvaluation(input: {
    runnerId: string;
    modelId: string;
    inputFingerprint: string;
    subjectArtifactIds: string[];
  }): string;
  /** Open one llm-call row BEFORE the provider is asked, so an interrupted call is still on the ledger. */
  startCall(input: {
    evaluationId: string;
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
  guidance: EnsembleEvaluatorGuidance;
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
 * The advisory outcome. `ok` carries the de-anonymised, validated result the engine persists as
 * the evaluation body and the label it surfaces on the compact summary. A failure names WHY, so
 * the engine can distinguish an interrupted call (retryable against the same evidence) from a
 * malformed one (a failure the operator must see), and neither ever becomes a recommendation.
 */
export type ReviewOutcome =
  | {
      ok: true;
      evaluationId: string;
      execution: ReviewExecution;
      result: EnsemblePayloadEnvelope;
      /** A short human label for the compact SSE summary, e.g. "recommends Submission B". */
      resultLabel: string;
    }
  | {
      ok: false;
      kind: ReviewFailureKind;
      detail: string;
      /** Null only when the failure preceded the evaluation row (empty evidence before any call). */
      evaluationId: string | null;
      execution: ReviewExecution | null;
    };

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
  run(context: ReviewDriverContext): Promise<ReviewOutcome>;
}
