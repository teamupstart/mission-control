# Phase 1 - A provider per background job

## Outcome

Each of Mission Control's five background jobs chooses its own provider, so the Goal job can run
on Claude while Workflow context runs on Codex. Changing the app-wide Provider radio stops wiping
the model boxes.

This phase also introduces the **settings matrix** - the provider/model table both later phases
render into - and fixes the one provenance bug that lives in a background job.

It is first because it is the gap the operator actually hit: the five background jobs are the only
model slots in the product with no provider of their own.

## Entry criteria and dependencies

- **Direct phase dependencies:** none.
- **Session dependency:** the planning session's pull request must merge so this file resolves on
  the default branch.

## Scope

In scope:

1. A `runners` override map for background jobs, and per-job runner resolution end to end.
2. The Background jobs group rebuilt as a provider/model matrix, and the shared matrix + row
   components that Phases 2 and 3 reuse.
3. The clearing rule: pinning a model pins its provider.
4. The workflow-context compaction provenance fix.

Explicit non-goals:

- **Foreman and the Inspector.** They already have their own provider; giving their roles
  individual ones, and moving their controls onto this page, is Phase 2.
- **Task kinds.** Phase 3.
- **Per-slot transport.** `print`/`sdk` and `exec`/`sdk` stay process-global
  (`src/server/llm/claude.ts:82-107`). A per-slot provider composes with that; a per-slot
  transport would not, and nobody has asked for one.
- **Personas and Ensemble judges.** Already per call. Do not re-plumb them.

## Repository findings

Verified against the current tree; correct anything that has moved rather than forcing it.

- **The chokepoint is two functions.** `runJob` and `runJobStructured`
  (`src/server/llm/jobs.ts:54-90`) are the only two of the daemon's twelve app-owned model call
  sites that read the app-wide runner. Both do
  `llmRunner(llmRunnerChoice(cfg).id).run(prompt, { model: llmJobModel(job, cfg).id, … })`. Their
  own doc comment says "Model and runner are the config's, not the caller's" - that comment is what
  this phase makes more precise, not less true.
- **There is no runner singleton.** `llmRunner(id)` (`src/server/llm/index.ts:34`) is a total
  lookup over `Record<LlmRunnerId, LlmRunner>`; `resolveLlmRunner` (`src/shared/llm.ts:158`) is a
  pure ladder returning `{ id, source, unknown }`.
- **The model ladder already accepts a runner.** `resolveLlmJobModel(job, models, env, runner)`
  (`src/shared/llm-jobs.ts:138`) uses it to pick the provider-appropriate fallback via
  `providerModelDefault(runner, "cheap")`. Only the runner *supply* is app-wide.
- **The shape to copy is shipped.** `resolvePersonaExecution`
  (`src/server/workflows/personas.ts`) is `persona.runner === null ? appRunner :
  resolveLlmRunner(persona.runner, undefined)`, then re-bases the model fallback onto the resolved
  runner. Mirror it; do not invent a second ladder.
- **Storage is a flat map.** `LlmConfig.models` is
  `z.record(z.string(), ModelOverrideSchema).catch({}).default({})`
  (`src/shared/protocol.ts:2689`). `setLlmConfig` merges `models` **per key**
  (`src/server/llm/config.ts:55-64`) precisely so two open dashboards do not clear each other's
  edits - the new map needs the same treatment.
- **`LlmConfigPatchSchema` is strict on write** (`src/shared/protocol.ts:2701-2716`) and refines
  `models` keys against `LLM_JOB_IDS`, while the read schema is tolerant via `.catch()`. Keep that
  asymmetry: tolerant read, strict write.
- **Foreman reads `/api/llm/status` over HTTP** (`src/server/foreman/client.ts:944-968`) and takes
  exactly `runner.id`, `claudeTransport`, `codexTransport`. It never reads `models`. Widening
  `LlmStatus` must not break that parse.
- **The clearing behaviour is one line.** `LlmSettingsPanel.tsx:100` writes
  `models: Object.fromEntries(LLM_JOB_IDS.map((job) => [job, ""]))` on every provider change.
- **There is no settings table component.** `<table>` appears in `src/web/components/` only in
  `DiffViewer.tsx:295`. The matrix is new markup, which is why this phase owns it.
- **`ModelField`** (`src/web/components/ModelField.tsx`) is the existing per-model control, already
  taking a `runner` prop to choose the catalog and already shared by the Models and Foreman panels.
  The provider control belongs beside it, not inside it.

## Implementation steps

1. **`src/shared/protocol.ts`** - add `runners: z.record(z.string(), RunnerOverrideSchema).catch({}).default({})`
   to `LlmConfigSchema` beside `models`, where `RunnerOverrideSchema` is
   `z.union([z.enum(LLM_RUNNER_IDS), z.literal("")])` - empty meaning inherit, mirroring
   `ModelOverrideSchema`. Add the strict, `LLM_JOB_IDS`-refined counterpart to
   `LlmConfigPatchSchema`.
2. **`src/server/llm/config.ts`** - merge `runners` per key in `setLlmConfig`, exactly as `models`
   is merged. Add `llmJobRunner(job, cfg): ResolvedLlmRunner` applying the persona rule: the job's
   own override, else `llmRunnerChoice(cfg)`. Report an unreadable stored id through `unknown`
   rather than swallowing it.
