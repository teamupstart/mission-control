# Phase 1: portable library and disposable index

## Outcome and value

Mission Control can discover, validate, search, read, open, and delete portable scout bundles under
the user's local Mission Control home without relying on an original task, session, worktree, or
SQLite row. A valid bundle copied from another user appears through the daemon API after background
reconciliation. Removing `harness.db` causes the same reconciler to rebuild the derived index.

This phase is intentionally headless. Existing scouts do not yet produce bundles automatically and
the dashboard does not yet expose the Scouts page. The HTTP surface and filesystem behavior make the
foundation independently testable and useful to external local tooling.

## Entry criteria and direct dependencies

- Direct phase dependencies: none.
- The planning pull request containing `plan.md`, `phased-plan.md`, and this file must be merged to
  the default branch before implementation starts.
- Re-read `AGENTS.md`, `docs/agent-guides/architecture.md`, and
  `docs/agent-guides/change-contracts.md`, especially database, shared event, and daemon ownership
  rules.

## Scope

In scope:

- version 1 portable manifest and canonical digest contracts;
- local archive root and durable producer namespace;
- contained, nonexecuting bundle validation and visible-text extraction;
- disposable SQLite archive, artifact, and search tables;
- serialized bootstrap, watch-hint, and recurring reconciliation;
- bounded list, detail, artifact read, artifact open, and delete routes;
- server-side atomic deletion and recovery;
- `scout_archive_changed` invalidation and an inert browser revision counter;
- server and shared tests, packaging, and storage documentation needed for the foundation.

Explicit non-goals:

- changing scout prompts or the HTML-report skill;
- adding `submit_scout_artifacts` or capture-job persistence;
- gating task completion, exit handling, or worktree reclaim;
- adding any visible dashboard page, topbar item, search UI, report reader, or delete modal;
- importing historical task rows or transcripts;
- adding a remote sync implementation, accounts, signatures, or trust badges.

## Repository findings and inherited contracts

This phase owns C1-C5 and the server half of C12 from `phased-plan.md`.

- `STATE_DIR` and `DB_PATH` live in `src/server/config.ts`; new paths must honor the same
  `MISSION_HOME` override rather than resolving the operating-system home independently.
- `openDb()` in `src/server/db.ts` runs base `CREATE TABLE IF NOT EXISTS` statements on old and new
  databases before additive migrations. These are all-new tables, so they belong in the base schema
  with indexes created only after their columns exist. Do not manufacture a column migration.
- Server stores such as `src/server/ensembles/store.ts` keep durable row parsing and transactions
  separate from policy managers. Follow that ownership shape for the derived index.
- `buildApp` in `src/server/routes.ts` is already called by many focused tests with positional
  dependencies. Add the scout manager at the end or move to a compatible options shape without
  breaking callers unrelated to scouts.
- Background services in `src/server/task-sources/sweeper.ts` and `src/server/schedules/loop.ts` use
  serialized self-rescheduling timers with a stop closure. A filesystem watcher is only a hint; the
  recurring scan remains authoritative.
- `ServerEvent` is exhaustive across `src/shared/types.ts` and `src/web/useEventStream.ts`. Historical
  scout rows are too large for the snapshot. Only an invalidation counter crosses that boundary.
- `src/server/session-files.ts` demonstrates realpath, lstat, symlink, regular-file, and bounded read
  defenses. Its API is session-root-specific, so archive containment must have its own owner or use
  a small extracted generic primitive with equivalent tests.
- `openFile` and the existing registered-target routes show how the daemon opens a verified local
  file without accepting an arbitrary path from the browser.

## Implementation steps

### 1. Define the portable contract

Add `src/shared/scouts.ts` as the browser-safe contract owner. Define:

- the literal format name `mission-control/scout-archive` and append-only version tuple containing
  version 1;
- producer UUID, archive UUID, composite archive key, generated repository slot, artifact ID,
  capture status, index status, artifact role, missing-evidence entry, provenance, manifest, compact
  summary, detail, search filter, cursor, and route response types;
- the opaque archive-key encoder and decoder used by both server routes and the browser. The decoder
  validates generated UUID components before any path is joined;
- constants for 32 MiB primary HTML, 128 MiB and 256 files in the report folder, 64 MiB per explicit
  file, 512 explicit entries, and 512 MiB per bundle;
