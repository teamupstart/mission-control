# Phase 2: Transactional forward restore engine

## Outcome

Mission Control can safely stage, preview, and restore a verified logical snapshot through an
internal daemon service. Restore is a forward mutation: current operator settings take the selected
historical values, revisions advance, current rows absent from the snapshot are archived, and
immutable workflow versions plus all operational history remain intact.

Before changing SQLite, the service validates every domain, refuses identity and compatibility
conflicts, and creates a verified pre-restore safety snapshot. All durable settings and relational
catalog changes commit in one SQLite transaction. Live daemon projections and external files are
reconciled afterward from persisted intent, with bounded warnings for post-commit failures.

**Engineering value:** the high-risk restore semantics are complete and independently proven before
any public route or dashboard control can invoke them.

## Entry criteria and direct phase dependencies

- Direct dependency: Phase 1 is merged.
- The planning pull request is merged and this file resolves on the default branch.
- Snapshot format v1, canonical digest bytes, stable domain ids, the config descriptor registry,
  verified file reads, capture, safety snapshot kind, mutex, and 90 plus 10 retention are available.

### Inherited contracts

- Never reinterpret or rewrite a published v1 snapshot.
- Restore only fields classified `setting`; merge them over current parsed objects so derived and
  operational fields remain current.
- No parallel config or domain inclusion list.
- Never restore built-ins, credentials, tasks, sessions, schedules, bindings, runs, attempts,
  reviews, usage, leases, projections, or ledgers.
- Never decrease a revision, delete an immutable workflow version, or orphan a current or historical
  reference.
- The daemon remains the only SQLite and filesystem writer.

## Scope

- Add envelope and per-domain migration dispatch for old snapshots and explicit refusal of newer
  snapshots.
- Add redacted preview and complete preflight validation.
- Add generic setting-field restore over the Phase 1 config registry.
- Add one store-owned relational catalog restore adapter over the shared `WorkflowStore` connection.
- Add verified safety snapshot creation and one all-or-nothing SQLite transaction.
- Rebuild Registry and runtime projections after commit.
- Add Skills and Cost preflight/reconciliation, bounded warning results, and startup retry.
- Test preservation of every excluded operational table and immutable reference contract.

### Explicit non-goals

- No HTTP routes and no public restore trigger.
- No `settings_restored` event, browser invalidation, notice, or Settings category.
- No arbitrary-path import and no cross-machine conflict resolution UI.
- No automatic conflict repair by renaming, deleting, or weakening uniqueness contracts.
- No rollback of a committed restore because an external filesystem reconciliation failed. SQLite
  remains the source of truth and startup retries the effect.

## Repository findings and inherited Phase 1 contracts

- Production catalog managers share one `WorkflowStore`, and `WorkflowStore.transact()` is the
  existing outer-transaction seam. Any restore method it calls must be explicitly
  in-transaction and must not invoke nested CAS methods that issue `BEGIN` themselves.
- The workflow tables declare no foreign keys, but bindings and runs hold immutable version ids.
  Preservation must be tested directly rather than inferred from SQLite.
- Unique constraints exist on Persona, Session Action, and workflow normalized names; on workflow
  version id; on `(workflow_id, version)`; and on `(workflow_id, source_draft_revision)`.
- An unpublished workflow may be deleted and its name reused. A snapshot containing the old id can
  therefore collide with a current different id under the same normalized name. Refuse before any
  safety or durable write.
- `reconcileSkills()` is already idempotent and updates the derived generation only when symlinks
  move. Cost has a surgical `writeOtelEnv` path but no startup reconciler yet.
- Registry initializes and incrementally updates four catalogs separately. Restore needs a bulk
  replacement boundary that updates all maps before one later global event is emitted in Phase 3.
- Most background services reread config on each tick or action. Pipelines and settings status have
  explicit refresh helpers that must run after commit.

## Implementation steps

### 1. Stage and migrate a selected snapshot

