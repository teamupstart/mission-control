import { createHash } from "node:crypto";
import type { TypeOf, ZodTypeAny } from "zod";
import {
  ensemblePayload,
  ENSEMBLE_LIMITS,
  type EnsembleEvaluatorGuidance,
  type EnsembleJson,
} from "@shared/ensemble.ts";
import { parseModelJson, runStructured, type StructuredAttemptObserver } from "../../llm/structured.ts";
import { boundedSection } from "../../review/prompt.ts";
import type { PromptSubjectEvidence } from "./prompt.ts";
import type { ReviewDriverContext, ReviewOutcome } from "./types.ts";

/**
 * The evidence packet and the provider round-trip every tool-less ensemble evaluator shares.
 *
 * There are two of them now - the comparative ranking and the consensus divergence pass - and
 * they differ in exactly three ways: the question they ask, the schema of the reply, and what
 * makes a reply semantically valid. Everything else is identical and must STAY identical, which
 * is why it lives here rather than in each driver: the anonymous ordering and labelling, the
 * per-subject byte allocation, the whitelist of observed git facts, the untrusted fencing, the
 * empty-evidence refusal, the input fingerprint, the persist-before-spawn ledger, the abort seam,
 * and the classification of a failure into interrupted / infrastructure / invalid output.
 *
 * A second copy of any of that is not a duplicate that drifts into a style difference. It is a
 * copy that drifts into an evaluator which leaks a ref name into an anonymous packet, or accepts
 * a reply it should have failed, or opens a provider call it never records.
 */

/** Opaque display labels, enough for the hard member cap. Assigned in stable-key order. */
export const SUBJECT_LETTERS = "ABCDEFGHIJKLMNOP";

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

export interface Reported {
  summary: string;
  checks: string[];
  testEvidence: string | null;
}

export function readReported(json: EnsembleJson): Reported {
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
 * carry identity or are simply not evidence, and the ref name in particular embeds the artifact
 * id an anonymous packet exists to hide. Only the statistics that let one diff be weighed against
 * another survive.
 */
export function observedForPrompt(json: EnsembleJson): {
  observed: Record<string, number | boolean>;
  filesChanged: number;
} {
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

/** Whether a subject has anything a fair judgement could weigh, rather than metadata alone. */
function hasUsableEvidence(
  materialFilesChanged: number,
  observedFilesChanged: number,
  reported: Reported,
): boolean {
  return materialFilesChanged > 0 || observedFilesChanged > 0 || reported.summary.trim() !== "";
}

export interface ResolvedGuidance {
  label: string;
  text: string;
  fenced: boolean;
}

/**
 * Resolve a plan's guidance snapshot to the exact text this attempt will use.
 *
 * `builtin` is the ONE rubric the calling evaluator owns. A plan naming any other builtin id - a
 * snapshot from a newer build, or a rubric belonging to a different strategy - resolves to null
 * and fails the attempt rather than judging with a substitute, which would evaluate against
 * criteria the operator never chose with nothing on screen to say so.
 */
export function resolveGuidance(
  guidance: EnsembleEvaluatorGuidance,
  builtin: { id: string; text: string; label: string },
): ResolvedGuidance | null {
  if (guidance.kind === "builtin") {
    return guidance.rubricId === builtin.id
      ? { label: builtin.label, text: builtin.text, fenced: false }
      : null;
  }
  // Control characters and backticks are stripped from the NAME because it is interpolated into
  // the prompt as prose rather than fenced; the guidance body below it is fenced as data.
  const name = guidance.name
    .replace(/\p{Cc}/gu, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { label: `the "${name}" Persona`, text: guidance.guidanceMarkdown, fenced: true };
}

/** The anonymous, bounded evidence every evaluator prompt is built from. */
export interface EvidencePacket {
  /** Opaque label -> artifact id. The mapping never enters the prompt. */
  labelToArtifact: Map<string, string>;
  /** The artifact ids judged, in the order they were presented. */
  subjectArtifactIds: string[];
  subjects: PromptSubjectEvidence[];
  intent: string;
  evidenceTruncated: boolean;
}

/**
 * Build one anonymous evidence packet, or say why it cannot be built.
 *
 * The order is deterministic - sorted by the artifact's own uuid, which carries no ordinal -
 * because a retry must rebuild the exact same packet, and therefore the same input fingerprint,
 * from the same immutable set.
 *
 * **Anonymity is unconditional, and `policy.anonymizeSubjects` is deliberately not consulted.**
 * Every subject becomes an opaque `Submission X` here, and `observedForPrompt` strips the ref,
 * shas and paths, so no agent, model, ordinal or identity-bearing string reaches a model on any
 * path. The policy field is persisted (it is inside compiled plans an operator already has) and
 * every shipped compiler pins it to `true`, so the plan states what actually happens. It is not
 * an operator control: a de-anonymised packet is a different safety story - one where a
 * candidate's own diff can impersonate a sibling's identity label - and it needs its own design,
 * not a boolean read here. Neither strategy's form offers a toggle for it, and
 * `ensemble-anonymity.test.ts` fails if one reappears.
 */
export async function assembleEvidencePacket(
  context: ReviewDriverContext,
  guidance: ResolvedGuidance,
): Promise<
  | { ok: true; packet: EvidencePacket }
  | { ok: false; kind: "empty_evidence" | "infrastructure"; detail: string }
> {
  const { runtime } = context;
  const ordered = [...context.subjects].sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
  );
  const labelToArtifact = new Map<string, string>();
  const artifactToLabel = new Map<string, string>();
  ordered.forEach((subject, index) => {
    const label = `Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)}`;
    labelToArtifact.set(label, subject.artifactId);
    artifactToLabel.set(subject.artifactId, label);
  });

  const intent = boundedSection(context.intent, ENSEMBLE_LIMITS.intent);
  const perPatch = perSubjectPatchBytes(
    ordered.length,
    context.policy.materialBudgetBytes,
    Buffer.byteLength(guidance.text, "utf8"),
    Buffer.byteLength(intent, "utf8"),
  );

  const subjects: PromptSubjectEvidence[] = [];
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
      };
    }
    const reported = readReported(subject.reported);
    const { observed, filesChanged: observedFilesChanged } = observedForPrompt(subject.observed);
    if (!hasUsableEvidence(material.filesChanged, observedFilesChanged, reported)) {
      return {
        ok: false,
        kind: "empty_evidence",
        detail: `${label} produced no comparable evidence - no diff and no reported summary`,
      };
    }
    if (material.truncated) evidenceTruncated = true;
    subjects.push({
      label,
      reported,
      observed,
      fileStats: material.files,
      diff: material.patch,
      diffTruncated: material.truncated,
      diffOmittedBytes: material.omittedBytes,
    });
  }

  return {
    ok: true,
    packet: {
      labelToArtifact,
      subjectArtifactIds: ordered.map((subject) => subject.artifactId),
      subjects,
      intent,
      evidenceTruncated,
    },
  };
}

