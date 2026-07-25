import { ENSEMBLE_LIMITS, type EnsembleJson } from "@shared/ensemble.ts";
import { ENSEMBLE_HARD_LIMITS } from "@shared/ensemble.ts";
import { boundedSection } from "../../review/prompt.ts";
import type { PromptSubjectEvidence } from "./prompt.ts";
import type { ReviewDriverContext, ReviewSubject } from "./types.ts";

/**
 * The anonymous evidence packet every review driver judges from, assembled once.
 *
 * Shared by the comparative reviewer and the panel because the two must be judging the SAME
 * evidence in the same order under the same anonymisation - a panel whose judges each saw a
 * slightly different packet would produce a disagreement measure that says nothing about the
 * submissions. It is also the expensive half: materialising N diffs out of the immutable refs is
 * real Git work, and a panel of five judges builds it once, not five times.
 *
 * Nothing here decides anything. It sorts, labels, budgets, materialises and bounds; who is asked,
 * with what guidance, and what is done with the answer belong to the driver.
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
 * carry identity or are simply not comparison evidence, and the ref name in particular embeds
 * the artifact id an anonymous packet exists to hide. Only the statistics that let one diff be
 * compared to another survive.
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

/** Whether a subject has anything a fair comparison could weigh, rather than metadata alone. */
function hasUsableEvidence(
  materialFilesChanged: number,
  observedFilesChanged: number,
  reported: Reported,
): boolean {
  return materialFilesChanged > 0 || observedFilesChanged > 0 || reported.summary.trim() !== "";
}

/** The assembled packet: what to show, what to call each subject, and how to read the answer back. */
export interface EvidencePacket {
  /** The bounded task intent, capped once for every prompt built from this packet. */
  intent: string;
  /** Anonymous subject sections, in the deterministic order the labels were assigned. */
  subjects: PromptSubjectEvidence[];
  /** The de-anonymisation map, applied only after a reply has passed validation. */
  labelToArtifact: Map<string, string>;
  /** The artifact ids in presentation order - what an evaluation row records as its subjects. */
  subjectArtifactIds: string[];
  /** True when any subject's diff was cut for length - a reason to trust the judgement less. */
  evidenceTruncated: boolean;
}

export type EvidenceFailure =
  | { kind: "infrastructure"; detail: string }
  | { kind: "empty_evidence"; detail: string };

/**
 * Assemble the packet, or say why this run has nothing a fair judgement could be made from.
 *
 * The subject order is a sort on the artifact id - a UUID, so it carries no member ordinal - and
 * the labels follow it. Deterministic because a retry must rebuild the exact same packet, and
 * therefore the same input fingerprint, from the same immutable set.
 */
export async function assembleEvidence(
  context: Pick<ReviewDriverContext, "subjects" | "intent" | "repoRoot" | "runtime">,
  budget: { materialBudgetBytes: number; guidanceBytes: number },
): Promise<{ ok: true; packet: EvidencePacket } | { ok: false; failure: EvidenceFailure }> {
  const ordered = [...context.subjects].sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0,
  );
  const labelToArtifact = new Map<string, string>();
  const labelFor = new Map<string, string>();
  ordered.forEach((subject, index) => {
    const label = `Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)}`;
    labelToArtifact.set(label, subject.artifactId);
    labelFor.set(subject.artifactId, label);
  });

  const intent = boundedSection(context.intent, ENSEMBLE_LIMITS.intent);
  const perPatch = perSubjectPatchBytes(
    ordered.length,
    budget.materialBudgetBytes,
    budget.guidanceBytes,
    Buffer.byteLength(intent, "utf8"),
  );

  const subjects: PromptSubjectEvidence[] = [];
  let evidenceTruncated = false;
  for (const subject of ordered) {
    const label = labelFor.get(subject.artifactId)!;
    let material;
    try {
      material = await context.runtime.materialize(subject, context.repoRoot, perPatch);
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: "infrastructure",
          detail: `could not materialize ${label}: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    const reported = readReported(subject.reported);
    const { observed, filesChanged: observedFilesChanged } = observedForPrompt(subject.observed);
    if (!hasUsableEvidence(material.filesChanged, observedFilesChanged, reported)) {
      return {
        ok: false,
        failure: {
          kind: "empty_evidence",
          detail: `${label} produced no comparable evidence - no diff and no reported summary`,
        },
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
      intent,
      subjects,
      labelToArtifact,
      subjectArtifactIds: ordered.map((subject) => subject.artifactId),
      evidenceTruncated,
    },
  };
}

/** One subject's validated score, after structure but before de-anonymisation. */
interface RankedSubject {
  label: string;
  score: number;
  rank: number;
  confidence: number;
}

/**
 * The semantic rules a ranking over anonymous labels has to satisfy, checked once for every driver.
 *
 * Every rule REFUSES rather than repairs: a score of 250, a duplicate rank, a gap in the ranks, or
 * a label the packet never used is a failed attempt, because a ranking that will inform a
 * promotion may not be quietly corrected into a plausible one. Shared between the comparison and
 * every panel ballot so the two cannot end up enforcing different arithmetic on the same numbers.
 */
export function validateRanking(
  subjects: readonly RankedSubject[],
  labelToArtifact: ReadonlyMap<string, string>,
): { ok: true } | { ok: false; reason: string } {
  const n = labelToArtifact.size;
  if (subjects.length !== n) {
    return { ok: false, reason: `expected ${n} subject scorecards, got ${subjects.length}` };
  }
  if (n > ENSEMBLE_HARD_LIMITS.maxMembers) {
    return { ok: false, reason: `a ranking may not cover more than ${ENSEMBLE_HARD_LIMITS.maxMembers} subjects` };
  }
  const seenLabels = new Set<string>();
  const seenRanks = new Set<number>();
  for (const subject of subjects) {
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
  return { ok: true };
}
