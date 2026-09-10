# Workflow Persona model overrides

## Outcome

Personas provide reusable review instructions and recommended execution defaults. Each use of a Persona in a workflow can choose its own provider and model without duplicating or changing the Persona.

For example, duplicate No-Mistakes Review, select a reviewer, choose a different model, and publish the custom workflow. That reviewer uses the workflow's choice; other reviewers and workflows retain their own settings. Two nodes referring to the same Persona can have different choices.

Status: approved by the operator on 2026-09-10 through the Mission Control plan review. This task produces planning artifacts only.

## Proposed product behavior

- Each Persona node in an editable workflow offers **Use Persona default** and **Override for this workflow**. The default is inheritance.
- An override selects an explicit provider and a nonempty model ID together. Existing provider capabilities and model suggestions populate the controls; custom model IDs remain available under the existing model-field conventions.
- Both Pipeline and Graph views expose the same node setting. Each shows the chosen provider/model and whether it comes from the Persona or this workflow. The Persona library describes its own values as defaults.
- Clearing an override restores Persona inheritance. Changing provider clears the previous provider's model selection and requires a deliberate model choice. Selecting another Persona for a node resets that node to inheritance; moving or reordering a node preserves its override.
- Saving, reloading, switching views, duplicating a workflow, and publishing preserve overrides. Built-in workflows remain read-only; Duplicate creates an editable copy without requiring copies of the Personas.
- Published versions show the frozen Persona defaults separately from the workflow override. Run details show the provider and model actually used by each attempt, including retries.

## Resolution and immutability

| Node setting | Provider and model used |
| --- | --- |
| No override | Existing Persona execution resolution, unchanged |
| Explicit override | The node's provider and model pair |
| Override removed in a draft | Live Persona defaults, with existing app/environment fallbacks |
| Published version without override | Frozen Persona defaults, with existing app/environment fallbacks where defaults are unset |

A draft follows live Persona edits only for inherited values. Publish freezes the Persona snapshot and the separate node override into the immutable workflow version. Editing a Persona, a workflow draft, or a newer published version must not change explicit choices in an already bound version. Existing unset defaults continue to resolve through the current app/environment ladder at attempt time; this feature does not change that behavior.

An override is a pair rather than two independently inherited fields, so a model chosen for one provider cannot accidentally run under another provider after a Persona default changes. Enabling the override can seed the form from the currently resolved defaults, but the saved override records the explicit pair. Empty model input is an incomplete override, not a silent fallback. Unsupported providers are refused through existing capability validation; a model missing from suggestions is not automatically invalid. Runtime provider failures keep existing infrastructure-failure and retry behavior, without silently substituting a different model.

## Execution flow

Before: the dashboard saves Persona references into workflow drafts; publishing freezes Persona defaults; the workflow engine resolves those defaults and invokes the selected LLM runner, recording the actual provider/model on the attempt.

After: the dashboard saves each Persona reference plus its optional execution override into the workflow draft; publishing freezes both the Persona snapshot and the override; the workflow engine selects the explicit pair when present, otherwise the existing Persona resolver, and invokes the LLM runner. The attempt continues to record the actual provider/model. SQLite remains daemon-owned, and the existing HTTP/SSE channels carry the extended graph.

## Repository findings and proposed changes

