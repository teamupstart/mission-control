import type { Session, Task } from "@shared/types.ts";
import { kindMissionMcpRequirement, type MissionMcpTool } from "./mission-mcp.ts";
import type { ResumeContext } from "./harness/resume.ts";

/** Owners resolve durable facts; harness adapters receive only these plain values. */
export function resumeContext(
  session: Session,
  task: Task | null,
  evidence: boolean,
  ensembleMember: boolean,
): ResumeContext {
  const tools = new Set<MissionMcpTool>(task ? kindMissionMcpRequirement(task, null, evidence)?.tools : []);
  if (evidence) tools.add("submit_workflow_evidence");
  if (ensembleMember) tools.add("submit_ensemble_result");
  const extraDirs = task ? [task.worktreePath, ...task.extraRepos.map((repo) => repo.worktreePath)]
    .filter((path): path is string => Boolean(path && path !== session.cwd)) : [];
  return { managed: session.runtime === "sdk" || task !== null || evidence || ensembleMember,
    requiredTools: [...tools], extraDirs: [...new Set(extraDirs)] };
}
