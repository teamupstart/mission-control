# Session lifecycle

Mission Control presents terminal-backed and SDK-backed agent sessions as one fleet, while
keeping their different sources of truth explicit. The [Registry](../src/server/registry.ts)
owns the in-memory session map and emits the changes that the rest of the daemon and the
dashboard consume.

## From observation to removal

Terminal sessions arrive through the [discovery poller](../src/server/discovery/poller.ts).
SDK sessions are launched and restored by the [SDK supervisor](../src/server/sdk/supervisor.ts).
Both paths create or update a Registry entry, which is why users see one card shape even
when the agent is running through a terminal pane or an embedded SDK.

When a session leaves, the Registry's `beginEviction` path first exposes an exited state,
then allows the linger window, and finally publishes `session_remove`. Consumers such as
tasks, workflows, reviews, and drafts use that durable removal event to reconcile their
own state. An exited process alone is not durable cleanup.

## Ownership boundaries

- The Registry owns live session state and the removal lifecycle.
- The SDK supervisor owns embedded process handles and reports their lifecycle to the
  Registry.
- Terminal adapters provide discovery and pane mechanics; they do not own task policy.
- Durable task and workflow records survive restarts, while live sessions are rebuilt from
  observation.

For the exact startup ordering, eviction requirements, and task-binding rules, read the
authoritative [session ownership](agent-guides/architecture.md#session-ownership) and
[session removal](agent-guides/architecture.md#a-session-going-away) contracts. The related
product behavior is documented in [Sessions and conversations](sessions.md).
