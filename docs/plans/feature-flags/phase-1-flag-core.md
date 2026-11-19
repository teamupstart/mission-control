# Feature flags - Phase 1: flag core

Read [`plan.md`](plan.md) for the approved goal and [`phased-plan.md`](phased-plan.md) for the
split. This file is the proposed route, not a specification: follow it where the repository
agrees, use judgement where it does not, and record any deviation in the pull request.

## 1. Outcome

Mission Control can declare a feature flag, store an operator's choices about flags, answer
"is this flag on" identically in the daemon and the dashboard, and tell every open window the
moment a choice changes. Nothing is visible to an operator yet, and the registry is empty. A
developer can add a flag and gate a feature with it, guided by `docs/feature-flags.md`.

## 2. Entry criteria and dependencies

None. This phase starts from `main`.

## 3. Scope and non-goals

In scope: the two shared modules, the stored config, the daemon module, two routes, one server
event, one snapshot field, the dashboard state and hook, tests, and developer documentation.

Not in scope:

- Any Settings UI, category, search entry, or palette entry. Phase 2 owns them.
- Any real flag. `FEATURE_FLAGS` stays empty.
- Any change to `CONDUCTOR_INTEGRATION_ENABLED`, `src/shared/conductor-integration.ts`,
  `src/server/pipelines/availability.ts`, or the conductor specs.
- Reading the update channel anywhere in resolution, on any process.

## 4. Repository findings

- Config modules follow one shape: `getAppConfig` / `setAppConfig` over an entry from
  `APP_CONFIG_ENTRIES`. `src/server/database-backups/config.ts` is a small example.
- `src/shared/app-config-entries.ts` has `wholeEntry(key, schema, valueClass, backupDomain)`.
  Newer entries add `optionalInSnapshot: true`, so a snapshot written before the key existed
  restores without touching it.
- `test/settings-backup-coverage.test.ts` pins the full list of `app_config` keys, requires
  every `setting`-class entry to have a backup domain, and requires every `settings`-surface
  domain to be named by a Settings control. See step 3 for how this phase satisfies it.
- `Registry.snapshot()` in `src/server/registry.ts` folds `settingsStatus` into the reconnect
  snapshot, and `emitSettingsStatus` drops a frame that restates the last one.
  `setKeepAwakeStatus` is the simplest example of that suppression.
- `ServerEvent` is a union in `src/shared/types.ts`. `src/web/useEventStream.ts` handles every
  member and reads the snapshot around line 429.
- `src/server/routes.ts` validates bodies with `parseBody(c, Schema)`, and its app factory
  takes a dependencies object that in-process tests use to inject collaborators.
  `PUT /api/storage/limits` is a compact example of a config route that then publishes.
- `src/server/settings-backups/service.ts` reconciles projections after a restore in a list of
  `attempt(...)` calls that includes `publishSettingsStatus(registry)`.
- `src/shared/zod-shapes.ts` exports `boundedRecord` for records with an entry limit.
- `test/route-surface-oracle.test.ts` pins the route surface and will need the two new routes.
- The update channel lives in `src/main/update-preferences.ts` and `src/shared/update.ts`. No
  daemon module reads the alpha preference today.

## 5. Implementation steps

1. **Registry module** `src/shared/feature-flag-registry.ts`. Data only, browser-safe, and
   nothing else in the file:
   - `FEATURE_FLAGS`, an empty `as const` tuple that `satisfies` a readonly array of
     definitions.
   - `RETIRED_FEATURE_FLAG_IDS`, an empty append-only tuple, with a comment stating that an id
     here is never reused and why.
   - This path and these two export names are a contract. Phase 2's browser build resolves
     this one module to a fixture, so no logic and no other export may live here.