- a format-version-specific canonical digest function over the sorted `(archive_path, bytes,
  sha256)` table. It excludes `manifest.json` and emits lowercase `sha256:<hex>`.

Keep strict inbound request schemas in `src/shared/protocol.ts`. Manifest parsing may preserve and
ignore unknown fields for a known version, but unknown versions must return a typed unsupported
result that can be indexed as unreadable. Add fixtures and golden digest vectors that can be copied
by a non-TypeScript implementation.

The manifest must never contain absolute home, worktree, task, session, or transcript identity.
`report/report.html` is the only allowable primary path for a complete archive. A partial manifest
may have no primary artifact only when `missing` explains why.

### 2. Establish local paths and producer identity

Extend `src/server/config.ts` with:

- `SCOUTS_DIR = join(STATE_DIR, "scouts")`;
- a producer identity path outside `SCOUTS_DIR`, such as
  `join(STATE_DIR, "scout-producer.json")`;
- a production reconciliation cadence of a jittered 60 seconds and a scoped test override such as
  `MISSION_SCOUT_RECONCILE_MS`;
- no second home-directory resolver and no remote location.

Add `src/server/scouts/producer.ts`. It creates the state and scout roots with private local
permissions, reads or atomically creates one cryptographically random UUID, and stores only an
optional operator-facing machine label beside it. Losing this file creates a new namespace for
future archives but never renames existing producer directories.

Do not place the producer file inside the syncable archive root. Imported bundles retain the
producer identity in their own path and manifest.

### 3. Build contained bundle parsing and static HTML validation

Create focused modules under `src/server/scouts/`, separating mechanisms:

- `paths.ts`: generated archive roots, POSIX manifest path normalization, containment checks,
  no-symlink traversal, regular-file checks, media-type mapping, and bounded reads;
- `manifest.ts`: schema parsing, path-to-identity agreement, artifact uniqueness, primary selection,
  byte and digest checks, canonical digest verification, and safe unreadable diagnostics;
- `html.ts`: nonexecuting HTML parsing, static report validation, and bounded visible-text
  extraction;
- `bundle.ts`: one verified representation used by both reconciliation and routes.

Add one server-only standards-based HTML parser to `package.json` and the lockfile. It must parse
bytes without evaluating script, loading resources, opening Electron, or instantiating a browser.
Keep it out of browser bundles and verify it survives the daemon and Electron package build rules.

For version 1, reject scripts, inline event handlers, forms, form actions, frames, executable embeds,
meta refresh, external and protocol-relative URLs, runtime-built content, and relative references
that escape `report/`. Allow inline CSS, inline SVG, fragment links, normalized report companions,
and bounded `data:` images. Extract visible text only after removing noncontent and hidden nodes.
Never follow a link during indexing.

Every read and open resolves a generated archive key and artifact ID to a server-verified path.
Never trust `archive_path` alone, accept an absolute path from a request, or follow a symlink found
after the initial scan.

### 4. Add the disposable SQLite store

In `src/server/db.ts`, add all-new tables and their dependent indexes:

- `scout_archives`: producer ID plus archive ID identity, format version, content digest, frozen
  display fields, `ready | partial | unreadable` status, relative bundle path, manifest fingerprint,
  counts, bytes, safe error, reconciliation epoch, and created, completed, indexed, and last-seen
  timestamps;
- `scout_artifacts`: archive identity, generated artifact ID, role, repository slot, original
  relative path, verified relative archive path, media type, bytes, digest, and presentation fields;
- `scout_search_segments`: archive identity, stable ordinal, source kind, and normalized bounded text.

Do not add foreign keys to tasks or sessions. Do not put completed evidence bytes or manifests in
SQLite. Make format versions, statuses, roles, and source kinds append-only persisted vocabulary.

Add `src/server/scouts/store.ts` for row parsing and transactions. Required operations include:

- transactional replace of all derived rows for one verified final bundle;
- unreadable-row replacement with a bounded safe diagnostic;
- complete-pass pruning by relative path and reconciliation epoch;
- stable bounded list/search using an opaque cursor and deterministic ordering;
- detail and artifact metadata lookup by composite key;
- transactionally removing all rows for one deleted key;
- literal normalized search over bounded segments without requiring optional FTS5 support.

