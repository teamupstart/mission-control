# Phase 1: Automatic logical snapshots

## Outcome

Mission Control creates one complete, versioned settings snapshot for each local calendar day the
daemon runs. The files live under `$MISSION_HOME/backups/settings/`, use owner-only permissions,
survive daemon restarts, and retain the newest 90 daily generations. The same writer can create
pre-restore safety snapshots under a separate 10-file budget, although Phase 1 has no restore caller
yet.

The phase also establishes the permanent coverage contract. Every supported `app_config` key and
every field of an object-valued config is classified. Every Settings control names its backup domain
or explicitly states why backup does not apply. A future setting is therefore included by the
generic path or keeps typecheck or a focused coverage test red.

**User-visible value:** complete daily recovery assets begin accumulating immediately, without a
browser being open and without including tasks, runs, leases, credentials, or operational ledgers.

## Entry criteria and direct phase dependencies

- No implementation phase dependency.
- The planning pull request must be merged so `plan.md`, `phased-plan.md`, and this file exist on the
  default branch.

### Inherited contracts

- Snapshot architecture is versioned logical JSON.
- Retention is 90 daily snapshots plus 10 pre-restore safety snapshots.
- The automatic-or-red guarantee applies to every supported Settings and persistence path.
- The daemon is the only database and backup writer.
- Snapshot scope includes all operator-owned configuration, active and archived Personas, Session
  Actions, Commands and overrides, workflow definitions, and immutable operator workflow versions.
- Snapshot scope excludes built-ins, credentials, tasks, sessions, schedules, bindings, runs,
  attempts, reviews, usage, leases, projections, and ledgers.

## Scope

- Add the exhaustive `app_config` descriptor registry and convert every generic config read and
  write to it.
- Add stable backup-domain ids, Settings control coverage metadata, and compile-time plus runtime
  coverage checks.
- Define snapshot format v1, bounds, metadata, canonical digest rules, and compatibility parsing.
- Capture every config and Library domain in the approved scope.
- Implement secure atomic file writes, bounded listing, integrity verification, and 90 plus 10
  retention.
- Start and stop a non-overlapping daily backup loop at the daemon's single-writer lifecycle
  boundary.
- Document automatic backup behavior, path resolution, privacy, scope, and retention.

### Explicit non-goals

- No restore, preview, or mutation from a historical file.
- No backup or restore HTTP routes.
- No Settings > Restore category and no visible dashboard changes.
- No import-from-path, cloud sync, encryption, compression, or full-database disaster recovery.
- No SQLite schema migration. Snapshot files are a new durable format; the source tables remain
  unchanged.
- Do not move Skills watermarks or away runtime state to new rows merely for backup. Field-level
  classification safely excludes them in place.

## Repository findings and starting contracts

- `src/server/db.ts` owns `getAppConfig` and `setAppConfig`, both currently typed with `string`.
- Config schemas already live in browser-safe modules: mostly `src/shared/protocol.ts`, with Task
  Sources in `src/shared/task-source.ts` and Pipelines in `src/shared/pipeline.ts`.
- `SkillsConfigSchema` includes setting fields `enabled` and `skills`, plus derived fields
  `generation` and `generationAt`.
- `AwayConfigSchema` includes setting fields `detectStalls`, `stallWorkingMinutes`,
  `stallUnfinishedMinutes`, and `stallEscalationMinutes`, plus operational fields `away` and
  `awaySince`.
- `WorkflowStore` is shared by all four relational catalog managers. Its public list methods merge
  built-ins, so snapshot capture must filter `builtin` rows and may need a narrow store-owned reader
  where public views omit persisted bytes.
- The service version reader is private to `src/server/routes.ts`; snapshot metadata needs the same
  value without importing the route module.
- `STATE_DIR` in `src/server/config.ts` is the only state-root answer. Tests redirect it through the
  required preload and `MISSION_HOME` fixture.

## Implementation steps

### 1. Establish one typed `app_config` registry

Create `src/shared/app-config-entries.ts`. It is browser-safe and owns stable descriptors, not
storage I/O. A descriptor contains its key, schema, snapshot entry version, backup domain id, and
classification.

For every object-valued schema, require an exhaustive field map using a shape equivalent to:

```ts
const fields = {
  enabled: "setting",
  generation: "derived",
} satisfies Record<keyof ExampleConfig, AppConfigValueClass>;
```

Do not accept a partial map. Scalar values such as `foreman.instructions` and whole operational
values may use one whole-value classification. The initial partition is:

| Key | Snapshot treatment |
| --- | --- |
| `harnesses`, `worktrees`, `cost`, `foreman`, `workflows`, `taskSources`, `llm`, `instructions.standing`, `inspector`, `shipping`, `pipelines`, `ui` | Every schema field is `setting` |
| `foreman.instructions` | Whole scalar value is `setting` |
| `skills` | `enabled` and `skills` are `setting`; `generation` and `generationAt` are `derived` |
| `away` | stall policy fields are `setting`; `away` and `awaySince` are `operational` |
| `foreman.lease` | Whole value is `operational` |
| `backlog.plan` | Whole value is `derived` |
| `costTelemetryEnabledAt` | Whole value is `derived` |
| `costOtelLastSeen` | Whole value is `operational` |

