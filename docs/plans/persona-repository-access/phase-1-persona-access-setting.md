# Phase 1 - The Persona repository-access setting and its publication contract

Source plan: `docs/plans/persona-repository-access/plan.md` (rendered at `plan.html`).
Index: `docs/plans/persona-repository-access/phased-plan.md`.

## Outcome

An operator can turn repository access on for any Persona - including a built-in, through a
local override that leaves guidance, runner and model immutable - and Publish freezes that
choice into the workflow version. Nothing about review execution changes yet: the setting is
recorded, snapshotted and displayed, and every access-enabled Persona still runs the review it
runs today.

That is a deliberate, shippable end state. It makes the highest-risk surface in the feature -
persisted Persona state, published-version compatibility, and built-in immutability - reviewable
on its own, before any behaviour depends on it.

## Entry criteria and dependencies

- **Direct phase dependencies: none.** This is a root phase.
- Runs concurrently with Phase 2. The two share `src/server/db.ts` and
  `src/server/workflows/store.ts` but touch disjoint tables, disjoint methods and disjoint
  append-only regions. Either may merge first; see the compatibility audit.

## Scope

In scope:

- The `PersonaRepositoryAccess` enum, its default, and the resolved value on `Persona`.
- `personas.repository_access` column and the `persona_access_overrides` table.
- Store read/resolve/write paths, including the built-in merge.
- `PersonaSnapshot.repositoryAccess`, `personaSnapshotOf`, `PersonaSnapshotSchema`,
  `personaSnapshotIsOutdated`, and the publish path.
- A publish-time byte guard on the **published** graph.
- `PUT /api/personas/:id/repository-access`.
- The Persona Editor chip, its control and its disclosure copy.
- Documentation for the setting.
- Unit, persistence, migration, render and browser tests for all of the above.

Explicit non-goals:

- No repository materialization, no read service, no broker, no prompt change. Phases 2 and 3.
- No change to `UpdatePersonaSchema`, `PERSONA_EDIT_FIELDS`, `PERSONA_DRAFT_FIELDS`,
  `personaUpdatePatch` or `reconcilePersonaSave`.
- No new `ServerEvent`. `persona_upsert` already carries a `PersonaView`.
- No change to built-in Persona Markdown. That edit belongs to Phase 3, where the prompt it
  describes actually changes.

## Repository findings this phase must respect

Re-verify at implementation; these were true at planning time.

- `Persona` is `src/shared/workflow.ts:461`. `PersonaView extends Persona` (`:496`) and reaches
  the browser through `persona_upsert` (`src/shared/types.ts:2977`) and the `snapshot` frame
  (`:2861`), so widening `Persona` needs no event work and no `useEventStream` arm.
- A built-in is **not a row**. `BUILTIN_PERSONAS` (`src/server/workflows/builtin-personas.ts:65`)
  is projected from compiled-in Markdown with `revision: 1`, `createdAt: 0`, `updatedAt: 0`,
  `runner: null`, `model: null`, `builtin: true`. Ids are `builtin:<slug>` and are append-only.
- Built-ins are merged into reads by three private store methods:
  `withBuiltins` (`store.ts:2121`), `withAddressableBuiltins` (`:2127`) and `builtinPersona(id)`
  (`:2131`). `withBuiltins` additionally applies `personasForDisplay` name shadowing;
  `withAddressableBuiltins` deliberately does not.
- Immutability is enforced as the first statement inside three transactions, returning
  `reason: "builtin"`: `insertPersona` (`:2222`), `updatePersonaCas` (`:2268`),
  `archivePersonaCas` (`:2322`). Nothing at the route or manager layer enforces it.
- `parsePersonaRow` (`store.ts:488`) hardcodes `builtin: false` - "a row is operator data by
  construction". `PersonaRowSchema` (`:419`) uses `nullableText.optional()` for the post-hoc
  `import_provenance_json` column, which is the idiom a post-hoc column follows so a build
  reading a database whose `migrate()` has not run still parses.
- `PersonaSnapshotSchema` (`src/shared/protocol.ts:3981`) is a plain `z.object` - strip mode.
  All seven keys are required; `runner` and `model` are `.nullable()` but not `.optional()` and
  carry no default.
- `publishWorkflow` (`store.ts:3231`) reads both catalogs **inside** the transaction and
  snapshots from those exact lists. `test/workflow-publish.test.ts` is a **source-text
  assertion** that it remains one `transaction(this.db ...)` using `personaSnapshotOf`.
- `publishBuiltinGraph` (`src/server/workflows/builtin-workflows.ts:148`) runs at module load and
  cannot read the database.
- `validateWorkflowGraph` checks `WORKFLOW_LIMITS.graphJsonBytes` (500,000) against the **draft**
  graph; `parseWorkflowVersionRow` reads `graph_json` through `parseJson`'s 500,000-byte cap. The
  published graph inlines guidance, so the two disagree today.