Use prepared statements and cap query, filter, cursor, and result sizes at the schema boundary.
Search metadata, title, question, summary, tags, repository labels, visible report text, and original
artifact paths. Never parse HTML during a query.

### 5. Implement incremental reconciliation

Add `src/server/scouts/reconciler.ts` with one serialized state machine:

1. Trigger from nonblocking bootstrap, a debounced filesystem watch hint, explicit local publish
   notification, or the recurring jittered cadence.
2. Walk exactly `SCOUTS_DIR/<producer-id>/<archive-id>/manifest.json`, excluding `.staging`,
   `.trash`, symlinks, hidden unexpected depth, and non-generated components.
3. Compare relative manifest path, size, and nanosecond modification time with the stored
   fingerprint. Skip report and artifact bodies for unchanged rows.
4. For a new or changed key, require the candidate fingerprint to remain stable across two
   observations. A partially copied bundle stays pending and invisible rather than briefly corrupt.
5. Validate the settled manifest, paths, bytes, digests, HTML, and same-key identity. Upsert the
   derived rows in one transaction, or store one safe unreadable row for stable invalid input.
6. If an existing final key changed to a different valid digest, record an immutable-key conflict as
   unreadable. Never pick or overwrite one candidate.
7. After a complete successful walk, remove index rows whose relative final path was not observed.
8. Emit one invalidation only when a batch changed derived state.

Coalesce overlapping triggers. Catch and report a pass failure without killing the timer or daemon.
Expose a stop closure that closes the watcher and timer during normal shutdown. A watch overflow or
unsupported platform must degrade to cadence scanning, not disable reconciliation.

Wire the service in `src/server/index.ts` after the daemon is serving, so a large empty-database
rebuild cannot block normal startup. The initial pass runs immediately in the background. Ensure all
async work is serialized and no Foreman process touches these tables.

### 6. Expose bounded routes and invalidation

Add a `ScoutArchiveManager` or equivalent server policy owner over the store, verifier, reconciler,
open-target registration, and deletion mechanism. Inject it into `buildApp` without creating store
access inside routes.

Implement strict schemas and thin adapters for:

```text
GET    /api/scouts
GET    /api/scouts/:archiveKey
GET    /api/scouts/:archiveKey/artifacts/:artifactId
POST   /api/scouts/:archiveKey/artifacts/:artifactId/open
DELETE /api/scouts/:archiveKey
```

The list endpoint accepts bounded literal query, producer, repository, agent, status, date, cursor,
and limit filters and returns compact summaries plus snippets. Detail returns provenance,
completeness, missing entries, verified primary identity, and artifact metadata, never every body.
Artifact reads set safe content type, disposition, and size headers from verified metadata. Open
registers only a currently verified contained target.

Delete requires `{ "confirmArchiveKey": "..." }` and rejects a mismatch before path resolution. The
manager verifies the generated final path, atomically renames only that bundle into `.trash`, removes
its derived rows, emits one invalidation, and then removes the trash entry. On restart, finish or
roll forward an interrupted trash operation. Do not remove task or session rows. Do not emit a
portable tombstone. If an external sync restores the bundle later, reconciliation indexes it again.

Add `scout_archive_changed` to the append-only `ServerEvent` union and a Registry invalidation
method. Update `src/web/useEventStream.ts` exhaustively with `scoutsRevision`, incrementing on the
event and reconnect. It remains unused until Phase 3 and must not add scout history to the snapshot
or start browser polling.

### 7. Document local storage and recovery

Update the documentation index and a focused product reference with:

- `$STATE_DIR/scouts/<producer-id>/<archive-id>/` and the default
  `~/.mission-control/scouts/` path;
- the fact that bundles are local, unencrypted by Mission Control, directly copyable, and may leave
  the machine only through operator-selected tools;
- SQLite as a disposable query cache, automatic background discovery, and empty-database recovery;
- version 1 layout, immutable-key behavior, cadence, partial-copy settling, limits, and API deletion;
- the absence of historical transcript or task import.

Do not add archive examples, reports, or screenshots to the repository as evidence.

## Data, API, migration, and compatibility details

- **Filesystem authority:** final bundle directories are durable evidence. SQLite is only a local
  projection. The producer file affects new writes only.
