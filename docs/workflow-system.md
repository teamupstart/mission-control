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
A Persona node with `recheckAfterRepair: true` bypasses pass reuse. The optional flag survives
stage edits and publication beside the Persona snapshot; omission preserves legacy behavior.
Documentation Review enables it for every judge.
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

The [built-in workflow catalog](workflows.md#built-in-workflows) uses the same Check,
Persona, All-pass Join, and Session action primitives as operator-authored workflows.
Published versions remain immutable. Repository Plan Validation includes PR publication;
Local Plan Validation ends without a PR. Documentation Review adds the dedicated documentation
Command and the documentation review roles without a new graph node kind or database table.
Persona calls cannot read checkout files, so document and plan contracts request current
registered text and the relevant unchanged comparison material.

Task workflow defaults resolve through `taskDefaultWorkflowId` in `src/shared/task.ts`, used by
both the dispatch form and server task creation. Plan defaults to Plan Validation; Bugfix defaults
to Bug Fix Review; Document defaults to Documentation Review; Ship retains the machine workflow setting. Explicit IDs and null opt-outs win.
Bugfix and Document share Ship's deferred publication, automatic wrap-up, backlog eligibility, and recovery
through the existing registries and `isShippingTaskKind` predicate.

Ensembles coordinate multiple agent attempts and hand a selected result back through
workflow and task seams. The [ensemble manager](../src/server/ensembles/manager.ts) owns
that coordination. The extension surface, strategies, and limits already have their own
authoritative guide: [Multi-agent ensembles](ensembles.md).

For product behavior, see [Workflows, Personas, and session actions](workflows.md). Before
changing persisted IDs, workflow evidence, action adapters, or registries, follow the
[change contracts](agent-guides/change-contracts.md#persisted-identifiers) and
[session-action contract](agent-guides/change-contracts.md#session-actions) rather than
copying their rules here.

## Switching a session workflow

The binding dialog submits a new published version with the id of the active binding it
observed. `WorkflowManager.createBinding` validates the selected version, live session, and
binding modes before `WorkflowStore.replaceBindingAndCancel` takes the database write lock.
The store verifies that the expected binding still owns the conversation, archives it and
any active repository siblings, cancels their active runs, and inserts the new binding in
one transaction. A failed insert rolls the archives back. The manager publishes the old
binding and run changes and the new binding only after the transaction commits. A stale
binding id returns a conflict so another session's workflow is never silently replaced.

## Runtime continuity

Continue in terminal transfers every active binding of the same native conversation,
including each repository sibling, while preserving binding IDs, published version pins,
repository scopes, active runs, rounds, segments and frozen evidence. An existing capture
finishes before the source stops; new captures wait for verified ownership and reread the
binding. Evaluators may finish immutable work while transport is held.

Only prepared delivery destinations move. Delivered, refused, cancelled and uncertain
packets retain their attribution and acknowledgement policy. A transfer does not authorize
retry, resubmit, a new workflow publication, or manual reattach. Historical delivery observers
follow committed successor links, while ordinary consent and delivery gates still run before
an unsent packet can cross the terminal boundary.

Source removal and first discovery both honor the durable reservation. On definite failure,
the existing orphan policy applies. Unknown launch, ownership conflict or missing proof stays
visible in Sitrep without manufacturing a replacement workflow or agent. Evidence registration
returns a retryable `handoff_awaiting_discovery` refusal until the live successor is verified;
then the existing active Persona binding and issued checkout-scope checks apply unchanged.
