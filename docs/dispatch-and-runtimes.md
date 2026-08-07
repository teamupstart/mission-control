# Dispatch and runtimes

Dispatch turns a task or operator request into a reachable agent session. Its main job is
to choose one runtime once, provision the appropriate execution surface, and deliver the
initial intent without hiding a failed choice behind an unrelated fallback.

The [dispatcher](../src/server/dispatcher.ts) coordinates launch. Runtime selection lives
with the [harness configuration](../src/server/harnesses.ts), while the [SDK supervisor](../src/server/sdk/supervisor.ts)
owns embedded turns after launch. Terminal execution uses a home and waits for discovery;
an SDK turn has no terminal home or discovery wait.

This split lets the dashboard offer one task experience without pretending the runtimes are
identical. A terminal runtime is controlled through a pane. An SDK runtime is driven by
the supervisor and emits agent events directly. Both ultimately report into the Registry
and its event stream.

Read [Dispatch, backlog, and task sources](dispatch-and-backlog.md) for the operator flow.
For the precise runtime-selection and failure rules, use the authoritative
[dispatch runtime contract](agent-guides/architecture.md#dispatch-runtime). Capability
boundaries are described in [Harnesses and terminal backends](harnesses-and-terminals.md).
