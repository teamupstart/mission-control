import { buildDispatchOptions, type DispatchOptionsFacts } from "@shared/dispatch-options.ts";
import type { DispatchOptionsRequest, DispatchOptionsResponse } from "@shared/home-dispatch.ts";
import { listRepos, resolveRepoRoot } from "../repos.ts";
import { getSkillsConfig, skillsConfigProblem } from "../skills/config.ts";
import { getUiConfig } from "../ui-config.ts";
import { getWorkflowPolicy } from "../workflows/config.ts";
import type { HomeDispatchDeps } from "./deps.ts";
import type { HomeDispatchResult } from "./stub.ts";

/** Active, published workflows, as the dashboard's after-work list offers them. */
export function publishedWorkflows(deps: HomeDispatchDeps): { id: string; name: string }[] {
  const rows = deps.workflows?.list(false) ?? [];
  return rows
    .filter((workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null)
    .map((workflow) => ({ id: workflow.id, name: workflow.name }));
}

/** Where a plan task keeps its plan, as `newPlanPolicy` resolves it, without throwing. */
export function configuredPlanStorage(): "repository" | "local" {
  if (skillsConfigProblem()) return "repository";
  return getSkillsConfig().planStorage === "local" ? "local" : "repository";
}

/** The settings and workflows every form and draft reads, in one place. */
export function dispatchSettings(deps: HomeDispatchDeps): Pick<
  DispatchOptionsFacts,
  "workflows" | "configured" | "storage" | "guidedDispatch"
> {
  return {
    workflows: publishedWorkflows(deps),
    configured: getWorkflowPolicy().kindWorkflowDefaults,
    storage: configuredPlanStorage(),
    guidedDispatch: getUiConfig(false).guidedDispatch,
  };
}

async function workspaceRepositories(): Promise<string[]> {
  try {
    return await listRepos();
  } catch {
    // A stalled scan only costs the repository question its list; the person can still name one.
    return [];
  }
}

/** `POST /mcp/dispatch/dispatch-options` (spec 7.5). */
export async function handleDispatchOptions(
  input: DispatchOptionsRequest,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<DispatchOptionsResponse>> {
  const cwdInRepo = (await resolveRepoRoot(input.cwd)) !== null;
  const repos = cwdInRepo ? [] : await workspaceRepositories();
  const body = buildDispatchOptions({
    request: { kind: input.kind, brief: input.brief, entry: input.entry },
    cwdInRepo,
    repos,
    ...dispatchSettings(deps),
  });
  return { status: 200, body };
}
