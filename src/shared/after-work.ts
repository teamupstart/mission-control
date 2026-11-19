/**
 * The after-work (workflow) identity every headless-mode surface shares (spec 7.5).
 * Browser-safe: no `node:` imports.
 */
import { BUILTIN_WORKFLOW_ID_PREFIX } from "./builtin-workflow.ts";

/** The value Form 2 and `AskUserQuestion` use for "no after-work workflow". */
export const AFTER_WORK_NONE = "none" as const;

/** The label an after-work default gets when its workflow is archived, unpublished or gone. */
export const UNAVAILABLE_WORKFLOW_LABEL = "Unavailable workflow" as const;

export interface AfterWork {
  id: string;
  slug: string;
  label: string;
}

function kebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `{ id, slug, label }` for one workflow. A built-in keeps its own slug (the part of its id
 * after the prefix), any other workflow gets its kebab-cased name, and an empty result falls
 * back to the id.
 */
export function afterWorkFor(workflow: { id: string; name: string }): AfterWork {
  const slug = workflow.id.startsWith(BUILTIN_WORKFLOW_ID_PREFIX)
    ? workflow.id.slice(BUILTIN_WORKFLOW_ID_PREFIX.length)
    : kebab(workflow.name);
  return { id: workflow.id, slug: slug === "" ? workflow.id : slug, label: workflow.name };
}
