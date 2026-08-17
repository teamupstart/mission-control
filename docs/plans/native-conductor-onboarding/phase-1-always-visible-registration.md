# Phase 1: Always-visible Conductor registration

## Outcome

Conductor is always available in Settings, deep links, keyboard navigation, search, and the command
palette. With `conduct-ts` already installed, an operator can select any repository from Mission
Control's existing workspace catalog and choose **Register and observe**. Mission Control invokes
Conductor's sanctioned registry command, verifies the exact canonical repository, then enables its
own observation consent. The selected repository becomes eligible for Runs -> Pipelines and
Dispatch -> Pipeline without a page reload.

If registration succeeds and observation consent fails, the page shows the real partial state and
offers **Enable observation**. It never repeats or rolls back the provider mutation implicitly.

## Entry criteria and dependencies

- Direct dependency: the native Conductor onboarding planning artifacts are merged to the default
  branch.
- Source requirements:
  `docs/plans/native-conductor-onboarding/plan.md` and
  `docs/plans/native-conductor-onboarding/phased-plan.md`.
- ai-conductor continues to expose `conduct-ts register <path>` with the documented exact success
  sentence. If that upstream grammar has changed, adapt the provider implementation and record the
  deviation rather than weakening output validation.

## Scope

- Make the Conductor category unconditional everywhere Settings is indexed or routed.
- Keep `SettingsStatus.pipelines.present` wire-compatible but remove it as a category gate.
- Remove the watcher's row-visibility presence cadence if it has no remaining consumer.
- Extend the provider axis with repository registration.
- Add a typed provider-neutral registration route.
- Merge workspace repositories with provider projects and configured rows in the panel.
- Add the compact Engine -> Register repo -> Observe commissioning line and installed/missing states.
- Implement Register and observe as two ordered operations with visible partial success.
- Refresh the active-repository view so an already-open Dispatch modal can expose Pipeline.
- Update documentation and all affected unit, route, render, and browser tests.

## Non-goals

- Launching or managing the Conductor installer. Phase 2 owns that.
- Downloading, cloning, upgrading, uninstalling, or deregistering Conductor.
- Starting a pipeline during setup.
- Replacing the existing observation master switch, repository switches, health lines, or Foreman
  controls.
- Showing Pipeline for an unobserved or different repository.
- Adding provider-specific command composition to a route or React component.

## Repository findings and inherited contracts

### Settings discovery

`SettingsAvailability` has one field and one exceptional category. It is threaded through:

- `src/web/lib/settings-registry.ts`
- `src/web/components/SettingsPage.tsx`
- `src/web/App.tsx`
- `src/web/lib/palette-index.ts`
- `test/settings-sidebar-render.test.ts`
- `test/palette-index.test.ts`
- `test/palette-render.test.ts`
- `e2e/specs/settings-conductor.spec.ts`

Delete or collapse this one-purpose availability axis rather than hard-code an always-true
Conductor special case at every consumer. The rail and arrow-key walk should use
`SETTINGS_CATEGORIES` and `settingsCategoriesIn(group)` directly. A valid Conductor hash always
renders the panel; only an unknown category falls back to Display.

`SettingsStatus.pipelines.present` is explicitly append-only in `src/shared/types.ts`. Keep the
member and the registry equality comparison. It may continue to describe engine/config presence for
compatibility, but no navigation surface consumes it. The slow watcher sub-cadence and
`onPresenceChanged` callback exist for dynamic row visibility and can be removed once no test or
surface depends on them. Keep `pipelinesObserving()` and every `pipelines.observing` consumer.

### Provider mutation

`src/server/pipelines/types.ts` already says provider-owned files have one writer and requires
provider controls to validate stdout, not exit code alone. Extend `PipelineProvider` with a method
shaped like:

```ts
registerRepo(repoRoot: string): Promise<PipelineRepoRegistrationResult>;
```

Define a browser-safe result in `src/shared/pipeline.ts`. It should distinguish confirmed success
from refusal with bounded, display-safe text and never require a route to interpret provider output.
The Conductor implementation belongs under `src/server/pipelines/conductor/`, preferably in a
focused `register.ts` module tested through injected execution. It must:

1. resolve the configured binary before spawning;
2. run exact argv equivalent to `conduct-ts register <canonical-root>` without a shell;
3. set a bounded timeout and output cap through the existing exec seam;
4. require a successful exit and parse `Registered <name> (<canonical-root>).` for the exact target;
5. return a sentence for missing binary, invalid output, timeout, or nonzero exit; and
6. never throw or write `~/.ai-conductor/registry.json` directly.