3. **`src/shared/llm-jobs.ts`** - extend `resolveLlmJobModels` (and any status projection) so each
   job's model resolves against *its* runner.
4. **`src/server/llm/jobs.ts`** - in both `runJob` and `runJobStructured`, resolve the job's runner
   once and pass its id into both `llmRunner(...)` and `llmJobModel(job, cfg, runnerId)`. This is
   the whole of the behavioural change; everything downstream already takes an id.
5. **`LlmStatus`** - carry each job's resolved runner beside its resolved model, and its source, so
   the panel can print which layer won. Keep `runner` (the app-wide one) as-is so Foreman's
   existing read is untouched.
6. **Shared UI: the settings matrix.** Add a small presentational component - suggested
   `src/web/components/SettingsMatrix.tsx` - rendering a labelled table from column definitions and
   rows, with an optional muted, non-editable "inherited" first row. Add a `ModelSlotRow` (or
   equivalent) pairing a provider `<select>` with the existing `ModelField`. Phases 2 and 3 render
   into these; they are the reason this phase owns them.
   - Wide content scrolls inside its own container - the settings page must not scroll sideways.
   - Select by role/label; **no `data-testid`.**
7. **`src/web/components/LlmSettingsPanel.tsx`** - render Background jobs through the matrix, with a
   Provider column. Remove the clear-on-provider-change write from the radio handler and implement
   the new rule instead: **pinning a model pins its provider**, so a slot with a model set records
   the provider that model belongs to and only Inherit slots re-resolve. Say the rule in the group's
   hint copy - it replaces a behaviour operators may have learned.
8. **`src/server/workflows/context.ts:302-304`** - label the persisted `compaction` metadata with
   the runner and model the call actually used rather than a separately-resolved pair. Do the same
   for the `llm_calls` row built at `src/server/workflows/manager.ts:5705-5706`.
9. **`src/web/lib/settings-search.ts`** - the Background jobs entry (`:441`) should reach the
   provider controls; add per-job anchors if the existing single `models/provider` anchor no longer
   describes the group.
10. **`docs/models.md`** - the provider is no longer app-wide-only. Document the per-job override,
    the inherit rule, and that changing the app-wide provider no longer clears anything.

## Data and compatibility

- **No migration.** `runners` is an additive sibling key on a schema-validated `app_config` blob
  with a `.default({})`, so an installation that never saved it reads exactly as before, and an
  older build ignores it.
- **Upgrade is a no-op.** Every job ships with no runner override, so all five resolve through
  `llmRunnerChoice` exactly as today.
- **Downgrade is safe.** A build without this change ignores `runners` and resolves every job
  app-wide - degraded, not broken.
- **`LlmStatus` is widened, not reshaped.** Foreman parses three fields from it; adding per-job
  runners must leave those three where they are.

## Tests and verification

- `test/` - the per-job ladder (override, then app-wide, then shipped default); an unset job
  resolving identically to today; an unreadable stored runner id reported as `unknown` rather than
  silently defaulting; `setLlmConfig` merging `runners` per key; a model pinned to one provider
  surviving an app-wide provider change.
- `test/` - the workflow-context fix: the recorded runner equals the runner the call used.
- `e2e/` - **required, this is a UI change.** Set one background job to a non-default provider,
  assert the other four did not move, and assert that flipping the app-wide radio no longer clears
  a pinned model. Select by role/label. The fake agents in `e2e/fixtures/fake-agents.ts` must stay
  faked; spend no model tokens.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build && npm run test:e2e`.

## Merge and exit criteria

- A background job can be set to a provider different from the app-wide one and runs on it.
- Changing the app-wide provider clears nothing and only re-resolves Inherit slots.
- Foreman's `/api/llm/status` read still parses.
- Docs updated; all gates green; a Playwright spec covers the new behaviour.

## Downstream handoff

Phases 2 and 3 may rely on, and must not change without reconciling here:

- **`SettingsMatrix` / `ModelSlotRow`** - the table and provider+model row. Phase 2 renders Foreman
  and Inspector groups into them; Phase 3 renders the task-kind matrix into `SettingsMatrix` with
  four columns. Extend by adding column definitions, never by forking the component.
- **The inherit rule** - `null`/empty means inherit; a set value replaces and re-bases the model
  fallback onto the chosen provider. Phase 2 applies the identical rule per Foreman role.
- **The pinning invariant** - pinning a model pins its provider. Phase 2 must not reintroduce a
  clear-on-change anywhere.
- **The sibling-map storage pattern** - an additive `runners`-style record beside the existing
  model keys, merged per key. Phase 2 applies the same shape to `ForemanConfigSchema`.
- **`llmJobRunner`** and the widened `LlmStatus` shape.

## Cross-phase audit record

- Written first; no earlier phases to reconcile.
- Reviewed against Phase 2: Phase 2 owns every Foreman and Inspector change, including the
  Inspector's `?? "claude"` fallback. This phase deliberately leaves both alone so the two can be
  reviewed apart.
- Reviewed against Phase 3: both this phase and Phase 3 edit `LlmSettingsPanel.tsx`,
  `settings-search.ts` and `docs/models.md`. Ownership is split by section - this phase owns the
  Background jobs group; Phase 3 owns the Task kinds group and the Models **category blurb** in
  `settings-registry.ts`, which this phase does not touch.
