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

An SDK session's native conversation identity comes from its owned driver, including the
first binding and explicit context resets. Hooks can supplement that session only when
they carry its current native conversation ID. Sharing its working directory or inherited
pane coordinates does not let an auxiliary CLI replace the owner, rotate its task episode,
or detach its workflow and evidence. Terminal sessions retain their hook-based binding and
clear behavior.

For SDK sessions, a matching end-of-query or context hook cannot mark the card Gone.
Only the owned driver's final exit closes the durable SDK row and begins eviction; late
hooks cannot reopen a closing card. Explicit stop stays closed across restart, while daemon
shutdown suspends the row for restoration.

### Model capacity retries

When the provider ends an SDK turn because the selected model is at capacity, the turn is
not reported as finished. Codex reports this as `serverOverloaded` ("Selected model is at
capacity"). Claude Code reports it once its own 529 retries are spent ("Repeated 529
Overloaded errors") or through its "experiencing high load" off-switch. The
[SDK supervisor](../src/server/sdk/supervisor.ts) keeps the card working, shows
`Model at capacity - retrying in 15s (attempt 1 of 8)`, and keeps the durable
`turn_in_progress` bit set. When the wait elapses it sends a continuation prompt, recorded as
Mission Control's words rather than the operator's. Workflows and Foreman therefore never
receive half-finished work as a completed turn.

The waits double from 15 seconds up to a 10 minute ceiling: 15s, 30s, 1m, 2m, 4m, 8m, 10m,
then 10m. After eight attempts the turn is reported finished, so a model that stays down
cannot hold a session busy indefinitely. Any turn that ends normally resets the count. A
message delivered during the wait replaces the retry. An interrupt cancels it and settles
the card idle, and a daemon restart during the wait continues the work through the ordinary
restart continuation. The schedule lives in
[`capacity-retry.ts`](../src/server/sdk/capacity-retry.ts). Terminal sessions are unchanged:
their harness's own interface shows the error.

Startup retires a live SDK row whose original task is cancelled and detached only when no
other task currently owns that session and no replacement work episode began at or after
the cancellation. Reset & clear can cancel the old task while retaining the replacement
conversation. Startup uses the ordinary eviction lifecycle for stale rows without
launching a driver or sending a continuation. Completed tasks may retain or reuse their
agents; task completion alone does not exclude an SDK session from restoration.

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

Before rollback, keep the current daemon running until Sitrep has no unresolved terminal
transfers. Use Check again to adopt a proven successor or End transfer only when the daemon
permits it. If process or launch proof is still unavailable, remain on this version; do not
delete reservations or force a second launch to make rollback possible. Once all transfers
are resolved, stop the daemon before starting an older build against the same state home.
