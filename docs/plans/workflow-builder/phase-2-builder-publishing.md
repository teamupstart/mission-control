# Phase 2 plan: workflow builder, validation, and publishing

Status: **implemented**

Parent: [Persona-driven workflow builder](./plan.md)

Prerequisite: [Phase 1 foundation and Personas](./phase-1-foundation-personas.md)

## Outcome

An operator can create a workflow draft, arrange a session-centered Persona graph in the
canvas-first builder, configure trigger/delivery placeholders and the optional Inspector final gate,
validate the graph, and publish an immutable version. Draft edits survive reloads with compare-and-
swap protection. A published version contains exact Persona snapshots and is never changed by later
Persona or draft edits.

This phase does not execute workflows or bind them to sessions.

## Phase 1 prerequisites

Phase 2 consumes these Phase 1 contracts without recreating them:

- `src/shared/workflow.ts`, workflow limits, ids, completion policy, and status enums.
- The complete workflow table family in `openDb()`.
- Persona manager, routes, SSE catalog, effective model view, archive behavior, and revision CAS.
- The Workflows page shell and its Personas tab.
- The `workflow-context` model registry entry, which remains unused until Phase 3.

Before implementation, run the Phase 1 test set. Do not begin canvas work on a branch whose Persona
snapshot or workflow-table tests are failing.

## Scope

### Included

- `@xyflow/react` as a canvas dependency and its stylesheet in the web entry.
- Distinct draft and published graph schemas.
- A pure graph validator shared by browser and daemon.
- Workflow definition, draft, validation, publishing, archive, and version-read APIs.
- Durable compare-and-swap autosave and idempotent publish.
- Workflow summary SSE state.
- Canvas-first workflow library, palette, graph, properties, validation, and publish UI.
- Inspector completion-policy configuration as workflow metadata.
- Version history, immutable Persona snapshot display, and stale-Persona indicators.

### Deferred

- Session bindings and run execution: Phase 3.
- Live delivery and Foreman completion triggers: Phase 4.
- Inspector polling-ledger integration: Phase 5.
- Guided-lane view, advanced accessibility, notifications, and polish: Phase 6.

## Split draft and published graph contracts

Phase 1 defines the vocabulary. Phase 2 must make edit-time references and execution-time snapshots
different types.

```ts
export type WorkflowSourcePort = "submitted" | "pass" | "fail";
export type WorkflowTargetPort = "activate" | "result" | "return_for_changes" | "terminal";

export interface WorkflowEdge {
  id: string;
  source: string;
  sourcePort: WorkflowSourcePort;
  target: string;
  targetPort: WorkflowTargetPort;
}

export type WorkflowDraftNode =
  | { id: string; kind: "session"; position: Point }
  | { id: string; kind: "persona"; personaId: PersonaId; position: Point }
  | { id: string; kind: "all_pass"; position: Point }
  | { id: string; kind: "end"; outcome: string; position: Point };

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
```

`WorkflowDraftGraph` contains draft nodes and edges. `PublishedWorkflowGraph` contains published
nodes and the same edge schema. Zod validates both separately. Code that executes a version accepts
only `PublishedWorkflowGraph`, so reaching for the live Persona catalog is a type error.

Ports are directional. A union that allows `submitted` as a target or `activate` as a source makes an
invalid edge representable and pushes errors into runtime. Keep source and target types separate.

An all-pass Join receives both the `pass` and `fail` edge from each predecessor on its `result`
target. Only one edge fires for one predecessor attempt. The Join groups receipts by predecessor node
id and waits for exactly one outcome from every configured predecessor.

## Workflow definition and summary types

```ts
export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  normalizedName: string;
  description: string;
  draft: WorkflowDraftGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  draftRevision: number;
  publishedVersion: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowVersion {
  id: WorkflowVersionId;
  workflowId: WorkflowId;
  version: number;
  sourceDraftRevision: number;
  graph: PublishedWorkflowGraph;
  completionPolicy: WorkflowCompletionPolicy;
  bindingDefaults: WorkflowBindingDefaults;
  publishedAt: number;
}
```

