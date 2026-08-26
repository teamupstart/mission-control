import type { Task, TaskKind } from "@shared/types.ts";
import {
  deferredImperativeList,
  taskCompletionContract,
  type TaskCompletionContract,
} from "@shared/task-completion.ts";
import { planContractAppendix, type PlanSkillInvocations } from "./plans/prompt.ts";
import { scoutReportAppendix } from "./scouts/prompt.ts";
import { scoutRepoSlots } from "./scouts/repos.ts";
import { executionAuthorizationContract } from "./execution-authorization.ts";
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
 * does not compile. `ship` owns the completion handoff that keeps pull-request work behind
 * Foreman or the selected workflow. Every task still receives the shared execution
 * authorization below.
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
 * `Record<TaskKind, …>` is the enforcement, matching `TASK_KIND_INFO`: a new kind does not
 * compile until it has said what its delivery contract is, including saying it is nothing.
 */
/**
 * The ship task's delivered completion handoff, rendered from the SHARED contract.
 *
 * The deferral sentence lists `TaskCompletionContract.deferred` rather than restating it,
 * because this appendix and Foreman's verify prompt have to draw the same line: the
 * verifier judges the durable objective, which routinely still asks for a pull request
 * that this very paragraph forbade, and a second hand-maintained list of deferred actions
 * is exactly how the two surfaces would drift apart. The surrounding prose stays
 * hand-written - this is the text an agent reads on its first turn, and a mechanically
 * assembled paragraph would read worse for no gain - so `test/task-completion.test.ts`
 * pins that both renderings name the same actions.
 */
const SHIP_COMPLETION_CONTRACT = requireCompletionContract("ship");

const SHIP_COMPLETION_HANDOFF = [
  "## Ship task completion handoff",
  "Implement and verify the requested change, then report that the work is complete and end this turn.",
  `During this initial task turn, do not ${deferredImperativeList(SHIP_COMPLETION_CONTRACT)}, even if the task request or repository instructions normally include those steps.`,
  "Mission Control owns what happens after this completion. Foreman will either start the task's selected workflow or send a later instruction for the direct pull-request path. Only an instruction delivered after this handoff, from Foreman or the workflow, starts commit, push, pull-request, and CI follow-through.",
].join("\n");

/** The kind's contract, or a loud failure - `ship` has one and this file depends on it. */
function requireCompletionContract(kind: TaskKind): TaskCompletionContract {
  const contract = taskCompletionContract(kind);
  if (!contract) throw new Error(`task kind ${kind} has no completion contract to deliver`);
  return contract;
}

const KIND_CONTRACT: Record<TaskKind, (task: Task, inputs: TaskContractInputs) => string | null> = {
  ship: () => SHIP_COMPLETION_HANDOFF,
  scout: (task, inputs) => scoutReportAppendix(scoutRepoSlots(task, inputs.fallbackRoot ?? null)),
  plan: (task, inputs) => planContractAppendix(requirePlanSkills(task, inputs)),
  pipeline: () => null,
  chat: () => null,
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
 * The intent a task is actually delivered: the composed intent, shared authorization, then
 * its kind's contract and eligible evidence instructions.
 *
 * `composedIntent` is whatever the caller has already built - the repo manifest prefix on a
 * multi-repo dispatch, the repository-memory pointer on Pi, the raw intent on an assignment.
 * Composing here rather than in each caller is what makes the ordering deterministic. Broad
 * authorization comes before narrower kind instructions, so the scout's no-PR rule and the
 * ship task's completion handoff remain authoritative for their initial turns.
 */
export function withTaskKindContract(
  task: Task,
  composedIntent: string,
  inputs: TaskContractInputs = {},
): string {
  const appendices = [
    executionAuthorizationContract({
      workflowEvidence: false,
      workflowContinuation: false,
    }),
    KIND_CONTRACT[task.kind](task, inputs),
    // Whether a Persona will read evidence is the workflow's property, resolved once by the
    // eligibility reader this flag arrives from - so it is not re-decided per kind here. A
    // scout dispatched with a Persona workflow gets its report contract AND this one, in that
    // order: handing over the report is what its kind means, and registering proof is what
    // the workflow waiting behind it needs.
    inputs.workflowEvidence ? workflowEvidenceContractAppendix() : null,
  ].filter((value): value is string => value !== null);
  return `${composedIntent}\n\n${appendices.join("\n\n")}`;
}
