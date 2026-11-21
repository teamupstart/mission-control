import type { ManagedPlanPolicy, TaskPlanInput } from "@shared/managed-plans.ts";
import type { TaskDependencyInput } from "@shared/protocol.ts";
import { dependencyKey } from "@shared/task-dependency.ts";
import type { Task, TaskDependency } from "@shared/types.ts";
import type { TaskWorkEpisodeBinding } from "../db.ts";
import type { planRevisionRecord } from "./store.ts";

type PlanOrigin = Pick<ReturnType<typeof planRevisionRecord>, "task_id" | "session_id" | "episode_id">;
type PinOrigin = { input: TaskPlanInput; origin: PlanOrigin };

/** The same exact-origin rule serves validation, editor guidance, and pin changes. */
export function planInputEdgesForOrigin(input: TaskPlanInput, origin: PlanOrigin, dependencies: TaskDependency[]): TaskDependency[] {
  return dependencies.filter(edge => edge.type === "plan"
    ? edge.planId === input.planId && edge.repoKey === input.repoKey && edge.revision === input.revision
    : edge.type === "task" ? edge.taskId === origin.task_id && edge.episodeId === origin.episode_id
      : edge.type === "session" && origin.task_id === null && edge.sessionId === origin.session_id && edge.episodeId === origin.episode_id);
}

/** Pure selection over looked-up records; the caller resolves and validates any addition. */
export function selectPinChangeDependencies({ current, from, to, remainingPins, storage, published, source, bindings, now }: {
  current: TaskDependency[];
  from: PinOrigin;
  to: PinOrigin;
  remainingPins: PinOrigin[];
  storage: ManagedPlanPolicy["storage"];
  published: boolean;
  source: Pick<Task, "id" | "title" | "kind" | "planPolicy"> | null;
  bindings: TaskWorkEpisodeBinding[];
  now: number;
}): {
  dependencies: TaskDependency[];
  addition: TaskDependencyInput | null;
  mergeCandidate: { edge: Extract<TaskDependency, { type: "task" }>; mergedAt: number | null } | null;
} {
  const oldEdges = planInputEdgesForOrigin(from.input, from.origin, current);
  const dependencies = current.filter(edge => !oldEdges.includes(edge)
    || remainingPins.some(pin => planInputEdgesForOrigin(pin.input, pin.origin, [edge]).length > 0));
  if (planInputEdgesForOrigin(to.input, to.origin, dependencies).length || published) {
    return { dependencies, addition: null, mergeCandidate: null };
  }
  const addition: TaskDependencyInput = storage === "local" && source?.kind === "plan" && source.planPolicy?.storage === "local"
    ? { type: "plan", repoKey: to.input.repoKey, planId: to.input.planId, revision: to.input.revision }
    : to.origin.task_id ? { type: "task", taskId: to.origin.task_id }
      : { type: "session", sessionId: to.origin.session_id };
  const binding = addition.type === "task" && !dependencies.some(edge => dependencyKey(edge) === dependencyKey(addition))
    ? bindings.find(bound => bound.taskId === addition.taskId && bound.episodeId === to.origin.episode_id && bound.sessionId === to.origin.session_id)
    : undefined;
  // This is only a candidate for the caller's merge-proof lookup, never a satisfied edge.
  // Completion or merge evidence from another episode cannot authorize its retention.
  const mergeCandidate = source && binding ? {
    edge: { type: "task" as const, taskId: source.id, title: source.title,
      sessionId: binding.sessionId, episodeId: binding.episodeId, agentSessionId: binding.agentSessionId,
      branch: binding.branch, prUrl: binding.prUrl, selectedAt: now, satisfiedAt: null },
    mergedAt: binding.mergedAt,
  } : null;
  return { dependencies, addition, mergeCandidate };
}