2. **Logic module** `src/shared/feature-flags.ts`. Browser-safe: no `node:` imports, no
   import from `protocol.ts`, and no import from any update-channel module.
   - `FeatureFlagDefinition`: `id`, `label`, `description`, `stage` (`"preview"` or
     `"default-on"`), `keywords`. `FeatureFlagId` derived from the registry.
   - `FeatureFlagsConfigSchema`: `enableAll` boolean defaulting to `false`, and `overrides`, a
     `boundedRecord` of kebab-case keys (at most 64 characters, at most 512 entries) to
     booleans, defaulting to empty. Export the inferred type and a defaults constant.
   - `FeatureFlagIntentSchema`, a discriminated union on `kind`: `{ kind: "master", enabled,
     enableDisabled? }` and `{ kind: "flag", id, enabled }`.
   - Pure functions, each taking `definitions` as a parameter that defaults to `FEATURE_FLAGS`:
     resolve one flag; resolve all into a record; list the definitions explicitly switched
     off (a stored `false` for a known id); apply an intent, returning the next config or an
     `unknown_flag` refusal. None of them takes the update channel as an input.
   - Apply-intent rules.
     - Flag: **always** store `overrides[id] = enabled`. Do not drop the entry when it matches
       what the flag would be without it. A flag switched off while the master is off must
       leave a stored `false`, because Phase 2's question is built from that list.
     - Master: set `enableAll` and change no stored choice, unless `enabled` and
       `enableDisabled` are both true, in which case also delete every stored `false` for a
       known id.
     - Every write drops ids in the retired list and preserves ids that are neither known nor
       retired.
3. **Backup domain and `app_config` entry.** Append `{ id: "feature-flags", surface:
   "runtime" }` to `SETTINGS_BACKUP_DOMAINS` with a comment: the control arrives in Phase 2,
   which moves the surface to `settings`. The id is persisted and final. Add `featureFlags` to
   `APP_CONFIG_ENTRIES` as a whole `setting` entry with backup domain `feature-flags` and
   `optionalInSnapshot: true`. Update the pinned key list and any other pinned list in
   `test/settings-backup-coverage.test.ts`. The `runtime` surface is what keeps that test's
   control-coverage assertion satisfied in this phase.
4. **Daemon module** `src/server/feature-flags/` (an `index.ts` is enough).
   - Read the config through `getAppConfig`, parse with defaults, and keep the parsed copy in
     memory. Replace the copy on every write and on `reloadFeatureFlags()`.
   - `getFeatureFlagsConfig()`, `featureEnabled(id)`, and
     `applyFeatureFlagIntent(intent)` which persists and notifies. The functions that validate
     ids take the definitions as a defaulted parameter, so the app factory's dependencies can
     supply fixture definitions to an in-process test.
   - `onFeatureFlagsChanged(listener)` returning an unsubscribe. Listeners run after the
     store is updated. A throwing listener is logged and does not stop the others or fail the write.
   - `requireFeature(id)`: Hono middleware that calls `next()` when the flag is on and
     otherwise answers 404 with `{ error, feature }`.
   - Under the test runner the in-memory copy must not leak between test files that use
     different state homes. Follow how the other config modules behave under
     `test/setup-state.mjs`; if a cache makes that awkward, key it by the resolved database
     path or expose a reset used by tests.
5. **Wire types.** In `src/shared/types.ts` add `{ type: "feature_flags"; config:
   FeatureFlagsConfig }` to `ServerEvent`, with a comment on why it carries content. Add
   `featureFlags` to the snapshot type.
6. **Registry.** In `src/server/registry.ts` add `featureFlags` to `snapshot()` and an
   `emitFeatureFlags(config)` that drops a frame equal to the last one. Compare `enableAll`
   and the full `overrides` record, not a subset.
7. **Routes** in `src/server/routes.ts`: `GET /api/feature-flags` answering `{ config }`, and
   `PUT /api/feature-flags` parsing `FeatureFlagIntentSchema` with `parseBody`, applying it,
   emitting through the registry, and answering `{ config }`. An unknown flag id answers 400.
   Add both to the route surface oracle.
8. **Restore.** In `src/server/settings-backups/service.ts` add an `attempt(...)` that reloads
   the daemon's copy and emits, so a restored config reaches open windows and subscribers.
9. **Dashboard state.** In `src/web/useEventStream.ts` add `featureFlags` to `MissionState`,
   hydrate it from the snapshot, and add a `case "feature_flags"`. Before the first snapshot it
   holds the defaults, so nothing preview is shown early.
10. **Hook and client.** Add `useFeatureFlag(id)` reading that state through whatever context
    the app already uses to hand `MissionState` to components, and API client functions for
    the two routes beside the existing ones in `src/web/lib/api.ts`.
11. **Documentation.**
    - New `docs/feature-flags.md`: stages, the resolution table, that a flag choice is always
      stored, the "takes effect without a restart" rule, the gates, the three-pull-request
      lifecycle from `plan.md`, and what the first flag's pull request owes. State the alpha
      rule in one place and in these words: the update channel never changes a flag; on every
      channel a preview feature is on only because the operator switched that flag on or
      switched on Enable all; only Enable all makes new preview features come on by themselves.
    - `docs/README.md` index entry.
    - `docs/event-stream.md`: the event and the snapshot field.
    - `docs/agent-guides/change-contracts.md`: add `RETIRED_FEATURE_FLAG_IDS` and the
      `feature-flags` backup domain to the append-only list, and extend the Registries rule so a
      feature flag is the one sanctioned runtime gate on a category, read through one gate,
      while probing for installed software stays forbidden.

