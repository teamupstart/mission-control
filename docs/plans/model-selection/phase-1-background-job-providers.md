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
  (`src/server/llm/jobs.ts:54-90`) are the only two of the daemon's twelve app-owned runner
  lookups that read the app-wide runner. Both do
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
  `models: Object.fromEntries(LLM_JOB_IDS.map((job) => [job, ""]))` on every provider change. It is
  the only thing standing between the config and a `runners.goal = "codex"` /
  `models.goal = "claude-haiku-4-5"` pair, so whatever replaces it has to answer the per-slot case
  as well as the app-wide one.
- **The catalog answers "does this provider offer that model".** `modelChoicesFor(agent, extra)`
  (`src/shared/model.ts:168`) is keyed off `MODEL_CATALOG` (`:135`), and it keeps an id it does not
  recognise, marked "not in this build", rather than discarding it - the same say-what-you-dropped
  ethic as `ResolvedSessionRuntime`. `providerModelDefault(runner, "cheap")` (`:178`) is what an
  unset job already falls back to.
- **Existing installations carry unpinned models, and the old clearing rule is why they are
  safe.** Today a saved `models[job]` always belongs to the app-wide runner, *because*
  `LlmSettingsPanel.tsx:100` wipes the map whenever that runner changes. After the upgrade every
  `runners[job]` is unset, so a legacy pinned model would inherit whatever the app-wide radio is
  moved to next. The schema is additive and needs no migration; the **semantics of the existing
  `models` map do change**, and that is what needs handling.
- **Model ids are free text, so a catalog miss is not an error.** `resolveModelChoice`
  (`src/shared/model-choice.ts:44-52`) treats every layer as optional free text, and
  `modelChoicesFor` keeps an id it does not recognise rather than dropping it. Any guard here must
  therefore act only on an id **positively known to belong to another provider** - present in a
  different provider's `MODEL_CATALOG` entry and absent from the resolved one. An id in no catalog
  is a new or custom model and must pass through untouched; rejecting it would be a worse failure
  than the one being prevented.
- **Reset-on-change is already shipped, one page over.** The dispatch form resets the model and
  effort when the agent beneath them changes and says so in its hint
  (`DispatchModal.tsx:2696`). The per-slot rule below is that same rule, not a new one.
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

   **Also in `setLlmConfig`: when a patch changes `runner`, first materialise the outgoing provider
   onto every job that has a model and no runner of its own.** That is the upgrade path. A legacy
   config's models are unpinned but were only ever safe because the old clearing rule kept them in
   step with the app-wide radio; the moment that radio moves is the moment - and the only moment -
   the provenance is both needed and still knowable. Use the *resolved* outgoing provider
   (`resolveLlmRunner(before.runner, env).id`), not the raw stored field, so an installation driven
   by `MISSION_LLM_RUNNER` pins the provider its models actually belong to.

   This belongs here and not in the panel's radio handler: `PUT /api/llm/config` is a route, a
   second dashboard tab is a second writer, and a rule enforced in one click handler is a rule with
   an unguarded back door.
3. **`src/shared/llm-jobs.ts`** - extend `resolveLlmJobModels` (and any status projection) so each
   job's model resolves against *its* runner.
4. **`src/server/llm/jobs.ts`** - in both `runJob` and `runJobStructured`, resolve the job's runner
   once and pass its id into both `llmRunner(...)` and `llmJobModel(job, cfg, runnerId)`. This is
   the whole of the behavioural change; everything downstream already takes an id.
5. **`LlmStatus`** - carry each job's resolved runner beside its resolved model, and its source, so
   the panel can print which layer won. Keep `runner` (the app-wide one) as-is so Foreman's
   existing read is untouched.
6. **The resolver refuses a pair no provider can honour.** Belt and braces for the write path
   above: when a job's resolved model is positively known to belong to a different provider, fall
   back to that provider's `providerModelDefault(runner, "cheap")` and **report what was dropped**
   rather than swallowing it - the `ResolvedSessionRuntime.unsupported` shape
   (`src/shared/harness-capabilities.ts:790`), surfaced through `ResolvedLlmJobModel` so the panel
   can say it. An id in no catalog passes through untouched, per the free-text finding above.

   This closes a hole no write-path fix can reach: `MISSION_LLM_RUNNER` changing between daemon
   restarts moves the effective app-wide provider without `setLlmConfig` ever running. That hole
   exists today, identically and for the same reason, so this is a fix carried along rather than a
   regression introduced - say so in the pull request.
