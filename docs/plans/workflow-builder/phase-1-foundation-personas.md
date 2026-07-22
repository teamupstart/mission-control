# Phase 1 plan: workflow contracts, storage, and Persona library

Status: **implemented**

Parent: [Persona-driven workflow builder](./plan.md)

## Outcome

Mission Control has the durable foundation for all six workflow phases and a usable Persona
library. An operator can open the new Workflows surface, create or edit exact Markdown guidance,
choose an optional LLM runner and model override, preview the Markdown, copy or download it, import
another Markdown file, duplicate a Persona, and archive it. Persona changes survive daemon and app
restarts and appear in every connected dashboard through SSE.

This phase deliberately creates the complete workflow table family and shared identifiers before it
implements graph execution. Later phases must extend these contracts, not replace them.

## Scope

### Included

- Pure shared workflow types, ids, enums, limits, and Zod request schemas.
- All new workflow tables and indexes, plus typed database row mappers.
- A Persona manager and Persona HTTP routes with revision-based compare-and-swap writes.
- Persona runner and model resolution through the existing shared ladders.
- Append-only registration and settings UI for the future `workflow-context` compaction job.
- Persona catalog state in the SSE snapshot and incremental events.
- The top-level Workflows shell and Personas tab.
- Markdown edit, preview, import, export, copy, duplicate, and soft archive.
- Tests for contracts, persistence, routes, model resolution, SSE, and rendering.

### Deferred

- Graph editing, graph validation, publishing, and workflow bindings: Phase 2.
- Persona execution, context capture, run history, and session chips: Phase 3.
- Live session injection and Foreman triggers: Phase 4.
- Inspector final-gate behavior: Phase 5.
- Retention, cost reporting, notifications, and final accessibility polish: Phase 6.

## Contracts that later phases inherit

Create `src/shared/workflow.ts`. It is browser-safe and contains no `node:` imports.

### Identifiers and limits

Use opaque string ids at the wire boundary. Export constructors only where they improve tests; do
not encode table names or meaning into an id.

```ts
export type PersonaId = string;
export type WorkflowId = string;
export type WorkflowVersionId = string;
export type WorkflowBindingId = string;
export type WorkflowRunId = string;
export type WorkflowSubmissionId = string;
export type WorkflowNodeAttemptId = string;
export type WorkflowDeliveryId = string;
export type WorkflowLlmCallId = string;

export const WORKFLOW_LIMITS = {
  personaName: 100,
  personaDescription: 500,
  personaGuidanceBytes: 100_000,
  workflowName: 120,
  graphNodes: 100,
  graphEdges: 300,
  graphJsonBytes: 500_000,
  eventPayloadBytes: 64_000,
  canvasCoordinateAbs: 100_000,
  repairRoundsMin: 1,
  repairRoundsMax: 20,
} as const;
```

Guidance limits are measured in UTF-8 bytes before persistence. Array and string element counts are
bounded in Zod before transforms walk them.

### Persona types

```ts
export interface Persona {
  id: PersonaId;
  name: string;
  normalizedName: string;
  description: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaExecutionView {
  runner: ResolvedLlmRunner;
  model: ResolvedModel;
}

export interface PersonaView extends Persona {
  execution: PersonaExecutionView;
}
```

`guidanceMarkdown` is exact user data. Do not trim, normalize line endings, prepend a title, or
rewrite it during import or save. Validation may reject an empty or oversized document but must not
alter an accepted one.

Normalize the uniqueness key with one exported pure helper: Unicode normalize to NFKC, trim,
collapse internal whitespace, and lowercase with a fixed English locale. Store both display name and
normalized name so SQLite does not have to approximate Unicode case folding.

### Graph and completion-policy types

Define the final graph vocabulary now even though Phase 2 is its first writer:

