import {
  REVIEW_LIMITS,
  REVIEW_TRUNCATION_MARKER,
  untrustedFence,
} from "@shared/review.ts";

// The composition half of the shared review framing. `@shared/review.ts` holds what the
// wording IS; this holds how a prompt assembles it, because assembly is server-side only.
//
// Every helper here is pure and reviewer-agnostic. A reviewer's own question, its evidence
// selection and its output schema stay in the subsystem that owns them.

/**
 * Bound one prompt section and say so in the text.
 *
 * The marker is not decoration: a silently clipped diff reads to a model as a complete diff,
 * and a verdict drawn from one is indistinguishable from a verdict drawn from the whole.
 */
export function boundedSection(value: string, max: number = REVIEW_LIMITS.section): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n${REVIEW_TRUNCATION_MARKER}`;
}

/** The same bound over a JSON rendering, so structured evidence truncates visibly too. */
export function boundedJsonSection(value: unknown, max: number = REVIEW_LIMITS.section): string {
  return boundedSection(JSON.stringify(value, null, 2), max);
}

/**
 * One fenced, explicitly untrusted evidence block.
 *
 * `name` is the caller's label for the evidence; the `-untrusted` suffix is added here so
 * no caller can accidentally emit an unmarked fence.
 */
export function untrustedBlock(
  name: string,
  body: string,
  max: number = REVIEW_LIMITS.section,
): string[] {
  return ["```" + untrustedFence(name), boundedSection(body, max), "```"];
}

/** The same block over a JSON value. */
export function untrustedJsonBlock(
  name: string,
  value: unknown,
  max: number = REVIEW_LIMITS.section,
): string[] {
  return ["```" + untrustedFence(name), boundedJsonSection(value, max), "```"];
}
