import { createHash } from "node:crypto";
import {
  ensemblePayload,
  ENSEMBLE_LIMITS,
  type EnsembleEvaluatorGuidance,
  type EnsembleJson,
} from "@shared/ensemble.ts";
import {
  BEST_OF_N_BUILTIN_RUBRIC,
  BEST_OF_N_BUILTIN_RUBRIC_TEXT,
  BEST_OF_N_COMPARISON_VERSION,
  BestOfNComparisonResultSchema,
  type BestOfNComparison,
  type BestOfNComparisonResult,
  type BestOfNScorecard,
} from "@shared/ensemble-strategies/best-of-n.ts";
import { parseModelJson, runStructured, type StructuredAttemptObserver } from "../../llm/structured.ts";
import { boundedSection } from "../../review/prompt.ts";
import { buildComparativePrompt, type PromptSubjectEvidence } from "./prompt.ts";
import type { ReviewDriver, ReviewDriverContext, ReviewOutcome } from "./types.ts";

/**
 * `comparative_review@1`: one tool-less, provider-neutral, ANONYMOUS comparison of every eligible
 * immutable artifact, producing a validated ranking that recommends a winner but cannot promote it.
 *
 * The driver's whole authority is to read the evidence and return an advisory result. It sorts the
 * subjects by a stable key and gives each an opaque label, so the model never sees which agent,
 * model, or member ordinal produced a submission; it fences every candidate-authored section as
 * untrusted data; it resolves runner and model at attempt time and records every call on the
 * ledger; it validates the reply strictly and semantically before mapping the labels back to
 * artifact ids; and it treats malformed, incomplete, or semantically invalid output as a FAILED
 * attempt rather than a low score or a fallback winner. It never launches, selects, cancels, or
 * deletes anything - those are the engine's, behind a human decision.
 */

/** Opaque display labels, enough for the hard member cap. Assigned in stable-key order. */
const SUBJECT_LETTERS = "ABCDEFGHIJKLMNOP";

/** A per-subject floor so a large guidance snapshot cannot starve a subject of all diff bytes. */
const MIN_PER_SUBJECT_PATCH_BYTES = 8 * 1024;
/** Fixed framing (contract + output contract + headers), reserved out of the packet budget. */
const FRAMING_RESERVE_BYTES = 8 * 1024;
/** Per-subject non-patch reserve (claims + stats + fences), matching the prompt's own field caps. */
const PER_SUBJECT_METADATA_RESERVE_BYTES = 12 * 1024;

/**
 * Split the packet budget so patches are allocated FAIRLY across subjects after the fixed and
 * per-subject metadata is reserved. Pure and exported so a test can assert the allocation without
 * a model. `guidanceBytes`/`intentBytes` are the actual sizes of those (already-capped) sections.
 */
export function perSubjectPatchBytes(
  count: number,
  packetBudget: number,
  guidanceBytes: number,
  intentBytes: number,
): number {
  const reserved =
    guidanceBytes + intentBytes + FRAMING_RESERVE_BYTES + count * PER_SUBJECT_METADATA_RESERVE_BYTES;
  const patchTotal = Math.max(count * MIN_PER_SUBJECT_PATCH_BYTES, packetBudget - reserved);
  return Math.max(MIN_PER_SUBJECT_PATCH_BYTES, Math.floor(patchTotal / count));
}

interface Reported {
  summary: string;
  checks: string[];
  testEvidence: string | null;
}

function readReported(json: EnsembleJson): Reported {
  const object = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const summary = typeof object.summary === "string" ? object.summary : "";
  const checks = Array.isArray(object.checks)
    ? object.checks.filter((check): check is string => typeof check === "string")
    : [];
  const testEvidence = typeof object.testEvidence === "string" ? object.testEvidence : null;
  return { summary, checks, testEvidence };
}

/**
 * The observed git facts the model may see - a WHITELIST, never the whole metadata blob.
 *
 * The stripped fields are the point: `ref`, `snapshotSha`, `treeSha`, `headSha` and `baseSha`
 * carry identity or are simply not comparison evidence, and the ref name in particular embeds
 * the artifact id an anonymous packet exists to hide. Only the statistics that let one diff be
 * compared to another survive.
 */