```ts
export type WorkflowSourcePort = "submitted" | "pass" | "fail";
export type WorkflowTargetPort = "activate" | "result" | "return_for_changes" | "terminal";

export type WorkflowDraftNode =
  | { id: string; kind: "session"; position: Point }
  | { id: string; kind: "persona"; personaId: PersonaId; position: Point }
  | { id: string; kind: "all_pass"; position: Point }
  | { id: string; kind: "end"; outcome: string; position: Point };

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: WorkflowSourcePort;
  target: string;
  targetPort: WorkflowTargetPort;
}

export interface PersonaSnapshot {
  sourcePersonaId: PersonaId;
  sourceRevision: number;
  name: string;
  description: string;
  guidanceMarkdown: string;
  runner: LlmRunnerId | null;
  model: string | null;
}

export type PublishedWorkflowNode =
  | Exclude<WorkflowDraftNode, { kind: "persona" }>
  | { id: string; kind: "persona"; persona: PersonaSnapshot; position: Point };

export type InspectorFindingsPolicy = "restart_workflow" | "inspector_only";

export type WorkflowCompletionPolicy =
  | { kind: "none" }
  | {
      kind: "inspector";
      onFindings: InspectorFindingsPolicy;
      missingPrAction: "wait" | "offer_prepare_pr";
    };

export type WorkflowTriggerMode = "manual" | "foreman_complete";
export type WorkflowDeliveryMode = "preview" | "live";

export interface WorkflowBindingDefaults {
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  maxRepairRounds: number;
}

export type WorkflowDeliveryKind = "persona_feedback" | "inspector_feedback" | "pr_handoff";
export type WorkflowDeliveryState =
  | "prepared"
  | "sending"
  | "delivered"
  | "refused"
  | "uncertain"
  | "cancelled";

export type WorkflowLlmPurpose = "context_compaction" | "persona_review";
export type WorkflowLlmCallState =
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";
```

There is exactly one visible `session` node. Draft Persona nodes reference a live Persona id;
published Persona nodes embed an exact snapshot and cannot compile against the live catalog. No
`checkpoint` or `inspector` node kind exists. Inspector is a workflow-level completion policy. These
negative assertions need contract tests so a later phase cannot accidentally restore the more
complicated design.

Define status enums for bindings, runs, submissions, attempts, and delivery now. The shared types
must distinguish judgment from infrastructure:

- Persona verdict: `passed` or `failed`.
- Attempt infrastructure state: `queued`, `running`, `retry_wait`, `error`, or `cancelled`.
- Run wait states: session repair, missing PR, Inspector review, blocked, or delivery uncertain.
- Submission mode: `full_workflow` or `inspector_only`.

Phase 1 does not yet transition these states, but database parsers must reject unknown values instead
of casting them.

### Persona model selection

Export `WORKFLOW_PERSONA_MODEL_SPEC` with:

- label `Workflow Persona`;
- environment variable `MISSION_WORKFLOW_PERSONA_MODEL`;
- provider-compatible balanced fallback from `providerModelDefault`;
- copy explaining that an individual Persona override wins.

The server resolves a Persona execution view in this order:

1. Persona runner override, otherwise `llmRunnerChoice()`.
2. Persona model override.
3. `MISSION_WORKFLOW_PERSONA_MODEL` from the daemon environment.
4. `providerModelDefault(resolvedRunner, "balanced")`.

Call the existing `resolveModelChoice` and `llmRunnerChoice`; do not introduce another resolver.
Return both stored and effective values to the browser. Unknown stored runner ids degrade through the
existing runner fallback and report that fallback rather than throwing the catalog route.

### Context-compaction model registration

Append `workflow-context` to `LLM_JOB_IDS` and add its `LLM_JOB_SPECS` record in Phase 1. Use
`MISSION_WORKFLOW_CONTEXT_MODEL` and copy explaining that the job compacts user goals, decisions, and
rationale for Persona review. The generic LLM config schema and panel already iterate the registry;
extend their contract tests so the new persisted key and rendered row are pinned.

This phase registers and configures the role but does not call it. Phase 3 owns the prompt, schema,
capture rules, and execution. Keep this app-wide job separate from `WORKFLOW_PERSONA_MODEL_SPEC`:
context compaction has one app setting, while a Persona can carry an individual execution override.

## Request schemas

Add all mutating schemas to `src/shared/protocol.ts`. Phase 1 routes use:

```ts
CreatePersonaSchema = {
  name,
  description?,
  guidanceMarkdown,
  runner?,
  model?
}

UpdatePersonaSchema = {
  expectedRevision,
  name?,
  description?,
  guidanceMarkdown?,
  runner?,
  model?
}
```

Use `ModelIdSchema` for a non-null model and `z.enum(LLM_RUNNER_IDS)` for a non-null runner. A patch
must contain at least one editable field in addition to `expectedRevision`. `null` explicitly clears
an override; omission leaves it unchanged.