## 6. Data, API and compatibility

- No migration. `featureFlags` is a new `app_config` key; a database without it reads as the defaults.
- A config written by a newer build parses on an older one: unknown ids are kept, not rejected.
- A snapshot written before this phase has no `feature-flags` domain and restores without touching flags.
- An older dashboard ignores the new snapshot field and event.
- `PUT /api/feature-flags` body is one intent. Response is `{ config }`. Errors follow the shapes
  `parseBody` and neighbouring config routes already use.

## 7. Tests and verification

- `test/feature-flags.test.ts`, with fixture definitions:
  - every row of the resolution table, including a preview flag switched on by hand while the
    master is off, which resolves on;
  - a flag intent always stores the choice, in both directions and under both master states;
  - the sequence the review named: master off, flag on, flag off leaves a stored `false`;
    master on then leaves that flag off, and it appears in the explicitly-switched-off list;
  - master on and off leave every stored choice alone;
  - `enableDisabled` clears stored `false` for known ids only, after which those flags follow
    their defaults;
  - unknown ids preserved across a write, retired ids dropped, an unknown flag id refused,
    schema bounds.
- The same file, against the real registry and source: ids unique and kebab-case, no id in
  both lists, every entry has a label and description, the registry module exports exactly its
  two tuples, and neither flag module nor `src/server/feature-flags/` imports an update-channel
  module (`update.ts`, `update-preferences.ts`).
- `test/feature-flags-http.test.ts`: GET defaults; PUT master; a flag intent with fixture
  definitions supplied through the app's dependencies stores the choice and is emitted; PUT
  with an unknown id is 400; the event is emitted once and not repeated for a no-change write;
  the snapshot carries the config; a subscriber is called; a restore republishes.
- Updated pins: `test/settings-backup-coverage.test.ts`, `test/route-surface-oracle.test.ts`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.
  For one file: `node --test --import ./test/setup-state.mjs --import tsx test/feature-flags.test.ts`.
- No Playwright spec: this phase changes nothing a person can see. Say so in the pull request.

## 8. Merge and exit criteria

- All commands above pass, and CI is green.
- `FEATURE_FLAGS` and `RETIRED_FEATURE_FLAG_IDS` are empty, alone in their module.
- No file under `src/web/components/` changed, and no conductor file changed.
- `docs/feature-flags.md` exists and matches the code.

## 9. Downstream handoff

Phase 2 may rely on, and must not change:

- `src/shared/feature-flag-registry.ts` at that path, exporting exactly `FEATURE_FLAGS` and
  `RETIRED_FEATURE_FLAG_IDS`. Phase 2 builds the daemon and the dashboard with this module
  replaced by a fixture.
- The logic module's schemas and pure functions, and the stored shape.
- A flag intent always storing the choice, and the explicitly-switched-off list being the
  known definitions with a stored `false`. Phase 2's question names exactly that list.
- The two routes and their `{ config }` responses, the `feature_flags` event, the snapshot
  field, `MissionState.featureFlags`, and the backup domain id `feature-flags`.

Phase 2 will change exactly one thing this phase wrote: the backup domain's `surface`, from
`runtime` to `settings`, when its Settings control exists.

## 10. Cross-phase audit record

- Written first. No earlier phase to reconcile.
- After Phase 2 was written: the pure functions take definitions as a parameter for unit and
  in-process HTTP tests; the explicitly-switched-off list exists because Phase 2's dialog
  names those flags; the master intent carries `enableDisabled` because that dialog needs one
  atomic write. The `runtime` surface was chosen so this phase passes the coverage test
  without a control, and Phase 2 owns the move.
- Plan Validation v3, repair round 1:
  - The first draft dropped a flag's stored choice when it matched the default. That erased a
    flag switched off while the master was off, so Phase 2's question could not see it and
    turning the master on would have enabled it. A flag intent now always stores the choice,
    and section 7 tests the exact sequence.
  - The registry tuples moved into a module of their own so Phase 2 can substitute a fixture
    registry at build time and exercise populated flags through the connected panel.
  - The alpha rule is stated once, in section 5 step 11, and resolution is tested to have no
    channel input.