Change `getAppConfig` and `setAppConfig` to accept descriptors rather than raw keys and infer their
value types. Convert every caller, including operational writers in `db.ts`, Cost, Foreman, backlog,
and all focused tests. Keep any raw key helper private to `db.ts`; no exported escape hatch may
restore the silent omission path.

The config owner remains responsible for defaults and update semantics. The registry describes what
is stored and backed up; it must not become a second implementation of each settings module.

### 2. Connect Settings controls to backup domains

Create `src/shared/settings-backup-domains.ts` with append-only domain ids, a
`surface: "settings" | "library"` classification, and the `SettingsBackupCoverage` union approved
in the source plan.

Extend `SettingsControl` in `src/web/lib/settings-search.ts` with mandatory `backup` metadata:

- `{ kind: "domain", domains: [...] }` for persisted controls;
- `{ kind: "not-applicable", reason: ... }` for read-only health, derived status, and operational
  actions.

Give generated harness and keyboard controls coverage in their generator so every generated row
inherits it. Map the UI-backed Display, Keyboard, and Dispatch controls to `ui`; map each daemon
panel to its owner domain; classify Worktree pool actions, health views, and similar non-settings
controls explicitly.

Add coverage tests beside `test/settings-search.test.ts` that prove:

- every control has metadata and every Settings-surface domain is referenced;
- every referenced domain resolves exactly once;
- every Library-surface domain is registered for capture but need not have a Settings control;
- every config setting field belongs to one domain;
- there are no unknown or orphan Settings domains;
- the existing rendered-anchor and category tests still pass.

Use a compile-time fixture or `@ts-expect-error` contract test to prove a new control and a new
object schema field cannot omit their required classifications.

### 3. Publish snapshot format v1

Create `src/shared/settings-backups.ts` with:

- format id and readable-version tuple, initially v1;
- `daily` and `pre_restore` kinds;
- snapshot id and filename schemas;
- `createdAt`, local date, producing app version, entry versions, normalized domain payloads,
  bounded counts, and SHA-256 digest;
- compatibility results that distinguish ready, corrupt, unreadable, and produced-by-newer-build;
- hard limits on file bytes, file count, text fields, catalog rows, and list results;
- canonical JSON ordering used as the exact digest input.

Domain ids and persisted vocabulary are append-only. A future build adds a reader or migration for
an older version; it never changes what v1 bytes mean. Unknown newer envelope, entry, or domain
versions are incompatible rather than corrupt.

Move the package-version reader from `src/server/routes.ts` into a small server helper consumed by
both routes and the backup service. Preserve the current `unknown` fallback.

### 4. Capture normalized config and Library catalogs

Create `src/server/settings-backups/config-registry.ts`. Enumerate `APP_CONFIG_ENTRIES` rather than
maintaining a second key list. For an object descriptor, parse the current value through its owning
schema and select every field classified `setting`; defaults therefore appear in a snapshot even if
the KV row predates them. Exclude derived and operational fields.

Create `src/server/settings-backups/catalogs.ts`. Capture through the shared `WorkflowStore` or a
narrow store-owned export method:

- every active or archived non-built-in Persona with exact Markdown, model choice, revision, times,
  and import provenance;
- every active or archived non-built-in Session Action;
- all fixed Command slot values and repository overrides;
- every active or archived non-built-in workflow definition;
- every row-backed immutable version for those workflow ids.

Use shared schemas to validate the normalized output. Sort maps and arrays by stable ids before
canonicalization. Do not capture built-in rows merged by display helpers, and do not follow bindings
or runs from a version.

### 5. Write, verify, list, and retain files securely

Create `src/server/settings-backups/store.ts` with the one backup root:

```text
join(STATE_DIR, "backups", "settings")
```

The store:

- creates directories with mode `0700` and files with mode `0600`;
- writes a sibling random temp file, flushes it, closes it, atomically renames it, then verifies the
  final file before pruning;
- uses `daily-YYYY-MM-DD.json` for the idempotent daily generation and a UTC timestamp plus random
  suffix for safety files;
- accepts ids and owned filename shapes only, never an arbitrary path;
- uses `lstat`, refuses symlinks and non-regular files, bounds bytes before parsing, and verifies
  schema and digest on every list/read;
- lists newest first with metadata only, retaining unreadable and incompatible entries as
  diagnostic rows;
- prunes daily and safety kinds independently after a verified write, keeping 90 and 10;
- removes only an exact temp file it created after a failed write.

Follow the containment, no-follow, bounded-read, and atomic-publication patterns in
`src/server/archives/`, but keep settings backups under their own owner. The archive library is a
different portable format and must not become a second settings-backup root.

### 6. Add the service and daily lifecycle

