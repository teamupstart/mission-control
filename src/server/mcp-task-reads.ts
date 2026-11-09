import { createHash } from "node:crypto";
import { z } from "zod/v3";
import type { McpListTasks, McpTaskSnapshot } from "@shared/protocol.ts";
import type { Task } from "@shared/types.ts";
import { taskRepoPrSummaries, taskRepoRefs } from "@shared/task-repos.ts";
import { listTasks, primaryRepoPrForTask } from "./db.ts";

const CursorSchema = z.object({
  version: z.literal(1),
  filters: z.string(),
  createdAt: z.number().int().nonnegative(),
  id: z.string().min(1),
}).strict();

export class InvalidTaskCursorError extends Error {
  constructor() {
    super("Invalid task cursor or changed filters");
  }
}

export function taskReadSnapshot(task: Task): McpTaskSnapshot {
  const primary = primaryRepoPrForTask(task.id);
  const prUrl = primary.prUrl ?? task.outcomeUrl;
  // Both callers read durable tasks: getDurable -> taskReposFor and listTasks ->
  // taskReposByTask already load extraRepos' PR bindings from work_episode_prs.
  // The callback supplies only live review feedback, never the attached PR URLs;
  // omit that session-private feedback while preserving the durable PR projection.
  return { ...task, prUrl, repoPrs: taskRepoPrSummaries(task, { ...primary, prUrl }, () => null) };
}

/** Reads durable rows, including completed tasks no longer in the Registry. */
export function readTaskPage(query: McpListTasks) {
  const filters = createHash("sha256").update(JSON.stringify({
    status: query.status, kind: query.kind, repository: query.repository,
    labels: [...new Set(query.labels ?? [])].sort(), priority: query.priority,
    enabled: query.enabled, dependsOnTaskId: query.dependsOnTaskId,
  })).digest("hex");
  let after: z.infer<typeof CursorSchema> | undefined;
  if (query.cursor) {
    try {
      after = CursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      if (after.filters !== filters) throw new Error("changed filters");
    } catch {
      throw new InvalidTaskCursorError();
    }
  }
  // Reuse the durable task reader's normalization of historical labels/dependencies.
  // The registry is only the live board and can omit finished tasks after a restart.
  const matching = listTasks().filter((task) =>
    (query.status === undefined || task.status === query.status) &&
    (query.kind === undefined || task.kind === query.kind) &&
    (query.repository === undefined || taskRepoRefs(task).some((repo) => repo.repoRoot === query.repository)) &&
    (query.labels ?? []).every((label) => task.labels.includes(label)) &&
    (query.priority === undefined || task.priority === query.priority) &&
    (query.enabled === undefined || task.enabled === query.enabled) &&
    (query.dependsOnTaskId === undefined || task.dependencies.some((edge) => edge.type === "task" && edge.taskId === query.dependsOnTaskId)) &&
    (!after || task.createdAt < after.createdAt || (task.createdAt === after.createdAt && task.id < after.id)),
  ).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const tasks = matching.slice(0, query.limit);
  const last = tasks.at(-1);
  return {
    tasks: tasks.map(taskReadSnapshot),
    nextCursor: matching.length > tasks.length && last
      ? Buffer.from(JSON.stringify({ version: 1, filters, createdAt: last.createdAt, id: last.id })).toString("base64url")
      : null,
  };
}