/**
 * What one evaluator contributes on top of the shared packet: its question, the schema of its
 * reply, and what makes a reply semantically valid. Nothing else - a driver needing more than
 * this would be reaching for authority the review seam deliberately withholds.
 */
export interface EvidenceReviewSpec<S extends ZodTypeAny> {
  /** How a failure names this evaluator in operator-facing text, e.g. "The comparison". */
  label: string;
  /**
   * The one builtin rubric this evaluator owns, and how the prompt names it.
   *
   * The ledger's `llmPurpose` is deliberately NOT here: the driver already declares it
   * (`ReviewDriver.llmPurpose`) because the engine reads it before the driver runs, and a second
   * copy on the spec would be a field nothing reads and everything could disagree with.
   */
  builtinRubric: { id: string; text: string; label: string };
  buildPrompt(input: {
    guidance: ResolvedGuidance;
    intent: string;
    baseSha: string;
    subjects: PromptSubjectEvidence[];
  }): string;
  /** Structure and lengths. Meaning is `validate`'s. */
  replySchema: S;
  /**
   * Semantic validation and the label-to-artifact mapping, in that order. Every rule here must
   * REFUSE rather than repair: a result shown to an operator as what the fleet found may not be
   * quietly corrected into a plausible one.
   */
  validate(
    reply: TypeOf<S>,
    packet: EvidencePacket,
  ): { ok: true; result: EnsembleJson; resultLabel: string } | { ok: false; reason: string };
}

/**
 * Run one evaluator end to end: assemble, fingerprint, open the evaluation row, call the provider
 * through the daemon-wide scheduler, validate, and hand back an advisory outcome.
 *
 * Every side effect that outlives the call is recorded BEFORE the provider is asked - the
 * evaluation row here, each call row in the observer - so a daemon that dies mid-call leaves a
 * ledger the engine can classify rather than a call nobody knows happened.
 */
export async function runEvidenceReview<S extends ZodTypeAny>(
  context: ReviewDriverContext,
  spec: EvidenceReviewSpec<S>,
): Promise<ReviewOutcome> {
  const { runtime } = context;

  const guidance = resolveGuidance(context.guidance, spec.builtinRubric);
  if (guidance === null) {
    return {
      ok: false,
      kind: "infrastructure",
      detail: "this build does not have the rubric this evaluation was compiled against",
      evaluationId: null,
      execution: null,
    };
  }

  const assembled = await assembleEvidencePacket(context, guidance);
  if (!assembled.ok) {
    return {
      ok: false,
      kind: assembled.kind,
      detail: assembled.detail,
      evaluationId: null,
      execution: null,
    };
  }
  const packet = assembled.packet;

  const execution = runtime.resolveExecution(context.guidance, context.policy);
  const prompt = spec.buildPrompt({
    guidance,
    intent: packet.intent,
    baseSha: context.baseSha,
    subjects: packet.subjects,
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
    subjectArtifactIds: packet.subjectArtifactIds,
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
      (request) =>
        runtime.runModel(execution.runnerId, request, {
          modelId: execution.modelId,
          timeoutMs: runtime.timeoutMs,
        }),
      prompt,
      (raw) => parseModelJson(raw, spec.replySchema),
      spec.label,
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

  const validated = spec.validate(result.value, packet);
  if (!validated.ok) {
    return { ok: false, kind: "invalid_output", detail: validated.reason, evaluationId, execution };
  }

  return {
    ok: true,
    evaluationId,
    execution,
    result: ensemblePayload(validated.result),
    resultLabel: validated.resultLabel,
  };
}
