import { type TaskKind } from "./types.ts";

/**
 * WHAT "COMPLETE" MEANS for the initial delivered turn of a dispatched task, as trusted
 * policy rather than as prose an agent or a verifier has to infer.
 *
 * WHY THIS MODULE EXISTS
 *
 * A dispatched `ship` task is delivered a completion handoff telling it to stop before
 * commit, push, pull request and CI - Mission Control owns those. Its durable objective,
 * written by a human, very often still says "open a reviewable pull request". Prompted
 * completion then asks a tool-less verifier "is the durable objective satisfied?", the
 * verifier reads an objective demanding a PR that nobody opened, answers no, and the
 * completed work-cycle generation is spent on a silent hold. Every later tick skips the
 * generation as already handled, so a finished implementation never reaches the workflow
 * that was bound to review it. That deadlock is what this contract closes.
 *
 * The fix is deliberately NOT "rewrite the objective" and NOT "let the verifier read the
 * handoff out of the transcript". The objective stays exactly what the human asked for,
 * and transcript text is evidence being judged, never policy. Instead the boundary the
 * agent was ACTUALLY given is carried here, structurally, keyed by durable task kind, and
 * handed to the verifier as trusted policy beside the objective.
 *
 * WHY IT IS SHARED AND BROWSER-SAFE
 *
 * Two surfaces have to mean the same thing by construction: the appendix delivered to the
 * agent (`server/task-contract.ts`) and the trusted-policy block in the verify prompt
 * (`server/foreman/queue-prompt.ts`). Two independently maintained wordings of
 * "ship-complete" is precisely how the boundary drifts, so both render from the one record
 * below. No `node:` imports, per `src/shared/` ownership - this is wire-and-policy shape
 * only.
 */

/** One post-completion action the agent must NOT take on its initial delivered turn. */
export interface DeferredCompletionAction {
  /** Stable id, for tests and for future callers that need to name one action. */
  id: string;
  /** Imperative phrasing, for the "do not …" sentence delivered to the agent. */
  imperative: string;
  /** Noun phrasing, for the verifier's trusted-policy list. */
  noun: string;
}

/**
 * The initial completion boundary for one task kind.
 *
 * `complete` and `deferred` are the whole contract: what has to be true for the delivered
 * turn to be finished, and what is explicitly somebody else's job afterwards. Both are
 * rendered, never re-stated, by the two surfaces that consume them.
 */
export interface TaskCompletionContract {
  kind: TaskKind;
  /** Who owns the deferred work once this boundary is crossed. */
  owner: string;
  /** One line naming the boundary, used as the heading of both renderings. */
  boundary: string;
  /** What must be complete for the initial delivered turn to be complete. */
  complete: readonly string[];
  /** Post-completion work explicitly deferred away from this turn. */
  deferred: readonly DeferredCompletionAction[];
}

const SHIP_CONTRACT: TaskCompletionContract = {
  kind: "ship",
  owner: "Mission Control",
  boundary: "the initial implementation handoff of a dispatched ship task",
  complete: [
    "the requested implementation is done",
    "repository documentation the change requires is updated",
    "the focused tests and verification the change requires have been run",
    "workflow evidence registration the task asked for is done when an active Persona workflow accepts it",
  ],
  deferred: [
    { id: "commit", imperative: "commit", noun: "committing the work" },
    { id: "push", imperative: "push", noun: "pushing a branch" },
    {
      id: "pull-request",
      imperative: "create or update a pull request",
      noun: "creating or updating a pull request",
    },
    {
      id: "review",
      imperative: "act on pull-request review feedback",
      noun: "pull-request review follow-through",
    },
    { id: "ci", imperative: "wait for pull-request CI", noun: "waiting for pull-request CI" },
  ],
};

const PLAN_CONTRACT: TaskCompletionContract = {
  kind: "plan",
  owner: "Mission Control",
  boundary: "the planning handoff to the bound workflow",
  complete: [
    "the human has reviewed and approved the plan, and their decisions are incorporated; dismissal is not approval",
    "the plan's Markdown and rendered HTML are complete and consistent",
    "when requested, phase files, the audited dependency graph, and the phase-to-task-id map are complete; declined phasing requires no phase tasks",
    "artifacts referenced by phase tasks are committed and pushed, with exact paths verified before scheduling, and every phase task depends on the planning session",
    "the verification the planning work requires has been run",
    "workflow evidence registration the task asked for is done when an active Persona workflow accepts it, including the current plan text and required cross-file context",
  ],
  // Plans need durable artifacts before scheduling. Commit/push are deliberately retained.
  deferred: [
    ...SHIP_CONTRACT.deferred.filter((action) => !["commit", "push"].includes(action.id)),
    { id: "merge", imperative: "merge the pull request", noun: "merging the pull request" },
  ],
};

/**
 * The contract per kind, or null for a kind that draws no such boundary.
 *
 * `Record<TaskKind, …>` for the same reason `KIND_CONTRACT` in `server/task-contract.ts`
 * uses one: a new task kind does not compile until it has said what its completion
 * boundary is, including saying it has none. Ship and Bugfix defer post-completion work;
 * workflow-bound plans defer publication follow-through. Other kinds and unbound plans
 * are judged against their objective unchanged.
 */
const KIND_COMPLETION_CONTRACT: Record<TaskKind, TaskCompletionContract | null> = {
  ship: SHIP_CONTRACT,
  bugfix: { ...SHIP_CONTRACT, kind: "bugfix", boundary: "the initial implementation handoff of a dispatched bugfix task" },
  scout: null,
  plan: null,
  pipeline: null,
  chat: null,
};

/**
 * The trusted initial completion contract for a durable task kind, or null.
 *
 * Ship/Bugfix keep a kind-only boundary. Plans defer PR work only when a workflow owns it;
 * an unbound phased-plan skill retains its direct publication path. Callers resolve the
 * binding structurally, never from transcript prose or Persona evidence eligibility.
 */
export function taskCompletionContract(
  kind: TaskKind | null | undefined,
  workflowBound = false,
): TaskCompletionContract | null {
  if (kind === "plan" && workflowBound) return PLAN_CONTRACT;
  return kind ? KIND_COMPLETION_CONTRACT[kind] ?? null : null;
}

/** Current daemon authority overrides an evidence demand retained in an older prompt or gap. */
export function workflowEvidenceRequirement(eligible: boolean): string {
  return eligible
    ? "An active Persona workflow accepts evidence. Complete the workflow evidence registration the task requires before handoff."
    : "No active Persona workflow accepts evidence. Workflow evidence registration is not required for this handoff. Do not request it or treat its absence as a blocking gap, even if an earlier instruction or review requested it. Implementation, required documentation, and focused verification are still required.";
}

/** "commit, push, create or update a pull request, … or wait for pull-request CI". */
export function deferredImperativeList(contract: TaskCompletionContract): string {
  return joinWithOr(contract.deferred.map((action) => action.imperative));
}

function joinWithOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}
