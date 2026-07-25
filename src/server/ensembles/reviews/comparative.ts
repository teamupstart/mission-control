import { type EnsembleJson, type EnsemblePayloadEnvelope } from "@shared/ensemble.ts";
import {
  BEST_OF_N_BUILTIN_RUBRIC,
  BEST_OF_N_BUILTIN_RUBRIC_TEXT,
  BEST_OF_N_COMPARISON_VERSION,
  BestOfNComparisonResultSchema,
  parseBestOfNComparison,
  type BestOfNComparison,
  type BestOfNComparisonResult,
  type BestOfNScorecard,
} from "@shared/ensemble-strategies/best-of-n.ts";
import { buildComparativePrompt } from "./prompt.ts";
import { runEvidenceReview, SUBJECT_LETTERS, type EvidencePacket } from "./packet.ts";
import type { ReviewDriver, ReviewDriverContext, ReviewOutcome } from "./types.ts";

/**
 * `comparative_review@1`: one tool-less, provider-neutral, ANONYMOUS comparison of every eligible
 * immutable artifact, producing a validated ranking that recommends a winner but cannot promote it.
 *
 * The driver's whole authority is to read the evidence and return an advisory result. The anonymous
 * packet, the fencing, the byte budget, the ledger and the failure classification are
 * `packet.ts`'s, shared with every other evaluator; what belongs HERE is the three things that make
 * this evaluator itself - the ranking question, the reply schema, and the semantic rules a ranking
 * has to satisfy before its labels are mapped back to artifact ids. It never launches, selects,
 * cancels, or deletes anything; those are the engine's, behind a human decision.
 */

function resultLabel(input: {
  result: EnsemblePayloadEnvelope;
  subjectArtifactIds: string[];
}): string | null {
  const comparison = parseBestOfNComparison(input.result.body);
  if (!comparison) return null;
  const index = input.subjectArtifactIds.indexOf(comparison.recommendedArtifactId);
  if (index < 0) return null;
  return `recommends Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)}`;
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
    if (!seenRanks.has(rank)) {
      return { ok: false, reason: `rank ${rank} is missing; ranks must be contiguous 1-${n}` };
    }
  }
  const recommended = result.subjects.find((subject) => subject.label === result.recommendation);
  if (!recommended) {
    return {
      ok: false,
      reason: `recommendation ${JSON.stringify(result.recommendation)} is not one of the subjects`,
    };
  }
  if (recommended.rank !== 1) {
    return {
      ok: false,
      reason: `the recommendation must hold rank 1, but ${result.recommendation} is rank ${recommended.rank}`,
    };
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

function validate(
  reply: BestOfNComparisonResult,
  packet: EvidencePacket,
): { ok: true; result: EnsembleJson; resultLabel: string } | { ok: false; reason: string } {
  const validated = validateComparison(reply, packet.labelToArtifact, packet.evidenceTruncated);
  if (!validated.ok) return validated;
  const result = validated.comparison as unknown as EnsembleJson;
  return {
    ok: true,
    result,
    resultLabel:
      resultLabel({
        result: { payloadVersion: 1, body: result },
        subjectArtifactIds: packet.subjectArtifactIds,
      }) ?? "recommends a submission",
  };
}

async function run(context: ReviewDriverContext): Promise<ReviewOutcome> {
  return runEvidenceReview(context, {
    evaluatorKind: "comparative_llm",
    purpose: "comparative_review",
    label: "The comparison",
    builtinRubric: {
      id: BEST_OF_N_BUILTIN_RUBRIC,
      text: BEST_OF_N_BUILTIN_RUBRIC_TEXT,
      label: "the built-in rubric",
    },
    buildPrompt: ({ guidance, intent, baseSha, subjects }) =>
      buildComparativePrompt({
        guidanceLabel: guidance.label,
        guidanceText: guidance.text,
        guidanceFenced: guidance.fenced,
        intent,
        baseSha,
        subjects,
      }),
    replySchema: BestOfNComparisonResultSchema,
    validate,
  });
}

export const comparativeReviewDriver: ReviewDriver = {
  driverKey: "comparative_review@1",
  llmPurpose: "comparative_review",
  resultLabel,
  recover({ policy, evaluations }) {
    if (policy.kind !== "comparative_llm") return null;
    const succeeded = evaluations.find((evaluation) => evaluation.status === "succeeded");
    if (!succeeded) return null;
    return {
      evaluationIds: [succeeded.id],
      resultLabel: succeeded.result
        ? resultLabel({ result: succeeded.result, subjectArtifactIds: succeeded.subjectArtifactIds })
        : null,
    };
  },
  run,
};