Extend `src/server/settings-backups/service.ts` with a staged-read pipeline. It accepts a snapshot id
and expected digest, resolves the id only through the Phase 1 store, rereads the regular file within
bounds, and verifies the digest again. A changed digest produces a specific stale-preview result.

Add envelope and per-domain migration functions beside the schemas in
`src/shared/settings-backups.ts` or a focused browser-safe migration module. The migration pipeline:

1. distinguishes corrupt bytes from a valid newer format;
2. upgrades every older readable envelope and entry version in deterministic order;
3. applies historical defaults for setting fields absent from an old entry;
4. rejects unknown newer domains, entry versions, or enum members;
5. returns one current normalized staged model that every later step consumes.

Do not mutate files during migration. Compatibility is a property of this read, not an in-place
upgrade of recovery evidence.

### 2. Produce a redacted preview and preflight result

Add shared preview/result schemas with bounded text. Preview reports:

- settings domain ids whose operator values change;
- counts of added, changed, archived, and reactivated Personas, Session Actions, Commands, and
  workflows;
- immutable workflow versions that will be inserted or retained;
- external effects that will be reconciled;
- exclusions, compatibility warnings, and blockers;
- the exact snapshot digest that a restore must echo.

It must not return Persona Markdown, Session Action prompts, argv arrays, repository allowlists, or
raw config payloads. Compare canonical normalized values rather than raw stored JSON key order.

Preflight the complete staged state before creating a safety snapshot:

- validate every config value and relational row against the current build's schemas and bounds;
- validate workflow drafts against the staged Persona and Session Action catalogs;
- validate workflow policy references such as a default workflow against the staged catalog;
- reject duplicate ids, normalized names, Command overrides, workflow version numbers, source draft
  revisions, or current-version pointers;
- compare an existing immutable version with the staged version byte for byte after canonical
  normalization;
- reject the old-id/new-id normalized-name collision and every immutable uniqueness conflict;
- ask Skills whether the desired symlink changes have known blockers;
- add a read-only Cost preflight that rejects an unparseable Claude settings file before the
  transaction. Missing files and failures only knowable during a write remain post-commit concerns.

The preview and preflight read current state from one synchronous daemon turn. Restore still repeats
them after acquiring the service mutex because preview is advisory until its digest and current
state are checked again.

### 3. Restore setting fields generically

Extend `src/server/settings-backups/config-registry.ts` with an in-transaction restore operation.
For every Phase 1 descriptor:

- parse the current stored value through the owning schema;
- migrate and parse the staged setting subset;
- replace a whole scalar setting or merge object fields classified `setting` over the current
  parsed object;
- preserve every `derived` and `operational` field from current state;
- validate the complete merged object through the owning schema before writing;
- skip the write when canonical setting values are unchanged.

All writes use the descriptor-aware DB helper against the exact database handle participating in
the outer transaction. Do not call high-level config setters that perform external I/O, emit events,
or open their own transaction.

This is the generic future-compatible path. A new descriptor field classified `setting` joins this
merge without a backup-service branch. A domain with additional external behavior names only its
post-commit reconciler; it does not replace generic durable restore.

### 4. Add one relational catalog restore adapter

Add a narrow bulk adapter to `src/server/workflows/store.ts`, or a focused module whose SQL executes
through that store's shared database handle. The adapter exposes preflight readers and one
`restoreSettingsCatalogsInTransaction` operation. It assumes the caller already opened the outer
transaction.

Apply catalogs in referential order:

1. **Personas and Session Actions.** For a snapshot id already present, restore exact authored
   values and archive state with `revision = max(current revision, snapshot revision) + 1`. For a
   missing id, insert the staged value with a valid positive revision. Archive current non-built-in
   rows absent from the snapshot and bump their revisions. Preserve `createdAt` from the identity
   being restored and set `updatedAt` to the restore time for changed rows.