| Owner | Finding and proposed work |
| --- | --- |
| `src/shared/workflow.ts` and `src/shared/protocol.ts` | Draft Persona nodes currently carry only `personaId`; published nodes carry a `PersonaSnapshot`. Add an optional node-owned `executionOverride` containing the existing runner ID type and model ID schema. Missing means inherit. Keep the Persona snapshot unchanged. |
| `src/shared/workflow-stages.ts` | `StageMember`, `memberOf`, and pipeline compilation reconstruct Persona nodes. Carry the override through every projection, compile, reorder, and edit path, keyed by node identity rather than Persona ID. |
| `src/server/workflows/store.ts` | Publishing explicitly constructs Persona nodes using `personaSnapshotOf`. Copy the separate override into the published node. Preserve it through draft writes, duplication, version export, and settings backup/restore paths. |
| `src/server/workflows/personas.ts` and `engine.ts` | `resolvePersonaExecution` owns fallback resolution; the engine currently passes only `node.persona`. Add a narrow workflow-node resolver that composes with it and keep non-workflow Persona consumers unchanged. Resolve before `claimAttempt`, and use that same result for accounting and runner launch. |
| Workflow editor components | `PipelineEditor.tsx`, `WorkflowCanvas.tsx`, `WorkflowNode.tsx`, `WorkflowProperties.tsx`, `WorkflowLibrary.tsx`, and `useWorkflowDraft.ts` own editing/projection. Reuse a shared node execution editor and presentation helper rather than separate routing rules in the two views. Reuse existing `ModelField` and provider data. |
| Published and run readers | `WorkflowVersionHistory.tsx` currently prints only Persona snapshot routing. Show default versus override there and on graph/pipeline summaries. Inspect `RunPipeline.tsx` and `run-model.ts` so actual attempt routing remains authoritative for historical runs. |

The graph is already stored as JSON, so no new SQLite column or table is expected. Verify all read/write schemas accept legacy graphs and preserve new fields. Do not normalize older graphs by adding fields or rewrite historical built-in versions. Any hashing or idempotency logic must distinguish an override change while retaining existing identities for graphs without overrides.

Implementation should verify exact ownership against the repository at execution time. The table names investigated seams, not a requirement to edit every listed file.

## Compatibility and scope

Existing Personas, built-in workflow versions, bindings, and runs keep their current behavior. Overrides belong to node occurrences, not a map keyed by Persona ID. Persona guidance, provenance, revisions, evidence rules, verdict parsing, retry budgets, and workflow completion policy remain under their existing owners.

This feature covers workflow authoring and the resulting execution. It does not add per-run or per-session overrides, a workflow-wide model preset, reasoning-effort controls, changes to ensembles or Foreman/Inspector routing, new providers, or automatic cost optimization. It does not bump No-Mistakes Review just to introduce an optional capability.

## Verification and acceptance

1. Contract and resolver tests prove legacy omission inherits; explicit override wins over Persona, app, and environment defaults; clearing restores inheritance; invalid pairs are refused; and separate nodes using one Persona stay independent.
2. Store and HTTP tests prove save/reload, duplicate, publish, export, and settings backup/restore preserve the field. Changing an override creates a distinct publication; old versions and Persona rows remain unchanged.
3. Stage tests prove graph-to-pipeline round trips, reordering, and unrelated edits preserve node IDs and overrides. Changing the selected Persona intentionally clears the override.
4. Engine tests use fake runners to prove the launched provider/model matches the attempt record and accounting, including retries and restart recovery. Non-workflow Persona execution keeps its existing defaults.
5. A Playwright spec duplicates No-Mistakes Review, configures individual reviewers through the editor, switches views, saves/reloads, publishes, and verifies displayed choices. A small runnable fixture with fake agents proves the chosen model reaches execution and run detail. Cover clearing, Persona replacement, and read-only published/built-in views. Use accessible selectors and the required modal-inset helper for any new modal.
6. Update `docs/workflows.md`, `docs/workflow-system.md`, and `docs/models.md` to explain defaults, override precedence, and publishing. Update relevant source tour copy if it describes the model as inseparable from the Persona; regenerate derived files rather than editing them.

Implementation must pass relevant focused tests, typecheck, lint, build, smoke, and the required E2E suite under repository instructions. The plan-only change is validated for source/render agreement, links, offline rendering, and scoped Git diff; application behavior is not claimed to be implemented or tested here.

## Adopted human decisions

- Override scope: **Provider and model**. Cross-provider overrides are included, with an explicit pair on each node.
- Plan review: **Approve this plan**. The operator accepted the behavior and compatibility boundaries above.
- Implementation follow-up: **Create phased implementation plan**. Write merge-aware phase artifacts and schedule dependent implementation tasks.

These are the complete submitted selections from the dashboard review. Implementation tasks wait for this planning PR to merge before starting. This task's authorization permits committing, pushing, and opening the planning PR; merge remains a human action unless separately authorized.
