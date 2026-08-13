# Phase 1: The kind-agnostic archive library

Source plan: [`plan.md`](./plan.md), rendered at [`plan.html`](./plan.html).
Index: [`phased-plan.md`](./phased-plan.md).

## 1. Outcome and value

The durable bundle library stops being scout-shaped and becomes a library of archives that each
declare what they preserve. After this phase the format, the root directory, the index tables and
the module that owns them are all neutrally named and carry a `kind` discriminator, and the
archive HTML validator permits a clickable external reference link while continuing to refuse
every automatic fetch.

**No behaviour changes for a person.** A scout dispatched after this phase is captured, indexed,
listed, read and deleted exactly as before, and archives written before this phase remain
discoverable. That is the whole review criterion: the existing scout suite must pass against the
renamed library.

The value is that the next phase to need durable storage - and the Archives reading UI that
`docs/scout-archives.md` still defers - inherits a container whose name matches what it holds.
This is affordable **only because no reading UI exists yet**; every surface built against the
scout name raises this cost.

## 2. Entry criteria and direct phase dependencies

**Direct dependencies: none.** This phase shares no decision or file ownership with Phase 2 and
the two may merge in either order.

Entry criteria:

- The planning pull request has merged, so `docs/plans/plan-kind/` resolves on the default branch.

## 3. Scope and explicit non-goals

In scope:

- A new archive format string and a `kind` field in the manifest, with the legacy format
  remaining readable forever.
- A new library root, with the legacy root remaining discoverable.
- The three disposable index tables renamed and given a `kind` column.
- The capture-job ledger renamed **with a real migration**, because it is the one scout table
  that cannot be rebuilt from disk.
- The `urlProblem` navigational relaxation.
- Module and symbol renames in `src/shared/` and `src/server/`.
- `docs/scout-archives.md` renamed and rewritten to describe a kind-discriminated library.

Explicit non-goals:

- **No plan capture.** Nothing writes a `kind: "plan"` bundle in this phase. Phase 4 does. The
  discriminator is introduced with exactly one legal value in the write path (`scout`) so this
  phase is provably behaviour-preserving.
- **No Archives reading UI.** Still deferred.
- **No rewriting of published bundles.** Nothing on disk is moved, re-signed or re-serialized.
- **No change to scout submission auth.** `scout-submission.key`,
  `scout-submission-credentials/` and `submit_scout_artifacts` stay scout-named and
  scout-scoped, because a plan is captured from its checkout at teardown and never submits
  through the agent-facing MCP tool. Renaming them would be churn with no consumer.
- **No change to `SCOUT_REPORT_ROOT`** (`docs/reports/<slug>/report.html`). That is the scout
  *checkout* convention, not the archive format, and it stays with the scout kind.

## 4. Repository findings and inherited contracts

Verified against the planning checkout. Re-check before editing.

**The append-only constraint is the governing finding.** `src/shared/scouts.ts:3-23` declares
itself the format owner and states that renaming a persisted value "orphans evidence that no
migration can reach, because the evidence is not in this database". Every published
`manifest.json` on every machine carries `format: "mission-control/scout-archive"`
(`src/shared/scouts.ts:26`, written at `src/server/scouts/capture.ts:824`). It follows that the
legacy identifier is never redefined and never rewritten - it keeps its exact current meaning and
stops being produced.

- `SCOUT_ARCHIVE_FORMAT_VERSIONS = [1]` (`:36`) is the readable set; `SCOUT_ARCHIVE_FORMAT_VERSION
  = 1` (`:40`) is what this build writes. `ManifestV1Schema` (`:548`) is deliberately **not**
  `.strict()` (rationale at `:540-547`): unknown fields are ignored so a newer build can add a
  field inside version 1.
- **Four tables, not three.** `scout_archives` (`db.ts:1569`), `scout_artifacts` (`:1623`),
  `scout_search_segments` (`:1641`) are the disposable index. `scout_capture_jobs` (`:1661`) is
  not: it is the idempotency and resume ledger, keyed `operation_key = <taskId>:<episodeId|->`,
  and its `repos_json` holds server-derived checkout roots "recorded while the session still
  exists, because the whole point of reserving on exit is that they are about to stop being
  derivable" (`db.ts:1661-1678`).
- **There are zero scout entries in `migrate()`.** Every scout column exists only in the
  `CREATE TABLE IF NOT EXISTS` block. This phase writes the first scout-family migration.
- The disposable half needs no data migration by design: `src/server/scouts/reconciler.ts:20-24`
  states "the FILESYSTEM is the library, and SQLite is a cache of it… A database that was deleted
  simply has no fingerprints, so every bundle looks new and the whole index rebuilds in the
  background."
- `SCOUTS_DIR = join(STATE_DIR, "scouts")` (`src/server/config.ts:39`) with the comment "Nothing
  else in the daemon may resolve a library root; a second one would silently split the catalog."
  That comment governs how the second root is introduced: one owner that resolves both, not two
  callers each resolving one.