7. **Shared UI: the settings matrix.** Add a small presentational component - suggested
   `src/web/components/SettingsMatrix.tsx` - rendering a labelled table from column definitions and
   rows, with an optional muted, non-editable "inherited" first row. Add a `ModelSlotRow` (or
   equivalent) pairing a provider `<select>` with the existing `ModelField`. Phases 2 and 3 render
   into these; they are the reason this phase owns them.
   - Wide content scrolls inside its own container - the settings page must not scroll sideways.
   - Select by role/label; **no `data-testid`.**
8. **`src/web/components/LlmSettingsPanel.tsx`** - render Background jobs through the matrix, with a
   Provider column. Remove the clear-on-provider-change write from the radio handler and implement
   the new rule instead: **pinning a model pins its provider**. The rule has two halves, and it is
   the same principle both times - *whose* choice is this control?
   - **The app-wide radio** says nothing about any particular slot, so it disturbs none of them. A
     slot with a model set keeps it; only Inherit slots re-resolve.
   - **A slot's own Provider select** is a statement about exactly that slot, so its model follows.
     Drop the pinned model back to Inherit unless `modelChoicesFor(newProvider)` offers the same
     id, and let the slot resolve through `providerModelDefault(newProvider, "cheap")`. Say what was
     reset and why, in the row - do not drop a configured id silently.

   Without the second half, one select would store a Claude model under a Codex runner and hand
   `runJob` a pair no runner can honour. Say the whole rule in the group's hint copy; it replaces a
   behaviour operators may have learned.
9. **`src/server/workflows/context.ts:302-304`** - label the persisted `compaction` metadata with
   the runner and model the call actually used rather than a separately-resolved pair. Do the same
   for the `llm_calls` row built at `src/server/workflows/manager.ts:5705-5706`.
10. **`src/web/lib/settings-search.ts`** - the Background jobs entry (`:441`) should reach the
   provider controls; add per-job anchors if the existing single `models/provider` anchor no longer
   describes the group.
11. **`docs/models.md`** - the provider is no longer app-wide-only. Document the per-job override,
    the inherit rule, and that changing the app-wide provider no longer clears anything.

## Data and compatibility

- **No schema migration, but the existing `models` map changes meaning.** `runners` is an additive
  sibling key on a schema-validated `app_config` blob with a `.default({})`, so nothing has to be
  rewritten to open the database. What does change is what a saved `models[job]` *means*: today it
  is implicitly bound to the app-wide runner, because the clearing rule kept it that way. Afterwards
  it means whatever `runners` says. Step 2 records that provenance at the one moment it is both
  needed and knowable - the app-wide provider changing - which is why this needs no backfill pass,
  no version marker and no write on read.
- **Upgrade is a no-op.** Every job ships with no runner override, so all five resolve through
  `llmRunnerChoice` exactly as today.
- **Downgrade is safe.** A build without this change ignores `runners` and resolves every job
  app-wide - degraded, not broken, and its own clearing rule re-establishes its assumption the next
  time its radio moves.
- **A pre-existing hole is closed on the way past.** `MISSION_LLM_RUNNER` changing between daemon
  restarts moves the effective provider without any config write, so a saved model can already
  outlive the provider it belongs to on today's build. Step 6's resolver guard covers it. Call it
  out in the pull request as a fix carried along, not as a regression this phase introduced.
- **`LlmStatus` is widened, not reshaped.** Foreman parses three fields from it; adding per-job
  runners must leave those three where they are.

## Tests and verification

- `test/` - the per-job ladder (override, then app-wide, then shipped default); an unset job
  resolving identically to today; an unreadable stored runner id reported as `unknown` rather than
  silently defaulting; `setLlmConfig` merging `runners` per key; **a legacy config - non-empty
  `models`, empty `runners` - pinned to the outgoing provider when the app-wide runner is patched,
  including when the outgoing value came from `MISSION_LLM_RUNNER` rather than the stored field**; a
  job whose model belongs to another provider falling back to that provider's default *and reporting
  what it dropped*; an id in **no** catalog passing through untouched, because model ids are free
  text; a model pinned to one provider
  surviving an app-wide provider change; **that same model dropped to Inherit when the slot's own
  provider changes**, and kept when the new provider's catalog offers the same id - the two
  asserted apart, since they are opposite behaviours reached from the same panel; and no reachable
  state in which a stored runner/model pair disagrees by the time `runJob` reads it.
