# Feature flags

The flag core stores one set of operator choices for this machine. The registry includes
**Codex resident native MCP** (below), [Resident active hours](residents.md#active-hours),
[Automatic PR branch updates](inspector-and-shipping.md#automatic-pr-branch-updates-preview),
**Headless mode** (`headless-mode`), **Hibernate tasks** (below), [Task shaping](task-shaping.md),
[Session control requests](sessions.md#when-a-session-asks-for-control),
[Fold the drawer's Profiles](residents.md#the-residents-drawer),
[Ask without stopping](sessions.md#asking-without-stopping) (`async-input`) and
[Reports and inbox upgrades](attention-and-alerts.md#one-name-for-an-agent) (`inbox`) as previews.
Settings > Feature flags controls these choices. The ai-conductor integration switch is unchanged.

**Change pinned plan revision** (`pinned-plan-change`) enables the backlog editor and MCP
[atomic pin change](dispatch-and-backlog.md#change-a-pinned-plan-revision-preview). Turning it off
refuses `planInputChange` and `previewOnly` requests; it does not change saved pins or dependencies.
This release also adds raw `planInputs` and `dependencies` edits to MCP `update_task`, independently
of this flag. Those edits remain subject to authentication and existing task, repository, and
dependency validation. The dashboard task-update endpoint already supported these raw atomic edits.

## Operator controls

Open **Settings > Feature flags**, directly after Setup. Preview features appear in one
searchable list; filter by name, description, keyword or id. Every click applies immediately
in every open window, with no Save button or restart. A refused write rolls back and shows an
inline error. Preview features are off until enabled individually or through the master switch.
With no preview declared the panel shows its empty state instead of a list.

**Codex resident native MCP** exposes [All native sources](residents.md#all-native-sources) in
Codex resident profiles. Turning it off prevents new saves and launches in that mode. Existing
runs keep their launch revision's MCP mode on resume. A saved profile can switch back to
**Pinned at launch** when the preview is off.

**Headless mode** (`headless-mode`) is a preview scaffold for dispatching work to Mission Control from
a Claude Code terminal session. It ships off until chosen. With it on, every `/dispatch/*` route
answers 501 `not implemented` until later phases fill the routes. With it off, every `/dispatch/*`
route answers 404 and the `home-dispatch-v1` health capability is absent.

**Hibernate tasks** adds [Hibernate](sessions.md#hibernate-a-task-and-resume-it-later) to a
task session's pause menu. Turning it off hides Hibernate. Tasks already hibernated stay in the
Backlog and can still be resumed, so switching the preview off never strands a conversation.

**Session control requests** (`session-control-requests`) lets a session ask for **Control other
sessions** with `request_session_control`; only a desktop click on the card's Accept grants it.
Turning it off refuses new asks and withdraws every pending card at once, telling each waiting
agent its ask ended without a decision. A grant already given is unaffected.

**Enable all feature flags** opts in to current and future preview features while preserving
individual choices. If you previously switched anything off, enabling it asks: **Keep them
off**, **Turn them on too**, or **Cancel**. Cancel and Escape write nothing. Turning the master
off keeps individually enabled flags on. **Advanced** starts collapsed and contains features
that are on by default, with a count of those switched off. A filter matching only Advanced
opens it. Settings search can toggle individual flags; the master result opens its panel.

Switching on **Alpha updates** in **Settings > Setup > Application updates** also switches on
Enable all, so an alpha operator gets every current and future preview feature by default. It is
the same write as the master switch without "Turn them on too": flags you switched off stay off.
Switching alpha off changes no flag, and you can still switch Enable all or any flag off while
on alpha. Alpha is saved first and stays on if that write fails, because the alpha
switch must keep working while the daemon is down; the Application updates section then says
Enable all could not be switched on and offers **Retry**. That failure survives moving between
Settings categories, and a pending write never locks the alpha switch. A write that gets no
answer within 10 seconds counts as failed, so Retry is never stuck behind a stalled request.

## Definition and resolution

Declare flags in `src/shared/feature-flag-registry.ts`. It exports `FEATURE_FLAGS`,
`RETIRED_FEATURE_FLAG_IDS` and one `<FLAG>_ID` constant for each flag whose gates need to name it
(today `HEADLESS_MODE_FLAG_ID`), so a gate imports the id instead of respelling it. It holds data
only, so a test build can substitute it without replacing logic; a substitute keeps those constants.
Each definition has `id`, `label`, `description`, `stage` and `keywords`. An id is kebab-case,
at most 64 characters. `FeatureFlagId` is derived from the tuple.

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

Resolution never reads the update channel. Opting in to alpha changes flags only through the
dashboard, which follows a successful alpha opt-in with the `{ kind: "master", enabled: true }`
intent below; the daemon still has no reader for the desktop's update preferences. Only Enable
all makes new preview features come on by themselves.

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

## Shipped flags

| Id | Stage | Gates | Guide |
| --- | --- | --- | --- |
| `codex-resident-native-mcp` | preview | Codex residents' native MCP sources | [Residents](residents.md#all-native-sources) |
| `resident-active-hours` | preview | A resident's active hours | [Residents](residents.md#active-hours) |
| `automatic-pr-branch-update` | preview | Automatic PR branch updates | [Inspector and shipping](inspector-and-shipping.md#automatic-pr-branch-updates-preview) |
| `headless-mode` | preview | Dispatch from a Claude Code terminal session | [Feature flags](#feature-flags) (above) |
| `task-shaping` | preview | `/api/shaping` and `/api/shaping/test`, the shaping engine, the Settings > Task shaping category, and the `shaping_config` event and snapshot field | [Task shaping](task-shaping.md) |
| `resident-profiles-fold` | preview | The chevron on the Residents drawer's Profiles heading that folds the launch list | [Residents](residents.md#the-residents-drawer) |
| `session-control-requests` | preview | `request_session_control`'s `/mcp/session-control/requests` routes, the decline route and the session's Permission card | [Sessions](sessions.md#when-a-session-asks-for-control) |
| `inbox` | preview | Agent reports (`post_report`, the inbox's Reports section and the top bar's to read figure), and the one naming rule on alert titles, inbox row headers, the review modal header and question cards. Stuck rows join it in a later release | [Agent reports](attention-and-alerts.md#agent-reports), [One name for an agent](attention-and-alerts.md#one-name-for-an-agent) |

`test/feature-flags.test.ts` checks every shipped definition against the id rules.
`e2e/specs/feature-flags.spec.ts` covers the shipped rows, and
`e2e/specs/task-shaping-flag.spec.ts` is Task shaping's own browser assertion: its row appears,
a toggle reaches a second window without a reload, and the `/api/shaping` gate follows it.
`e2e/specs/inbox-flag.spec.ts` checks that the `inbox` row appears off, that a toggle is stored
and reaches a second window without a reload, and that the panel's filter finds it.
`e2e/specs/inbox-display-name.spec.ts` checks the names the flag changes: the inbox row, the review
modal header, the question card, an alert's title, and a resident's board colour.
`e2e/specs/reports-inbox.spec.ts` checks agent reports: a report posted on the tool's channel
reaches the inbox and the to read figure, opening it changes no figure, Mark read clears it, a
replacement shows once with its note, the session never turns amber, and nothing shows with the
flag off.
`e2e/specs/task-shaping-settings.spec.ts` covers its Settings category, which follows the flag
in every open window.

A Settings category behind a flag declares it as `flag` in `SETTINGS_CATEGORIES`, and
`settingsCategoryAvailable(id, flags)` is its one gate for the rail, the page, settings search
and the palette.