function observedForPrompt(json: EnsembleJson): { observed: Record<string, number | boolean>; filesChanged: number } {
  const object = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const num = (key: string): number => (typeof object[key] === "number" ? (object[key] as number) : 0);
  const bool = (key: string): boolean => object[key] === true;
  const filesChanged = num("filesChanged");
  return {
    observed: {
      filesChanged,
      insertions: num("insertions"),
      deletions: num("deletions"),
      binaryFiles: num("binaryFiles"),
      dirtyWhenSubmitted: bool("dirty"),
      diffTruncatedAtCapture: bool("patchTruncated"),
      diffOmittedBytesAtCapture: num("patchOmittedBytes"),
    },
    filesChanged,
  };
}

/** Whether a subject has anything a fair comparison could weigh, rather than metadata alone. */
function hasUsableEvidence(materialFilesChanged: number, observedFilesChanged: number, reported: Reported): boolean {
  return materialFilesChanged > 0 || observedFilesChanged > 0 || reported.summary.trim() !== "";
}

function resolveGuidance(
  guidance: EnsembleEvaluatorGuidance,
): { label: string; text: string; fenced: boolean } | null {
  if (guidance.kind === "builtin") {
    // Only rubrics this build actually has can run. A plan naming an unknown rubric - a snapshot
    // from a newer build - fails the attempt rather than judging with a substitute.
    return guidance.rubricId === BEST_OF_N_BUILTIN_RUBRIC
      ? { label: "the built-in rubric", text: BEST_OF_N_BUILTIN_RUBRIC_TEXT, fenced: false }
      : null;
  }
  const name = guidance.name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { label: `the "${name}" Persona`, text: guidance.guidanceMarkdown, fenced: true };
}

/**
 * Strict semantic validation on top of the zod parse, then the label -> artifact mapping.
 *
 * Every rule here refuses rather than repairs: a score of 250, a duplicate rank, a recommendation
 * that is not rank 1, or a label the packet never used is a FAILED attempt, because a comparison
 * that will authorise a promotion may not be quietly corrected into a plausible ranking. The map
 * back to artifact ids happens only once all of these pass.
 */
export function validateComparison(
  result: BestOfNComparisonResult,
  labelToArtifact: Map<string, string>,
  evidenceTruncated: boolean,
): { ok: true; comparison: BestOfNComparison } | { ok: false; reason: string } {
  const n = labelToArtifact.size;
  if (result.subjects.length !== n) {
    return { ok: false, reason: `expected ${n} subject scorecards, got ${result.subjects.length}` };
  }
  const seenLabels = new Set<string>();
  const seenRanks = new Set<number>();
  for (const subject of result.subjects) {
    if (!labelToArtifact.has(subject.label)) {
      return { ok: false, reason: `unknown subject label ${JSON.stringify(subject.label)}` };
    }
    if (seenLabels.has(subject.label)) {
      return { ok: false, reason: `subject label ${JSON.stringify(subject.label)} appears more than once` };
    }
    seenLabels.add(subject.label);
    if (!Number.isInteger(subject.score) || subject.score < 0 || subject.score > 100) {
      return { ok: false, reason: `score for ${subject.label} must be an integer 0-100` };
    }
    if (!Number.isInteger(subject.rank) || subject.rank < 1 || subject.rank > n) {
      return { ok: false, reason: `rank for ${subject.label} must be an integer 1-${n}` };
    }
    if (seenRanks.has(subject.rank)) {
      return { ok: false, reason: `rank ${subject.rank} is assigned to more than one subject` };
    }
    seenRanks.add(subject.rank);
    if (!(subject.confidence >= 0 && subject.confidence <= 1)) {
      return { ok: false, reason: `confidence for ${subject.label} must be within 0-1` };
    }
  }
  for (let rank = 1; rank <= n; rank++) {
    if (!seenRanks.has(rank)) return { ok: false, reason: `rank ${rank} is missing; ranks must be contiguous 1-${n}` };
  }
  const recommended = result.subjects.find((subject) => subject.label === result.recommendation);
  if (!recommended) {
    return { ok: false, reason: `recommendation ${JSON.stringify(result.recommendation)} is not one of the subjects` };
  }
  if (recommended.rank !== 1) {
    return { ok: false, reason: `the recommendation must hold rank 1, but ${result.recommendation} is rank ${recommended.rank}` };
  }

  const scorecards: BestOfNScorecard[] = [...result.subjects]
    .sort((a, b) => a.rank - b.rank)
    .map((subject) => ({
      artifactId: labelToArtifact.get(subject.label)!,
      score: subject.score,
      rank: subject.rank,
      strengths: subject.strengths,
      risks: subject.risks,
      rationale: subject.rationale,
      confidence: subject.confidence,
    }));
  return {
    ok: true,
    comparison: {
      version: BEST_OF_N_COMPARISON_VERSION,
      recommendedArtifactId: labelToArtifact.get(result.recommendation)!,
      comparison: result.comparison,
      caveats: result.caveats,
      scorecards,
      evidenceTruncated,
    },
  };
}

