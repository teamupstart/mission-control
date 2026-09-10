# Phase 1: Per-node execution defaults and overrides

## Outcome and entry criteria

Allow a workflow author to duplicate No-Mistakes Review and choose the provider and model for each Persona occurrence. Personas retain recommended defaults, while a published workflow runs and reports its own explicit choices. The same Persona can be used by different nodes without sharing their overrides.

Read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) first. The operator approved provider-and-model pairs, the whole source plan, and phased task scheduling on 2026-09-10. The only direct prerequisite is the planning session's PR merged to the default branch. There are no earlier implementation phases.

This is the complete implementation phase in `teamupstart/mission-control`, with no attached repositories. The phase document is the proposed route, not a specification: follow it where the repository agrees, adapt with judgment when it does not or a better implementation exists, and explain deviations in the PR. Preserve the approved user outcome and compatibility boundaries.

## Scope and non-goals

Own the shared graph contract, stage projections, save/publish/export/restore preservation, execution resolution, both editing views, published/run presentation, tests, and documentation together. Do not change Persona instructions or library routing when editing a workflow node.

Exclude per-run/session overrides, workflow-wide presets, effort controls, new model providers, Foreman/Inspector/ensemble routing changes, evidence policy, retry budgets, completion policy, or automatic cost optimization. No CI, release, production, deployment, or Electron configuration change is needed. Do not modify historical built-in workflow versions or hand-edit generated files.

## Findings and inherited contracts

- `WorkflowDraftNode` carries live `personaId`; `PublishedWorkflowNode` carries `PersonaSnapshot`. Store publication uses `personaSnapshotOf` and a draft-revision idempotency key. JSON graph storage already exists.
- `StageMember`, `memberOf`, and `compileStages` in `src/shared/workflow-stages.ts` construct new objects; adding a field only to graph types would lose it during Pipeline edits.
- `src/web/workflows/useWorkflowDraft.ts` duplicates through `POST /api/workflows` with `current.draft`. Its fingerprint and history snapshots already retain the draft as a whole. `WorkflowLibrary.tsx` also supports selected-node duplication; cloned occurrences must preserve settings while receiving fresh node IDs.
- `src/server/settings-backups/catalogs.ts` shares the graph schemas. `src/server/routes.ts` owns create/update/publish/export routes, and `WorkflowManager.exportVersion` projects the stored version.
- `WorkflowEngine.runAttempt` resolves before `claimAttempt`, then uses the resolution for launch and spend. Existing attempt fields record actual provider/model. The engine's injectable `resolveExecution` seam currently takes a Persona snapshot; preserve test injection while extending workflow-node resolution.
- `resolvePersonaExecution` in `src/server/workflows/personas.ts` owns the app/environment fallback ladder. Keep non-workflow callers unchanged. The supported headless providers come from `LLM_RUNNER_IDS`, not interactive harness IDs.

## Implementation sequence

1. Add focused regression coverage before UI changes. Establish fixtures with inherited nodes and two nodes sharing a Persona with different overrides. Write the browser scenario so it fails on the existing editor before adding controls.
2. Extend the Persona arms in `src/shared/workflow.ts` and their schemas in `src/shared/protocol.ts` with optional `executionOverride: { runner, model }`. Reuse `LlmRunnerId`, its schema registry, and the bounded model-ID schema. Omission is the persisted inheritance form. Reject incomplete pairs, unknown runner IDs, empty or whitespace-only models, and malformed objects. Do not add a default that changes old serialized graphs merely by reading them.
3. Carry the field through `StageMember`, draft/published stage projection, compilation, and editor transforms. Address editing by the occurrence's node ID or exact member reference, never solely by Persona ID. Preserve overrides when moving, reordering, switching views, changing unrelated fields, duplicating nodes, undoing/redoing, and saving/reloading. New nodes inherit; explicitly replacing a node's Persona removes its override. Apply provider-switch reset in form state before saving a new pair.
4. Copy the node override separately from `personaSnapshotOf` in `WorkflowStore.publishWorkflow`. Use existing CAS writes, draft revisions, and publication idempotency. Inspect route schemas, version/run exports, built-in duplicate flows, and backup staging/restore so no parser strips the new property. Tests must prove an override-only edit publishes a new version while an idempotent repeat does not. Built-in graphs without the field remain unchanged.
5. Add a narrow node execution resolver that delegates to `resolvePersonaExecution` when no override exists and resolves the explicit pair otherwise. Use one resolved value for attempt claim, runner selection, model launch, and spend. Keep fallback ranking in its existing owner. Preserve immutable version routing through retry/resume and daemon recovery. Known but unavailable runners use existing infrastructure failures without model substitution; unknown IDs fail schema validation before save. Disabled nodes still avoid model launches.
6. Build one reusable node execution form using `ModelField` and existing provider/model data. Mount it from Pipeline member controls and the Graph selection/editing surface in `WorkflowProperties.tsx` under `WorkflowLibrary`. Offer Use Persona default and Override for this workflow, show effective routing and source, and require a nonempty model for an override. Provider changes clear stale model input. Persona replacement restores inheritance. Keep new unsaved input local until valid, and preserve existing autosave conflict handling. Read-only built-in and published views display routing without mutation controls.
7. Update routing presentation in Pipeline/Graph summaries, `WorkflowVersionHistory.tsx`, and applicable `RunPipeline.tsx`/`run-model.ts` surfaces. Published detail distinguishes frozen Persona defaults from the override. Completed attempts display their stored actual runner/model, not today's catalog default. Queued/unstarted rows must not claim a model has already executed. Update Persona library copy to say default; keep existing model-source enums or wider shared APIs unchanged unless needed for an honest projection, using a workflow-specific provenance label when appropriate.
8. Update `docs/workflows.md`, `docs/workflow-system.md`, and `docs/models.md`. Inspect tour source copy that describes Persona routing, change the source if needed, and regenerate via the existing generator. Capture browser evidence in a gitignored location and attach it to the implementation PR.

