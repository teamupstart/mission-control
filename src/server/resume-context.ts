import type { Task } from "@shared/types.ts";
import { kindMissionMcpRequirement, type MissionMcpTool } from "./mission-mcp.ts";
import type { ResumeContext, ResumeSource } from "./harness/resume.ts";
import { resolveDispatchAdvisor, resolveDispatchModel } from "./harnesses.ts";
import { launchWorkUnitId } from "./work-unit.ts";

/** Owners resolve durable facts; harness adapters receive only these plain values. */
export function resumeContext(
  session: ResumeSource,
  task: Task | null,
  evidence: boolean,
  ensembleMember: boolean,
): ResumeContext {
  const tools = new Set<MissionMcpTool>(task ? kindMissionMcpRequirement(task, null, evidence)?.tools : []);
  if (evidence) tools.add("submit_workflow_evidence");
  if (ensembleMember) tools.add("submit_ensemble_result");
  const extraDirs = task ? [task.worktreePath, ...task.extraRepos.map((repo) => repo.worktreePath)]
    .filter((path): path is string => Boolean(path && path !== session.cwd)) : [];
  return { resident: task?.kind === "resident", managed: session.runtime === "sdk" || task !== null || evidence || ensembleMember,
    requiredTools: [...tools], extraDirs: [...new Set(extraDirs)],
    // A resume is a start, so it decides again, here and once: the agent it opens carries the
    // task's work unit when the preview is on now, whatever the previous process carried.
    workUnitId: launchWorkUnitId(task),
    // The model the conversation is running on now, when the session has reported one, and
    // otherwise the one its launch would resolve: the advisor is chosen per model.
    advisorModel: task
      ? resolveDispatchAdvisor(
        task,
        session.meta?.modelId ?? resolveDispatchModel(task.agent, task.model, null, task.kind),
      )
      : null };
}
