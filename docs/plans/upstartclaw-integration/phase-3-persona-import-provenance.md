# Phase 3: Persona import with provenance and drift detection

Implements Track C of [plan.md](plan.md). Read [phased-plan.md](phased-plan.md) for how this
phase relates to the others. This phase is independent of Phases 1 and 2 and may merge in any
order relative to them.

## 1. Outcome

An operator imports an externally-authored Markdown persona **from a file path on the
daemon's machine** (the motivating source: UpstartClaw's `agent-team` role files under the
installed plugin). The persona records provenance (source path, content hash, imported-at,
optional plugin version). When the upstream file later changes, the persona shows an
**upstream changed** badge; **Re-import** pulls the new text as a new revision through the
existing CAS lifecycle. Published workflow and ensemble snapshots stay immutable throughout -
drift is a visible diff a human adopts by re-importing and republishing, never a silent
change to what judges score with (plan decisions 11 and 12).

## 2. Entry criteria and dependencies

- Direct prerequisite: the planning session's PR (this document reachable on the default
  branch). No other phase is a prerequisite.

## 3. Scope and non-goals

In scope: one nullable provenance column + migration + upgrade test, a daemon-side import
route and a re-import route, a drift route, the import/badge/re-import UI in the Persona
library, unit tests, one Playwright spec, README.

Non-goals:

- **No change to `PersonaSnapshot`.** Provenance is a live-catalog concern; snapshots are the
  reproducibility contract. `personaSnapshotOf` (`src/shared/workflow.ts:901-909`) stays the
  single construction site, untouched (`test/workflow-publish.test.ts` source-greps for it).
- **No live reference**: guidance is always a stored copy (plan decision 11 rejected run-time
  reads as breaking the publish-snapshot invariant).
- **Not** the unimplemented `docs/plans/persona-versioning-and-foreman/plan.md` (persona
  domain extraction, `persona_versions` table). This phase stays inside `WorkflowStore` and
  must remain additive so that plan stays implementable later.
- No automatic sync, no background polling of upstream files, no new SSE event (drift is
  fetched on request).
- No committing of Claw persona content into this repo (plan decision: no catalog
  duplication; the adapted personas are operator DB content).

## 4. Repository findings (verified 2026-08-05)

- **`personas` table** (`src/server/db.ts:351-367`): 11 columns, **no metadata/JSON column**,
  zero existing `addColumn` calls against it. A migration is required.
