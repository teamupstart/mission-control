/**
 * Durable identities for Workflows that ship with Mission Control.
 *
 * This module is browser-safe because the default dispatch config is shared by the daemon
 * and dashboard. Slugs and the ids derived from them are append-only: workflow version ids
 * are persisted by bindings and runs.
 */
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin-workflow:";

export function builtinWorkflowId(slug: string): string {
  return `${BUILTIN_WORKFLOW_ID_PREFIX}${slug}`;
}

/** The synthetic version id a binding or run stores. Append-only, per version. */
export function builtinWorkflowVersionId(slug: string, version: number): string {
  return `${builtinWorkflowId(slug)}@${version}`;
}

export const NO_MISTAKES_REVIEW_WORKFLOW_SLUG = "no-mistakes-review";
export const NO_MISTAKES_REVIEW_WORKFLOW_ID =
  builtinWorkflowId(NO_MISTAKES_REVIEW_WORKFLOW_SLUG);
