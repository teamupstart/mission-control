# Phase 2: Browser catalog cutover

Part of [phased-plan.md](phased-plan.md); source plan [plan.md](plan.md). Read both,
[Phase 1](phase-1-harness-model-catalog-service.md), and the
[planned request sequence](../../../.docs/architecture/sequences/pi-model-catalog.md) before
starting. This file is the proposed route, not a specification: follow it where the repository
agrees, use your own judgement where it does not or where a better implementation presents itself,
and record any deviation and its reasoning in the pull request.

## 1. Outcome and value

Every dispatch-time model picker reads one browser catalog provider backed by Phase 1's daemon API.
Pi now mirrors every model its configured installation reports and groups the complete list by
provider. Loading, an unsupported Pi version, a failed child, or an empty account catalog leaves the
picker usable, explains the fallback, and preserves the operator's selected model. Claude and Codex
keep the same shipped rows. A zero-token Playwright flow proves the visible option reaches the exact
existing persisted `provider/id` and survives a later discovery failure.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 1 merged.
- The default branch must expose `GET /api/harnesses/models`, including `?refresh=1`, with the
  exhaustive response and cache semantics recorded in Phase 1's handoff.
- Re-read Phase 1's final pull request for measured bounds, renamed fields, or documented route
  deviations before binding browser state to them.

## 3. Scope and non-goals

In scope:

- one root browser catalog provider and API client;
- one current-value-preserving model resolver and provider-grouped option renderer;
- atomic cutover of every `modelChoicesFor` UI call site;
- loading, cached-failure, fallback, and retry presentation for Pi;
- an RPC-only fake Pi binary and focused Playwright coverage;
- render/helper tests and behavior documentation.

Non-goals:

- no server protocol, cache-policy, or process-bound redesign unless Phase 1's implemented contract
  is proven insufficient and both audit records are updated;
- no Pi session-launch fake and no terminal or SDK Pi dispatch in e2e;
- no dynamic Claude or Codex discovery;
- no reasoning-effort options derived from per-model metadata;
- no changes to config, task, schedule, or ensemble persistence schemas;
- no browser timer, SSE model event, or per-picker fetch.

## 4. Repository findings and inherited contracts

Inherited from Phase 1 and not to be changed casually: C1 through C6 in `phased-plan.md`, especially
the aggregate route, source/problem semantics, stable provider-qualified ids, forced-refresh query,
and stale-success-before-shipped-fallback precedence.

Additional findings:

- `main.tsx` already owns application-wide presentation providers and is the narrowest mount for a
  catalog context that Settings, Dispatch, schedules, ensembles, and workflow-backed panels all
  need. `App` should consume the store, not own a second fetch.
- Static render tests call `HarnessesPanel`, `ScheduleEditor`, `EnsembleDispatch`, and `ModelField`
  directly. A context whose default is the shipped catalog lets those tests remain synchronous and
  truthful without wrapping every historical render. New provider-state tests cover live and
  fallback states explicitly.
- `DispatchModal` has two pure label helpers, `defaultModelOptionLabel` and
  `harnessDefaultsLine`, plus the visible select. All three must receive the same resolved catalog
  or the guided choice can describe a different default from the select.
- `EnsembleDispatch` has both member-row selects and `PlanStrip` label lookup. The resolver must be
  threaded to the nested summary rather than calling the old helper there.
- `ModelField` serves two axes. Claude/Codex app-runner fields and Persona fields stay on static
  results, while Foreman's backlog-task rows include Pi and need live results. The shared provider
  can serve both without teaching the component which subsystem called it.
- `useHarnesses` intentionally polls only the editable config. Do not fold model discovery into that
  hook: it is Settings-scoped, while Dispatch and Ensembles exist outside Settings, and its 4-second
  timer would turn an account catalog into forbidden browser polling.
- The current e2e fake Pi fails every call. It should continue failing every non-RPC catalog call so
  a future accidental real Pi launch cannot look successful or spend tokens.

## 5. Implementation steps

1. **Add the API client and catalog state model.** Add a typed `fetchHarnessModelCatalogs` in
   `src/web/lib/api.ts` that validates or narrows Phase 1's response consistently with neighboring
   clients. Create a focused browser module, for example `src/web/model-catalog.tsx`, with state for
   the current exhaustive catalogs, initial loading, the latest request generation, and retry.
   Mount its provider once above `App` in `main.tsx`.