- **Migration contract** (`docs/agent-guides/change-contracts.md:23-36`, `AGENTS.md:78-92`):
  update the fresh `CREATE TABLE IF NOT EXISTS`, `addColumn` in `migrate()` (`db.ts:1431`,
  helper `:1942`), indexes referencing new columns only after `addColumn` (none needed here),
  nullable-no-default is the idiom for "a pre-feature row genuinely had nothing here"
  (`db.ts:1437-1441`), and an upgrade test seeded with a **hand-written pre-feature schema**
  (template: `test/session-action-migration.test.ts:33-39` - "an upgrade test that builds its
  fixture with the CURRENT schema proves nothing").
- **Row parsing**: `PersonaRowSchema` / `parsePersonaRow` (`src/server/workflows/store.ts:318-359`).
  For the provenance JSON choose **degrade + report** (the `runner_id` discipline,
  `store.ts:324-327`) - a broken provenance blob must not hide a working persona; parse
  through a Zod schema and fall back to null.
- **Write paths**: `insertPersona` explicit column list (`store.ts:1509-1512`);
  `updatePersonaCas` field-by-field SET builder gated on
  `WHERE id = ? AND revision = ? AND archived_at IS NULL` (`store.ts:1529-1581`). Mutation
  vocabulary is `PersonaMutation` with reasons
  `not_found | revision_conflict | name_conflict | archived | builtin`
  (`src/server/workflows/personas.ts:34-40`) - re-import refusals reuse it.
- **Manager and routes**: `PersonaManager` (`personas.ts:92-164`); persona routes at
  `routes.ts:562-684` with `PERSONA_BODY_MAX_BYTES` (`routes.ts:255`) and the
  `personaFailure` refusal mapper (`:616-630`). New routes join this block and mirror its
  shape.
- **Name/description derivation shared with Import .md and built-ins**:
  `personaNameFromMarkdown` (`shared/workflow.ts:259`, doc `:252-258` says it is "one rule
  for both readers of authored Markdown") and `personaDescriptionFromMarkdown` (`:269`).
  Guidance is exact text, validated by `PersonaGuidanceSchema` (`protocol.ts:2242`), capped at
  `WORKFLOW_LIMITS.personaGuidanceBytes` (100,000).
- **Sanctioned file-reading patterns**: `src/server/util/repo-doc.ts` (realpath-first
  containment, byte-capped `readCapped`, doc `:76-99` on why containment is judged on the
  real path) and `src/server/session-files.ts` (`rootAndTarget` `:83-107` refusing NUL,
  `..`, symlinks; `revision()` `:26-28` is the repo's sha256 idiom). The import read has no
  containment root (the operator names an absolute path on their own machine over the
  loopback+token API), so compose: refuse relative/NUL paths, `realpath`, require a regular
  file, decode UTF-8 with a fatal decoder, **refuse** (never truncate) beyond
  `personaGuidanceBytes` - a truncated persona would silently change review authority.
- **UI surfaces**:
  - Sidebar row tag precedent: `Built-in` `<em className="persona-list-tag">` in
    `PersonaLibrary.tsx:304-322` (CSS `.persona-list-tag`, `styles.css:10263`).
  - Editor status precedence builtin -> archived -> conflict -> dirty
    (`PersonaEditor.tsx:129-174`); the drift state joins this line.
  - The existing "outdated" affordance to echo: `WorkflowVersionHistory.tsx:64-81` renders
    `· outdated` via `personaSnapshotIsOutdated` - that surface is about published snapshots
    and stays unchanged; this phase's badge is about the live catalog row vs its upstream
    file.
  - Library shelf card contract: `LibraryCard.tags` with tone `"attention"` and
    `factTone: "warn"` (`library-model.ts:104-124`); `workflowCards` (`:126-154`) is the
    precedent for a warning tag. `personaCards` (`:157-171`) gains an optional drift map
    parameter.
  - Import button precedent: `Import .md` (`PersonaLibrary.tsx:257-284`), which is
    browser-side (`File.text()`, no path, no provenance) and **stays unchanged**.
- **Persona catalog is pushed over SSE** (snapshot carries `personas: PersonaView[]`,
  `types.ts:2092`; `persona_upsert`/`persona_remove` `:2143-2145`). Adding `provenance` to
  the `Persona` shared type rides the existing events; **no new ServerEvent**, so no
  `useEventStream.ts` case is added (the exhaustiveness rule is untouched).
- **e2e**: `library.spec.ts` drives the Persona library (`seedAssets` `:71-87`, navigation
  `:254-261`); specs may write files into `daemon.home` (e.g. `cost-chip.spec.ts:24`); the
  daemon env sets `HOME: home` (`daemon.ts:147`).

## 5. Implementation steps

1. **Shared types** (`src/shared/workflow.ts` + `src/shared/protocol.ts`):
   - `PersonaProvenance` = `{ sourcePath: string; sourceRepo: string | null; pluginVersion: string | null; contentSha256: string; importedAt: number }`
     with a Zod schema; `Persona` gains `provenance: PersonaProvenance | null`.
   - `ImportPersonaSchema` = `{ path: z.string().min(1).max(4096) }` (refine: absolute, no
     NUL). `ReimportPersonaSchema` = `{ expectedRevision: z.number().int().positive() }`.
   - Drift wire shape: `PersonaDriftView = { id: PersonaId; upstream: "current" | "changed" | "missing" }`.
2. **Migration** (`src/server/db.ts`): add `import_provenance_json TEXT` to the fresh
   `CREATE TABLE` block and `addColumn(d, "personas", "import_provenance_json", "TEXT")` in
   `migrate()`. Nullable, no default, no index. No backticks in the SQL literal.
3. **Store** (`src/server/workflows/store.ts`): extend `PersonaRowSchema`/`parsePersonaRow`
   (degrade + report on a malformed blob), `PersonaInsert`, the `INSERT` column list, and a
   provenance-aware patch path in `updatePersonaCas` (re-import updates guidance +
   provenance + name/description only when derived values changed; revision bumps as today).
4. **Manager** (`src/server/workflows/personas.ts`):
   - `importFromFile(path, now)`: read (per the composed rules in section 4), hash
     (sha256 hex), derive name/description, `create` with provenance; a name conflict
     returns the existing `name_conflict` refusal with the current row.
   - `reimport(id, expectedRevision, now)`: refuse `builtin`, `archived`, `not_found`, no
     provenance (`bad_request`-shaped refusal), revision conflicts per CAS; on success
     re-read the source path, update guidance + provenance, publish the upsert.
   - `drift()`: for every non-archived persona with provenance, re-read + hash the source
     file (bounded, per request - the `skillDrift` read-the-disk discipline,
     `reconcile.ts:616-628`) and report `current | changed | missing`.
   - `pluginVersion`: when the source path sits under a Claude plugin install, a best-effort
     read of the adjacent plugin manifest's version; null when undeterminable. Keep this
     tolerant and generic (no Claw-specific parsing beyond "a `.claude-plugin/plugin.json`
     with a version field somewhere above the file").
5. **Routes** (`routes.ts`, inside the persona block `562-684`, mirroring its shape):
   - `POST /api/personas/import` (body-limited like the create route; 201 with the
     `PersonaView`; refusals through `personaFailure` plus a 400 for unreadable/oversized/
     non-UTF-8/non-absolute paths, each naming the reason).
   - `POST /api/personas/:id/reimport` (CAS body; same refusal vocabulary).
   - `GET /api/personas/drift` returning `{ personas: PersonaDriftView[] }`, always 200.
6. **Web** (`src/web/`):
   - `personaApi.ts`: `importPersonaFromPath(path)`, `reimportPersona(id, expectedRevision)`,
     `fetchPersonaDrift()`.
   - A small `usePersonaDrift()` hook: fetch on mount, expose `refresh()`; refreshed after
     import and re-import.
   - `PersonaLibrary.tsx`: an "Import from path" affordance beside `Import .md` (a text
     input for the absolute path; keep the existing browser import untouched); sidebar rows
     gain an `upstream changed` tag (`.persona-list-tag` styling, attention-toned) when the
     drift map says `changed` or `missing` (distinct wording for missing).
   - `PersonaEditor.tsx`: the status line gains the drift state (after builtin/archived/
     conflict/dirty in precedence); an editor action **Re-import from source** (disabled for
     builtin/archived/no-provenance, confirm-guarded like Archive) that calls the route and
     reconciles like Save does; the eyebrow or a detail line shows the source path and
     imported-at.
   - `library-model.ts`: `personaCards(personas, drift?)` adds
     `{ label: "upstream changed", tone: "attention" }` when drifted; `LibraryPage` passes
     the hook's map.
7. **Tests** (`node:test` + `node:assert/strict`):
   - Upgrade test seeded with a hand-written pre-feature `personas` schema (template
     `test/session-action-migration.test.ts`): the migration adds the column, pre-feature
     rows read back with `provenance: null`, and a fresh DB matches.
   - Store round-trip: provenance survives insert/read byte-for-byte; malformed blob
     degrades to null without dropping the row.
   - Manager/HTTP (the `test/personas-http.test.ts` in-process pattern): import happy path
     (exact guidance, derived name/description, hash correctness), oversize/non-UTF-8/
     relative-path refusals, name conflict, re-import CAS conflict and builtin/archived/
     no-provenance refusals, drift reporting for current/changed/missing.
   - Render test for the sidebar tag + editor status (the `persona-editor-render.test.ts`
     pattern).
8. **Playwright spec** (`e2e/`): write a role-shaped `.md` into `daemon.home`, import it
   through the new UI, assert the persona appears with its provenance detail; append to the
   upstream file, refresh drift (reopen or use the refresh affordance), assert the
   `upstream changed` tag on the sidebar row; click Re-import, assert the tag clears and the
   editor shows the new text. Assert the published-snapshot invariant is untouched only at
   the unit level (publishing is already covered by `workflow-publish.test.ts`).
9. **README** (same change, in `## Workflows and Personas`): document import-from-path,
   provenance, the drift badge, re-import semantics (a new revision through CAS; published
   versions keep the guidance they were published with - extend the existing built-ins
   sentence at ~2545-2584 that already states exactly this semantics), and a usage note
   naming UpstartClaw's `agent-team` roles as the motivating source (self-contained; do not
   link Phase 2's section anchor, which may not exist yet in this merge order). Update the
   "Import .md" prose only if its claims would otherwise become false.

## 6. Data / API / migration

- One nullable column: `personas.import_provenance_json TEXT` (migration as above).
- Two new POST routes + one GET, all inside the existing persona route block, schema-parsed.
- `Persona`/`PersonaView` gain `provenance` (rides existing SSE events; no protocol version
  concern - additive optional field, older UIs ignore it).

## 7. Verification

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/persona-import.test.ts
node --test --test-concurrency=2 --import tsx test/persona-migration.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

(Adjust test filenames to what is actually created; the two named runs are the new suites.)

## 8. Merge and exit criteria

- Upgrade test proves a pre-feature database opens and reads `provenance: null`.
- Import stores exact bytes, refuses oversize/invalid input with named reasons, and records
  a correct sha256.
- Drift reports current/changed/missing per request; re-import is CAS-guarded and refused
  for builtin/archived/no-provenance.
- Published workflow versions and ensemble evaluations are byte-identical before and after
  an upstream change + re-import (no snapshot surface touched).
- README documents the feature in the same change.

## 9. Downstream handoff

Later work may rely on: `personas.import_provenance_json` (nullable TEXT JSON, schema in
`src/shared/`), the three routes' shapes, and `PersonaProvenance` field names (additive
changes only - the blob is persisted). The future Track D migration (personas distributed via
a Claw-side `mission-control` plugin) changes only where the imported files come from; the
import/provenance/drift mechanism is the stable contract it plugs into.

## 10. Cross-phase audit record

- 2026-08-05: Initial version. No contracts consumed from Phases 1 or 2. README edits live in
  the Workflows and Personas region (~2522+), disjoint from both. Deliberately avoids
  Phase 2's environment-check registry (drift is a persona-scoped fact fetched from a persona
  route, not a machine-scoped environment check) and does not reference Phase 2's README
  anchor, so merge order is free.
