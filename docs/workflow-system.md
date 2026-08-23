# Workflows, personas, actions, and ensembles

The workflow system turns a repeatable review or delivery process into durable runs. A
workflow has versioned definitions and nodes. Nodes can invoke a persona, run a check, or
perform a session action. The [workflow manager](../src/server/workflows/manager.ts) owns
run orchestration and recovery; its [store](../src/server/workflows/store.ts) owns the
durable workflow records.

Personas and session actions are editable catalogs managed by
[`personas.ts`](../src/server/workflows/personas.ts) and
[`session-actions.ts`](../src/server/workflows/session-actions.ts). The repository's builtin
Markdown sources are compiled into generated modules by
[`scripts/builtin-personas.ts`](../scripts/builtin-personas.ts) and
[`scripts/builtin-session-actions.ts`](../scripts/builtin-session-actions.ts), so installed
defaults and operator-managed copies remain distinct.

The current built-in No-Mistakes Review is version 10. It runs the compiled
`builtin:code-quality-judge` Persona after the parallel deep reviewers and before the verified
Pull Request action, then completes under the existing `none` policy. Older immutable versions
and custom workflows may still use the `inspector` completion policy, which is presented as the
GitHub Inspector final gate. GitHub Inspector remains the daemon-owned remote reviewer and the
source of exact-head Shipping proof.

Ensembles coordinate multiple agent attempts and hand a selected result back through
workflow and task seams. The [ensemble manager](../src/server/ensembles/manager.ts) owns
that coordination. The extension surface, strategies, and limits already have their own
authoritative guide: [Multi-agent ensembles](ensembles.md).

For product behavior, see [Workflows, Personas, and session actions](workflows.md). Before
changing persisted IDs, workflow evidence, action adapters, or registries, follow the
[change contracts](agent-guides/change-contracts.md#persisted-identifiers) and
[session-action contract](agent-guides/change-contracts.md#session-actions) rather than
copying their rules here.
