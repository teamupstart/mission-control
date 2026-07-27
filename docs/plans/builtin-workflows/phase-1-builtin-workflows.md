# Phase 1: Built-in workflows and No-Mistakes Review

Source plan: `docs/plans/builtin-workflows/plan.md`
Index: `docs/plans/builtin-workflows/phased-plan.md`

## Outcome and value

A fresh install has a working, published review workflow named **No-Mistakes Review** in the
Workflows tab, composed from the four built-in Personas, with the Inspector final gate
configured. No authoring step, no import, no seeding.

Today an operator gets four ready Personas and zero workflows, so the canonical pipeline that
`README.md` already describes is a manual authoring gesture nobody performs. This phase closes
the gap between what ships and what the documentation says composes.

## Entry criteria and dependencies

- Direct prerequisite: the planning session's PR merges, so `docs/plans/builtin-workflows/`
  is on the default branch.
- No dependency on Phase 2. This phase adds no node kind and does not touch the validator.

## Scope

In scope:

- `builtin: boolean` on `WorkflowDefinition` and `WorkflowSummary`.
- A `BUILTIN_WORKFLOWS` catalog module holding definitions and their pre-published versions.
- The `WorkflowStore` merge, name reservation, and write refusals.
- The No-Mistakes Review graph as compiled data.
- Read-only treatment in `WorkflowLibrary.tsx` with Duplicate as the customization path.
- README section, tests.

Explicit non-goals:

- **No check node.** Phase 2 owns it.
- **No new HTTP route.** Built-ins are read through the routes that already exist.
- **No DB migration.** Nothing is stored.
- **No second built-in.** One shipped workflow, version 1.
- **No change to Persona authoring**, `scripts/builtin-personas.ts`, or `docs/personas/*.md`.
- **No auto-binding.** The workflow exists; binding it to a session stays an operator gesture.

## Repository findings this phase depends on

- `WorkflowStore` already takes injectable `builtins` (`store.ts:967`), and the comment says
  why: a test can prove merge rules on a catalog it authored. Mirror that for workflows.
- `WorkflowManager.list()` (`manager.ts:394`) and `get()` (398) read through the store, and
  SSE publication goes through `registry.upsertWorkflow(summary)`. A store-level merge needs
  no route or manager change beyond refusal plumbing.
- `summary()` resolves `publishedVersion` with a row lookup (`store.ts:1444-1446`); a built-in
  needs its own arm.
- `archiveWorkflowCas` finds active bindings by joining `workflow_bindings` to
  `workflow_versions` on `workflow_id` (`store.ts:1307-1311`). A built-in has no version rows,
  so that join is blind to its bindings. Harmless only because the built-in refusal precedes
  it; do not reorder.
- `insertWorkflow` conflicts on `normalized_name` (`store.ts:1226-1233`), the same shape
  `insertPersona` uses, so name reservation drops in identically.
- `normalizeWorkflowName` is `normalizePersonaName` re-exported (`@shared/workflow.ts`).
- The graph is legal under today's validator. Verified against `workflow-graph.ts:170-217`.

## Implementation steps, in execution order

### 1. Shared types (`src/shared/workflow.ts`)

- Add `builtin: boolean` to `WorkflowDefinition` and to `WorkflowSummary`.
- Add `workflowsForDisplay(workflows)` beside `personasForDisplay`, applying the same
  live-row-shadows-built-in rule on `normalizedName`. `WorkflowSummary` has no
  `normalizedName`, so shadow on `WorkflowDefinition` before projecting to summaries.

Adding a required field to `WorkflowDefinition` breaks every construction site until it says
what it is, which is the intended enforcement.

### 2. The catalog module (`src/server/workflows/builtin-workflows.ts`)

Model it directly on `builtin-personas.ts`, including a module comment that states why this
is not a row.

```ts
export const BUILTIN_WORKFLOW_ID_PREFIX = "builtin-workflow:";

export function builtinWorkflowId(slug: string): string {
  return `${BUILTIN_WORKFLOW_ID_PREFIX}${slug}`;
}

export function builtinWorkflowVersionId(slug: string, version: number): string {
  return `${builtinWorkflowId(slug)}@${version}`;
}
```