- `SCOUT_PRODUCER_PATH = join(STATE_DIR, "scout-producer.json")` (`config.ts:~50`) is deliberately
  **outside** the library root so sync tools do not copy it. The producer id is this machine's
  identity and appears inside every manifest this machine has written.
- `urlProblem` (`src/server/scouts/html.ts:354`) rejects every scheme in every slot.
  `navigational` is already computed at `html.ts:198` for `href`, `action`, `formaction`, `ping`
  and is currently used only to refuse `data:` link targets (`:366-368`). The hook the relaxation
  needs already exists.
- `test/fixtures/scout-archive/golden-digests.json` is hand-committed with no generator, and
  `test/scout-format.test.ts:257-279` asserts `golden.format === SCOUT_ARCHIVE_FORMAT`. The
  digests are taken over content paths only and are unaffected by a format-string change, but
  that equality assertion breaks immediately.
- `src/shared/` may not import `node:` (project rule). The shared format module stays browser-safe.

## 5. Implementation steps, in execution order

1. **Introduce the kind vocabulary in the format.** In the shared format module add an
   append-only `ARCHIVE_KINDS` vocabulary whose initial members are `scout` and `plan`, and a new
   format string `mission-control/archive` at version 1. Keep `SCOUT_ARCHIVE_FORMAT` exported and
   documented as the legacy identifier that is still read and never written.
2. **Teach the manifest parser both formats.** `parseScoutManifest` (`:631`) settles the version
   before the shape; extend it to settle the *format* first. A legacy manifest parses to a
   manifest whose `kind` is `scout`; a new-format manifest requires an explicit `kind` drawn from
   the vocabulary. Add `wrong_kind` to `SCOUT_MANIFEST_PROBLEMS` (`:511`) - that list is
   append-only, so add, never reorder.
3. **Write the new format only.** `serializeScoutManifest` (`:831`) emits the new format string
   and the `kind`. Nothing rewrites an existing manifest.
4. **Resolve two roots behind one owner.** Add the new root beside `SCOUTS_DIR` in
   `src/server/config.ts`, honouring the existing comment by making the manager the single
   resolver: the write path targets the new root, the discovery path walks both. A legacy bundle
   keeps its path and its format forever.
5. **Rename the three disposable tables** to `archives`, `archive_artifacts` and
   `archive_search_segments`, each with a `kind` column, and rename their indexes to match. Their
   migration is **drop and let the reconciler rebuild**, which is the property the subsystem was
   designed around. Do not attempt a row copy; a copied row would carry a fingerprint that no
   longer corresponds to a verified read.
6. **Migrate the capture-job ledger properly.** Rename `scout_capture_jobs` to
   `archive_capture_jobs`, add a `kind` column defaulting to `scout`, and **copy the rows** in
   `migrate()`. This is the one table where dropping loses something real: an in-flight capture
   that was reserved but not published would lose its resume path across the upgrade, and
   `repos_json` is not re-derivable once the session is gone. Keep the migration next to its
   upgrade path per the project's schema rule.
7. **Relax the validator.** In `urlProblem` (`html.ts:354`), permit `http:` and `https:` when
   `context.navigational` is true, and keep refusing every other scheme in every slot and all
   schemes in fetching slots. Leave the `data:` navigational refusal exactly as it is. Update the
   doc comment at `:345-353` to state the distinction the relaxation rests on: an automatic fetch
   happens when the page opens, a navigation happens only when a person clicks.
8. **Rename the modules and symbols.** `src/shared/scouts.ts` becomes the neutral format module;
   `src/server/scouts/` becomes `src/server/archives/`. The scout-semantic modules -
   `repos.ts`, `task-gateway.ts`, `submission-auth.ts`, `submission-tool.ts`, `prompt.ts` - keep
   their scout meaning; place them so that "generic bundle mechanics" and "what a scout is" are
   visibly separate, since Phase 4 adds a second kind adapter beside them.
9. **Rename the SSE event and its web consumer.** `scout_archive_changed`
   (`src/server/registry.ts:842`) and the `scoutsRevision` counter
   (`src/web/useEventStream.ts:117-127, 387, 433`). `useEventStream.ts` is a controlled path
   requiring exhaustive handling of every `ServerEvent`.
10. **Rename the HTTP routes.** `/api/scouts*` becomes `/api/archives*`
    (`src/server/routes.ts:1762-1867`), with the list query gaining a `kind` filter. There is no
    browser consumer to keep working, which is what makes this a rename rather than a deprecation.
11. **Rewrite the documentation.** `docs/scout-archives.md` becomes the archives page and
    describes a kind-discriminated library, the two roots, and the compatibility window.
    `docs/database-and-migrations.md:22-29`, `docs/configuration.md:30` and
    `docs/event-stream.md:23-26` name the old surfaces.

## 6. Data, API, and compatibility

- **On disk, nothing moves.** Legacy bundles keep their root, their directory names and their
  `format` string. New bundles are written under the new root with the new format.
- **Reading is a union; writing is one format.** This is what keeps the append-only rule intact.
- **The index is disposable and is rebuilt.** Operators see a background re-index after upgrading.
  It is bounded by the existing `MAX_CANDIDATES` of 20,000 and the 60-second reconcile cadence.
