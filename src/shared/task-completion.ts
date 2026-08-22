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
    "evidence registration the task asked for is done",
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

/**
 * The contract per kind, or null for a kind that draws no such boundary.
 *
 * `Record<TaskKind, …>` for the same reason `KIND_CONTRACT` in `server/task-contract.ts`
 * uses one: a new task kind does not compile until it has said what its completion
 * boundary is, including saying it has none. Only `ship` defers post-completion work
 * today; scout, plan, pipeline and chat finish inside their own delivered turn and are
 * judged against their objective unchanged.
 */
const KIND_COMPLETION_CONTRACT: Record<TaskKind, TaskCompletionContract | null> = {
  ship: SHIP_CONTRACT,
  scout: null,
  plan: null,
  pipeline: null,
  chat: null,
};

/**
 * The trusted initial completion contract for a durable task kind, or null.
 *
 * Keyed by KIND alone, deliberately. Not by agent, not by the selected workflow, and not
 * by whether a workflow is bound at all: the binding decides what happens AFTER
 * completion, never what implementation-complete means. A `ship` task heading for
 * Straight-to-PR and one heading for No-Mistakes Review are complete at the same line.
 */
export function taskCompletionContract(kind: TaskKind | null | undefined): TaskCompletionContract | null {
  return kind ? KIND_COMPLETION_CONTRACT[kind] ?? null : null;
}

/** "commit, push, create or update a pull request, … or wait for pull-request CI". */
export function deferredImperativeList(contract: TaskCompletionContract): string {
  return joinWithOr(contract.deferred.map((action) => action.imperative));
}

function joinWithOr(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}
