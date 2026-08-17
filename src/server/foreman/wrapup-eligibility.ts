import type { TaskKind } from "@shared/types.ts";

/**
 * Why Foreman must retire a completion without handing it to a review Workflow or PR prompt.
 *
 * These are policy reasons, not persisted ids. They stay structured so callers can log the
 * stable explanation while tests assert the decision without depending on prose.
 */
type AutomaticChatWrapupBlock = { kind: "chat"; reason: string };

type AutomaticScoutWrapupBlock = { kind: "scout"; reason: string };

export type AutomaticWrapupBlock =
  | AutomaticChatWrapupBlock
  | AutomaticScoutWrapupBlock
  | { kind: "review_artifact"; reason: string };

export interface AutomaticWrapupInput {
  /** The durable task kind when this session belongs to a Mission Control task. */
  taskKind: TaskKind | null;
  /** The task's resolved Workflow selection, or null when completion belongs to the human. */
  workflowId: string | null;
  /** The resolved completion contract Foreman is about to claim. */
  objective: string | null;
  /** Repo-relative paths from the completed diff, when that evidence is available. */
  changedPaths?: readonly string[] | null;
  /** Whether the operator wants scout completions retired before automatic wrap-up. */
  skipScoutWrapup: boolean;
  /** Whether the operator wants review-only artifacts retired before automatic wrap-up. */
  skipReviewArtifactWrapup: boolean;
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
  /^\s*(?:(?:an?|the)\s+)?(?:(?:new|updated|working|production[- ]ready)\s+)*(?:implementation\b(?!\s+(?:plans?|notes?|details?|guides?|reports?|analys(?:is|es)|recommendations?))|code\s+changes?\b|pull\s+request\b|shippable\s+change\b|(?:source\s+)?code\b|(?:[a-z0-9.+#_-]+\s+){0,3}(?:test\s+suites?|tests?|components?|features?|applications?|apps?|modules?|endpoints?|services?)\b)/i;

/** A natural-language action whose object is a shippable change, not just discussion of one. */
const SHIPPABLE_ACTION =
  /\bimplement(?:ed|ing)?\b|\b(?:build|create|develop|ship|fix|refactor|update|deliver)\b[^.?!\n]{0,80}\b(?:implementation|source\s+code|code\s+changes?|working\s+(?:feature|application|app)|test\s+suites?|tests?|features?|applications?|apps?|components?|services?|endpoints?|modules?|codebase|bugs?|issues?)\b/i;

/** An implementation verb is sufficient when its own clause names no review artifact. */
const GENERIC_IMPLEMENTATION_ACTION =
  /\b(?:build|create|develop|ship|fix|refactor|update|deliver)\b/i;

/** An explicit publishing imperative, recognized only when it leads its own clause. */
const SHIPPING_DIRECTIVE =
  /^\s*(?:(?:please|next|then)\s*,?\s+)?(?:(?:open|raise|submit|publish|merge)\b[^.?!\n]{0,60}\b(?:pull\s+request|pr)\b|(?:commit|push)\b[^.?!\n]{0,60}\b(?:changes?|commits?|branch)\b)/i;

/** `a plan for code changes` names a topic, not a second implementation deliverable. */
const REVIEW_ARTIFACT_TOPIC =
  /\b(?:mock[- ]?ups?|wireframes?|prototypes?|storyboards?|design\s+(?:concepts?|explorations?|options?)|plans?|reports?|analys(?:is|es)|research|audit\s+findings?|recommendations?)\b[^.?!\n]{0,30}\b(?:for|on|about|of|to|that|which|explaining|describing|detailing|outlining|covering|discussing)\b/i;

/** An explicit task-contract field such as `Output: mockups`. */
const OUTPUT_FIELD =
  /^\s*(?:(?:expected|required)\s+)?(?:output|deliverables?|artifacts?)\s*:\s*(.+)$/gim;

/** A direct request to create a review artifact, even when it is not written as a field. */
const REVIEW_ARTIFACT_REQUEST =
  /\b(?:create|produce|prepare|present|draft|generate|write|deliver|compare|explore)\b[^.?!\n]{0,100}\b(?:mock[- ]?ups?|wireframes?|prototypes?|storyboards?|design\s+(?:concepts?|explorations?|options?)|plans?|reports?|analys(?:is|es)|research|audit\s+findings?|recommendations?)\b/i;

/** A review-only investigation stated directly as an imperative, without an output noun. */
const DIRECT_REVIEW_REQUEST =
  /(?:^|[.!?;:\n]\s*)(?:[-*]\s+)?(?:(?:please|first|next|then)\s*,?\s+)?(?:research|investigate|analy[sz]e|audit|assess|evaluate|review|study|survey|compare|explore|recommend)\b/im;

/** Conventional homes for review-only artifacts. Mixed code plus artifacts remains eligible. */
const REVIEW_ARTIFACT_PATH =
  /(?:^|\/)(?:(?:docs\/)?(?:mockups?|wireframes?|prototypes?|plans?|research|design[-_ ]explorations?)(?:\/|$)|[^/]*(?:mock[-_ ]?up|wireframe|prototype)[^/]*\.(?:html?|md|png|jpe?g|gif|svg|webp)$)/i;

function outputValuesRequestShipping(values: readonly string[]): boolean {
  // Treat coordinated fields as a list of deliverables. A shipping phrase only counts when
  // its own list member is not itself a plan, report, mockup, or other review artifact. Thus
  // `mockups and source code` ships, while `a plan for code changes` remains review-only.
  return values
    .flatMap((value) => value.split(/\s*(?:[,;/]|\band\b|\bplus\b)\s*/i))
    .some((part) => SHIPPABLE_OUTPUT.test(part) && !REVIEW_ARTIFACT.test(part));
}

function naturalLanguageRequestsShipping(objective: string): boolean {
  // Sentence and coordination boundaries separate "make the artifact" from a genuine follow-up
  // implementation action. Inside one clause, a review artifact followed by `for`, `on`, etc.
  // makes the code phrase its topic: "write a report on code changes" is not a request to code.
  return objective
    .split(/(?:[.!?;\n]|\bthen\b|\band\b)/i)
    .some((clause) => {
      if (REVIEW_ARTIFACT_TOPIC.test(clause)) return false;
      return SHIPPING_DIRECTIVE.test(clause) || SHIPPABLE_ACTION.test(clause) || (
        GENERIC_IMPLEMENTATION_ACTION.test(clause) && !REVIEW_ARTIFACT.test(clause)
      );
    });
}

function objectiveRequestsReviewArtifacts(objective: string): boolean {
  // A combined contract such as "Output: implementation and mockups" is shippable. Check the
  // value rather than the whole objective so an implementation task may still cite a mockup in
  // its context without changing its completion kind.
  OUTPUT_FIELD.lastIndex = 0;
  const outputValues = [...objective.matchAll(OUTPUT_FIELD)].map((match) => match[1] ?? "");
  if (outputValuesRequestShipping(outputValues)) return false;
  if (outputValues.some((value) => REVIEW_ARTIFACT.test(value))) {
    // An Output field is one part of the completion contract, not necessarily the whole of
    // it. `Implement the viewer. Output: mockups` still requests a shippable implementation;
    // the mockups only name the accompanying review deliverable.
    return !naturalLanguageRequestsShipping(objective);
  }

  // Natural-language fallback for prompts like "Present at least three HTML mockups". A prompt
  // that also explicitly asks for implementation remains eligible, which keeps "mock up, then
  // implement" from being mistaken for an artifact-only task.
  return (
    REVIEW_ARTIFACT_REQUEST.test(objective) || DIRECT_REVIEW_REQUEST.test(objective)
  ) && !naturalLanguageRequestsShipping(objective);
}

function diffContainsOnlyReviewArtifacts(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => REVIEW_ARTIFACT_PATH.test(path));
}

/**
 * Whether the review-artifact classifier is asked about a task of this kind at all.
 *
 * A statement about the KIND, read once and applied to both halves of the classifier, rather
 * than a negation dropped into two conditions - because it is one claim, and a claim split
 * across two `&&`s is one somebody later fixes in half.
 *
 * `plan` is the exemption, and it is a requirement of this kind rather than a consequence of
 * it. The classifier would catch a plan task twice over: its objective says "write a plan",
 * which is the vocabulary `REVIEW_ARTIFACT_REQUEST` matches, and its diff lands entirely under
 * `docs/plans/**`, which is every path matching `REVIEW_ARTIFACT_PATH`. Both halves have to be
 * exempted or the approved "offer ordinary wrap-up" decision is not delivered.
 *
 * The reason a plan is not a review artifact in the sense this setting means: a mockup is
 * produced FOR a review and then discarded, and shipping it would put a throwaway on the
 * default branch. A plan is a durable document whose landing on the default branch is the
 * thing that releases the phase tasks depending on it - `phased-plan` schedules tasks carrying
 * paths rather than content, and an unmerged plan leaves every one of those paths dead. So the
 * plan kind wants exactly what a ship task gets, and the exemption is keyed on the kind so
 * that a SHIP task producing only mockups - or only plans - is judged exactly as before.
 *
 * `scout` still takes the classifier. Its own branch above is separately switchable, and an
 * operator who turns that one off has not asked for a scout's mockup-only diff to start
 * shipping itself.
 *
 * `Record<TaskKind, …>` for `TASK_KIND_INFO`'s reason: a new kind does not compile until it
 * has answered this, which is the one question about a new kind that is easiest to forget and
 * whose wrong answer is invisible until a completion is silently retired.
 */
const KIND_TAKES_REVIEW_ARTIFACT_CLASSIFIER: Record<TaskKind, boolean> = {
  ship: true,
  scout: true,
  plan: false,
  pipeline: false,
  chat: true,
};

/** Kinds whose ordinary completion stays with the human unless a Workflow was selected. */
const KIND_REQUIRES_EXPLICIT_WORKFLOW: Record<TaskKind, boolean> = {
  ship: false,
  scout: false,
  plan: false,
  pipeline: false,
  chat: true,
};

/** A session with no linked task has no kind to exempt it, so it is classified as before. */
function classifiesAsReviewArtifact(kind: TaskKind | null): boolean {
  return kind === null || KIND_TAKES_REVIEW_ARTIFACT_CLASSIFIER[kind];
}

/**
 * The one automatic-shipping eligibility boundary shared by both Foreman completion triggers.
 *
 * A block means neither an existing Foreman-complete binding nor the built-in No-Mistakes
 * fallback may be submitted, and the direct Straight-to-PR instruction may not be typed. Manual
 * operator actions stay outside this predicate.
 */
export function automaticWrapupBlock(input: AutomaticWrapupInput): AutomaticWrapupBlock | null {
  if (
    input.taskKind !== null &&
    KIND_REQUIRES_EXPLICIT_WORKFLOW[input.taskKind] &&
    input.workflowId === null
  ) {
    return { kind: "chat", reason: "the linked chat task has no explicit Workflow" };
  }

  if (input.skipScoutWrapup && input.taskKind === "scout") {
    return { kind: "scout", reason: "the linked task kind is scout" };
  }

  // Read once and applied to both halves below: the classifier either speaks about this task
  // or it does not, and the two halves must not be able to answer that differently.
  const classified =
    input.skipReviewArtifactWrapup && classifiesAsReviewArtifact(input.taskKind);

  if (classified && input.objective && objectiveRequestsReviewArtifacts(input.objective)) {
    return {
      kind: "review_artifact",
      reason: "the requested output is a review artifact rather than a shippable change",
    };
  }

  if (classified && input.changedPaths && diffContainsOnlyReviewArtifacts(input.changedPaths)) {
    return {
      kind: "review_artifact",
      reason: "the completed diff contains only review artifacts",
    };
  }

  return null;
}
