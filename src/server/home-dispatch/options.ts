import type { Handler } from "hono";
import { buildDispatchQuestions } from "@shared/dispatch-options.ts";
import { HomeDispatchOptionsRequestSchema, type HomeDispatchOptionsResponse } from "@shared/home-dispatch.ts";
import { parseBody } from "../http-body.ts";
import { newPlanPolicy, PlanStoreError } from "../plans/store.ts";
import { listRepos, resolveRepoRoot } from "../repos.ts";
import { getWorkflowPolicy } from "../workflows/config.ts";
import { requireHomeSession } from "./sessions.ts";
import type { HomeDispatchDeps, HomeDispatchHandler } from "./stub.ts";

// Owner: P5. `POST /dispatch/dispatch-options` returns the dialog questions (spec 7.5). The
// pages come from `buildDispatchQuestions` in `src/shared/dispatch-options.ts`, the same
// module the mod imports, so the daemon only gathers what the pages depend on.

/** Every active published Workflow, as the dashboard's After work picker lists them. */
export function publishedWorkflows(deps: HomeDispatchDeps): Array<{ id: string; name: string }> {
  return (deps.workflows?.list() ?? [])
    .filter((workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null)
    .map((workflow) => ({ id: workflow.id, name: workflow.name }));
}

/** The workspace repositories, or none when the scan cannot run: the Repo page is then simply absent. */
async function workspaceRepos(): Promise<string[]> {
  try {
    return await listRepos();
  } catch {
    return [];
  }
}

/** Where a new plan would be stored. A skills config the store refuses leaves the repository default. */
export function defaultPlanStorage(): "repository" | "local" {
  try {
    return newPlanPolicy(undefined).storage;
  } catch (error) {
    if (error instanceof PlanStoreError) return "repository";
    throw error;
  }
}

export const dispatchOptionsHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeDispatchOptionsRequestSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const home = requireHomeSession(deps, body.sessionId);
  if (!home.ok) return c.json({ error: home.refusal.reason }, home.refusal.status);

  const inRepository = (await resolveRepoRoot(body.cwd)) !== null;
  const response: HomeDispatchOptionsResponse = {
    questions: buildDispatchQuestions({
      entry: body.entry,
      kind: body.kind,
      brief: body.brief,
      inRepository,
      workspaceRepos: inRepository ? [] : await workspaceRepos(),
      workflows: publishedWorkflows(deps),
      configured: getWorkflowPolicy().kindWorkflowDefaults,
      planStorage: defaultPlanStorage(),
    }),
  };
  return c.json(response);
};
