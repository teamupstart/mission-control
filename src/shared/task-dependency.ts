import type { TaskDependencyInput } from "./protocol.ts";
import type { TaskDependency } from "./types.ts";

// One spelling of a dependency's identity, shared by the stored edge and the input that
// names it. Every surface that de-duplicates, compares or keeps edges across an edit reads
// it here, so a new edge type is added in one place rather than at each call site.

/** A task or session edge: the two that follow a piece of OUR work to its pull request. */
export type WorkDependency = Extract<TaskDependency, { type: "task" | "session" }>;

/**
 * Whether this edge tracks OUR work (a task or a session) and so is reconciled against
 * pull requests. A `plan` edge follows a managed plan revision, a `source` edge an external
 * item, and an `unknown` one is only ever kept.
 */
export function isWorkDependency(dependency: TaskDependency): dependency is WorkDependency {
  return dependency.type === "task" || dependency.type === "session";
}

/** The identity key of a stored edge or of the input that names it. */
export function dependencyKey(dependency: TaskDependency | TaskDependencyInput): string {
  switch (dependency.type) {
    case "plan":
      return `plan:${dependency.repoKey}:${dependency.planId}:${dependency.revision}`;
    case "task":
      return `task:${dependency.taskId}`;
    case "session":
      return `session:${dependency.sessionId}`;
    case "source":
      return `source:${dependency.sourceId}:${dependency.externalId}`;
    case "unknown":
      return `unknown:${dependency.key}`;
  }
}

/** A stored edge as the input that names it, which is what an update body carries. */
export function dependencyInputOf(dependency: TaskDependency): TaskDependencyInput {
  switch (dependency.type) {
    case "plan":
      return { type: "plan", repoKey: dependency.repoKey, planId: dependency.planId, revision: dependency.revision };
    // The operator's stack/after-merge override travels with the edge, so an edit that only
    // touches another field does not silently reset it to the inherited default.
    case "task":
      return { type: "task", taskId: dependency.taskId, ...(dependency.mode ? { mode: dependency.mode } : {}) };
    case "session":
      return { type: "session", sessionId: dependency.sessionId, ...(dependency.mode ? { mode: dependency.mode } : {}) };
    case "source":
      return {
        type: "source",
        sourceId: dependency.sourceId,
        externalId: dependency.externalId,
        url: dependency.url,
        title: dependency.title,
      };
    case "unknown":
      return { type: "unknown", key: dependency.key };
  }
}