- **The ledger is migrated, not dropped.** See step 6.
- **Producer identity must not be re-minted.** The producer id appears inside every manifest this
  machine has written. If the file is relocated, it is relocated by reading the existing id and
  writing it to the new path - never by generating a new one. Preserving it is a correctness
  requirement, not a nicety: a new id would present this machine's existing bundles as a foreign
  producer's.
- **Downgrade.** A bundle written by this build is not discovered by an older build. This is
  acceptable for a local cache of local files that remain readable in a file manager, and is the
  same property the schedule store already has. State it in the docs.

## 7. Tests and verification

- **The behaviour-preservation proof:** every existing `test/scout-*.test.ts` file passes with
  only mechanical import and name edits. A test that needs a *semantic* edit is a signal that this
  phase changed scout behaviour, which it must not.
- `test/scout-format.test.ts`: extend the golden-vector fixture with a `format` key for the new
  identifier while keeping a legacy vector asserting the old one still parses to `kind: "scout"`.
  The content digests are unaffected.
- New: a manifest-parsing test proving a legacy manifest reads as a scout, a new-format manifest
  without a `kind` is refused with `wrong_kind`, and an unknown `kind` is refused.
- New: a reconciler test proving both roots are discovered in one pass and that a bundle present
  under both is not double-indexed.
- New: a migration test opening a database that holds `scout_capture_jobs` rows and asserting the
  rows survive into `archive_capture_jobs` with `kind = 'scout'`. Per the project's schema rule
  the database must keep opening safely on an existing file.
- `html.ts` tests: add a passing case for `<a href="https://example.com">` and an explicitly
  failing case for **each** fetching slot - `src`, `xlink:href`, CSS `url()`, `@import`,
  `image-set()` - plus the unchanged `data:` navigational refusal. This is what stops the
  relaxation spreading.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build && npm run smoke`
  (runtime surfaces changed).
- No Playwright spec: this phase has no UI surface. Stated explicitly so the omission is not read
  as skipping the project's e2e requirement.

## 8. Merge and exit criteria

- Scout behaviour is unchanged end to end: dispatch, submit, complete, list, read, delete.
- Bundles written before the change are still discovered, indexed and readable.
- A database carrying the old tables opens, migrates, and keeps its capture-job rows.
- The validator permits a clickable external link and refuses every fetching slot, with a test per
  slot.
- No file outside the archive subsystem, its tests, its routes and its docs is touched.

## 9. Downstream handoff

Later phases may rely on:

- **C-A1**: A manifest declares its `kind`, drawn from an append-only vocabulary that already
  contains `plan`. A legacy manifest reads as `scout`.
- **C-A2**: The write path emits one format under one root; the read path unions both. Adding a
  kind requires no new format string and no new root.
- **C-A3**: The index tables carry `kind` and the list query can filter on it.
- **C-A4**: Generic bundle mechanics (paths, bundle verification, store, reconciler, capture
  publish, HTML validation) are kind-agnostic. What a kind contributes is: which checkout paths
  become the primary artifact, and what the search segments are cut from.
- **C-A5**: The archive HTML validator permits navigational `http(s)` and refuses it in every
  fetching slot.

Later phases must not:

- Rewrite, move or re-serialize a published bundle.
- Redefine `mission-control/scout-archive` or reorder any append-only vocabulary.
- Re-mint the producer identity.
- Add a second library-root resolver.

## 10. Cross-phase audit record

- **Against Phase 2 (the plan kind):** no shared decision. The only shared file is
  `src/server/db.ts`, in different regions - this phase adds table DDL and the first
  scout-family migration, Phase 2 changes the task row read at `:3232`. A textual conflict is
  possible and a semantic one is not.
- **Against Phase 4 (plan capture):** Phase 4 consumes C-A1 through C-A4. This phase deliberately
  introduces the `kind` discriminator with only `scout` reachable in the write path, so that this
  phase is provably behaviour-preserving and Phase 4 owns the entire "a plan can be captured"
  change. The vocabulary already contains `plan` because the vocabulary is append-only and adding
  a member later is a second format decision for no benefit.
- **Against Phase 3 (delivery contract):** no relationship. Phase 3 touches prompts, skills and
  Foreman; this phase touches storage and validation.
- **Reconciliation applied while writing this file:** the initial route had this phase renaming
  the scout submission credential and MCP tool for symmetry. That was moved out of scope after
  the finding that a plan is captured from its checkout at teardown and never submits through the
  agent-facing tool, so renaming those would be churn with no consumer and would touch a
  persisted HMAC key path for no reason. Recorded here because the symmetry argument will
  resurface in review.
- **Deferred decision surfaced here:** whether the three disposable tables should be dropped and
  rebuilt or copied. Step 5 resolves it as drop-and-rebuild on the strength of the reconciler's
  own stated design property. An implementer who finds that property no longer holds must raise
  it rather than silently copying rows, because a copied fingerprint that never corresponded to a
  verified read is a cache that lies.