`WorkflowSummary` is the only form placed in SSE. It includes id, name, description, draft revision,
current published version number/id, archive state, updated timestamp, draft validation counts, node
count, and Persona count. It never includes graph JSON or guidance.

## Graph validation

Create `src/shared/workflow-graph.ts` for pure adjacency, port, reachability, and strongly-connected-
component logic. It may import only shared types and Zod.

Return structured diagnostics instead of a boolean:

```ts
interface WorkflowDiagnostic {
  code: WorkflowDiagnosticCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeId?: string;
}
```

Codes are stable UI and test contracts. Include at least:

- missing/multiple Session;
- missing End;
- duplicate node or edge id;
- dangling edge;
- invalid source or target port for node kind;
- missing pass or fail route;
- Join with fewer than two predecessors;
- Join predecessor missing its paired pass/fail edge;
- duplicate outcome route to the same Join;
- unreachable node;
- node that cannot reach End or Session repair;
- cycle without Session;
- missing or archived Persona;
- invalid completion policy;
- count, serialized-size, non-finite position, or absolute coordinate limit exceeded.

### Port matrix

| Node kind | Accepted target ports | Emitted source ports |
|---|---|---|
| Session | `return_for_changes` | `submitted` |
| Persona | `activate` | `pass`, `fail` |
| All-pass Join | `result` | `pass`, `fail` |
| End | `terminal` | none |

Rules:

1. Exactly one Session and at least one End.
2. Session has at least one `submitted` route, and it may fan out so a first wave of reviewers runs
   in parallel; zero routes is still an error. Its incoming edges must be `fail` to
   `return_for_changes`.
3. Every Persona and Join has at least one route for both `pass` and `fail`.
4. A `pass` or `fail` may fan out, except a paired Join input must contain exactly one of each from
   that predecessor.
5. A Join has at least two distinct predecessor nodes. Each predecessor must be a Persona or Join and
   connect both outcomes to that Join's `result` target.
6. Every node is reachable from Session.
7. Every reachable node can reach an End or return to Session.
8. Every cyclic strongly connected component contains the single Session. A Persona-only, Join-only,
   or mixed Persona/Join cycle is invalid.
9. Draft Persona nodes must resolve to active Personas at Publish. An archived Persona may remain in
   version history but may not enter a new version.
10. Inspector is validated only as the workflow completion policy. An `inspector` graph node is a
    schema error.

Browser connection validation runs the port matrix before accepting a drop. Full validation runs
after every draft change and again in the daemon before save and Publish.

## Persistence refinements

Use the Phase 1 tables. Add no new tables in this phase.

The `workflow_versions` table must carry `source_draft_revision INTEGER NOT NULL` and a unique index
on `(workflow_id, source_draft_revision)`. This makes a repeated Publish request idempotent. Its
existing unique `(workflow_id, version)` index remains.

`workflow_definitions.current_version_id` points at the current immutable version. The draft remains
editable after publish; Publish never clears or rewrites it.

Create or extend `src/server/workflows/store.ts` with:

- list/get/create/update/archive definition;
- CAS update keyed by `draft_revision`;
- list/get versions;
- publish transaction;
- summary projection.

The publish transaction performs these actions atomically:

1. Load the definition at `expectedDraftRevision`.
2. Parse and validate graph and completion policy.
3. Load every referenced Persona and reject missing or archived rows.
4. Replace each draft Persona reference with an exact `PersonaSnapshot`.
5. Compute the next version number.
6. Insert the immutable version with `sourceDraftRevision`, completion policy, and binding defaults.
7. Update `current_version_id` on the definition.
8. Return the existing version instead if the same draft revision was already published.

Do not update a published version when a Persona changes. Staleness is a comparison shown to the
operator, not a mutation.

## Manager and HTTP surface

Create `src/server/workflows/manager.ts` in Phase 2. It owns definition policy now and gains execution
policy in Phase 3.