- `test/` - the workflow-context fix: the recorded runner equals the runner the call used.
- `e2e/` - **required, this is a UI change.** Set one background job to a non-default provider,
  assert the other four did not move, and assert that flipping the app-wide radio no longer clears
  a pinned model. Select by role/label. The fake agents in `e2e/fixtures/fake-agents.ts` must stay
  faked; spend no model tokens.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build && npm run test:e2e`.

## Merge and exit criteria

- A background job can be set to a provider different from the app-wide one and runs on it.
- Changing the app-wide provider clears nothing and only re-resolves Inherit slots.
- Changing one slot's own provider resets that slot's pinned model unless the new provider offers
  it, says so in the row, and leaves every other slot alone.
- An installation that upgrades with per-job models already saved keeps running them on the provider
  they were saved under, including after the app-wide radio is moved.
- No reachable configuration - upgraded, hand-edited, or env-driven - lets `runJob` receive a model
  its provider cannot run.
- Foreman's `/api/llm/status` read still parses.
- Docs updated; all gates green; a Playwright spec covers the new behaviour.

## Downstream handoff

Phases 2 and 3 may rely on, and must not change without reconciling here:

- **`SettingsMatrix` / `ModelSlotRow`** - the table and provider+model row. Phase 2 renders Foreman
  and Inspector groups into them; Phase 3 renders the task-kind matrix into `SettingsMatrix` with
  four columns. Extend by adding column definitions, never by forking the component.
- **The inherit rule** - `null`/empty means inherit; a set value replaces and re-bases the model
  fallback onto the chosen provider. Phase 2 applies the identical rule per Foreman role.
- **The pinning invariant, both halves** - pinning a model pins its provider, so the *app-wide*
  default never disturbs a pinned slot; and a *slot's own* provider control resets that slot's model
  unless the new provider offers it. Phase 2 applies the identical pair per Foreman role. Do not
  reintroduce the blanket clear-on-change, and do not answer the per-slot case differently.
- **The sibling-map storage pattern** - an additive `runners`-style record beside the existing
  model keys, merged per key. Phase 2 applies the same shape to `ForemanConfigSchema`.
- **`llmJobRunner`** and the widened `LlmStatus` shape.
- **Pin-on-provider-change in `setLlmConfig`** - a patch that changes a group-level provider first
  materialises the outgoing one onto everything below it that has a model and no provider of its
  own. Phase 2 inherits the identical obligation for Foreman's group-level `runner`.
- **The resolver guard** - a model positively known to belong to another provider falls back and
  reports what it dropped; an id in no catalog passes through.

## Cross-phase audit record

- Written first; no earlier phases to reconcile.
- Review round 6 found the invariant only answered the app-wide case, leaving a slot's own
  provider select free to strand a Claude model under a Codex runner. Both halves are now stated
  here, because this phase owns the invariant and Phases 2 and 3 consume it. The fix is not the
  review's alternative of blocking the provider change while a model is pinned: that makes the
  common case ("run this job on Codex instead") a two-step dance, and the product already resets
  rather than blocks in the same situation (`DispatchModal.tsx:2696`).
- Review round 7 found that the upgrade case was unhandled: existing installations carry models
  that are unpinned but were only safe because the old clearing rule kept them aligned, so removing
  that rule would let the next app-wide change strand them. Adopted the review's remedy, moved to
  `setLlmConfig` rather than the panel's click handler (the route and a second tab are also writers)
  and keyed off the *resolved* outgoing provider so an env-driven installation pins correctly. Added
  a resolver-side guard the review did not ask for, because no write-path fix can reach an env
  change between restarts - and narrowed it to ids positively known to belong to another provider,
  because model ids are free text and dropping an unrecognised one would be the worse failure.
- Reviewed against Phase 2: Phase 2 owns every Foreman and Inspector change, including the
  Inspector's `?? "claude"` fallback. This phase deliberately leaves both alone so the two can be
  reviewed apart.
- Reviewed against Phase 3: both this phase and Phase 3 edit `LlmSettingsPanel.tsx`,
  `settings-search.ts` and `docs/models.md`. Ownership is split by section - this phase owns the
  Background jobs group; Phase 3 owns the Task kinds group and the Models **category blurb** in
  `settings-registry.ts`, which this phase does not touch.
