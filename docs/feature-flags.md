# Feature flags

The flag core stores one set of operator choices for this machine. The registry ships one
preview: `resident-active-hours`, [resident active hours](residents.md#active-hours).
Settings > Feature flags controls these choices. The ai-conductor integration switch is unchanged.

## Operator controls

Open **Settings > Feature flags**, directly after Setup. Preview features appear in one
searchable list; filter by name, description, keyword or id. Every click applies immediately
in every open window, with no Save button or restart. A refused write rolls back and shows an
inline error. With no preview declared the panel shows its empty state instead of a list.

**Enable all feature flags** opts in to current and future preview features while preserving
individual choices. If you previously switched anything off, enabling it asks: **Keep them
off**, **Turn them on too**, or **Cancel**. Cancel and Escape write nothing. Turning the master
off keeps individually enabled flags on. **Advanced** starts collapsed and contains features
that are on by default, with a count of those switched off. A filter matching only Advanced
opens it. Settings search can toggle individual flags; the master result opens its panel.

Alpha builds do not enable preview features. Choose individual flags or Enable all on any
update channel.

## Definition and resolution

Declare flags in `src/shared/feature-flag-registry.ts`. It exports only `FEATURE_FLAGS` and
`RETIRED_FEATURE_FLAG_IDS`, so a test build can substitute the data without replacing logic.
Each definition has `id`, `label`, `description`, `stage` and `keywords`. An id is kebab-case,
at most 64 characters. `FeatureFlagId` is derived from the tuple; an empty registry means
there are no valid ids for production gates.

The `featureFlags` app_config entry stores `{ enableAll, overrides }`, defaulting to
`{ enableAll: false, overrides: {} }`, with at most 512 boolean overrides. There is no database
migration. `src/shared/feature-flags.ts` owns schemas and all resolution and intent logic.

| Stage | Enable all | Stored choice | Resolved |
| --- | --- | --- | --- |
| preview | off | none | off |
| preview | off | on | on |
| preview | on | none | on |
| preview | on | off | off |
| default-on | either | none | on |
| default-on | either | off | off |

A stored choice wins over the stage and master switch. Setting one flag always stores its
choice, even if it matches its default. On then off with the master off therefore leaves an
explicit off, which a later master-on keeps. `explicitlyDisabledFeatureFlags` lists known
flags with that stored false for the confirmation dialog.

The update channel never changes a flag; on every channel a preview feature is on only because
the operator switched that flag on or switched on Enable all; only Enable all makes new preview
features come on by themselves.

Unknown ids never enable a feature, but their stored choices survive writes, so downgrading
and upgrading does not erase preferences. Retired ids are dropped on the next write and must
never be reused. Otherwise an old choice could disable an unrelated new feature.

## Writes and live gates

`GET /api/feature-flags` and `PUT /api/feature-flags` return `{ config }`. PUT accepts one intent:

- `{ kind: "flag", id, enabled }` records a known flag's choice. Unknown ids return 400.
- `{ kind: "master", enabled, enableDisabled? }` sets the master and keeps individual choices.
  With both booleans true it also clears false overrides for known ids, in the same write.
  Unknown choices remain intact. The Settings panel asks before requesting this clearing.

The daemon's `src/server/feature-flags/index.ts` owns persistence and a cache scoped to its
SQLite connection. `getFeatureFlagsConfig` returns an immutable value. Successful writes
update it before notifying listeners. Changes are delivered in commit order: if a listener
makes another choice, every listener receives the first config before the next config.
Each callback receives the immutable config for its change; a fresh read can already see a
newer committed choice. Listener failures are logged without failing the write or stopping
other listeners. A settings restore reloads that same cache and publishes it.

Daemon startup connects `onFeatureFlagsChanged` to Registry once and unsubscribes on shutdown.
Every write through `applyFeatureFlagIntent` and every `reloadFeatureFlags` therefore reaches
open windows through that subscription. Routes and restore code do not publish separately.
Both intent validation and daemon gates use the imported registry. Tests substitute that
module for both readers and writers, rather than supplying a separate route definition list.

Every gate takes effect without a restart:

- `featureEnabled(id)` is the daemon reader. Check it for each new operation.
- `requireFeature(id)` gates a Hono route group, returning 404 with `{ error, feature }` when off.
- `onFeatureFlagsChanged(listener)` lets a watcher or poller start and stop immediately.
  Subscribe and reconcile its initial state, and call the returned unsubscribe on shutdown.
- `useFeatureFlag(id)` reads the dashboard's event-stream config through its provider in App.
  Pure data builders take resolved flags as arguments instead of freezing them at module load.

Disabling a feature prevents new work and hides its surfaces. It deletes no data, consent or
configuration. Each feature documents what it does with work already in flight. The Foreman
worker still never reads SQLite: pass any flags it needs from the daemon. Electron startup
behavior is outside this system.

The `feature_flags` event carries the whole bounded config; identical frames are suppressed.
The snapshot's `featureFlags` hydrates reconnecting windows. Before the first snapshot the
dashboard uses defaults. The `feature-flags` backup domain is optional in older snapshots;
restoring one without it leaves current choices alone. Its surface is `settings`; the persisted id is unchanged.

## Three pull requests per flag

1. Add a `preview` definition. Gate every daemon and dashboard entry point, and subscribe
   long-lived work. Test off and on; the suite's default remains previews off. Document the
   flag in the feature's guide. The first real flag also owes a browser assertion against the
   shipped registry that its Settings row appears and toggling it changes a second window
   without reloading.
2. Change its stage to `default-on`. Untouched installations get the feature, while an
   explicit off stays off. The panel lists this stage under Advanced. Test the default
   behavior without enabling the flag first.
3. Delete the definition and append its id to `RETIRED_FEATURE_FLAG_IDS`. Run typecheck and
   remove each gate and off path it identifies. Remove off-state tests and obsolete flag
   documentation. Stored choices disappear on the next flag write.

Do not skip the default-on release: it gives operators a way to disable a problem before the
feature becomes permanent. Removing a flag makes the feature unconditional by deleting its
gates, not by resolving an unknown id as on.