Add a provider-neutral orchestration function in `src/server/pipelines/index.ts` so routes look up
the registry and do not branch on `"ai-conductor"`.

### Request and consent ordering

Add a Zod body beside existing pipeline schemas in `src/shared/protocol.ts`, containing only
`provider` and `repoRoot`. Add `POST /api/pipelines/register` beside the config route. The route:

1. parses the body through `parseBody`;
2. canonicalizes through `resolveRepoRoot()`;
3. invokes the provider-neutral registration function;
4. force-probes the provider after confirmed success; and
5. returns the typed registration result plus the fresh provider probe or refreshed pipeline view.

The route does **not** write observation consent. `useConductor` owns the combined user action and
keeps the two mutations ordered:

1. queue and call registration;
2. on confirmed success, force-refresh the view;
3. compose the latest whole config with master enabled and the canonical provider/repo row enabled;
4. send it through the existing serialized `save()` path; and
5. retain a registered/not-observed action state when `save()` returns false.

This separation reuses the current single config writer and naturally preserves partial success. A
reload derives that state again by finding the project in the provider probe but not in
`activePipelineRepos(config)`.

### Repository candidates and Dispatch

Fetch `/api/repos` only while the Conductor panel is active. Merge candidates by
`pipelineRepoKey(provider, canonicalRoot)` in this order:

1. workspace catalog paths as unregistered and unobserved;
2. provider probe projects as registered;
3. stored config rows as the authoritative observation choice.

Configured rows remain visible even if they leave both the workspace catalog and provider registry,
so the operator can withdraw consent. Do not add a second repository scanner.

Dispatch already filters `kindOptions` by the active pipeline repo set for the selected exact root.
Preserve that predicate. After a successful consent write, invalidate or refetch the active pipeline
repo request used by an open Dispatch modal; do not optimistically offer Pipeline before the daemon
confirms the config.

## Implementation steps

1. **Unconditional Settings registry**
   - Simplify `src/web/lib/settings-registry.ts` so category lists are unconditional.
   - Remove availability plumbing from `SettingsPage`, `App`, palette stores/providers, and tests.
   - Update comments that promise absence when no engine is installed.
   - Keep the panel hook gated only on whether Conductor is the shown category, to avoid background
     probes on unrelated Settings pages.

2. **Presence cleanup with wire compatibility**
   - Retain `SettingsStatus.pipelines.present`, settings-status construction, and tuple equality.
   - Remove watcher-only row-visibility polling and callback plumbing if nothing else consumes it.
   - Update focused watcher/status tests to pin the remaining semantics and ensure
     `pipelines.observing` still publishes immediately after consent changes.

3. **Shared registration contract**
   - Add the registration result and request schema in shared modules without `node:` imports.
   - Extend every `PipelineProvider` implementation through the exhaustive provider record.
   - Implement ai-conductor registration and output confirmation in a focused server module.
   - Add the provider-neutral route/orchestrator with canonical root validation and a forced probe.

4. **Conductor hook orchestration**
   - Extend `ConductorState` with workspace candidates, registration action, in-flight state, and a
     specific setup error/partial state.
   - Serialize registration against config writes. Prevent a four-second poll from overwriting a
     just-confirmed project or optimistic observation update.
   - Refetch active pipeline repositories after successful observation so Dispatch changes without a
     reload.

5. **Native panel states**
   - Add the persistent compact commissioning line using existing settings tokens and Console cards.
   - Show missing engine as setup-needed with copyable instructions and Check again. Phase 1 does not
     offer Open installer.
   - Add a searchable workspace repository picker and per-row registered, observed, and dispatch-ready
     readings.
   - Make Register and observe primary for an unregistered repo, Enable observation primary for a
     registered/unobserved repo, and retain switches for later reversible changes.
   - Ensure text, icons, and accessible names communicate state without color alone.

6. **Documentation and tests**
   - Rewrite the discovery and consent sections in `docs/pipelines.md` and remove the
     absent-by-default guarantee.
   - Update stale phase/visualizer wording encountered in that document.
   - Update every focused unit, static-render, route, fake-provider, and Playwright contract below.

## API and compatibility details

- Existing `GET /api/pipelines/config`, `PUT /api/pipelines/config`, and
  `GET /api/pipelines/repos` remain compatible.
- `POST /api/pipelines/register` is additive and localhost-only like neighboring routes.
- Shared tuple and persisted provider ids are not renamed or reordered.
- No database migration is needed. Observation still lives in the schema-validated `pipelines`
  app-config blob.