The prefix differs from the Persona prefix so a mistaken id lookup cannot cross catalogs.

Shape the catalog as a list of versions per workflow, newest current:

```ts
export interface BuiltinWorkflow {
  definition: WorkflowDefinition;   // builtin: true, currentVersionId = newest version id
  versions: readonly WorkflowVersion[];  // ascending; every published version stays here
}

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = [...];
```

**The list is the cross-phase contract.** Phase 3 adds version 2. A single-version catalog
would strand every binding pinned to version 1, and building the list now costs nothing.

Version 1 contains committed Persona snapshot literals frozen from `BUILTIN_PERSONAS` when
this phase ships. It is never rebuilt from the current Persona catalog at module load. A
later change to any referenced `docs/personas/*.md` file must append a new built-in workflow
version in the same commit and leave version 1 byte-identical. Fail loudly at load if a
referenced built-in Persona id is absent, rather than shipping a workflow whose node cannot
resolve.

Definition fields: `draftRevision: 1`, `archivedAt: null`, `createdAt: 0`, `updatedAt: 0`,
`builtin: true`, `bindingDefaults: DEFAULT_WORKFLOW_BINDING_DEFAULTS`, and
`completionPolicy: { kind: "inspector", onFindings: "restart_workflow", missingPrAction:
"offer_prepare_pr" }`. Zero timestamps match the Persona precedent, where surfaces print
"Built-in" where they print a row's dates.

### 3. The No-Mistakes Review graph

Nodes: one `session`, four `persona` (Intent Conformance Judge, then Code Risk Reviewer, Test
Evidence Auditor, Documentation Steward), one `all_pass`, one `end` with outcome `Complete`.

Edges:

| From | Port | To | Port |
|---|---|---|---|
| session | submitted | intent | activate |
| intent | pass | risk / evidence / docs | activate (three edges) |
| intent | fail | session | return_for_changes |
| risk / evidence / docs | pass | join | result (three edges) |
| risk / evidence / docs | fail | join | result (three edges) |
| join | pass | end | terminal |
| join | fail | session | return_for_changes |

**The graph is a committed literal with hardcoded node and edge ids. Do not call
`compileStages` at module load.**

`compileStages` mints `crypto.randomUUID()` for every member with a null `nodeId`, every new
join, and every new edge (`workflow-stages.ts:369, 386, 396`). A graph compiled when the module
loads would therefore have different node and edge ids on every daemon restart. Those ids are
durable: `workflow_node_attempts.node_id` and `workflow_edge_receipts.edge_id` both reference
them, so an in-flight run that spans a restart would hold attempts pointing at nodes the graph
no longer contains. It also makes a nonsense of "immutable published version", which is the
one thing a version is.

Use `compileStages` **at authoring time** to produce the graph once, then paste the result in
as a literal with its ids frozen. The test proves the literal is what the compiler would have
produced structurally, which is what keeps the two from drifting without making the ids
runtime-generated.

Positions come from that same authoring pass, so they satisfy `stageExpressible` and the
workflow renders in the Pipeline editor rather than Graph view. `LAYOUT` in
`workflow-stages.ts` is the coordinate authority; do not hand-place coordinates.

### 4. The store merge (`src/server/workflows/store.ts`)

Second constructor parameter `builtinWorkflows: readonly BuiltinWorkflow[] = BUILTIN_WORKFLOWS`,
injectable for the same reason `builtins` is.