Routes:

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:id
PATCH  /api/workflows/:id
DELETE /api/workflows/:id
POST   /api/workflows/:id/validate
POST   /api/workflows/:id/publish
GET    /api/workflows/:id/versions
GET    /api/workflows/:id/versions/:version
```

All writes use schemas from `src/shared/protocol.ts` through `parseBody`.

- Create starts with one Session, one End, and no connecting edge. The draft is invalid but useful;
  the UI says what remains rather than inventing a hidden path.
- Patch requires `expectedDraftRevision` and may update metadata, graph, and completion policy in one
  CAS.
- Validate requires `expectedDraftRevision` and validates the stored draft. The browser already runs
  the same validator; the route is the authoritative pre-publish check and supports future clients.
- Publish requires `expectedDraftRevision`; it is idempotent for that revision.
- Delete is soft archive. Refuse archive if a future active binding points at the definition; in
  Phase 2 there are no bindings yet, but implement the query now.
- Full GET returns the draft and version metadata. List returns summaries only.

Stable conflicts return 409 with `code`, expected/current revision, and current summary. Validation
errors return 422 with the diagnostic array. Malformed bodies remain 400 through `parseBody`.

## SSE additions

Add `workflowSummaries: WorkflowSummary[]` to the snapshot and `MissionState`, plus:

```ts
| { type: "workflow_upsert"; workflow: WorkflowSummary }
| { type: "workflow_remove"; id: WorkflowId }
```

As with Personas, archive is an upsert. Do not send full graph JSON over fleet SSE. The selected
builder fetches its full definition through HTTP, and an SSE summary revision tells it when that
definition changed elsewhere.

Update `ServerEvent`, `Registry.snapshot()`, `useEventStream`, and snapshot-equivalence tests in the
same change.

## Canvas-first user experience

Implement the first mockup in [the rendered parent plan](./plan.html): workflow library and palette
on the left, graph canvas in the center, properties/validation on the right.

Suggested modules:

```text
src/web/workflows/WorkflowLibrary.tsx
src/web/workflows/WorkflowCanvas.tsx
src/web/workflows/WorkflowNode.tsx
src/web/workflows/WorkflowProperties.tsx
src/web/workflows/WorkflowValidation.tsx
src/web/workflows/WorkflowVersionHistory.tsx
src/web/workflows/useWorkflowDraft.ts
```

### Library and draft lifecycle

- Workflows tab becomes active and opens the last selected definition.
- Create, duplicate, rename, archive, and open version history.
- Autosave draft changes after 500 ms of quiet, with one request in flight per workflow.
- Every save includes the revision it was based on. A successful response advances the local
  revision.
- An SSE revision newer than a clean local draft reloads it. A newer revision while dirty or saving
  freezes autosave and opens a conflict banner with Reload latest or Duplicate my draft.
- Route changes flush a pending save or ask before discarding it.
- Publish is disabled while dirty, saving, conflicted, invalid, or already published at the same
  revision.

### Palette and nodes

The palette contains Persona, All-pass Join, and End. Session is created with the workflow and cannot
be deleted or duplicated. Persona drag/drop opens a chooser if more than one Persona exists.

Node presentation:

- Session: blue, one submitted handle, one return-for-changes handle.
- Persona: accent-colored, name, provider/model summary, pass/fail handles.
- Join: neutral, predecessor count, pass/fail handles.
- End: green, editable outcome label, no outgoing handle.

Use custom React Flow nodes. Mission Control owns all styles; do not style by `AgentType` or put node
ids in global CSS.

### Properties and workflow policy

When a node or edge is selected, the right pane edits it and lists diagnostics attached to it. With
nothing selected it shows workflow-level settings:

- default trigger for new bindings: Manual or Foreman complete;
- default delivery for new bindings: Preview or Live;
- maximum repair rounds, default 5, range 1 through 20;
- final gate: None or Inspector approval;
- Inspector findings: Restart all Personas or Repush and recheck Inspector only;
- missing PR: Wait or Offer Prepare PR.

Phase 2 persists these choices in `WorkflowBindingDefaults` and the completion policy. Phase 3
copies defaults into each binding, which may override them. The UI labels Foreman, Live, and
Inspector execution as landing in later phases; it does not pretend they work yet.

### Version history

Each version view shows:

- version and source draft revision;
- publish time;
- completion policy;
- binding defaults;
- graph in read-only mode;
- every embedded Persona name, source revision, provider/model override, and exact Markdown;
- an `outdated` indicator when the current live Persona revision differs;
- `archived source` when the Persona no longer appears in the active library.

Do not offer "update version." The operator edits the draft and publishes a new version.

## Package and build changes

Add `@xyflow/react` to `dependencies` and import its base stylesheet from the workflow page or web
entry. No new build entry point is needed. Verify Vite production build, Electron build, and source
map behavior. Package lock changes belong in this phase.

Do not add a CDN, web worker, server-side rendering path, or browser polling.

## Implementation order

1. Refine shared draft/published node, edge, directional port, diagnostic, definition, version, and
   summary types.
2. Implement the pure validator and exhaustive unit tests.
3. Add the `source_draft_revision` table/index contract and store methods.
4. Implement manager routes, CAS, publish transaction, Persona snapshotting, and route tests.
5. Add workflow summary registry/SSE state.
6. Add React Flow and the Workflows library/canvas shell.
7. Implement custom nodes, connections, selection, properties, and diagnostics.
8. Implement autosave conflict behavior and idempotent Publish.
9. Implement version history and stale-Persona display.
10. Update README with graph semantics, final-gate configuration, and draft/version behavior.

## Tests

- `workflow-graph.test.ts`: port matrix, fan-out, paired Join outcomes, reachability, legal Session
  cycles, rejected Persona cycles, size limits, NaN/Infinity/out-of-range positions, and stable
  diagnostic codes.
- `workflow-publish.test.ts`: exact Persona snapshots, archived/missing Persona rejection,
  source-draft idempotency, monotonic versions, and immutable old versions.
- `workflow-store.test.ts`: definition CAS, normalized-name collision, archive, JSON validation, and
  summary projection.
- `workflows-http.test.ts`: parseBody, status codes, conflicts, validation 422, version reads, and
  idempotent Publish.
- Extend `workflow-sse.test.ts` for summary snapshot/upsert/archive and reconnect equivalence.
- `workflow-draft.test.ts`: debounce, one in-flight save, conflict freeze, reload, duplicate, and
  Publish guards.
- `workflow-builder-render.test.ts`: empty library, nodes, policy panel, diagnostics, conflict, and
  version history.
- `workflow-node-contract.test.ts`: only shared custom node leaves render each node kind and no
  checkpoint/Inspector node appears.
- Production `npm run build:web`, `npm run typecheck`, and the full test suite.

## Exit criteria

- The example Session to Code Quality to concurrent Maintainability/Design to Join graph can be
  drawn, saved, reloaded, validated, and published.
- Failures visibly return to one Session node; the palette has no checkpoint or Inspector node.
- Invalid connections are refused at drop time and reported by the shared validator if loaded from
  durable data.
- Concurrent editor conflicts preserve local work and never overwrite a newer draft.
- Repeating Publish for one draft revision returns one immutable version.
- Published versions contain exact Persona snapshots and do not change after Persona edits/archive.
- Inspector choices are stored only as completion policy and clearly marked unavailable until
  Phase 5.
- Fleet SSE remains the only live browser channel and carries summaries, not graph blobs.

## Handoff to Phase 3

Phase 3 executes only immutable `WorkflowVersion` records. It may add binding/run routes and runtime
SSE summaries, but it must not execute a mutable draft, resolve live Persona guidance, mutate a
version, or introduce a new graph validator. A full resubmission always starts from the published
Session node and gets a new immutable evidence snapshot.

## Cross-phase audit record

- Initial audit: checked against the parent and Phase 1 plans.
- Phase 1 follow-up required: split draft Persona references from published Persona snapshots; split
  source and target port types; add Join `result`, Persona `activate`, and End `terminal` target
  ports; add `source_draft_revision` to versions for idempotent Publish.
- Phase 3 audit: added `WorkflowBindingDefaults` to definitions, versions, publishing, settings, and
  history so trigger/delivery/round-cap values become explicit defaults that bindings copy.
- Phase 5 audit: no schema correction required. The published Inspector policy and missing-PR action
  already live outside the graph and are immutable inputs to the final-gate adapter.
- Phase 6 audit: added finite bounded node coordinates to the authoritative validator. Fit/zoom and
  auto-layout cannot safely treat NaN, Infinity, or unbounded positions as cosmetic UI data.