- **Old databases:** all scout tables are new `CREATE TABLE IF NOT EXISTS` definitions. Add an
  old-database test that opens a pre-feature schema and proves existing task data remains intact.
- **Empty or replaced databases:** the daemon serves first, then the background pass reconstructs all
  rows. No prompt, settings action, or blocking migration is introduced.
- **Wire compatibility:** one append-only invalidation event and response types are added. Existing
  snapshots do not grow. The exhaustive browser reducer understands the event before a visible page
  consumes its revision.
- **Imported data:** producer labels and provenance are untrusted descriptive strings. Version,
  identity, path, digest, and size validation authorize behavior.
- **No conflict overwrite:** independently generated UUID namespaces prevent normal collisions.
  Exact copies are idempotent. A same-key, different-digest mutation is unreadable.
- **Deletion:** the archive key is bound at both request and filesystem layers. Deleting the local
  bundle does not claim that external sync copies are gone.

## Tests and verification

Add focused `node:test` coverage for:

- shared manifest fixtures, unknown-field handling, unsupported versions, path normalization,
  primary-report selection, partial manifests, canonical digest vectors, and exact-copy identity;
- producer identity persistence and regeneration without orphaning existing namespaces;
- regular-file containment, symlink swaps, traversal, special files, generated IDs, limits, digest
  mismatches, static HTML rules, and visible-text extraction;
- fresh schema and a pre-feature database opening safely with existing task rows preserved;
- store pagination, literal search across each segment kind, filters, nullable provenance,
  producer separation, unreadable rows, and task-deletion independence;
- nonblocking bootstrap, unchanged fingerprint skips, new and changed discovery, pending two-pass
  settle, cadence, watch hints, coalescing, missing-path pruning, empty-database rebuild, and
  same-key digest conflicts;
- list, detail, body, open, and delete routes, including auth, bounds, headers, path refusal, key
  confirmation, unreadable deletion, interrupted trash recovery, and no task cascade;
- `ServerEvent` exhaustiveness and reconnect/event revision bumps.

Relevant commands:

```sh
node --test --import tsx test/scout-format.test.ts
node --test --import tsx test/scout-store.test.ts
node --test --import tsx test/scout-reconciler.test.ts
node --test --import tsx test/scout-http.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No visible dashboard surface changes in this phase, so no Playwright spec is introduced. If the
implementation makes any user-visible UI change beyond an unused revision value, add the required
built-dashboard Playwright coverage in this phase.

## Merge and exit criteria

- A valid local or foreign version 1 bundle becomes searchable through the API after background
  settle and remains readable after its source checkout and all related task rows are absent.
- Removing only SQLite and restarting reconstructs the same bounded summaries, search hits, detail,
  and artifact access without prompting the user or blocking startup.
- An unchanged bundle does not reparse report or supporting file bodies on normal startup.
- Same-key different-digest input never overwrites a final directory or silently changes evidence.
- API deletion removes exactly one verified local bundle and its derived rows and leaves task and
  session data untouched.
- Existing dispatch, scout, ship, database, snapshot, and dashboard behavior is unchanged.
- Focused tests and repository-required gates are green, and the pull request contains no operator
  data or evidence artifact.

## Downstream handoff

Phase 2 may rely on C1-C5 and the server half of C12: generated archive identity, producer storage,
shared manifest and digest code, staging/final path helpers, contained verifier, index store,
reconciler notification, and thin route manager. It adds capture jobs and is the only later phase
allowed to publish Mission Control-created bundles.

Later phases must not put task/session foreign keys on completed archives, write report bytes into
SQLite, introduce a second library root, bypass atomic staging, weaken external-bundle validation, or
change version 1 digest and identity semantics. A new format would be append-only and out of scope.

## Cross-phase audit record

- 2026-08-12: initial phase draft owns the entire portable read side so it is operable without the
  task-lifecycle phase.
- 2026-08-12: capture-job persistence was moved to Phase 2. It is not needed to rebuild or read a
  completed bundle and would otherwise leave a dormant operation ledger in Phase 1.
- 2026-08-12: server deletion remains here because it is part of filesystem lifecycle and recovery.
  Phase 3 adds the approved confirmation and selection behavior without inventing another delete
  mechanism.
- 2026-08-12: the invalidation event and revision move together here to preserve shared-event
  exhaustiveness. The revision is inert until Phase 3.