- Route body guards: `PERSONA_BODY_MAX_BYTES = 616_384` (`src/server/routes.ts:460`),
  `REVISION_ONLY_BODY_MAX_BYTES = 1024` (`:532`). Failure envelope is `personaFailure`
  (`:1379`), `code = \`persona_${reason}\``.
- Persona Editor: `readOnly = archived || builtin` (`PersonaEditor.tsx:628`); a built-in renders
  **no** Save button (primary flips to `Duplicate to edit`, `:638-645`) and `save()` hard-returns
  for `builtin` (`:518`). `PERSONA_DRAFT_FIELDS` (`:53`) is the five editable fields. Chips are
  `LibraryPropertyChip` (`src/web/library/LibraryPropertyChip.tsx`): the chip button's accessible
  name is `<name><value>`, the popover is `role="group"` named by `controlLabel`.
- Migration idiom: no version counter. `migrate(d)` runs on every open and must be idempotent;
  `addColumn` returns whether it added the column. A post-hoc column whose default **is** the
  true backfill is declared `NOT NULL DEFAULT <value>` with no follow-up `UPDATE`
  (`src/server/db.ts:1221-1227`).

## Implementation steps

### 1. Shared contract - `src/shared/workflow.ts`

- Add `PERSONA_REPOSITORY_ACCESS_MODES = ["off", "read"] as const`, the derived type, and
  `DEFAULT_PERSONA_REPOSITORY_ACCESS = "off"`. Comment it as appended-only, with the reason: the
  strings reach durable rows in two places (a column and a published snapshot).
- Add `repositoryAccess: PersonaRepositoryAccess` to `Persona`. It is the **resolved** value for
  both kinds: a row's column, or a built-in's override falling back to `off`.
- Add `repositoryAccess: PersonaRepositoryAccess` to `PersonaSnapshot` and to
  `personaSnapshotOf`.
- Extend `personaSnapshotIsOutdated(snapshot, current)` with an access comparison, applied to
  both arms - a row (which otherwise compares `sourceRevision`) and a built-in (which otherwise
  compares `guidanceMarkdown`). A built-in's guidance never changes when its override does, so
  without this the outdated indicator would be silent on exactly the case decision 10 adds.

### 2. Wire schemas - `src/shared/protocol.ts`

- `PersonaRepositoryAccessSchema = z.enum(PERSONA_REPOSITORY_ACCESS_MODES)`.
- In `PersonaSnapshotSchema`, add
  `repositoryAccess: PersonaRepositoryAccessSchema.default(DEFAULT_PERSONA_REPOSITORY_ACCESS)`.
  Comment why `.default` and not `.optional()`, following the precedent already written on
  `PersonaProvenanceSchema`'s `sourceKey`/`catalogLabel`: this schema parses blobs a previous
  build wrote.
- `SetPersonaRepositoryAccessSchema = z.object({ expectedRevision: z.number().int().positive(), repositoryAccess: PersonaRepositoryAccessSchema })`.
  `expectedRevision` is required for a row (CAS) and is accepted and ignored for a built-in,
  whose synthetic revision is always `1` - state that in a comment rather than making the field
  conditional, so one schema serves one route.
- `CreatePersonaSchema` gains
  `repositoryAccess: PersonaRepositoryAccessSchema.optional().default("off")`, so Duplicate and
  import can carry the setting rather than silently dropping it.

### 3. Persistence - `src/server/db.ts`

In the boot `CREATE TABLE` block:

```sql
ALTER-equivalent on personas: repository_access TEXT NOT NULL DEFAULT 'off'

CREATE TABLE IF NOT EXISTS persona_access_overrides (
  persona_id         TEXT PRIMARY KEY,
  repository_access  TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
```

In `migrate(d)`, beside the other `personas` entry:

```ts
addColumn(d, "personas", "repository_access", "TEXT NOT NULL DEFAULT 'off'");
```

Comment both: the column default **is** the backfill (no `UPDATE` follows), and the override
table is keyed by `persona_id` because `(persona_id)` is both the resolution key and the key a
duplicate write must be refused on - the same reasoning `workflow_command_overrides` carries. No
`CHECK` constraint on the mode column: the list is append-only and a `CHECK` would make a third
mode an `ALTER`-and-rebuild of a table holding operator data.

### 4. Store - `src/server/workflows/store.ts`

- `PersonaRowSchema` gains `repository_access: text.optional()`. Optional on **shape**, for the
  same reason `import_provenance_json` is: a build reading a database whose `migrate()` has not
  run must still parse the row.
- `parsePersonaRow` maps it through a tolerant reader that degrades an unrecognized value to
  `off` and calls `diagnose()`. Follow `readResumptionPolicy` (`store.ts:392`) exactly: an
  unknown value from a newer build degrades to the **safe** value, never to a nearest match.
  Degrading to `off` is the fail-closed direction; failing the row would remove a working
  reviewer from the library over a setting.