Also declare the graph, workflow draft, publish, binding, submit, retry, and cancel schemas needed by
later phases. They do not get routes until their owning phase. Declaring them here makes Phase 1
contract tests the guard against drift between persistence and later endpoints.

Every later mutating route must use `parseBody`; no route may hand-parse JSON.

## Persistence

Add new tables to the `openDb()` SQL block. They are new tables, so they do not need `addColumn` calls.
Do not put backticks inside the SQL template literal.

### `personas`

| Column | Contract |
|---|---|
| `id` | `TEXT PRIMARY KEY` |
| `name` | Display name, non-null |
| `normalized_name` | Non-null uniqueness key |
| `description` | Non-null, default empty string |
| `guidance_md` | Exact Markdown, non-null |
| `runner_id` / `model_id` | Nullable overrides |
| `revision` | Non-null integer starting at 1 |
| `archived_at` | Nullable epoch ms |
| `created_at` / `updated_at` | Non-null epoch ms |

Add a unique index on `normalized_name`. Archive does not release the name; this prevents two durable
identities from swapping meaning when an archived Persona remains embedded in a published workflow.

### Workflow tables

Create these now so all subsequent phases share one migration boundary:

| Table | Required identity and constraints |
|---|---|
| `workflow_definitions` | `id` primary key; non-null unique `normalized_name`; draft graph, completion-policy, and binding-defaults JSON; monotonic draft revision; nullable current published version; archive and timestamps. |
| `workflow_versions` | `id` primary key; non-null workflow id, integer version, and source draft revision; immutable published graph, completion-policy, and binding-defaults JSON; published timestamp; unique non-null `(workflow_id, version)` and `(workflow_id, source_draft_revision)`. |
| `workflow_bindings` | `id` primary key; version id, durable `note_key`, last synthetic session id, trigger/delivery modes, state, round limit, timestamps. Partial unique index permits one active binding per `note_key`. |
| `workflow_runs` | `id` primary key; binding/version ids, status, current phase, round limit, trigger source/key, optional pinned Inspector PR/head, bounded gate-state JSON, timestamps. Unique non-null trigger key. |
| `workflow_submissions` | `id` primary key; run id, round, mode, non-null trigger source/key, evidence fingerprint, context/evidence JSON, optional PR head, status, timestamps. Unique non-null `(run_id, round)` and `trigger_key`. |
| `workflow_node_attempts` | `id` primary key; submission/node ids, attempt number, state, Persona snapshot JSON, verdict/output JSON, retry metadata, input fingerprint, timestamps, error. Unique non-null `(submission_id, node_id, attempt)`. |
| `workflow_edge_receipts` | `id` primary key; submission/edge/source-attempt ids, payload JSON, timestamp. Unique non-null `(submission_id, edge_id, source_attempt_id)`. |
| `workflow_deliveries` | `id` primary key; run/submission ids, kind, target session/note key, exact bounded payload and SHA-256, state, error, timestamps. Unique non-null `(submission_id, kind, payload_sha256)`. |
| `workflow_llm_calls` | `id` primary key; non-null run/submission ids, nullable node-attempt id, purpose, actual runner/model, call attempt/state, timing, prompt/result byte counts, nullable authoritative cost, bounded error code. Index `(run_id, started_at)` and `(submission_id, purpose)`. |
| `workflow_events` | Integer autoincrement id; run id, timestamp, event kind, bounded payload JSON. Index `(run_id, id)`. |

Do not add foreign keys unless the connection also enables and tests `PRAGMA foreign_keys`; the
existing database does not rely on unenforced declarations. Managers own referential checks and
deletion policy.

Store graph and policy as independent JSON columns. This lets Phase 5 read the completion policy
without parsing React Flow positions. Validate both on every read and write. A malformed durable row
is skipped with a diagnostic; it must not take down `/events` or the Persona catalog.

### Store module

Create `src/server/workflows/store.ts` for all workflow table access, beginning with:

- `listPersonas(includeArchived)`;
- `getPersona(id)`;
- `insertPersona(input)`;
- `updatePersonaCas(id, expectedRevision, patch)`;
- `archivePersonaCas(id, expectedRevision)`;
- table row parsers for every table;
- test-only cleanup helpers that accept an explicit test database.

