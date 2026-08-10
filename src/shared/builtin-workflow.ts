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

/**
 * The workflow and version number inside a built-in version id, or null for any other id.
 *
 * The inverse of `builtinWorkflowVersionId`, and it lives beside it so the two cannot drift.
 * Surfaces that hold only a version id - a binding, a run, a conflict notice - need to SAY
 * which workflow that is, and a built-in's rows exist nowhere to join against. Parsing the id
 * this module already defines is the one honest answer available without a catalog lookup.
 *
 * `lastIndexOf` rather than a split: the slug is append-only but not guaranteed `@`-free, and
 * the version is always the final segment. An operator workflow's id is a UUID with no
 * prefix, so it returns null and callers fall back to naming it from the catalog.
 */
export function parseBuiltinWorkflowVersionId(
  versionId: string,
): { workflowId: string; version: number } | null {
  if (!versionId.startsWith(BUILTIN_WORKFLOW_ID_PREFIX)) return null;
  const at = versionId.lastIndexOf("@");
  if (at <= BUILTIN_WORKFLOW_ID_PREFIX.length) return null;
  const version = Number(versionId.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return null;
  return { workflowId: versionId.slice(0, at), version };
}

export const NO_MISTAKES_REVIEW_WORKFLOW_SLUG = "no-mistakes-review";
export const NO_MISTAKES_REVIEW_WORKFLOW_ID =
  builtinWorkflowId(NO_MISTAKES_REVIEW_WORKFLOW_SLUG);
