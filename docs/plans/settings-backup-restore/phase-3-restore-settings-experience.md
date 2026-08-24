# Phase 3: Restore Settings experience

## Outcome

Mission Control exposes its verified backup catalog in a new Settings > Restore category. An
operator can inspect a historical snapshot, review a redacted impact summary, explicitly confirm
the destructive forward restore, and see the result, safety snapshot, and any bounded
reconciliation warnings.

The initiating window refreshes its persisted browser configuration before reloading. Other open
windows retain unsaved work and receive a persistent Reload now notice after the daemon has
completed durable restore and live reconciliation.

**User-visible value:** the daily recovery assets from Phase 1 become safely selectable and
restorable without paths, shell access, or silent stale state in another Mission Control window.

## Entry criteria and direct phase dependencies

- Direct dependency: Phase 2 is merged.
- The planning pull request is merged and this file resolves on the default branch.
- The backup service provides bounded list metadata, digest-bound redacted preview, confirmed
  restore, stable result codes, safety snapshot ids, and bounded reconciliation warnings.
- Registry replacement and all synchronous post-commit refreshes finish before restore success is
  returned.

### Inherited contracts

- Routes expose the existing service. They do not duplicate parsing, validation, diffing,
  transaction logic, or external reconciliation.
- A restore accepts a validated snapshot id and digest, never an arbitrary path.
- The daemon remains the only writer.
- The public workflow requires preview, a matching digest, and explicit confirmation.
- Incompatible, unreadable, and corrupt entries remain visible for diagnosis but cannot be
  selected for restore.
- Tasks, sessions, schedules, bindings, runs, attempts, reviews, usage, leases, projections, and
  ledgers remain historical and operational state, not restore targets.

## Scope

- Add bounded list, preview, and confirmed restore HTTP routes over the singleton service.
- Add a shared `settings_restored` event after successful reconciliation.
- Add request-id coordination for the initiating window and a persistent reload notice for other
  windows.
- Add the Restore Settings category, search entry, panel, preview, confirmation modal, result, and
  responsive styling.
- Add shared client contracts and one explicit API state owner with no optimistic mutation.
- Prove the complete flow in Playwright, including restored Library configuration, preserved
  operational history, a safety snapshot, incompatible files, and two-window behavior.
- Finish user and technical documentation for backup and restore.

### Explicit non-goals

- No manual snapshot button, arbitrary-path import, export, cloud sync, encryption, compression, or
  full-database recovery.
- No snapshot editing, conflict resolution, rename-on-conflict, or partial domain restore.
- No undo shortcut. The pre-restore safety snapshot is selected and restored through the same
  explicit preview and confirmation flow.
- No automatic reload of other windows, since it could discard an unsaved Persona, Session Action,
  Command, workflow, or Settings edit.
- No browser access to the backup directory and no direct SQLite access outside the isolated E2E
  fixture boundary.

## Repository findings and inherited Phase 2 contracts

- `buildApp` has positional construction across many focused tests. Append the backup service as a
  final optional dependency and return 503 from these routes when it is absent.
- `src/web/lib/uiConfig.ts` already owns `hydrateUiConfig()`, which refreshes the daemon-backed UI
  configuration and local cache. The initiating window must call it before reload.
- `src/web/useEventStream.ts` exhaustively handles every `ServerEvent`. The new event requires an
  explicit case and is not part of `LINE_INPUT_EVENTS`, because it carries global invalidation, not
  a bounded Line record.
- `SETTINGS_CONTROLS` is the single Settings search registry, while `SettingsPage` exhaustively
  renders categories. The Restore category must be added to both contracts and use a stable anchor.
- Existing `.app-banner` styling can carry the persistent cross-window notice, with a focused
  extension for its action and narrow layout.
- Playwright starts an isolated built daemon and redirects every agent binary to a fake. Database
  fixture work must use `withDaemonDb`; it must never instantiate `DatabaseSync` directly.

## Implementation steps

### 1. Publish shared route and event contracts

Extend `src/shared/protocol.ts` or a focused browser-safe backup contract with bounded schemas for:

