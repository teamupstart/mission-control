import type { Registry } from "../registry.ts";
import type { Session } from "@shared/types.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { scoutRepoSlots } from "../scouts/repos.ts";
import { PlanStoreError, type PlanAuthority } from "./store.ts";

/** Files discovers the same repository slots that the daemon issues to the writer. */
export function sessionPlanAuthorities(registry: Registry, session: Session): PlanAuthority[] {
  const task = registry.taskForSession(session.id, session.cwd);
  const slots = task ? scoutRepoSlots(task, session.cwd).map((repo) => repo.slot) : ["repo-01"];
  return slots.map((slot) => planAuthority(registry, session, slot));
}

/** Session/task owners issue slots; no request chooses an absolute repository or owner. */
export function planAuthority(registry: Registry, session: Session, slot: string): PlanAuthority {
  if (session.state === "exited" || registry.sessionResetInProgress(session.id)) throw new PlanStoreError("An active registered session is required", 403);
  const task = registry.taskForSession(session.id, session.cwd);
  if (task && !isActiveTask(task.status)) throw new PlanStoreError("This task is no longer active; use the session's current work episode");
  const episode = registry.workEpisodeForSession(session.id);
  if (episode?.awaitingAgentRebind) throw new PlanStoreError("Session identity is being rebound; retry after registration", 409);
  // Taskless sessions may start below the checkout root; repoRoot names the owner of linked worktrees.
  const repos = task ? scoutRepoSlots(task, session.cwd) : [{ slot: "repo-01", root: session.gitRoot }];
  const repo = repos.find((r) => r.slot === slot);
  const repoRoot = task ? (slot === "repo-01" ? task.repoRoot : task.extraRepos[repos.findIndex((r) => r.slot === slot) - 1]?.repoRoot) : session.repoRoot;
  if (!repo?.root || !repoRoot) throw new PlanStoreError("Repository slot is not authorized for this session", 403);
  const authority: PlanAuthority = { sessionId: session.id, taskId: task?.id ?? null, episodeId: episode?.episodeId ?? null, repoSlot: slot, checkout: repo.root, repoRoot };
  const pid = session.pid;
  const agentSessionId = session.agentSessionId;
  authority.assertCurrent = () => {
    const current = registry.getSession(session.id);
    if (!current || current.pid !== pid || current.agentSessionId !== agentSessionId) throw new PlanStoreError("Plan writer registration changed; retry with the current session", 403);
    const resolved = planAuthority(registry, current, slot);
    if (resolved.taskId !== authority.taskId || resolved.episodeId !== authority.episodeId || resolved.checkout !== authority.checkout || resolved.repoRoot !== authority.repoRoot) throw new PlanStoreError("Plan writer work episode or repository scope changed", 403);
  };
  return authority;
}