Keep SQL and row mapping here. `PersonaManager` owns policy, ids, normalization, conflicts, and SSE.
Use a transaction for name-conflict checking plus insert/update. A failed CAS returns the current row
to the route so the editor can explain the conflict.

## Persona manager and HTTP surface

Create `src/server/workflows/personas.ts` with a `PersonaManager` constructed after `Registry` and
passed to `buildApp`.

Routes:

```text
GET    /api/personas?includeArchived=true|false
GET    /api/personas/:id
POST   /api/personas
PATCH  /api/personas/:id
DELETE /api/personas/:id
```

- `GET` returns `PersonaView`, including effective runner/model.
- `POST` returns 201.
- `PATCH` requires `expectedRevision`; stale revision or normalized-name conflict returns 409 with a
  stable error code and current row when available.
- `DELETE` is a soft archive, requires `expectedRevision` in a parsed body, and returns the archived
  row. It never deletes historical guidance.
- Missing ids return 404. Archived rows remain readable but refuse edits.

Browser copy and download remain client-side. Import reads one local `.md` file, derives the proposed
name from the first H1 or filename, leaves runner/model unset, and submits the unchanged file body to
the normal create route.

## SSE contract

Add `personas: PersonaView[]` to `registry.snapshot()` and the `snapshot` ServerEvent. Add:

```ts
| { type: "persona_upsert"; persona: PersonaView }
| { type: "persona_remove"; id: PersonaId }
```

Archive emits `persona_upsert`, because archived Personas stay addressable for history. Reserve
`persona_remove` for a future true deletion or reconciliation of corrupt state.

Update all compiler-enforced surfaces together:

- `ServerEvent`;
- `Registry.snapshot()` and Persona catalog initialization;
- `src/web/useEventStream.ts` exhaustive switch;
- `MissionState` and its return value;
- snapshot equivalence tests.

The web app must not add polling for Personas.

## Workflows shell

Add a hash-based page state owned by `App.tsx`:

```text
#/fleet
#/workflows
#/workflows/personas
#/workflows/runs
```

`#/workflows/personas` is the Phase 1 default. The Workflows and Runs tabs render honest empty-state
copy until their phases land. Do not add a router dependency.

Keep `useEventStream` and other fleet-level hooks mounted in `App`; switch only the rendered page
body. Returning to Cards, Console, or Board must not reconnect SSE or discard layout/selection.
Session keyboard shortcuts stand down while a Workflows page owns focus. The topbar Workflows button
must remain clickable in the Electron drag region.

Suggested modules:

```text
src/web/workflows/WorkflowPage.tsx
src/web/workflows/PersonaLibrary.tsx
src/web/workflows/PersonaEditor.tsx
src/web/workflows/useWorkflowRoute.ts
```

## Persona editor behavior

Use the existing `FileEditor` with a synthetic `<normalized-name>.md` path and the existing
`Markdown` component for preview. The selected Persona editor holds a local draft so incoming SSE
updates do not erase typed text.

Required behavior:

- Split Edit and Preview panes with an accessible toggle on narrow screens.
- Name, description, provider, model, and exact guidance fields.
- Effective provider/model displayed beside stored overrides.
- Explicit Save and `Cmd/Ctrl+S` using the revision loaded with the draft.
- Dirty-state confirmation before changing Persona, route, or archive.
- Copy Markdown, browser `Blob` download, `.md` import, Duplicate, and Archive.
- Conflict state retains the local draft and shows Reload latest or Save as duplicate. It never
  silently overwrites the newer revision.
- Archived Persona pages are read-only and clearly labeled.
- No autosave of guidance in Phase 1; a deliberate save keeps CAS conflicts understandable.

Do not add an Electron capability. Clipboard uses `navigator.clipboard` with the same fallback policy
as existing browser copy actions, and download uses an object URL that is revoked after click.

## Implementation order

1. Add shared types, enums, limits, model spec, append-only `workflow-context` job, and all request
   schemas.
2. Add tables, indexes, row parsers, and store tests under an isolated `MISSION_HOME`.
3. Add Persona model resolution and manager tests.
4. Extend Registry, ServerEvent, SSE snapshot, and browser event state.
5. Add Persona routes and HTTP integration tests.
6. Add hash page state and the Workflows shell.
7. Add Persona library/editor and import/export actions.
8. Add rendering, keyboard, conflict, and desktop drag-region tests.
9. Update README navigation, model environment variables, and Persona storage/export semantics.