Create `src/server/settings-backups/service.ts` as the only composer of config capture, catalog
capture, envelope creation, and file storage. Serialize capture operations through one process-local
mutex. Phase 1 methods cover `ensureDailySnapshot`, explicit internal safety capture for the next
phase, list/verify for tests, and bounded last-error status.

Create `src/server/settings-backups/loop.ts` using the established loop shape:

- injected clock, timer, and local-date helpers;
- an immediate first tick after start;
- one daily generation for the current local date;
- next-midnight calculation capped by a short health interval so sleep, DST, and clock jumps are
  re-evaluated;
- no overlapping ticks, contained errors, `unref()`, and a stop closure.

Construct one service in `src/server/index.ts` after the shared catalog managers exist. Start its
loop inside the successful `serve` callback and stop it during shutdown. A day when the daemon never
runs has no fabricated file; the next launch captures the current date.

### 7. Document the shipped backup behavior

Update `docs/configuration.md`, `docs/skills-and-settings.md`, and the relevant feature list in
`docs/README.md` with the default path, `MISSION_HOME` behavior, daily semantics, included and
excluded data, owner-only local privacy warning, and 90 plus 10 retention. State that restore UI is
not yet shipped in this phase only if the documentation lands separately before later phases; the
final phase removes that transitional sentence.

## Data, format, and compatibility details

- No SQLite migration is added.
- The format carries only normalized logical values. It never serializes table names as restore
  instructions or raw `app_config` rows.
- Missing object fields in an older stored config receive current schema defaults before capture.
- Missing fields in a future restore are handled by the per-entry migration contract owned by
  Phase 2; Phase 1 only publishes v1 and parses it faithfully.
- Setting values in mixed objects are independent from runtime values. For example, a safety
  snapshot can remember enabled Skills without claiming a historical reload generation.
- Absolute repository paths and Persona provenance are private configuration and remain in the
  owner-only file because they are required to reproduce behavior.

## Tests and verification

Add focused Node tests for:

- the exact initial `app_config` partition and exhaustive field maps;
- raw string keys rejected by types and every existing caller using a descriptor;
- setting fields automatically captured, with synthetic derived and operational fields excluded;
- Settings control/domain coverage, dynamic controls, explicit non-applicable reasons, and Library
  domain registration;
- active and archived catalog capture with built-ins and operational history absent;
- deterministic canonical bytes and digest golden vectors;
- envelope v1 round-trip, bounds, corrupt digest, unknown newer version, and malformed entries;
- owner-only directory/file modes, symlink refusal, bounded reads, temp-write failure, atomic
  replacement, idempotent daily filenames, and independent 90 plus 10 pruning;
- immediate daily tick, non-overlap, thrown tick recovery, stop behavior, DST, sleep, backward and
  forward clock jumps, and one file per local date;
- `MISSION_HOME` isolation and no access to an operator home from tests.

Use the repository's required isolated single-file form for focused tests:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/settings-backups.test.ts
```

Then run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No Playwright spec is required because this phase changes no browser-visible behavior. The browser
registry metadata is a compile-time contract and renders no new content.

## Merge and exit criteria

- A daemon started against a fresh isolated home creates and verifies today's logical snapshot.
- That snapshot includes every approved config and Library domain and no excluded operational row.
- File permissions, atomicity, digest validation, bounds, symlink refusal, and retention are pinned
  by tests.
- Adding a schema field without classification or a Settings control without backup coverage makes
  typecheck fail; a `setting` classification requires no backup-service edit.
- All focused and repository commands above pass.
- Documentation matches the behavior merged in this phase.
- One reviewable pull request is green and merged before Phase 2 starts.

## Downstream handoff

Phase 2 may rely on:

- published format v1 and its exact canonical digest bytes;
- stable `SettingsBackupDomainId` and entry versions;
- the exhaustive `APP_CONFIG_ENTRIES` field partition;
- the service mutex, capture method, safety kind, verified-read API, and store bounds;
- one shared `WorkflowStore` for every relational catalog;
- daily and safety retention budgets of 90 and 10.

Phase 2 must not change v1 meanings, add a parallel config inclusion list, restore derived or
operational fields, or write outside the daemon. Any needed old-to-new transformation is an explicit
reader migration rather than a rewrite of an existing file.

## Cross-phase audit record

- **2026-08-24, initial.** Audited against the source plan and phased index. This phase owns every
  capture, format, file-safety, retention, daily lifecycle, and coverage-invariant requirement. It
  deliberately leaves restore dormant for Phase 2 and public exposure for Phase 3. Mixed Skills and
  away values are handled by exhaustive field maps, preserving the source plan's exclusions without
  weakening the future-settings guarantee. Library domains are captured and classified separately
  from Settings-surface control coverage.
- **2026-08-24, final reconciliation.** Rechecked after all three phase documents were written.
  Phase 1 remains the only owner of format v1, canonicalization, capture, file security, retention,
  daily scheduling, and automatic-or-red coverage. Phase 2 consumes these contracts without
  redefining them, and Phase 3 exposes them without adding a second writer or inclusion list.
