import {
  normalizeSessionActionName,
  sessionActionDescriptionFromMarkdown,
  sessionActionNameFromMarkdown,
} from "@shared/workflow.ts";
import type { SessionAction, SessionActionCompletion } from "@shared/workflow.ts";
import { PULL_REQUEST_SKILL, RETRO_SKILL } from "@shared/skills.ts";
import { BUILTIN_SESSION_ACTION_SOURCES } from "./builtin-session-actions.generated.ts";

/**
 * The session actions that ship with the application.
 *
 * App data, not operator data, exactly as `BUILTIN_PERSONAS` is: never rows, merged into
 * every SessionAction read by `WorkflowStore`, and therefore visible to the library, to draft
 * validation and to Publish's snapshot without a seeding step that could half-run.
 *
 * `builtinSessionActionId` is append-only for an action that remains shipped. The id reaches
 * durable storage as a published version's `sourceSessionActionId` and as a draft graph's
 * `sessionActionId`, so renaming a file slug silently repoints an id an operator's draft
 * already uses. Removing a document removes its id from the catalog; published versions
 * remain intact because they carry their own prompt copy.
 */
export const BUILTIN_SESSION_ACTION_ID_PREFIX = "builtin:";

/** Durable, human-readable, and derived from the filename so nothing states it twice. */
export function builtinSessionActionId(slug: string): string {
  return `${BUILTIN_SESSION_ACTION_ID_PREFIX}${slug}`;
}

/**
 * Which shipped action wants which skill and which proof.
 *
 * A table keyed by slug rather than frontmatter parsed out of the document, because these
 * two fields are CONTRACTS the daemon enforces - a required skill blocks delivery and a
 * completion kind decides what counts as done - and a document is prose. Putting them in
 * the Markdown would make an authored typo into a shipped action that either never sends or
 * completes under the wrong proof. A slug with no entry gets the conservative pair.
 */
const BUILTIN_SESSION_ACTION_CONTRACTS: Record<
  string,
  { requiredSkillId: string | null; completion: SessionActionCompletion }
> = {
  "pull-request": {
    requiredSkillId: PULL_REQUEST_SKILL,
    completion: { kind: "pull_request" },
  },
  // The retro's product is a commit under `.agents/memory`, so `repo_commit` is the proof.
  // `session_turn` would report a retrospective that talked about three memories and wrote
  // none of them as finished, which is the exact failure the completion contract exists to
  // catch.
  retro: {
    requiredSkillId: RETRO_SKILL,
    completion: { kind: "repo_commit" },
  },
};

function builtinSessionAction(source: { slug: string; promptMarkdown: string }): SessionAction {
  const name = sessionActionNameFromMarkdown(source.promptMarkdown, source.slug);
  const contract = BUILTIN_SESSION_ACTION_CONTRACTS[source.slug]
    ?? { requiredSkillId: null, completion: { kind: "session_turn" as const } };
  return {
    id: builtinSessionActionId(source.slug),
    name,
    normalizedName: normalizeSessionActionName(name),
    description: sessionActionDescriptionFromMarkdown(source.promptMarkdown),
    promptMarkdown: source.promptMarkdown,
    requiredSkillId: contract.requiredSkillId,
    completion: contract.completion,
    // One revision, because a build has exactly one copy of each document. Editors read this
    // to decide what a save would be based on, and a built-in has no save.
    revision: 1,
    archivedAt: null,
    // A built-in was not created on this machine and has no edit history, so there is no
    // instant to report. Surfaces print "Built-in" where they print a row's dates.
    createdAt: 0,
    updatedAt: 0,
    builtin: true,
  };
}

export const BUILTIN_SESSION_ACTIONS: readonly SessionAction[] =
  BUILTIN_SESSION_ACTION_SOURCES.map(builtinSessionAction);

/** The shipped Pull Request action, by the id Phase 4's built-in workflow will name. */
export const PULL_REQUEST_SESSION_ACTION_ID = builtinSessionActionId("pull-request");

/**
 * The shipped Retro action, by the id the retro delivery route resolves.
 *
 * Named here rather than spelled at the call site because the route delivers this ONE action
 * on request - there is no operator selection in front of it - so a typo would be a route
 * that 404s at runtime rather than a build that fails.
 */
export const RETRO_SESSION_ACTION_ID = builtinSessionActionId("retro");