## Data, API, and compatibility

No SQL migration is expected: graph JSON carries the field. Do not create a workflow-level override map, mutate Persona rows, flatten overrides into the Persona snapshot, or add redundant attempt routing columns. Absence must preserve the legacy runner/model fallback behavior, including live app/environment fallbacks for unset published defaults.

Published explicit pairs cannot change when the Persona, application defaults, or workflow draft changes. Old bindings stay pinned to their existing versions. Snapshot source revision/name/guidance retain their current provenance semantics. Export and settings restore round-trip the optional property without inventing a new format solely for it. This feature guarantees old stored data works in the upgraded application; it does not claim an older binary understands new override fields.

Use the existing HTTP/SSE ownership and schema parsing. There is no browser polling, separate database writer, external API, new launch path, or worker state. Model IDs stay free text under existing conventions: absence from suggestions is not a hard validation failure.

## Tests and verification commands

- Extend `test/persona-model.test.ts` or a focused sibling for explicit-pair precedence, existing fallbacks, clearing, and non-workflow behavior. Exercise unsupported/malformed values through graph schemas and route validation.
- Extend `test/workflow-stages.test.ts` and `test/workflow-graph.test.ts` for full round trips and independent occurrences, including reorder and Persona replacement. Inspect editor reducer helpers for focused cases rather than asserting object construction alone.
- Extend `test/workflow-store.test.ts`, `test/workflows-http.test.ts`, and relevant settings backup/restore tests for duplication, version immutability, changed draft revisions, export preservation, and legacy graph parsing. Retain frozen built-in workflow assertions.
- Extend `test/workflow-engine.test.ts` with fake runner capture proving claim/launch/spend agreement, retry and recovery behavior, live default changes not affecting explicit pairs, and disabled-node no-launch behavior.
- Add `e2e/specs/workflow-persona-model-overrides.spec.ts`. Drive Duplicate on No-Mistakes Review, choose different reviewers' routing, edit through both Pipeline and Graph, move a node, save/reload, duplicate again, publish, and inspect read-only routing. Use a small runnable fake-agent workflow to verify actual execution in run detail. Cover reset-to-default, provider switch, Persona replacement, two occurrences of one Persona, and late Persona edits not rewriting published overrides. Read `e2e/README.md`; use accessible selectors, never `data-testid`, and call `expectContentClearsBorder` for a new modal.
- Run focused unit files using the exact single-file invocation in repository `AGENTS.md`, including its mandatory isolation preload. Follow its native-addon provisioning contract for any real-daemon test.
- Run `npm run typecheck` and `npm run lint`.
- Run `npm run build`, then `npm run smoke`.
- Run the focused browser spec with `npm run test:e2e -- e2e/specs/workflow-persona-model-overrides.spec.ts`, then the repository-required `npm run test:e2e` gate. Keep all model and GitHub binaries faked.
- Complete remaining relevant repository checks in proportion to risk. During CI/workflow repair, follow standing instructions: run tests specific to the fix and push; do not rerun the full suite before committing a repair.

## Merge and exit criteria

The implementation PR provides working authoring-to-execution behavior for inherited and overridden nodes with passing relevant tests and required gates. Existing workflows behave as before. Both editor modes preserve settings, published history is immutable, and recorded attempts show actual routing. Documentation matches the feature, evidence is attached, and no unrelated or generated evidence files are committed. Address valid in-scope review findings and monitor CI through a green PR. Merge follows the task's operator authorization and completes this sole implementation phase.

## Downstream handoff

There is no later phase. Future features may consume the optional node override and the existing attempt audit, but must not reinterpret omission, merge node occurrences by Persona ID, mutate published versions, or redefine non-workflow Persona defaults. New providers must enter through the shared headless runner registry.

## Cross-phase audit record

2026-09-10: audited against the approved source and index. This phase owns all approved product behavior and verification. Reconciled duplication with the existing create route, publishing with draft revisions, backups with shared schemas, provider validation with headless runner support, and auditing with existing attempt fields. No other phase owns a schema or migration; all consumers land in this PR. Corrected the compiler name to `compileStages` and located selected-node editing in `WorkflowProperties.tsx`. No scope or approved choice was changed. Re-read the complete artifact set after writing this phase and found no missing prerequisite or downstream cleanup requirement.