| Method | Change |
|---|---|
| `listWorkflows` | merge, apply display shadowing, keep the existing sort. Built-ins are never archived so they appear in both listings, like Personas |
| `getWorkflow` | fall back to the built-in catalog when no row matches |
| `insertWorkflow` | refuse a built-in id (`reason: "builtin"`) and a built-in normalized name (`reason: "name_conflict"`) before the row conflict query |
| `updateWorkflowCas` | refuse a built-in id; refuse a rename onto a built-in name |
| `archiveWorkflowCas` | refuse a built-in id, **before** the active-binding join |
| `publishWorkflow` | refuse a built-in id: it is already published |
| `listWorkflowVersions` / `listWorkflowVersionMetadata` | return the catalog's versions for a built-in id |
| `getWorkflowVersion` | resolve by `(workflowId, version)` from the catalog |
| `getWorkflowVersionById` | resolve a synthetic version id from the catalog. **This is the one bindings and runs depend on** |
| `summary` | for a built-in, take `publishedVersion` from the catalog instead of the row lookup |

Add `workflowCatalog()` beside `personaCatalog()` returning the non-shadowed addressable set,
and use it wherever binding or run resolution needs a definition.

Extend `WorkflowStoreWrite["reason"]` with `"builtin"`.

### 5. Manager and routes (`manager.ts`, `routes.ts`)

- `create` / `update` / `archive` / `publish` map the new `"builtin"` refusal to a 409 with a
  sentence, matching how the Persona routes report theirs.
- No route additions. Confirm `GET /api/workflows/:id`, `/versions` and `/versions/:version`
  return the built-in through the existing handlers.

### 6. Web (`src/web/workflows/`)

- `WorkflowLibrary.tsx`: a `Built-in` tag in the list row beside the existing status line
  (`:517`); disable Archive (`:631`) and Publish (`:647`); relabel Duplicate as the
  customization path; make the properties rail read-only (`:794`, `:806`, `:828` already gate
  on `archivedAt`, so extend the same expression).
- Render the built-in explanation **before** any archived state, following the comment at
  `PersonaEditor.tsx:148`. An operator reading the wrong reason goes looking for the wrong
  control.
- Reuse `.persona-list-tag` and `.persona-state.builtin` or add `workflow-` prefixed siblings
  in the matching section of `styles.css`. Do not inline a variant.
- Duplicating a built-in produces an ordinary row whose name is uniquified by the existing
  `nextWorkflowName` path.

### 7. README

A **Built-in workflows** subsection under `#workflows-and-personas`, beside Built-in Personas:
what ships, that it is app data not operator data, that it is read-only with Duplicate as the
customization path, that its name is reserved with the historical-shadowing exception, and
that built-in versions and their Persona snapshots are immutable. Explain that a Persona
guidance change appends a new current workflow version while existing bindings remain pinned.
Update the sentence at line 2016 that currently sends the reader to the plan document for the
example workflow.

## Data, API and compatibility

- **No migration.** Nothing is stored. No `addColumn`, no index, no `CREATE TABLE`.
- **No wire break.** `builtin` is a new required field on two shapes the browser reads from
  SSE and HTTP; both are served by this build, so there is no skew window.
- **Durable references.** A binding created against `builtin-workflow:no-mistakes-review@1`
  stores that string. It resolves through `getWorkflowVersionById`. Ids are append-only.
- **Downgrade.** An operator who downgrades past this build has bindings naming a version id
  nothing resolves. That is the same failure a deleted workflow row already produces and the
  binding reports it the same way; it is not newly introduced and needs no special handling.

## Tests and verification

New `test/builtin-workflows.test.ts`:

- The shipped graph validates clean against `validateWorkflowGraph` with the real built-in
  Persona catalog: zero errors, zero warnings. **Verified during planning**: the graph below
  returns `valid: true` with `diagnostics: []` and 13 edges.
- `projectStages(graph)` returns a pipeline (not `null`), so it renders in the Pipeline editor.
- Round trip, stated precisely because the naive form fails: assert
  `projectStages(compileStages(p, graph)) === p` where **`p = projectStages(graph)`**, that is,
  a pipeline whose members already carry real node ids. Comparing against a hand-written seed
  with `nodeId: null` is not the invariant and will not hold, because the compiler mints ids
  for null members.
- Node and edge ids are stable across two module loads in the same test run, which is what
  catches a reintroduced `compileStages`-at-load-time.
- Every persona node's `sourcePersonaId` exists in `BUILTIN_PERSONAS`. The newest version's
  snapshots equal the current built-in Persona catalog.
