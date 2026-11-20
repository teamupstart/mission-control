import { taskDefaultWorkflowId, type KindWorkflowDefaults } from "./task.ts";
import type { TaskKind } from "./types.ts";

/**
 * The after-work rule, written once (headless mode spec 7.5).
 *
 * The dashboard's dispatch form and the daemon's `/dispatch/dispatch-options` both ask this
 * module what a kind runs after its work, so the two cannot disagree. Browser safe: no
 * `node:` imports.
 */

/**
 * The after-work Workflow a task of this kind arms when nobody chose one: the operator's
 * Settings row if there is one, else the built-in answer, with a locally stored plan taking
 * Local Plan Validation. `null` is None.
 *
 * The rule the dispatch form applied inline (`taskDefaultWorkflowId`) with its arguments
 * spelled out, so a surface that is not the form reaches it by this name. `test/` fails when
 * the form's answer and this one differ for any kind.
 */
export function kindAfterWork(
  kind: TaskKind,
  configured: KindWorkflowDefaults,
  storage: "repository" | "local" = "repository",
): string | null {
  return taskDefaultWorkflowId(kind, configured, storage);
}

/** What a surface needs to name one after-work Workflow. */
export interface AfterWorkChoice {
  id: string;
  label: string;
}

/** The facts of a Workflow summary `afterWorkFor` reads. A `WorkflowSummary` satisfies it. */
export interface AfterWorkSource {
  id: string;
  name: string;
}

/** `{ id, label }` for one Workflow, the label being its name. */
export function afterWorkFor(workflow: AfterWorkSource): AfterWorkChoice {
  return { id: workflow.id, label: workflow.name };
}