async function run(context: ReviewDriverContext): Promise<ReviewOutcome> {
  const { runtime } = context;

  const guidance = resolveGuidance(context.guidance);
  if (guidance === null) {
    return {
      ok: false,
      kind: "infrastructure",
      detail: "this build does not have the rubric this comparison was compiled against",
      evaluationId: null,
      execution: null,
    };
  }

  // Deterministic anonymous order: sort by the stable artifact key (a UUID, so the order carries
  // no member ordinal), then assign opaque labels. Deterministic because a retry must rebuild the
  // exact same packet - and therefore the same input fingerprint - from the same immutable set.
  const ordered = [...context.subjects].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
  const labelToArtifact = new Map<string, string>();
  const artifactToLabel = new Map<string, string>();
  ordered.forEach((subject, index) => {
    const label = `Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)}`;
    labelToArtifact.set(label, subject.artifactId);
    artifactToLabel.set(subject.artifactId, label);
  });
  const subjectArtifactIds = ordered.map((subject) => subject.artifactId);

  const intent = boundedSection(context.intent, ENSEMBLE_LIMITS.intent);
  const guidanceBytes = Buffer.byteLength(guidance.text, "utf8");
  const perPatch = perSubjectPatchBytes(
    ordered.length,
    context.policy.materialBudgetBytes,
    guidanceBytes,
    Buffer.byteLength(intent, "utf8"),
  );

  const promptSubjects: PromptSubjectEvidence[] = [];
  let evidenceTruncated = false;
  for (const subject of ordered) {
    const label = artifactToLabel.get(subject.artifactId)!;
    let material;
    try {
      material = await runtime.materialize(subject, context.repoRoot, perPatch);
    } catch (error) {
      return {
        ok: false,
        kind: "infrastructure",
        detail: `could not materialize ${label}: ${error instanceof Error ? error.message : String(error)}`,
        evaluationId: null,
        execution: null,
      };
    }
    const reported = readReported(subject.reported);
    const { observed, filesChanged: observedFilesChanged } = observedForPrompt(subject.observed);
    if (!hasUsableEvidence(material.filesChanged, observedFilesChanged, reported)) {
      return {
        ok: false,
        kind: "empty_evidence",
        detail: `${label} produced no comparable evidence - no diff and no reported summary`,
        evaluationId: null,
        execution: null,
      };
    }
    if (material.truncated) evidenceTruncated = true;
    promptSubjects.push({
      label,
      reported,
      observed,
      fileStats: material.files,
      diff: material.patch,
      diffTruncated: material.truncated,
      diffOmittedBytes: material.omittedBytes,
    });
  }

  const execution = runtime.resolveExecution(context.guidance, context.policy);
  const prompt = buildComparativePrompt({
    guidanceLabel: guidance.label,
    guidanceText: guidance.text,
    guidanceFenced: guidance.fenced,
    intent,
    baseSha: context.baseSha,
    subjects: promptSubjects,
  });
  // The protected input fingerprint: a digest of the exact bytes the model is asked to judge, so a
  // retry against the same immutable evidence proves it judged the same packet.
  const inputFingerprint = createHash("sha256").update(prompt).digest("hex");

  // Persist the evaluation BEFORE any provider work; the first call row is opened by the observer's
  // first `start`, which also runs before the provider is asked.
  if (context.signal.aborted || !context.stillActive()) {
    return {
      ok: false,
      kind: "interrupted",
      detail: "the review stage stopped before evaluation began",
      evaluationId: null,
      execution,
    };
  }
  const evaluationId = context.persist.beginEvaluation({
    runnerId: execution.runnerId,
    modelId: execution.modelId,
    inputFingerprint,
    subjectArtifactIds,
  });

  const callIds = new Map<number, string>();
  const callStarts = new Map<number, number>();
  const callInputBytes = new Map<number, number>();
  let stopped = false;
  // The last attempt's outcome, tracked as primitives so the classification below survives control
  // flow: `error` set means the provider threw (infrastructure); a finish with neither an error nor
  // a parse means the reply arrived but was malformed (invalid output).
  let sawFinish = false;
  let lastError: string | null = null;
  let lastParsed = false;
  const observer: StructuredAttemptObserver = {
    start: (attempt, request) => {
      // The abort seam: a cancel, a withdrawal, or a superseding stage attempt lands here and stops
      // a parse retry before it starts new provider work, exactly as the Workflow engine's does.
      if (context.signal.aborted || !context.stillActive()) {
        stopped = true;
        return false;
      }
      const startedAt = runtime.now();
      const inputBytes = Buffer.byteLength(request, "utf8");
      const callId = context.persist.startCall({
        evaluationId,
        attempt,
        runnerId: execution.runnerId,
        modelId: execution.modelId,
        inputBytes,
        startedAt,
      });
      callIds.set(attempt, callId);
      callStarts.set(attempt, startedAt);
      callInputBytes.set(attempt, inputBytes);
    },
    finish: (attempt, callResult) => {
      sawFinish = true;
      lastError = callResult.error;
      lastParsed = callResult.parsed;
      const callId = callIds.get(attempt);
      if (!callId) return;
      const startedAt = callStarts.get(attempt) ?? runtime.now();
      const finishedAt = runtime.now();
      context.persist.finishCall(callId, {
        state: callResult.error ? "failed" : callResult.parsed ? "succeeded" : "failed",
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        inputBytes: callInputBytes.get(attempt) ?? 0,
        outputBytes: callResult.raw ? Buffer.byteLength(callResult.raw, "utf8") : 0,
        costUsd: null,
        errorCode: callResult.error ? "review_infrastructure" : callResult.parsed ? null : "review_parse",
      });
    },
  };

  const result = await runtime.scheduler(() =>
    runStructured(
      (request) => runtime.runModel(execution.runnerId, request, { modelId: execution.modelId, timeoutMs: runtime.timeoutMs }),
      prompt,
      (raw) => parseModelJson(raw, BestOfNComparisonResultSchema),
      "The comparison",
      observer,
    ),
  );

  if (result.kind === "failed") {
    // Classify the failure so the engine can tell a retryable interruption from a malformed reply.
    // A stop (cancel/withdraw) is interrupted; a throw (spawn/timeout/exit) is infrastructure; a
    // reply that arrived but never parsed - prose, or a fenced malformed object - is invalid output.
    const kind =
      stopped || context.signal.aborted || !context.stillActive()
        ? "interrupted"
        : lastError != null
          ? "infrastructure"
          : sawFinish && !lastParsed
            ? "invalid_output"
            : "infrastructure";
    return { ok: false, kind, detail: result.reason, evaluationId, execution };
  }

  const validated = validateComparison(result.value, labelToArtifact, evidenceTruncated);
  if (!validated.ok) {
    return { ok: false, kind: "invalid_output", detail: validated.reason, evaluationId, execution };
  }

  const recommendedLabel = artifactToLabel.get(validated.comparison.recommendedArtifactId) ?? "a submission";
  return {
    ok: true,
    evaluationId,
    execution,
    result: ensemblePayload(validated.comparison as unknown as EnsembleJson),
    resultLabel: `recommends ${recommendedLabel}`,
  };
}

export const comparativeReviewDriver: ReviewDriver = {
  driverKey: "comparative_review@1",
  run,
};