- list metadata and service status;
- a redacted preview request and response;
- a confirmed restore request and result;
- stable route error codes and bounded user-safe messages;
- `settings_restored` with `snapshotId`, `restoredAt`, and the client `requestId`.

The restore body contains the snapshot digest returned by preview, a client-generated request UUID,
and one exact confirmation literal such as `RESTORE SETTINGS`. Reject missing, malformed, or
mismatched confirmation before calling the service. The literal is a deliberate final-action
contract, not a free-form note.

Add `settings_restored` to the append-only `ServerEvent` union. Handle it exhaustively in
`src/web/useEventStream.ts` and prove it is deliberately absent from `LINE_INPUT_EVENTS`. Keep event
payloads invalidation-only: do not include config values, Markdown, prompts, argv, allowlists, or a
preview diff.

### 2. Expose the singleton service through loopback routes

Append the existing `SettingsBackupService` as the final optional `buildApp` argument so current
focused route constructors remain valid. Add:

```text
GET  /api/settings-backups
GET  /api/settings-backups/:id/preview
POST /api/settings-backups/:id/restore
```

All handlers parse ids, params, and bodies through shared schemas, call only the injected service,
and return bounded responses. Use this status mapping consistently:

| Status | Meaning |
| --- | --- |
| 200 | List, preview, or successful restore |
| 404 | Snapshot id is not owned or no longer exists |
| 409 | Digest is stale, another restore is active, or current-state preflight blocks restore |
| 422 | File is corrupt, invalid, unreadable as a snapshot, or produced by a newer format |
| 500 | Unexpected bounded service or filesystem failure |
| 503 | Backup service was not supplied to `buildApp` |

The POST handler passes the expected digest, request id, and confirmation authority to the Phase 2
service. After the service has committed and completed its synchronous Registry and projection
reconciliation, its route-owned callback emits exactly one `settings_restored` event. Never emit on
preview, a refused restore, rollback, or an uncommitted result.

Construct the singleton service and callback once in `src/server/index.ts`. Routes must not create a
second store, timer, mutex, or backup root.

### 3. Add a single browser API and restore state owner

Add typed client functions in the existing web API layer for list, preview, and restore. Add one
focused hook or reducer that owns:

- initial loading, newest-first metadata, service status, and retry;
- current selection, digest-bound preview, compatibility, and preview errors;
- confirmation modal state and exact confirmation input;
- restore in progress, success, safety snapshot id, warnings, and bounded errors;
- cancellation or invalidation when a refreshed list changes the selected digest.

Do not optimistically edit settings or Library state. The daemon completes the forward restore
first. Disable selection, confirmation, and duplicate submission according to explicit reducer
states, and preserve the selected row when a recoverable request fails.

Generate one request UUID when a confirmed submit begins and register it as the initiating request
before POST. On success, call `hydrateUiConfig()` and then reload the initiating window so every
daemon-backed and browser-cached setting is rebuilt from one startup path. Clear pending request
state on failure. Do not treat an HTTP timeout as proof that the daemon did not commit; a later
matching event or refreshed list remains authoritative.

Keep definite failures out of the request registry. Retain at most 32 recent ambiguous request ids
so a late matching event still owns the initiating window without letting repeated offline retries
grow page memory for its entire lifetime.

### 4. Coordinate other open windows without discarding drafts

When `useEventStream` receives `settings_restored`:

- if its `requestId` matches the pending initiating request, suppress the other-window notice and
  let the successful submit path hydrate and reload;
- otherwise, set persistent application-level invalidation state and render a banner that names the
  restore time and offers **Reload now**;
- keep the notice across navigation until the user reloads;
- never automatically reload or replace client draft state.

Keep the latest event's three public scalar fields as a bounded reconnect marker. The first
snapshot establishes a window's baseline without showing a notice. A later snapshot with a new
marker recovers an event missed while the stream was disconnected and follows the same initiating
versus external request-id behavior above.

