# Tasks, queues, and schedules

Tasks are Mission Control's durable units of requested work. They can be filed by an
operator, imported by a task source, created from a recurring mission, or commissioned by
automation. A task may point at the session executing it, but that pointer represents the
current execution, not its complete history.

The [task manager](../src/server/tasks.ts) owns task operations and dispatch integration.
The [queue manager](../src/server/queue.ts) provides work-queue state. Recurring missions
are managed through the [schedule manager](../src/server/schedules/manager.ts) and its
[loop](../src/server/schedules/loop.ts). The daemon composes these services in
[`src/server/index.ts`](../src/server/index.ts), where they share the Registry and its
event publication path.

Foreman can act as a separate, HTTP-only worker that helps progress queued work. It never
writes SQLite directly; its [worker](../src/server/foreman/worker.ts) calls daemon routes
like another client. This keeps task and queue persistence within the daemon boundary.

Read [Dispatch, backlog, and task sources](dispatch-and-backlog.md), [Recurring missions](recurring-missions.md),
and [Work queues and backlog autopilot](work-queues.md) for user-facing behavior. The
binding and cleanup rules remain in the [tasks and worktrees contract](agent-guides/architecture.md#tasks-and-worktrees).
