import type { Registry } from "../registry.ts";
import type { Session, Task } from "@shared/types.ts";
import { isActiveTask } from "@shared/task-status.ts";
import { scoutRepoSlots } from "../scouts/repos.ts";
import { planPolicyForTask, PlanStoreError, type PlanAuthority } from "./store.ts";

function taskRepository(task: Task, slot: string, fallbackRoot: string | null = null) {
  const repos = scoutRepoSlots(task, fallbackRoot);
  const index = repos.findIndex((repo) => repo.slot === slot);
  const checkout = repos[index]?.root;
  const repoRoot = index === 0 ? task.repoRoot : task.extraRepos[index - 1]?.repoRoot;
  if (!checkout || !repoRoot) throw new PlanStoreError("Repository slot is not authorized for this task", 403);
  return { checkout, repoRoot };
}

/** Daemon recovery uses the persisted task episode, never a fabricated live writer. */
export function taskPlanAuthority(registry: Registry, taskId: string, slot: string): PlanAuthority {
  const task = registry.getTask(taskId);
  const episode = registry.workEpisodeForTask(taskId);
  const current = episode ? registry.recordedWorkEpisodeForSession(episode.sessionId) : null;
  if (!task || task.status !== "running" || task.kind !== "plan" || task.planPolicy?.storage !== "local"
    || !episode || task.sessionId !== episode.sessionId || current?.episodeId !== episode.episodeId
    || current.agentSessionId !== episode.agentSessionId || current.awaitingAgentRebind
    || registry.sessionResetInProgress(episode.sessionId)) throw new PlanStoreError("Local plan recovery requires the task's current work episode");
  const authority: PlanAuthority = { sessionId: episode.sessionId, taskId, episodeId: episode.episodeId,
    repoSlot: slot, ...taskRepository(task, slot), policy: planPolicyForTask(task) };
  authority.assertCurrent = () => {
    const resolved = taskPlanAuthority(registry, taskId, slot);
    if (resolved.sessionId !== authority.sessionId || resolved.episodeId !== authority.episodeId
      || resolved.checkout !== authority.checkout || resolved.repoRoot !== authority.repoRoot
      || JSON.stringify(resolved.policy) !== JSON.stringify(authority.policy)) throw new PlanStoreError("Plan publication work episode or repository scope changed", 403);
  };
  return authority;
}

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
  const repo = task ? taskRepository(task, slot, session.cwd) : { checkout: slot === "repo-01" ? session.gitRoot : null, repoRoot: session.repoRoot };
  if (!repo.checkout || !repo.repoRoot) throw new PlanStoreError("Repository slot is not authorized for this session", 403);
  const authority: PlanAuthority = { sessionId: session.id, taskId: task?.id ?? null, episodeId: episode?.episodeId ?? null, repoSlot: slot, checkout: repo.checkout, repoRoot: repo.repoRoot, policy: task ? planPolicyForTask(task) : null };
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