Place the notice at the application shell so it is visible from Settings and Library. Reuse the
existing app-banner visual language and expose a reachable Reload now button with an accessible
name. If more than one external restore arrives, the latest metadata replaces the notice without
stacking banners.

The event is global invalidation rather than a catalog update. Do not attempt to merge the restored
Personas, Session Actions, Commands, workflows, or config values into independently cached React
state from the event payload.

### 5. Add Settings > Restore

Add an append-only Restore category to the Sessions group with `scope: "home"`. Extend
`SETTINGS_CONTROLS` with a stable Restore anchor and
`{ kind: "not-applicable", reason: "operational-action" }` coverage metadata, because invoking a
restore is an action rather than another persisted setting. Extend the exhaustive category renderer
and sidebar/search tests rather than introducing a second menu list.

Implement a focused `RestoreSettingsPanel` with:

- automatic-backup status, resolved destination, retention summary, last successful snapshot, and
  bounded last error;
- a newest-first table or list with timestamp, kind, producing version, compatibility, and compact
  size or domain summary;
- visible but disabled rows for corrupt, unreadable, and newer-format entries, with the reason;
- a selected-snapshot preview containing changed setting domains, added/changed/archived/reactivated
  catalog counts, external effects, exclusions, warnings, and blockers;
- an explicit **Restore settings** action that opens a confirmation dialog;
- snapshot identity, consequences, confirmation literal, cancel, and final restore action inside
  the dialog;
- a success result showing the restored snapshot, created safety snapshot, reload behavior, and any
  reconciliation warnings.

Use semantic table, list, dialog, status, and alert roles; associated labels; keyboard focus on
dialog open; focus return on cancel; and focus on the success or error summary after completion.
Never add `data-testid`. At narrow widths, allow metadata and actions to stack without horizontal
page overflow, clipped confirmation text, or unreachable actions.

### 6. Add isolated browser fixtures and full-flow proof

Add an E2E fixture helper that writes a valid v1 snapshot under the isolated daemon's
`home/backups/settings` directory. The helper imports the production shared snapshot schema and
canonical digest helper, so the fixture cannot drift to bytes production would reject. It accepts
normalized domain data, creates owner-shaped filenames, and never writes to the operator's actual
home.

Use real loopback APIs to create and later observe configurable values where practical. Seed and
inspect operational task, binding, or run history only through `withDaemonDb`, which preserves the
suite's database isolation boundary. Every spawned agent remains the repository's fake agent.

Add `e2e/specs/settings-backup-restore.spec.ts` to prove:

1. the Restore sidebar item and cold `#/settings/restore` route render with status and retention;
2. a seeded historical snapshot appears newest-first and produces the expected redacted preview;
3. explicit confirmation restores a UI setting plus a Persona, Session Action, workflow, and
   Command value;
4. task and workflow-run history remain unchanged and still resolve their immutable version;
5. a pre-restore safety snapshot appears and is selectable after success;
6. corrupt and newer-format files stay visible, explain the incompatibility, and cannot restore;
7. two browser windows receive the event, the initiator refreshes, and the other window preserves
   an unsaved Library draft behind a persistent Reload now notice.

Select through roles, names, labels, and placeholders only. Capture visual evidence for the pull
request in a gitignored location, not in the repository.

### 7. Finish product and technical documentation

Update the settings and configuration documentation linked from `docs/README.md` with:

- daily behavior and local-date semantics;
- `$MISSION_HOME/backups/settings/` path resolution and owner-only storage;
- 90 daily plus 10 pre-restore safety retention;
- included settings and Library catalogs, plus excluded operational history and credentials;
- preview, explicit confirmation, forward-restore, safety snapshot, and warning behavior;
- incompatibility across newer formats and the rule that files should not be edited by hand;
- the automatic-or-red extension contract for new config fields and Settings controls.

Document the new event and route contracts in the nearest existing technical guide. Do not copy the
test preloader command explanation into product docs; the repository agent guide remains its owner.

## Data, API, migration, and compatibility details

- This phase adds no SQLite migration and no new persistence owner.
- Routes expose metadata, redacted preview, and bounded results only. Snapshot payloads are never
  downloaded to the browser.