- Each previously shipped version is asserted byte-for-byte against a committed fixture so a
  Persona edit cannot mutate it in place. Changing referenced guidance without appending a
  newest version fails the current-catalog assertion.
- `completionPolicy` and `bindingDefaults` are exactly the adopted values.
- Version ids follow `builtinWorkflowVersionId` and the catalog is ascending with
  `definition.currentVersionId` naming the newest.

Extend `test/workflow-store.test.ts` (or a new `builtin-workflows-store.test.ts`):

- `listWorkflows` includes the built-in on an empty database.
- A stored workflow with the same normalized name shadows it in `listWorkflows`, while
  `workflowCatalog()` and `getWorkflowVersionById` still resolve it.
- `insertWorkflow` refuses the built-in name; `updateWorkflowCas`, `archiveWorkflowCas` and
  `publishWorkflow` refuse the built-in id with `reason: "builtin"`.
- An archived stored row does **not** shadow, matching the Persona rule and its stated reason.
- Inject a fabricated catalog rather than asserting against the real shipped workflow, so
  these rules do not depend on what the four documents happen to say.

Extend `test/workflows-http.test.ts`: `GET /api/workflows` lists it, `/:id` returns it,
`/versions/:version` returns its graph, and every mutating route 409s on it.

Web render test in `test/builtin-workflows-web.test.ts` via `renderToStaticMarkup`: the list
row carries the tag, Archive and Publish are disabled, the built-in sentence is present, and
it takes precedence over an archived sentence.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual: point `HARNESS_HOME` at an empty directory, `make start`, open `#/workflows`, and
confirm No-Mistakes Review is listed, opens read-only with Duplicate, shows v1, and binds to a
live session. Confirm you are on your own Vite port, not `:5173` serving another checkout.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- A fresh state directory lists the workflow with no operator gesture.
- Every mutating path refuses it in the store, not at a caller.
- A binding created against the built-in version resolves after a daemon restart.
- README updated in this change.

## Downstream handoff

Phase 3 may rely on:

- `BUILTIN_WORKFLOWS` being a list of versions per workflow, so adding version 2 is additive.
- `builtinWorkflowId` / `builtinWorkflowVersionId` spellings, which are append-only.
- `workflowCatalog()` as the non-shadowed addressable projection.
- `WorkflowStoreWrite["reason"]` including `"builtin"`.

Phase 3 must not:

- Rename the slug `no-mistakes-review` or any existing version id.
- Mutate version 1 in place. Adding gates means appending version 2.
- Move the refusals out of the store.

## Cross-phase audit record

- **Against Phase 2**: no overlap in owned contracts. Textual overlap in
  `src/shared/workflow.ts` (different regions: this phase edits `WorkflowDefinition` and
  `WorkflowSummary`, Phase 2 edits `WorkflowDraftNode`, `WorkflowConfig` and adds
  `WORKFLOW_CHECK_SLOTS`) and in `README.md` (different subsections). No shared migration, no
  shared route.
- **Defect found and corrected during planning, by executing the graph rather than reading
  it.** The first draft said to derive the graph with `compileStages` from a hand-written
  pipeline. Running it showed `compileStages` mints `crypto.randomUUID()` for null-id members,
  joins and edges, so a module-load compile would change every node and edge id on each daemon
  restart, stranding durable `workflow_node_attempts.node_id` and
  `workflow_edge_receipts.edge_id` rows and making the "immutable" version mutable. Corrected
  to a committed literal with frozen ids. Phase 3 inherits the same rule for version 2.
- **The round-trip assertion was also wrong as first written** and is now stated against a
  projected pipeline rather than a hand-written seed. Verified: the corrected form returns
  true, the naive form returns false.
- **Against Phase 3**: the versions-list catalog shape exists specifically so Phase 3 can
  append. Recorded as a binding contract above after noticing that a single-version catalog
  would strand Phase 3's upgrade path; this decision was moved into Phase 1 rather than being
  fixed later, per the audit rule that a contract belongs in the earliest phase that must own
  it.
