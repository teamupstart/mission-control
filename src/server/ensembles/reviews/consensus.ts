import { type EnsembleJson, type EnsemblePayloadEnvelope } from "@shared/ensemble.ts";
import {
  CONSENSUS_BUILTIN_RUBRIC,
  CONSENSUS_BUILTIN_RUBRIC_TEXT,
  CONSENSUS_FINDINGS_VERSION,
  ConsensusResultSchema,
  divergenceOptionId,
  divergenceQuestionId,
  parseConsensusFindings,
  type ConsensusDivergence,
  type ConsensusFindings,
  type ConsensusResult,
} from "@shared/ensemble-strategies/consensus.ts";
import { buildConsensusPrompt } from "./consensus-prompt.ts";
import { runEvidenceReview, type EvidencePacket } from "./packet.ts";
import type { ReviewDriver, ReviewDriverContext, ReviewOutcome } from "./types.ts";

/**
 * `consensus_review@1`: one tool-less, provider-neutral, ANONYMOUS pass over every eligible
 * immutable artifact that reports what the fleet agreed on and what it did not - and recommends
 * nothing at all.
 *
 * Its authority is smaller than the comparative reviewer's, because its output authorises nothing:
 * the questions it produces are put to a person, and the run terminates `retained` whatever they
 * answer. What it must still get exactly right is honesty about the evidence. Every rule in
 * `validateConsensus` refuses rather than repairs, for the same reason the comparative validator's
 * do - a question set is shown to an operator as *what the fleet found*, and a quietly repaired
 * one is a question the fleet never actually raised.
 *
 * Question and option ids are assigned HERE, server-side, after validation. The model never sees
 * them and never supplies them, so the operator's recorded answer names an id no candidate's diff
 * could have influenced.
 */

/**
 * Semantic validation, then the label -> artifact mapping.
 *
 * The rules, and the failure each one rules out:
 *
 *  - **nothing reported at all** - an evaluator that returned neither an agreement nor a
 *    divergence has said nothing about the evidence, which is a failed attempt to retry rather
 *    than a finding that "they were all the same";
 *  - **an unknown submission label** - the reply is not about this packet;
 *  - **one submission in two options of the same question** - a member holds one position per
 *    question, so this is an evaluator that has stopped reporting and started theorizing;
 *  - **a submission that appears in no option anywhere** (when there ARE divergences) - the
 *    checkable trace that every artifact was actually read. A pass with no divergences at all is
 *    exempt because full agreement covers every subject by definition, which is why the exemption
 *    is written out rather than left to the reader.
 */
export function validateConsensus(
  result: ConsensusResult,
  labelToArtifact: Map<string, string>,
  subjectArtifactIds: string[],
  evidenceTruncated: boolean,
): { ok: true; findings: ConsensusFindings } | { ok: false; reason: string } {
  if (result.agreements.length === 0 && result.divergences.length === 0) {
    return {
      ok: false,
      reason: "the pass reported neither an agreement nor a divergence, so it found nothing to report",
    };
  }

  const covered = new Set<string>();
  const divergences: ConsensusDivergence[] = [];
  for (const [questionIndex, divergence] of result.divergences.entries()) {
    const seenHere = new Set<string>();
    const options = [];
    for (const [optionIndex, option] of divergence.options.entries()) {
      const artifactIds: string[] = [];
      for (const label of option.submissions) {
        const artifactId = labelToArtifact.get(label);
        if (artifactId === undefined) {
          return { ok: false, reason: `unknown submission label ${JSON.stringify(label)}` };
        }
        if (seenHere.has(label)) {
          return {
            ok: false,
            reason: `${label} holds two positions on ${JSON.stringify(divergence.question)}`,
          };
        }
        seenHere.add(label);
        covered.add(label);
        artifactIds.push(artifactId);
      }
      options.push({
        id: divergenceOptionId(questionIndex, optionIndex),
        label: option.label,
        rationale: option.rationale,
        artifactIds,
      });
    }
    divergences.push({
      id: divergenceQuestionId(questionIndex),
      question: divergence.question,
      options,
    });
  }

  if (divergences.length > 0) {
    const missing = [...labelToArtifact.keys()].filter((label) => !covered.has(label));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${missing.join(", ")} appears in no option, so ${missing.length === 1 ? "that submission was" : "those submissions were"} not accounted for`,
      };
    }
  }

  return {
    ok: true,
    findings: {
      version: CONSENSUS_FINDINGS_VERSION,
      agreements: result.agreements,
      divergences,
      subjectArtifactIds,
      evidenceTruncated,
    },
  };
}

function resultLabel(input: {
  result: EnsemblePayloadEnvelope;
  subjectArtifactIds: string[];
}): string | null {
  const findings = parseConsensusFindings(input.result.body);
  if (!findings) return null;
  const agreements = `${findings.agreements.length} agreement${findings.agreements.length === 1 ? "" : "s"}`;
  const questions =
    findings.divergences.length === 0
      ? "no open questions"
      : `${findings.divergences.length} open question${findings.divergences.length === 1 ? "" : "s"}`;
  return `${agreements}, ${questions}`;
}

function validate(
  reply: ConsensusResult,
  packet: EvidencePacket,
): { ok: true; result: EnsembleJson; resultLabel: string } | { ok: false; reason: string } {
  const validated = validateConsensus(
    reply,
    packet.labelToArtifact,
    packet.subjectArtifactIds,
    packet.evidenceTruncated,
  );
  if (!validated.ok) return validated;
  const result = validated.findings as unknown as EnsembleJson;
  return {
    ok: true,
    result,
    resultLabel:
      resultLabel({
        result: { payloadVersion: 1, body: result },
        subjectArtifactIds: packet.subjectArtifactIds,
      }) ?? "reported agreements and divergences",
  };
}

async function run(context: ReviewDriverContext): Promise<ReviewOutcome> {
  return runEvidenceReview(context, {
    label: "The consensus pass",
    builtinRubric: {
      id: CONSENSUS_BUILTIN_RUBRIC,
      text: CONSENSUS_BUILTIN_RUBRIC_TEXT,
      label: "the built-in guidance",
    },
    buildPrompt: ({ guidance, intent, baseSha, subjects }) =>
      buildConsensusPrompt({
        guidanceLabel: guidance.label,
        guidanceText: guidance.text,
        guidanceFenced: guidance.fenced,
        intent,
        baseSha,
        subjects,
      }),
    replySchema: ConsensusResultSchema,
    validate,
  });
}

export const consensusReviewDriver: ReviewDriver = {
  driverKey: "consensus_review@1",
  llmPurpose: "consensus_review",
  resultLabel,
  run,
};