- Add `WORKFLOW_TABLES`-style registration for `persona_access_overrides` if the row-error type
  enumerates tables.
- One private `resolvePersonaAccess(personas: Persona[]): Persona[]` that applies override rows
  to `builtin: true` entries, called from `withBuiltins`, `withAddressableBuiltins` and
  `builtinPersona`. Load the override map once per call rather than per persona.
- `insertPersona` writes the column from `CreatePersona.repositoryAccess`.
- New `setPersonaRepositoryAccess(id, expectedRevision, mode, now)` returning the same
  `{ ok } | { ok: false, reason, current }` union the other Persona writes return:
  - built-in id: upsert into `persona_access_overrides` (`ON CONFLICT DO UPDATE`) and return the
    resolved built-in. **No `builtin` refusal** - this is the one write that is allowed, and it
    writes to a different table, so the three existing refusals stay untouched.
  - a row: CAS on `revision` exactly as `updatePersonaCas` does, set `repository_access`, bump
    `revision`, set `updated_at`. Bumping the revision is what makes
    `personaSnapshotIsOutdated` fire for an operator Persona.
  - unknown id: `not_found`. An override row for a non-built-in id is refused; the column is the
    only place a row's setting lives.
- `publishWorkflow` needs no change beyond `personaSnapshotOf` carrying the new field - keep the
  single-transaction, catalogs-read-inside shape that `test/workflow-publish.test.ts` asserts.
- Add the publish-time guard: after projecting the published graph and before the `INSERT`, check
  `JSON.stringify(graph)` byte length against the same ceiling `parseJson` will read it back
  through, and return a `validation` diagnostic rather than writing a row that can never be read.
  Name the diagnostic after the cause (published guidance size), not after the field this phase
  added.

### 5. Route - `src/server/routes.ts`

`PUT /api/personas/:id/repository-access`, with `bodyLimit({ maxSize: REVISION_ONLY_BODY_MAX_BYTES })`,
`parseBody(c, SetPersonaRepositoryAccessSchema)`, the manager call, `workflows?.refreshSummaries()`
on success, and `personaFailure` on refusal. It must **not** produce a `persona_builtin` refusal.

### 6. Manager - `src/server/workflows/personas.ts`

Add the pass-through that maps the store result to a `PersonaView` via `resolvePersonaExecution`,
matching the existing `PersonaMutation` shape. No new reason codes.

### 7. Browser - `src/web/workflows/`

- `personaApi.ts`: `setPersonaRepositoryAccess(id, expectedRevision, mode)` using the existing
  `personaRequest` wrapper, so the 409-with-`current` shape stays uniform.
- `PersonaEditor.tsx`: a `repository` chip after `model`, `controlLabel="Repository access"`,
  `state` = `"inherited"` when `off` and `"overridden"` when `read`, value text naming the mode
  in words. Its child control is a new `PersonaRepositoryAccessControl` holding the choice and
  the disclosure list from the plan's UX section. The control:
  - is disabled when `persona === null` (unsaved draft, chip reads `resolves after save`) and
    when `archived`;
  - is **enabled** when `builtin`, which is the single deliberate exception to
    `readOnly = archived || builtin`;
  - commits on change through the new route, optimistically, reverting and writing the existing
    `persona-error` line on failure. It is not part of the draft, so `dirty`, the CAS conflict
    banner, `personaUpdatePatch` and `reconcilePersonaSave` are untouched.
- Built-in copy states three things plainly: the override is local to this machine, it does not
  change the shipped guidance, and it does not make the Persona editable.
- Disclosure copy states what is granted, what is not, what is denied, and that the setting
  applies to **newly published** workflow versions.

### 8. Documentation

- `docs/workflows.md`: the setting, the capability list, the denial list, the publish-freeze
  rule, the built-in override and its Duplicate-the-workflow limitation.
- `docs/database-and-migrations.md`: the column and the override table.
- `docs/security.md`: a forward pointer that repository access exists and is off by default; the
  full trust-boundary section lands with Phase 2.

## Tests

- `test/workflow-contracts.test.ts`: the mode list is append-only and distinct from any other
  durable enum; `personaSnapshotOf` carries the field.
- `test/personas-store.test.ts`: the column round-trips; setting a row's access bumps exactly one
  revision and leaves guidance bytes identical; a stale `expectedRevision` gets the current row
  back; an override row is refused for a non-built-in id.
- `test/builtin-personas.test.ts`: an override changes a built-in's resolved access and nothing
  else - name, description, guidance, runner, model, revision, timestamps all unchanged; `update`,
  `archive` and `insert` still refuse with `reason: "builtin"`; the override survives a store
  reopen; an unknown stored mode degrades to `off` rather than failing the built-in.