2. **Commands.** Seed the fixed slot catalog through its existing store path if needed, then replace
   default argv, run budget, and the complete override set. Advance each changed slot above both the
   current and staged revision. Never create or delete a slot id outside the append-only shared slot
   registry.
3. **Workflow definitions.** Insert missing definitions without a current-version pointer first.
   Restore existing draft values as a forward revision. Archive current non-built-in definitions
   absent from the snapshot, including one with an active historical binding; the binding and its
   version remain valid, while new selection sees the archived definition.
4. **Immutable workflow versions.** Insert a missing exact row only after its definition exists. If
   its id or either unique tuple already names different canonical bytes, abort. Never update or
   delete a version, including versions newer than the snapshot.
5. **Current pointers and high-water marks.** Point each restored definition at the selected staged
   version after verifying that version exists. Set the restored draft revision above the current
   revision, staged revision, and every preserved version's `source_draft_revision`, so a later
   Publish cannot collide with historical source revisions. Later version numbers continue from
   the table's existing `MAX(version)` behavior.

Built-ins never enter the adapter. Validate the final catalogs inside the transaction before commit,
including draft references and current-version resolution.

### 5. Orchestrate safety snapshot and one transaction

The service restore method runs under the Phase 1 mutex:

1. reread, verify, migrate, and validate the selected file against the expected digest;
2. recompute preview and preflight against current state;
3. create and reread a verified `pre_restore` snapshot of current settings;
4. call `WorkflowStore.transact()` once;
5. apply generic config setting fields and relational catalogs through in-transaction helpers on
   the same SQLite connection;
6. validate the staged final relational state and commit;
7. run post-commit reconciliation and return restored metadata, safety snapshot id, and warnings.

If the safety write or its verification fails, no SQLite write begins. If any durable write or final
validation throws, the transaction rolls back completely and the safety snapshot remains. The
service never attempts a compensating second restore transaction.

Add a process-local in-progress result even though the mutex serializes calls, so Phase 3 can return
a specific conflict rather than queueing two human restores behind one another. Scheduled daily
capture may wait on an active restore; it must never overlap it.

### 6. Reconcile live and external projections after commit

Add a Registry bulk replacement method that accepts all four complete catalog maps. It computes the
new maps before assigning them and emits no per-row burst. Phase 3 emits the single
`settings_restored` invalidation only after this method and every synchronous refresh completes.

Post-commit reconciliation runs in a stable order:

- replace Persona, Session Action, Command, and workflow summary maps from the shared store;
- refresh Harness, Worktree, Pipeline, and settings-status projections through their existing
  owners or invalidation helpers;
- reconcile Skills from restored intent, allowing its derived generation to advance if the disk
  moved;
- reconcile Cost's telemetry block from restored intent through a new idempotent helper;
- return bounded warnings for unexpected filesystem failures while leaving persisted intent in
  force.

Call the Skills and Cost reconcilers best-effort during daemon startup as well. This is the retry
path for a post-commit external failure or a state directory copied to a fresh machine. Do not log
config payloads, paths beyond the existing safe status path, Markdown, or argv.

### 7. Keep the engine dormant until Phase 3

Construct Phase 2 dependencies through the existing singleton `SettingsBackupService`, but add no
route to `buildApp` and no browser event. Expose restore methods only to focused daemon tests. This
is intentional: Phase 1's automatic snapshots remain fully operable, while no external caller can
trigger a restore before browser invalidation and explicit confirmation land with the UI.

## Data, API, migration, and compatibility details

- No HTTP API is added in this phase.
- No SQLite schema migration is expected. If implementation inspection proves a small durable
  restore ledger is necessary for crash recovery, stop and reconcile the source plan before adding
  it; the approved design assumes the transaction plus safety file is sufficient.
- Snapshot migration functions are pure and append-only. V1 remains readable exactly as published
  by Phase 1.
- A build may restore an older readable snapshot after migration. It refuses a snapshot with an
  envelope, domain, or entry version it does not understand.
