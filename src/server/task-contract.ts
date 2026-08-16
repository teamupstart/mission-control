import type { Task, TaskKind } from "@shared/types.ts";
import { planContractAppendix, type PlanSkillInvocations } from "./plans/prompt.ts";
import { scoutReportAppendix } from "./scouts/prompt.ts";
import { scoutRepoSlots } from "./scouts/repos.ts";
import {
  workflowEvidenceContractAppendix,
} from "./workflows/agent-contract.ts";

/**
 * What a task's KIND adds to the intent it is delivered, composed at the delivery boundary.
 *
 * One function, called at both seams - a fresh dispatch (`dispatcher.ts`) and a backlog task
 * assigned to a live session (`tasks.ts`) - because those are the only two ways an intent
 * reaches an agent and a helper that reached one of them would leave every task taking the
 * other door with no idea what it owed. `test/scout-prompt.test.ts` and
 * `test/plan-prompt.test.ts` both pin the pair of call sites for that reason.
 *
 * A REGISTRY over the kinds rather than a chain of `if`s, so that adding a kind's contract
 * means adding one entry here and nowhere else, and so that a kind added without a contract
 * does not compile. `ship` returns null and is not a placeholder for future work: a ship task
 * is delivered exactly what the operator wrote, and returning the composed intent untouched -
 * the same string, not a copy of it - is what keeps every existing dispatch byte-identical.
 *
 * The appendix is a SUFFIX, always. Whatever the caller already composed - the repo manifest
 * on a multi-repo dispatch, Pi's repository-memory pointer - is context the agent needs BEFORE
 * the request, and this is what "delivered" means once it has read it. Nothing here clamps or
 * rewrites the intent; a task that could not read its own request intact would be failing at
 * something more important than its file layout.
 */

/**
 * Everything a kind's contract might need that the Task itself cannot supply.
 *
 * Both fields are optional and both are ignored by the kinds that do not read them, which is
 * what lets one call site serve every kind. They are supplied by the CALLER rather than
 * resolved here on purpose - see `plans/prompt.ts` for why the plan invocations in particular
 * must not be resolved inside the composer.
 */
export interface TaskContractInputs {
  /**
   * The checkout to resolve repository slots against when the task has no worktree of its own.
   *
   * The assignment seam's case: a backlog task handed to a live agent is standing in that
   * agent's checkout, and `assign` refuses a multi-repo task, so there is exactly one slot.
   */
  fallbackRoot?: string | null;
  /**
   * The resolved per-harness invocations for a plan task's two skills.
   *
   * Non-null on every plan delivery, because both seams refuse the delivery before reaching
   * here when they cannot be resolved (`plans/skills.ts`).
   */
  planSkills?: PlanSkillInvocations | null;
  /** The server resolved a Persona node in the selected immutable workflow graph. */
  workflowEvidence?: boolean;
}

/**
 * The appendix each kind contributes, or null when it contributes none.
 *
 * `Record<TaskKind, …>` is the enforcement, matching `TASK_KIND_INFO`: a fourth kind does not
 * compile until it has said what its delivery contract is, including saying it is nothing.
 */
const KIND_CONTRACT: Record<TaskKind, (task: Task, inputs: TaskContractInputs) => string | null> = {
  ship: () => null,
  scout: (task, inputs) => scoutReportAppendix(scoutRepoSlots(task, inputs.fallbackRoot ?? null)),
  plan: (task, inputs) => planContractAppendix(requirePlanSkills(task, inputs)),
};

/**
 * A plan's invocations, or a loud failure.
 *
 * Unreachable through either shipped seam, and deliberately not made harmless. Both refuse a
 * plan delivery they cannot resolve the skills for, and they do it before anything is
 * provisioned and before a live agent's checkout is reset - so arriving here means a third
 * seam was added without that refusal. Delivering a contract with a hole in it instead would
 * hand an agent a sentence that points at nothing, which is the one outcome this kind's
 * approved "point at the skills" decision cannot survive.
 */
function requirePlanSkills(task: Task, inputs: TaskContractInputs): PlanSkillInvocations {
  if (inputs.planSkills) return inputs.planSkills;
  throw new Error(
    `plan task ${task.id} reached delivery without resolved planning-skill invocations`,
  );
}

/**
 * The intent a task is actually delivered: the composed intent, then its kind's contract.
 *
 * `composedIntent` is whatever the caller has already built - the repo manifest prefix on a
 * multi-repo dispatch, the repository-memory pointer on Pi, the raw intent on an assignment.
 * Composing here rather than in each caller is what makes the ordering deterministic.
 */
export function withTaskKindContract(
  task: Task,
  composedIntent: string,
  inputs: TaskContractInputs = {},
): string {
  const appendices = [
    KIND_CONTRACT[task.kind](task, inputs),
    task.kind === "ship" && inputs.workflowEvidence ? workflowEvidenceContractAppendix() : null,
  ].filter((value): value is string => value !== null);
  return appendices.length === 0 ? composedIntent : `${composedIntent}\n\n${appendices.join("\n\n")}`;
}