2. **Keep initial rendering synchronous and useful.** Initialize every agent from
   `MODEL_CATALOG`, marked as local/loading browser state. Fire one ordinary API request when the
   root provider mounts. Until it resolves, writable model fields remain enabled with shipped
   choices. On success replace all three catalogs atomically. On transport or response failure keep
   shipped data and expose one bounded browser problem state. Do not add a timer. Abort or sequence
   requests so an older initial read cannot overwrite a later retry.
3. **Expose one resolver.** The context should return stable operations rather than raw mutable
   arrays at each component. The resolver takes `AgentType` and the current value and returns:
   - the resolved catalog choices in server order;
   - the current value appended exactly once when absent, with a label from `modelLabel` and a hint
     that says it is not currently reported rather than claiming it is invalid;
   - grouping metadata that uses the validated provider field for Pi and leaves Claude/Codex
     ungrouped;
   - catalog quality needed for the note.
   Keep the pure fallback merge testable outside React and preserve referential stability where it
   prevents unnecessary modal and grid renders.
4. **Centralize grouped option markup.** Add a small reusable component or renderer for option rows.
   Pi renders one native `<optgroup>` per provider, in first-seen provider order, with every
   validated model in Pi order. Do not add a recommended-only group, hide unknown providers, or
   duplicate a row across groups. Claude and Codex retain their current flat order and label-hint
   text. The surrounding select continues to own its existing empty default option.
5. **Cut every consumer over in one change.** Remove direct UI use of `modelChoicesFor` from:
   - `HarnessesPanel`, including all three saved default values;
   - `DispatchModal`, including the select, default-option label, and guided Harness defaults line;
   - `ScheduleEditor`;
   - `EnsembleDispatch`, including member rows and `PlanStrip` summaries;
   - `ModelField`, including Foreman's Pi backlog-default row while leaving runner-only use behavior
     unchanged.
   Pass the resolver into nested pure helpers instead of calling hooks conditionally or outside
   components. An end-of-phase source assertion should leave `modelChoicesFor` reachable in web
   code only inside the catalog provider's pure fallback boundary, if it remains there at all.
6. **Render catalog quality without blocking work.** Add a compact, accessible Pi catalog note next
   to the affected control or its shared section:
   - initial state says the app is checking Pi while still showing built-in choices;
   - live success is silent or says when it refreshed without visual noise;
   - a stale successful cache says the last known Pi list is shown and gives the bounded problem
     category;
   - shipped fallback says built-in choices are shown because Pi could not be read;
   - Retry calls the same provider with `?refresh=1`, disables only itself while pending, and never
     disables selection or dispatch.
   Keep raw stderr and technical process details out of UI copy. Reuse one component so all surfaces
   state the same condition.
7. **Build an RPC-only e2e Pi fake.** Replace the generated shell stub with a copied extension-less
   `e2e/fixtures/fake-pi.mjs`, following the Claude/Codex executable pattern. It must:
   - record argv and cwd under `MC_E2E_RECORD_DIR`;
   - accept only the exact no-session model RPC mode Phase 1 launches;
   - read one command line, preserve its id, and return a success response containing multiple
     providers and at least one model absent from the shipped fallback;
   - read a fixture control file on every invocation so a spec can switch from success to failure
     without touching production state;
   - exit non-zero with a loud diagnostic for any prompt, session launch, or unsupported command.
   Expose a typed helper in `fake-agents.ts` for the control-file path and modes rather than making a
   spec know the filename.
8. **Add the browser regression spec.** Create `e2e/specs/pi-model-catalog.spec.ts`. Against the real
   built daemon and fake Pi:
   - open Harnesses Settings and wait for a fake-only provider/model;
   - assert its native provider group and exact value;
   - select it as Pi's dispatched default and verify `GET /api/harnesses/config` stores the exact
     provider-qualified id;
   - open the ordinary Dispatch modal, choose Pi, and prove the same catalog and default label are
     visible there;
   - switch the fake to failure, restart the isolated daemon to clear the in-memory successful
     cache, reload, and prove the fallback note appears while the saved fake-only value remains
     selected and available;
   - exercise Retry and prove selection stays enabled even when the retry fails;
   - assert the recorded invocation contains only the expected catalog probe and no prompt.
   Capture an optional screenshot only under the repository's existing evidence flag and keep it in
   the gitignored e2e artifacts directory.