- The transaction writes only approved `app_config` setting fields and the six catalog tables. Every
  other table is byte-for-byte unchanged by the durable step.
- Post-commit reconciliation may change approved external files and derived config watermarks. Those
  changes are effects of restored intent, not rollback of operational history.
- The safety snapshot is retained even when the transaction rolls back, since it is valid evidence
  of the pre-attempt state and may aid diagnosis.

## Tests and verification

Add focused Node tests for:

- deterministic envelope and per-entry migrations, historical defaults, and refusal of newer
  versions;
- digest-bound preview and restore, including a file changed after preview;
- redacted preview counts with no Markdown, prompts, argv, allowlists, or full payloads;
- whole-staged-state validation and every duplicate, name, current-pointer, and immutable-version
  conflict;
- generic setting-field merge preserving Skills generation and current away state;
- a synthetic newly classified setting field restoring without a service branch;
- Persona, Session Action, Command, workflow definition, and immutable version forward restore;
- revision advancement above current and staged values, plus workflow draft revision above every
  preserved source revision;
- archive and reactivate behavior for rows created after or before the snapshot;
- active bindings and existing runs continuing to resolve their immutable versions;
- exact conflict refusal on version id, workflow version number, source draft revision, and reused
  normalized name;
- safety snapshot failure before transaction, durable throw rollback, final validation rollback,
  and preservation of the safety file;
- a before/after dump of tasks, sessions, schedules, bindings, runs, attempts, reviews, usage,
  leases, pipeline rows, archives, and ledgers proving they are unchanged;
- Registry bulk replacement with no per-row event burst;
- Skills and Cost preflight, successful reconcile, warning results, idempotency, and startup retry;
- service mutex behavior and a second restore receiving the in-progress result.

Run focused tests with the required preload, for example:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/settings-restore.test.ts
```

Then run:

```sh
npm run typecheck
npm run lint
npm test
```

No Playwright spec is required because the restore engine is not exposed and no visible browser
behavior changes in this phase.

## Merge and exit criteria

- Every readable snapshot is either fully staged or refused before a safety or durable write.
- A successful restore creates a verified safety snapshot, commits one SQLite transaction, advances
  revisions, preserves immutable versions and operational history, and refreshes live daemon state.
- A transaction failure changes no durable setting or catalog row.
- Post-commit external failures return warnings and are retried idempotently at startup.
- The restore engine has no public route or browser trigger.
- All focused and repository commands above pass.
- One reviewable pull request is green and merged before Phase 3 starts.

## Downstream handoff

Phase 3 may rely on:

- service methods for bounded list metadata, digest-bound redacted preview, and confirmed restore;
- stable success, incompatibility, stale-digest, in-progress, preflight-blocked, and I/O result codes;
- the safety snapshot id and bounded reconciliation warnings in a successful result;
- Registry bulk replacement having completed before the service reports success;
- no browser event having been emitted yet;
- the restore engine never accepting a path, only a validated snapshot id and expected digest.

Phase 3 must not duplicate validation, preview diffing, confirmation authority, transaction logic, or
reconciliation in routes or React. It exposes and renders the engine's existing results.

## Cross-phase audit record

- **2026-08-24, initial.** Audited against Phase 1's published contracts. The restore reader consumes
  v1 without changing its meaning, uses the same domain and config registries, and executes under
  the same service mutex and verified file store. The relational adapter owns every forward-mutation
  rule from the source plan. Repository inspection added refusal for normalized-name and immutable
  unique-tuple collisions, because the current schema cannot preserve both identities by archiving
  alone. Public exposure remains wholly assigned to Phase 3, preventing a temporary stale-browser
  surface.
- **2026-08-24, final reconciliation.** Rechecked against the completed Phase 3 document. Phase 2
  remains the only owner of migration, redacted preview computation, preflight, safety capture,
  transaction semantics, revision advancement, immutable history, and reconciliation. Phase 3 maps
  stable results to HTTP and emits only after this phase's success boundary.
