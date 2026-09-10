# Workflow Persona model overrides: implementation index

## Approved source and decisions

Read the [approved source plan](plan.md) and its [rendered page](plan.html). On 2026-09-10 the operator selected **Provider and model**, **Approve this plan**, and **Create phased implementation plan**. Those selections are recorded in the source plan and govern this index.

Repository: `teamupstart/mission-control` only. No additional repository is required. Planning artifacts are published by this session's PR; the implementation task remains blocked until that PR merges.

## Sizing and phase count

Estimated gross production code added or materially changed: **350–600 lines**, excluding tests and documentation. Assumptions: 60–100 lines for contracts and projection preservation, 40–80 for publication and execution resolution, 180–300 for a shared node editor and both authoring surfaces, and 70–120 for default/override/history presentation. Existing model fields, JSON graph storage, provider registries, and attempt routing records are reused.

Create **one phase and one one-shot implementation task**. Although the estimate exceeds 200 lines, this is one bounded vertical slice with no new service, database lifecycle, or concurrency protocol. A schema-only phase would expose an unused capability; a UI-only phase would create controls without execution. Keeping the round-trip and runtime tests alongside the editor is safer and remains reviewable for a mid-tier implementation model. No preparation, test-only, or documentation-only phase is needed.

## Repository investigation and reconciliations

- Draft and published nodes are separate unions in `src/shared/workflow.ts`, validated by separate Zod schemas in `src/shared/protocol.ts`. Preserve optional omission rather than backfilling old graph JSON.
- `src/shared/workflow-stages.ts` reconstructs nodes in `memberOf` and `compileStages`. Both need the new field. Its `stageMemberKey` can use Persona identity as a fallback, so override editing must target a node occurrence and tests must use the same Persona more than once.
- `useWorkflowDraft.duplicate` posts the current draft directly to the ordinary create route. There is no need to invent a duplicate endpoint. Existing duplication semantics for other workflow policies remain intact.
- `WorkflowStore.publishWorkflow` freezes `personaSnapshotOf(persona)` inside a transaction and keys idempotency on source draft revision. A saved override change must increment the ordinary draft revision; do not introduce a separate publication fingerprint or rewrite old versions.
- Settings backups already reuse the shared graph schemas in `src/server/settings-backups/catalogs.ts`. Verify round-trip preservation rather than adding a parallel backup format.
- The engine resolves execution before `claimAttempt` and already persists actual runner/model IDs. A separate database column for overrides on attempts is unnecessary: the immutable version identifies the setting, and the attempt identifies what ran.
- Provider identity is the headless `LlmRunnerId` registry, currently Claude and Codex at investigated commit `2cace061`. It is not the interactive agent/harness catalog. Follow the registry present during implementation, without introducing a new provider or hardcoding today's list.
- The root plan's phrase capability validation means validating the supported runner ID and respecting existing runtime availability behavior. There is no existing Persona-provider availability gate in `workflow-graph.ts` to extend; do not require an installed CLI merely to save an otherwise valid workflow. Unknown runner IDs are rejected; unavailable known runners follow infrastructure-failure behavior when run.
- `WorkflowCanvas` owns graph labels, `WorkflowLibrary` owns editing actions, and `WorkflowProperties.tsx` owns the selected Persona control and replacement. A new standalone NodeInspector or executor is not assumed. `src/server/routes.ts` contains the HTTP routes. No Electron, packaging, Foreman worker, or deployment changes are needed.

## Phase and dependency graph

| Phase | Outcome | Direct merge prerequisite | Detailed guide |
| --- | --- | --- | --- |
| 1: Per-node execution defaults and overrides | Author, publish, execute, and inspect independent provider/model overrides for workflow Persona occurrences | This planning session's PR merged to the default branch | [Phase 1](phase-1-node-execution-overrides.md) |

Dependency graph: **planning session PR merged → Phase 1 task → implementation PR merged**.

Concurrency groups: only Phase 1 exists; there are no parallel phase tasks. Merge order is the planning PR, then the single implementation PR. Set `dependsOnCurrentSession: true` when scheduling; there are no direct phase-task dependencies and no guessed session IDs.

## Cross-phase contracts and handoff

Phase 1 owns every source requirement: paired overrides, inheritance, provider-switch validation, Persona replacement reset, per-occurrence independence, both editor views, duplication, persistence, publishing, historical presentation, actual execution/accounting, legacy compatibility, documentation, and all verification. There is no downstream cleanup dependency.

The durable contract is an optional node-owned execution pair on draft and published graphs. Absence preserves existing behavior. Persona snapshots preserve recommended defaults; explicit overrides are frozen separately. Existing runner/model attempt fields remain the execution audit. Persona library records and non-workflow consumers are unaffected.

## Verification strategy

The [phase guide](phase-1-node-execution-overrides.md) owns the detailed implementation and command sequence. Verify resolver precedence, node-identity round trips, immutable publication, persistence/export/restore, fake-runner launches, and browser editing-to-run behavior. Run the repository's required typecheck, lint, build, smoke, relevant unit tests, and E2E gates. Never spend model tokens in verification.

For these planning artifacts, run `python3 docs/plans/workflow-persona-model-overrides/render-plan.py --check`, the same command with `phased --check`, and `git diff --check`. Check every linked local path and inspect the rendered plan through Mission Control Files. Application tests belong to implementation; this PR adds no application behavior.

## Cross-phase audit record

2026-09-10: reconciled the source plan with the actual duplicate route, revision-based publication, shared backup schemas, headless provider registry, and existing attempt audit fields. All approved behavior is assigned exactly once to Phase 1. No new migration, provider, workflow version rewrite, or secondary model resolver is required. Only one phase consumes these contracts, so there are no competing migration owners or cross-phase merge conflicts. The final state requires no undocumented cleanup.

## Publication and scheduling

Commit and push all source, render, index, and phase artifacts before creating the task. Verify the three task pointer paths against the pushed commit. Create exactly one task using the current repository and a direct dependency on this session. Record the returned task ID in the PR description, verify its canonical repository, and keep it backlogged until this planning PR merges. Recheck the paths after review changes. Merge requires separate operator authorization; a green open PR is handed to the operator for that action.
