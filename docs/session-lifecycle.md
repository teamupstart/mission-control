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

## Continuing the same conversation in terminal

`SessionTransferCoordinator` reserves one durable `session_runtime_transfers` record per
source conversation and active task. Store-backed guards are available before TaskManager
startup reconciliation and SDK restore. The source leaves only through `beginEviction`;
its removal does not settle reserved tasks, orphan captured workflow bindings, or discard
pending review questions.

Preparation precedes reservation and stop. The coordinator persists each boundary before
its external side effect: `prepared`, `stopping`, `launching`, then `awaiting_successor`.
`adopted`, `aborted`, and `failed` release the hold. `recovery_required` and unknown states
retain it. Restart can revoke unused preparation, observe, adopt, or report uncertainty;
it cannot replay stop, spawn, or a delivery whose acknowledgement is unknown.

Before entering stop, the coordinator saves the SDK driver's PID and process start time.
Subprocess drivers report their child; an in-process driver reports its daemon lifetime.
If that identity cannot be recorded, the handoff rolls back without stopping the source.
After a crash, a complete inventory can prove the recorded lifetime ended even when the SDK
exit event never updated its `running` row. Once the terminal lease also proves absence,
ordinary task and workflow failure settlement releases the hold and retains the checkout.
Live processes, unreadable inventory and older records without lifetime proof remain pending.

The successor must match the native conversation, harness, canonical checkout and repository,
plus this launch's resource. Multiplexer names additionally require the claimed wrapper's
PID and start time ancestry. Emulator inventory IDs or exact wrapper ancestry provide launch
proof. An early keyless resume hook retains its native identity durably but cannot bind a
session until the same launch proof passes. Conflicting task attempts, episodes, sibling
bindings and other active tasks leave recovery pending.

One transaction binds the task and its new work episode, archives outgoing PR provenance,
transfers all captured active workflow bindings, moves unanswered review requests, retargets
only prepared delivery destinations, and marks adoption. Owner projections publish after
commit. Already answered reviews and delivered or uncertain packets retain their historical
attribution; committed successor links let their existing observers follow the conversation.
Staged evidence stays keyed by the native conversation and scoped repository; immutable
submissions, criteria, generations and workflow versions are never copied or rewritten.

The synchronous discovery wait is a response budget. Sitrep exposes unresolved summaries
independently of source cards, including recovery after restart. The Phase 1 resource lease
alone owns credential cleanup. Transfer failure uses existing task settlement, retains the
checkout and never creates a worktree-return obligation. Do not downgrade with pending
transfers: older daemons do not know these ownership guards.
