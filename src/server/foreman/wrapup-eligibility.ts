import type { TaskKind } from "@shared/types.ts";

/**
 * Why Foreman must retire a completion without handing it to a review Workflow or PR prompt.
 *
 * These are policy reasons, not persisted ids. They stay structured so callers can log the
 * stable explanation while tests assert the decision without depending on prose.
 */
export type AutomaticWrapupBlock =
  | { kind: "scout"; reason: string }
  | { kind: "review_artifact"; reason: string };

export interface AutomaticWrapupInput {
  /** The durable task kind when this session belongs to a Mission Control task. */
  taskKind: TaskKind | null;
  /** The resolved completion contract Foreman is about to claim. */
  objective: string | null;
  /** Repo-relative paths from the completed diff, when that evidence is available. */
  changedPaths?: readonly string[] | null;
}

/**
 * Outputs that are meant for human review rather than automatic shipping.
 *
 * Kept deliberately narrower than every noun a scout might produce. Task kind is the durable
 * answer for investigations, audits and reports. Text classification exists for the common
 * failure mode behind this guard: a task left on the default `ship` kind even though its
 * requested output is explicitly a set of mockups or a closely related design artifact.
 */
const REVIEW_ARTIFACT =
  /\b(?:mock[- ]?ups?|wireframes?|prototypes?|storyboards?|design\s+(?:concepts?|explorations?|options?)|plans?|reports?|analys(?:is|es)|research|audit\s+findings?|recommendations?)\b/i;

/** Positive evidence that the same output also asks for a shippable implementation. */
const SHIPPABLE_OUTPUT =
  /\b(?:implement(?:ation|ed|ing)?|production[- ]ready|code\s+changes?|working\s+(?:feature|application|app)|pull\s+request|shippable\s+change)\b|(?:^|\band\b|\bplus\b|[,;/])\s*(?:source\s+)?code\b/i;

/** A natural-language request to ship, rather than a contextual mention of existing code. */
const SHIPPABLE_REQUEST =
  /\b(?:implement(?:ation|ed|ing)?|production[- ]ready|code\s+changes?|working\s+(?:feature|application|app)|pull\s+request|shippable\s+change)\b|\b(?:build|create|develop|ship|fix|refactor|update|deliver)\b[^.?!\n]{0,80}\b(?:source\s+code|code\s+changes?|feature|application|app|component|service|endpoint|module)\b/i;

/** An explicit task-contract field such as `Output: mockups`. */
const OUTPUT_FIELD =
  /^\s*(?:(?:expected|required)\s+)?(?:output|deliverables?|artifacts?)\s*:\s*(.+)$/gim;

/** A direct request to create a review artifact, even when it is not written as a field. */
const REVIEW_ARTIFACT_REQUEST =
  /\b(?:create|produce|prepare|present|draft|generate|write|deliver|compare|explore)\b[^.?!\n]{0,100}\b(?:mock[- ]?ups?|wireframes?|prototypes?|storyboards?|design\s+(?:concepts?|explorations?|options?)|plans?|reports?|analys(?:is|es)|research|audit\s+findings?|recommendations?)\b/i;

/** Conventional homes for review-only artifacts. Mixed code plus artifacts remains eligible. */
const REVIEW_ARTIFACT_PATH =
  /(?:^|\/)(?:(?:docs\/)?(?:mockups?|wireframes?|prototypes?|plans?|research|design[-_ ]explorations?)(?:\/|$)|[^/]*(?:mock[-_ ]?up|wireframe|prototype)[^/]*\.(?:html?|md|png|jpe?g|gif|svg|webp)$)/i;

function objectiveRequestsReviewArtifacts(objective: string): boolean {
  // A combined contract such as "Output: implementation and mockups" is shippable. Check the
  // value rather than the whole objective so an implementation task may still cite a mockup in
  // its context without changing its completion kind.
  OUTPUT_FIELD.lastIndex = 0;
  const outputValues = [...objective.matchAll(OUTPUT_FIELD)].map((match) => match[1] ?? "");
  if (outputValues.some((value) => SHIPPABLE_OUTPUT.test(value))) return false;
  if (outputValues.some((value) => REVIEW_ARTIFACT.test(value))) return true;

  // Natural-language fallback for prompts like "Present at least three HTML mockups". A prompt
  // that also explicitly asks for implementation remains eligible, which keeps "mock up, then
  // implement" from being mistaken for an artifact-only task.
  return REVIEW_ARTIFACT_REQUEST.test(objective) && !SHIPPABLE_REQUEST.test(objective);
}

function diffContainsOnlyReviewArtifacts(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => REVIEW_ARTIFACT_PATH.test(path));
}

/**
 * The one automatic-shipping eligibility boundary shared by both Foreman completion triggers.
 *
 * A block means neither an existing Foreman-complete binding nor the built-in No-Mistakes
 * fallback may be submitted, and the direct Straight-to-PR instruction may not be typed. Manual
 * operator actions stay outside this predicate.
 */
export function automaticWrapupBlock(input: AutomaticWrapupInput): AutomaticWrapupBlock | null {
  if (input.taskKind === "scout") {
    return { kind: "scout", reason: "the linked task kind is scout" };
  }

  if (input.objective && objectiveRequestsReviewArtifacts(input.objective)) {
    return {
      kind: "review_artifact",
      reason: "the requested output is a review artifact rather than a shippable change",
    };
  }

  if (input.changedPaths && diffContainsOnlyReviewArtifacts(input.changedPaths)) {
    return {
      kind: "review_artifact",
      reason: "the completed diff contains only review artifacts",
    };
  }

  return null;
}
