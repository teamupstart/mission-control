# Workflows, personas, actions, and ensembles

The workflow system turns a repeatable review or delivery process into durable runs. A
workflow has versioned definitions and nodes. Nodes can invoke a persona, run a check, or
perform a session action. The [workflow manager](../src/server/workflows/manager.ts) owns
run orchestration and recovery; its [store](../src/server/workflows/store.ts) owns the
durable workflow records.

The machine policy `skipPassedJudges` defaults to true. At claim time the engine looks up the
latest executed, completed verdict for the same Persona node in an earlier round of the same
run. Only a pass is reusable: an explicit recheck that fails supersedes an older pass even if
reuse is enabled again. The engine records a completed attempt with `reusedPassAttemptId` and
atomically emits the usual pass receipts without a model call. The original attempt remains
the authority, including after daemon recovery; no second pass ledger is stored. Runs resolves
that reference to display the original round. Checks and Session actions continue through
their existing execution paths.
Reuse also requires the current directive to match the earned attempt's snapshot, including
revision, timestamps, and text. This applies changed feedback once without making an unchanged
directive force perpetual rechecks; removing and recreating a directive cannot revive a pass
from its earlier revision sequence.
A Persona node also carries an optional `executionOverride` - one explicit
`{ runner, model }` pair chosen by the workflow rather than by the reviewer. It lives on the
node in both the draft and published graph JSON, is frozen beside the Persona snapshot at
publish rather than folded into it, and is absent when the node inherits, so no migration
touches an existing graph.
[`resolveWorkflowNodeExecution`](../src/server/workflows/personas.ts) composes it over
`resolvePersonaExecution`, which keeps the app and environment fallback ladder in its
existing single owner and leaves every non-workflow Persona caller unchanged.

Personas and session actions are editable catalogs managed by
[`personas.ts`](../src/server/workflows/personas.ts) and
[`session-actions.ts`](../src/server/workflows/session-actions.ts). The repository's builtin
Markdown sources are compiled into generated modules by
[`scripts/builtin-personas.ts`](../scripts/builtin-personas.ts) and
[`scripts/builtin-session-actions.ts`](../scripts/builtin-session-actions.ts), so installed
defaults and operator-managed copies remain distinct.

The current built-in No-Mistakes Review is version 15. After its deterministic checks, it runs the
compiled `builtin:intent-conformance-judge` and `builtin:test-coverage-judge` Personas together as
stage 2. Their All-pass Join gates the parallel code-review and evidence-review stages before the
verified Pull Request action. The workflow completes under the existing `none` policy. Older
immutable versions and custom workflows may still use the `inspector` completion policy, which is
presented as the GitHub Inspector final gate. GitHub Inspector remains the daemon-owned remote
reviewer and the source of exact-head Shipping proof.

Ensembles coordinate multiple agent attempts and hand a selected result back through
workflow and task seams. The [ensemble manager](../src/server/ensembles/manager.ts) owns
that coordination. The extension surface, strategies, and limits already have their own
authoritative guide: [Multi-agent ensembles](ensembles.md).

For product behavior, see [Workflows, Personas, and session actions](workflows.md). Before
changing persisted IDs, workflow evidence, action adapters, or registries, follow the
[change contracts](agent-guides/change-contracts.md#persisted-identifiers) and
[session-action contract](agent-guides/change-contracts.md#session-actions) rather than
copying their rules here.