- The expected digest binds confirmation to the exact bytes previewed. A changed file must be
  previewed again.
- The request id coordinates browser behavior but is not durable authorization, idempotency, or a
  substitute for the service mutex and digest check.
- A 409 preflight result may describe bounded blockers, but it must not expose raw settings or
  catalog content.
- The success event is emitted after durable commit and synchronous live reconciliation. Bounded
  warnings may still report external effects that will retry on startup.
- Unknown future snapshot formats remain visible and disabled. Adding a reader or migration belongs
  to the backup contract, not to React.
- The Settings Restore control participates in the Phase 1 coverage test. Adding it without backup
  metadata makes typecheck or the focused coverage suite fail.

## Tests and verification

Add focused Node and render tests for:

- route schema validation, exact confirmation, status mapping, optional-service 503, and one event
  only after success;
- no event on stale digest, preflight refusal, in-progress conflict, rollback, or I/O failure;
- the shared event schema, exhaustive browser handling, and exclusion from `LINE_INPUT_EVENTS`;
- the API reducer's loading, selection invalidation, retry, duplicate-submit guard, success,
  warnings, and failure states;
- initiating request-id matching, `hydrateUiConfig()` before reload, external notice persistence,
  latest-event replacement, and no automatic reload;
- Restore category, sidebar/search anchor integrity, panel markup, incompatible disabled state,
  confirmation dialog accessibility, and result alerts;
- narrow-layout CSS and existing Settings category exhaustiveness.

Run focused Node tests with the required preload, for example:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/settings-backup-routes.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-restore-ui.test.ts
```

Build before the focused browser proof, then run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/settings-backup-restore.spec.ts
npm run test:e2e
```

On macOS under the Codex seatbelt, use the repository's scoped outside-sandbox approval for the
real Electron portions of `npm test`; do not bypass the preflight or add Chromium flags.

## Merge and exit criteria

- Settings > Restore lists all retained evidence, keeps incompatible entries visible, and never
  sends a path to the daemon.
- Preview is redacted and digest-bound; restore requires the exact confirmation and cannot be
  submitted twice.
- A successful route result follows durable commit, live reconciliation, and safety snapshot
  creation, then emits one bounded invalidation event.
- The initiating window hydrates and reloads. Every other window preserves drafts until its user
  chooses Reload now.
- The browser proof restores settings and all Library catalog types while operational task and run
  history remain unchanged.
- Static, unit, integration, build, smoke, focused Playwright, and full E2E commands pass.
- One reviewable pull request is green and merged, completing the feature.

## Downstream handoff

This is the final implementation phase. Its merge should leave:

- versioned daily and safety snapshots with the approved independent retention budgets;
- automatic-or-red coverage for every supported persisted setting and Settings control;
- a transactional forward restore that preserves immutable and operational history;
- one explicit Settings workflow with redacted preview and confirmation;
- deterministic same-window refresh and non-destructive other-window invalidation;
- user and technical documentation that match the shipped behavior.

Any future snapshot format change must add a new version and migration without reinterpreting v1.
Any new setting field must use the typed config descriptor, and any new Settings control must
declare backup coverage or a reason that backup does not apply.

## Cross-phase audit record

- **2026-08-24, initial.** Audited against Phases 1 and 2. This phase is the sole owner of HTTP
  exposure, shared invalidation, request-id coordination, Restore UI, cross-window notice, and
  Playwright proof. It consumes rather than reimplements the service's validation, preview,
  transaction, and reconciliation. The E2E fixture writes only inside the isolated daemon home and
  uses the published canonical format, while operational fixture reads and writes remain behind
  `withDaemonDb`.
- **2026-08-24, final reconciliation.** Rechecked against the root plan and both predecessor phases.
  Every remaining public requirement is assigned here exactly once: route mapping, confirmation,
  event timing, same-window hydration, other-window draft protection, Settings rendering,
  accessibility, responsive behavior, and browser proof. Restore remains an operational action in
  the coverage registry rather than a self-referential backed-up setting.