9. **Update behavior documentation.** In `docs/harnesses-and-terminals.md`, explain that Pi model
   choices come from the configured local Pi account catalog, are grouped by provider, and fall back
   without changing a saved selection. Update any dispatch documentation that still calls
   `MODEL_CATALOG` the sole picker authority. Document when a probe occurs, what Retry does, and that
   no prompt or model API call is made.

## 6. Data, API, and compatibility

- Consume Phase 1's read API only. No new write route, persistent schema, migration, or SSE event.
- Existing `HarnessesConfig`, task, schedule, and ensemble payloads continue carrying one string or
  null. The browser submits exactly the selected `provider/id`; no provider is stored separately.
- A current value absent from the live list is retained in every component and remains submit-safe
  under the existing `ModelIdSchema`. Discovery absence is not revocation.
- Claude and Codex option order, labels, hints, and persisted values remain unchanged.
- A browser talking to a daemon without the new route keeps the shipped initial catalog and shows
  fallback quality. This supports a stale tab during a local daemon upgrade.

## 7. Tests and verification

Add or extend focused Node render/helper tests for:

- initial shipped choices while loading, live replacement, transport fallback, stale-cache copy,
  retry sequencing, and an earlier request resolving after a later one;
- provider grouping with complete row counts and first-seen ordering;
- current-value retention when absent, without duplication when present;
- `HarnessesPanel`, `DispatchModal` helper labels, `ScheduleEditor`, `EnsembleDispatch` member and
  summary labels, and `ModelField` using the same resolved Pi choices;
- Claude/Codex flat markup and static labels remaining unchanged;
- accessible loading/fallback/retry copy and writable selects in every quality state;
- a source-level inventory proving no UI consumer still imports the old helper directly.

Run the focused tests using the required setup-state imports, then:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/pi-model-catalog.spec.ts
npm run test:e2e
```

The build must precede both Playwright commands. No test may call a real Pi, Claude, Codex, or model
provider. Visually inspect the provider groups, long-list usability, loading note, and fallback note
in the built dashboard; diff inspection alone is insufficient for this UI change.

## 8. Merge and exit criteria

- Every validated Pi row from the fake aggregate response appears exactly once under its provider.
- Every dispatch-time model surface uses the same root provider and retains its current value.
- Loading, stale cache, fallback, and failed retry never disable a writable picker or dispatch.
- Exact `provider/id` persistence is proven through the real daemon route, and the saved value
  survives daemon restart plus discovery failure.
- The e2e fake records only a no-session catalog probe and refuses every model-launch shape.
- Focused tests, typecheck, lint, full unit suite, build, smoke, focused Playwright, and full e2e pass.
- Documentation and optional visual evidence match the implemented behavior.

## 9. Downstream handoff

This is the final scheduled phase. Later dynamic discovery for Claude or Codex may rely on:

- the exhaustive daemon contract and one root browser provider;
- current-value retention being independent of catalog source;
- grouping metadata and option rendering accepting more than Pi;
- quality and retry UI being source-neutral;
- no direct model-catalog fetches in individual controls.

It may not silently change the meaning of a returned Pi row, treat discovery absence as revocation,
or bypass the harness registry with a provider-specific route. Per-model effort remains a separate
future product decision.

## 10. Cross-phase audit record

- 2026-08-18: initial draft reconciled against Phase 1. Required the aggregate response, provider
  metadata, deterministic order, quality/problem state, and `?refresh=1`; Phase 1's implementation
  steps and handoff record all five.
- 2026-08-18: added `ModelField` after tracing Foreman's backlog-task defaults. This keeps the final
  source-of-truth claim honest without changing Claude/Codex LLM runner behavior.
- 2026-08-18: kept all browser consumers together. Splitting Harnesses from Dispatch, schedules,
  ensembles, or Foreman would expose different Pi catalogs for the same persisted model id.
- 2026-08-18: chose daemon restart in the e2e failure arm. Without it, Phase 1 correctly returns the
  last successful cache, which cannot prove the shipped-fallback plus saved-value path.