- Registration idempotence is provider-defined. A repeated confirmed registration is still success
  if stdout confirms the same canonical path.
- A response that exits zero but does not confirm the path is a refusal. The UI may force-probe and
  discover that state moved, but it must not call the action confirmed.

## Tests and verification

### Focused unit and route tests

- `test/settings-sidebar-render.test.ts`: Conductor is always in the rail and its deep link always
  renders, including no-engine/null-status cases.
- `test/palette-index.test.ts` and `test/palette-render.test.ts`: panel/control hits are unconditional
  and palette stores no longer need availability.
- `test/settings-status.test.ts` and watcher tests: append-only tuple remains valid, observation count
  still moves, and dead presence cadence assertions are removed.
- New or focused provider registration tests: exact argv/cwd, binary missing, invalid repo before
  spawn, nonzero exit, deceptive zero-exit output, mismatched path, bounded output, timeout,
  idempotence, and no throw.
- `test/pipeline-http.test.ts`: schema refusal, main-root canonicalization, provider routing,
  force-probe, confirmed result, and refusal mapping.
- Conductor render/hook tests: candidate union, configured-row retention, action ordering, stale poll
  rejection, successful consent, and registered/not-observed recovery.
- Dispatch tests: exact observed repo gains Pipeline; unobserved and other repos do not.

### Browser test

Rewrite and extend `e2e/specs/settings-conductor.spec.ts` and `e2e/fixtures/conductor.ts`:

1. With the fake binary missing, Conductor is visible in the rail and palette, its hash opens the
   setup state, and unrelated Settings categories do not start the probe.
2. With the fake installed, an unregistered workspace repo appears and Register and observe invokes
   exact fake argv, updates the fake project registry, enables consent, and changes Dispatch for that
   repo only.
3. A fake registration confirmation failure never enables consent.
4. A forced config failure after registration shows the partial state and Enable observation
   recovers it without a second registration.
5. The commissioning line and repository rows work at the narrow Settings breakpoint with logical
   keyboard order and no clipping.

The fake CLI must implement `register` entirely inside the disposable E2E home and log argv. It must
never run an actual engine, installer, or model.

### Commands

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/settings-sidebar-render.test.ts \
  test/palette-index.test.ts \
  test/palette-render.test.ts \
  test/settings-status.test.ts \
  test/pipeline-http.test.ts
npm run typecheck
npm run lint
npm run build
npx playwright test e2e/specs/settings-conductor.spec.ts
```

Run additional focused provider/hook test files under their implemented names. Capture browser
screenshots for missing-engine, ready-to-register, partial-success, and dispatch-ready states in a
gitignored evidence directory.

## Merge and exit criteria

- The pull request contains the whole installed-engine vertical slice and no installer launch.
- Conductor cannot disappear from Settings because of engine/config state.
- Registration uses the provider CLI, validates the exact canonical root, and never writes provider
  files directly.
- Observation is attempted only after confirmed registration, partial success is visible, and the
  exact repository becomes Pipeline-eligible only after the config write succeeds.
- Existing observation controls, watcher projection, Runs tab, and Foreman behavior still pass.
- Focused tests, typecheck, lint, build, and the Conductor Playwright spec are green.
- Documentation matches the new always-visible behavior.

## Downstream handoff

Phase 2 may rely on:

- an always-mounted Conductor category and the commissioning-line state model;
- a provider-neutral setup seam with `registerRepo` and typed results;
- `useConductor` owning serialized setup action state;
- the workspace/provider/config repository union;
- an E2E fake that records setup argv; and
- exact-repository observation remaining the only Dispatch gate.

Phase 2 must not replace registration, merge provider state with observation consent, restore
conditional category visibility, or let installer state bypass the active-repository Dispatch gate.

## Cross-phase audit record

- **2026-08-17 initial audit:** Registration was assigned to this phase because it forms one vertical
  slice with visibility, repository selection, consent, and Dispatch. The installer was left to
  Phase 2 because it crosses a different trust and mutation boundary.
- **Compatibility check:** Keeping `SettingsStatus.pipelines.present` avoids reshaping the append-only
  tuple. Removing only its navigation consumer and obsolete watcher cadence leaves later Phase 2 free
  to add optional setup data without a wire break.
- **Phase 2 reconciliation:** Phase 2 adds an optional provider `installer` capability beside this
  phase's required `registerRepo` method. It consumes the same setup state but does not change the
  registration result, config writer, or active-repository Dispatch contract established here.