- `test/personas-http.test.ts`: the route parses through `parseBody`; a built-in gets `200` and
  **not** `409 persona_builtin`; a stale revision on a row gets `409 persona_revision_conflict`
  with `current`; an unknown mode is `400`; an oversize body is refused before schema parsing.
- `test/persona-migration.test.ts`: a hand-written pre-feature `personas` table (not imported from
  `db.ts`) opens, migrates, and reads `repositoryAccess: "off"` with guidance bytes, revision and
  timestamps unchanged; both the fresh `CREATE TABLE` and the migration name the column; two
  opens are idempotent.
- **New**, closing a gap the investigation named: a `workflow_versions.graph_json` hand-seeded in
  the pre-feature shape resolves with `repositoryAccess: "off"` and its node ids intact; the same
  row with an **unknown extra key** inside the persona snapshot also resolves, proving strip mode
  is the property this field's compatibility rests on. Model the seeding on
  `test/session-action-migration.test.ts`.
- `test/workflow-store.test.ts`: Publish freezes the access value present at publish time; a later
  change to the Persona does not alter the published version; `personaSnapshotIsOutdated` becomes
  true for both a row and a built-in after an access change.
- `test/workflow-publish.test.ts`: still passes unchanged (it is a source-text assertion).
- `test/builtin-workflows.test.ts`: every shipped workflow version's persona snapshots carry
  `repositoryAccess: "off"`, pinning the module-load limitation as intended rather than
  accidental.
- `test/persona-editor-render.test.ts`: the chip renders with its mode; it is quiet when off and
  solid when on; a built-in renders it **enabled** while Name, Description, provider, model and
  the guidance editor stay read-only and `Save` is absent; an unsaved draft renders it disabled.
- `e2e/specs/persona-repository-access.spec.ts` (new): open a Persona, open the
  `repository` chip popover by its `role="group"` accessible name, read the disclosure, turn
  access on, reload, and see it still on; then open a built-in and confirm the access control is
  reachable while `Save` has count zero and the primary reads `Duplicate to edit`.

Verification: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
and `npm run test:e2e` (UI surface changed). One focused run for the new and touched files, with
the loader preamble `--import ./test/setup-state.mjs --import tsx`.

## Merge and exit criteria

- An operator can set repository access on an operator Persona and on a built-in, and the value
  survives a daemon restart.
- A built-in remains un-editable and un-archivable, proven by the existing refusals still
  returning `reason: "builtin"`.
- Publish freezes the value; a later Persona change does not alter a published version; the
  version reads as outdated.
- Every pre-existing database, published version and historical attempt row reads back unchanged,
  with `repositoryAccess: "off"`.
- No review behaviour changed: an access-enabled Persona runs exactly the review it ran before.
- All verification commands green.

## Downstream handoff

Later phases may rely on, and must not change:

- `PERSONA_REPOSITORY_ACCESS_MODES`, `DEFAULT_PERSONA_REPOSITORY_ACCESS`, and `off` meaning
  "absent" everywhere.
- `Persona.repositoryAccess` being the **resolved** value, so no consumer merges overrides again.
- `PersonaSnapshot.repositoryAccess` being non-optional after parse, so Phase 3 reads
  `node.persona.repositoryAccess` with no fallback.
- `personaSnapshotOf` remaining the single projection, and `publishWorkflow` remaining one
  transaction that reads catalogs inside it.
- The setting living outside the editor draft: `PERSONA_DRAFT_FIELDS`, `personaUpdatePatch` and
  `reconcilePersonaSave` are unchanged and must stay that way.
- Built-in workflow versions freezing `off`.

## Cross-phase compatibility audit

- **Against Phase 2**: disjoint tables (`personas`, `persona_access_overrides` here;
  `workflow_submissions` columns and `workflow_repository_queries` there) and disjoint store
  methods. Both append to `src/server/db.ts`'s boot block and `migrate()`. `addColumn` and
  `CREATE TABLE IF NOT EXISTS` are idempotent and order-independent, so either merge order
  produces the same schema; the expected conflict is textual adjacency in two append-only regions
  and is resolved by keeping both. Neither phase reads the other's data.
- **Against Phase 3**: Phase 3 consumes `PersonaSnapshot.repositoryAccess` and adds
  `workflow_llm_calls.round`. It adds no field to `PersonaSnapshot`, so the `.default("off")`
  compatibility argument is not re-opened. Phase 3 owns the built-in Persona Markdown correction
  and the `reviewContract` variant; this phase must not pre-empt either, or the drift signal it
  causes would fire a phase early with no behaviour to justify it.
- **Reconciliation record**: the publish-time byte guard was placed here rather than in Phase 3
  because this is the phase that widens the published snapshot; a guard added later would leave a
  window in which the field shipped without it.