## Tests

Add focused tests rather than one broad suite:

- `workflow-contracts.test.ts`: closed enums, limits, negative checkpoint/Inspector node assertions,
  completion policy, model spec, and protocol schemas.
- `workflow-db.test.ts`: table/index presence, exact Markdown round trip, JSON validation, unique
  indexes including per-submission trigger and delivery identity, and test-home isolation.
- `personas-store.test.ts`: insert, CAS update, stale conflict, normalized-name collision, archive,
  and archived-name reservation.
- `persona-model.test.ts`: runner override, app runner fallback, env model, provider-compatible
  fallback, stored override, and unknown runner reporting.
- Extend `llm-jobs.test.ts` and `llm-panel.test.ts` for the `workflow-context` registry entry and
  settings row.
- `personas-http.test.ts`: parseBody rejection, status codes, effective values, and soft archive.
- `workflow-sse.test.ts`: snapshot/upsert/archive and reconnect equivalence.
- `persona-editor-render.test.ts`: empty, selected, dirty, conflict, and archived states.
- Extend `desktop-drag-region.test.ts` for the Workflows topbar control.
- Extend the event-stream exhaustiveness and snapshot contract tests.

Run at minimum:

```text
npm run typecheck
node --test --import tsx test/workflow-contracts.test.ts
node --test --import tsx test/workflow-db.test.ts
node --test --import tsx test/personas-store.test.ts
node --test --import tsx test/persona-model.test.ts
node --test --import tsx test/personas-http.test.ts
node --test --import tsx test/workflow-sse.test.ts
node --test --import tsx test/persona-editor-render.test.ts
npm test
```

## Exit criteria

- Persona guidance round-trips byte-for-byte across create, update, restart, export, and import.
- Two tabs editing the same revision receive an explicit 409 conflict; neither loses text.
- Runner/model UI reports the same effective selection the daemon would execute.
- Archived Personas remain readable, reserve their names, and cannot be edited or newly selected.
- A browser reconnect receives the same Persona catalog as incremental events produced.
- The Workflows shell does not reconnect fleet SSE or break Cards, Console, Board, shortcuts, or the
  Electron drag region.
- All workflow tables and shared state enums required by Phases 2 through 6 exist and parse safely.
- `workflow-context` is an append-only configurable LLM job even though Phase 3 has not invoked it
  yet.

## Handoff to Phase 2

Phase 2 may add graph manager methods and routes to the existing store, plus workflow summary SSE
collections. It must use `WorkflowDraftNode`, `PublishedWorkflowNode`, `WorkflowEdge`,
`WorkflowCompletionPolicy`, the immutable version tables, and the page shell established here. It
must not add a checkpoint or Inspector node, resolve live Persona guidance while reading a published
version, or introduce a second workflow schema.

## Cross-phase audit record

- Initial audit: checked against the parent plan. There were no earlier phase documents. Added the
  `workflow-context` append-only model registration that the parent assigns to Phase 1.
- Phase 2 audit: split draft Persona references from immutable published Persona snapshots, split
  directional source and target port types, and added source-draft revision uniqueness for
  idempotent Publish.
- Phase 3 audit: added immutable binding defaults to definitions and versions. A later binding copies
  these defaults and may override them; trigger/delivery settings are not hidden global state.
- Phase 4 audit: added a dedicated delivery id/state/table and non-null unique trigger keys on every
  submission. Live side effects and repair resubmissions need durable identity before their owning
  phases can execute them safely.
- Phase 5 audit: added `pr_handoff` to the front-loaded delivery kinds and bounded Inspector
  gate-state JSON to `workflow_runs`. Later gate recovery must not require a migration to a workflow
  table that Phase 1 already owns.
- Phase 6 audit: added a finite canvas-coordinate limit and `workflow_llm_calls` accounting table.
  Input bounds and call ownership are foundation contracts even though Phase 6 first renders their
  diagnostics and totals.
- Contracts intentionally front-loaded for later audit: completion-policy shape, submission mode,
  all table identities, exact Persona snapshots, and the absence of checkpoint/Inspector node kinds.
