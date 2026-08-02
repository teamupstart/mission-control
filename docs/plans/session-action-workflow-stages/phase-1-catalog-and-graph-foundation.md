# Phase 1: SessionAction catalog and graph foundation

Source plan: [`plan.md`](plan.md)

Phased index: [`phased-plan.md`](phased-plan.md)

## Outcome and value

Mission Control gains the durable vocabulary every later SessionAction feature consumes:

- a revisioned SessionAction catalog with exact prompt Markdown;
- compiled built-in SessionActions, beginning with Pull Request;
- immutable SessionAction snapshots in published workflow graphs;
- a `session_action` graph node with an append-only `complete` output;
- an honest stage union separating evaluation waves from singleton session actions.

This phase deliberately does not expose action authoring in the browser and does not execute an
action node. It establishes one source of truth, complete persistence and wire validation, and
round-trip-safe graph behavior without shipping a button that starts an unavailable runtime.

## Entry criteria and direct dependencies

Direct prerequisite: the planning-artifacts pull request containing `plan.md`, `phased-plan.md`,
and all four phase documents is merged to the default branch.

Before editing:

1. Read the source plan, phased index, this file, root `AGENTS.md`, architecture guide, change
   contracts, workflow builder plan, workflow pipeline plan, and built-in workflow plan.
2. Run `git status --short` and preserve unrelated work.
3. Run `npm run typecheck` on the merged base.
4. Verify the current No-Mistakes Review version catalog and append-only workflow tuples rather than
   trusting the planning branch's observed version number.

## Scope

In scope:

- SessionAction shared types, limits, normalization helpers, completion-adapter ids, snapshots,
  graph node variants, and source port.
- Zod schemas for entities, mutations, snapshots, draft/published nodes, and events.
- SQLite catalog table, fresh schema, additive migration, row parsers, CAS CRUD, archive, built-in
  merge/addressability rules, and upgrade tests.
- Compiled built-in Pull Request SessionAction sourced from exact Markdown.
- SessionAction manager and bounded HTTP CRUD routes.
- Registry snapshot and exhaustive SSE upsert/remove handling.
- Workflow validation and publish-time SessionAction resolution/snapshotting.
- Stage projection/compiler discriminated union and stable-id round trips.
- Minimal read-only Graph/Pipeline/version rendering needed to keep every parsed graph representable.
- A server-side publish refusal for action graphs while the Phase 2 runtime is unavailable.
- Focused documentation of the new internal contracts in the affected code and plan audit.

Explicit non-goals:

- No SessionActions tab or action editor in the browser.
- No builder add control, drag source, editable properties, or removal/reorder affordance for an
  action created through unsupported raw API manipulation.
- No action delivery, attempt runner, wait state, session observer, or continuation capture.
- No database segment migration.
- No `session_action` delivery kind or delivery-to-attempt link.
- No Pull Request completion adapter or change to the legacy Inspector `preparePr` path.
- No No-Mistakes Review version 8.
- No Inspector footer presentation.

## Repository findings and inherited contracts

### Persona is the catalog precedent, not the execution abstraction

`personas` already supplies the desired CAS, normalization, archive, built-in, display-shadow,
addressable-catalog, registry, route, and immutable-snapshot patterns. Reuse those ownership
boundaries, but do not add action fields to `Persona` or `PersonaSnapshot`. Personas select an LLM
runner/model and emit verdicts; SessionActions select a session prompt, optional skill, and
completion adapter.

### Built-ins are compiled app data

Built-in Personas and workflows do not occupy operator rows. Follow that model for Pull Request.
Since SessionActions did not exist before this phase, there is no legitimate pre-feature operator
row to preserve under the built-in name. Still implement the same addressable/display split so
future built-ins and archived operator rows behave consistently.

### Graph and Pipeline share one persisted truth

`workflow-stages.ts` must continue to satisfy:

```text
projectStages(compileStages(pipeline, previousGraph)) == pipeline
```

Every surviving node, Join, Session, End, and edge id must be reused. Adding the `complete` port
must not rewrite old graphs or remint their identities.

### Published graphs are immutable

A draft action node holds only `sessionActionId`. Publish must resolve the action inside the same
transactional catalog view used for Personas and replace it with a complete snapshot. Runtime code
in later phases will read only that snapshot.

### Durable identifiers are append-only

Phase 1 owns these exact spellings:

```ts
node kind: "session_action"
source port: "complete"
completion kinds: "session_turn", "pull_request"
```

Append them to existing tuples. Never reorder or alias them.

## Implementation steps

### 1. Shared SessionAction contract

In `src/shared/workflow.ts`:

- add `SessionActionId`;
- add prompt/name/description/skill-id limits;
- add append-only `SESSION_ACTION_COMPLETION_KINDS`;
- add `SessionActionCompletion`, `SessionAction`, and `SessionActionSnapshot`;
- add normalization and display-choice helpers with the same Unicode rule as Personas;
- add snapshot-outdated detection;
- add draft/published `session_action` node variants;
- append `complete` to `WORKFLOW_SOURCE_PORTS`;
- keep `WorkflowVerdictNode` restricted to Persona and Check;
- add a narrow `WorkflowSessionActionNode` type guard rather than widening verdict helpers.

The initial entity shape is fixed by the source plan:

```ts
interface SessionAction {
  id: SessionActionId;
  name: string;
  normalizedName: string;
  description: string;
  promptMarkdown: string;
  requiredSkillId: string | null;
  completion: SessionActionCompletion;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  builtin: boolean;
}
```

Prompt Markdown is exact after decoding. Required skill is an id only and never an argv or free
shell command. Completion ids are closed server-owned adapters, not user-authored scripts.

### 2. Protocol schemas

In `src/shared/protocol.ts`:

- add bounded create, update, archive, entity, and snapshot schemas;
- require `expectedRevision` on update/archive;
- require at least one editable field on update;
- validate prompt content without transforming it;
- conservatively bound skill ids and make them nullable;
- add the draft and published node arms;
- accept `complete` only through the shared source-port tuple;
- add ServerEvent payload validation if the event union is schema-backed;
- update body-size constants in routes based on the prompt byte ceiling.

Malformed stored completion kinds must fail the row boundary. Do not `.catch()` them into
`session_turn`, because that could complete a historical action under a different proof contract.

### 3. Built-in source and generator

Add `docs/session-actions/pull-request.md` as the exact authored prompt. Its first H1 is the action
name and the paragraph beneath it is the description, matching the built-in Persona authoring
convention.

Add a generator under `scripts/` and a generated server module beside built-in workflow assets.
Prefer extracting shared parsing/generation helpers from `scripts/builtin-personas.ts` while
preserving the existing `npm run personas` command. Add `npm run session-actions`, or one additive
umbrella command, without silently changing what `npm run personas` writes.

The generated record uses:

- stable built-in id derived from a reserved slug;
- `requiredSkillId: "pull-request"`;
- `completion: { kind: "pull_request" }`;
- exact prompt Markdown;
- `builtin: true` and a stable synthetic revision.

Tests compare the generated module with the source document so drift is detected.

### 4. Database and row parsing

In `src/server/db.ts`, add the fresh `session_actions` table:

```sql
CREATE TABLE IF NOT EXISTS session_actions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  normalized_name   TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  prompt_md         TEXT NOT NULL,
  required_skill_id TEXT,
  completion_kind   TEXT NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 1,
  archived_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

Create the normalized-name unique index. This is a new table, so no column backfill is required,
but add a migration/upgrade test proving an existing database opens and receives it safely.

In `src/server/workflows/store.ts`:

- add strict row schemas/parsers;
- add list, addressable catalog, get, insert, update CAS, and archive CAS;
- add built-in merge, name reservation, sort, and display helpers;
- retain archived rows for draft/version history;
- never write a built-in to SQLite;
- publish workflow snapshots from a transaction-local SessionAction catalog alongside Personas.

Name conflicts and built-in refusals should return typed results parallel to Persona mutations,
with action-specific error codes and copy.

### 5. Manager, routes, registry, and SSE

Add `src/server/workflows/session-actions.ts` owning policy and Registry publication. Add routes:

- `GET /api/session-actions`;
- `GET /api/session-actions/:id`;
- `POST /api/session-actions`;
- `PATCH /api/session-actions/:id`;
- `DELETE /api/session-actions/:id` for archive.

Follow route body limits and `parseBody`; do not hand-parse JSON.

Extend Registry with one SessionAction map and initialization/upsert/remove methods. Extend
`MissionState`, snapshot construction, `ServerEvent`, and `src/web/useEventStream.ts` exhaustively.
Archive emits upsert because the durable entity remains addressable.

Use the Persona precedent and include the bounded action catalog in the state snapshot/SSE. Do not
add workflow-summary prompt text or a second browser poller. Record the payload-size decision in
tests so a later switch to detail-only fetching is intentional.

### 6. Graph validation capability model

In `src/shared/workflow-graph.ts`, replace the assumptions collected in `OUTCOME_KINDS` with one
browser-safe node capability descriptor that owns:

- allowed source ports;
- allowed target ports;
- required outgoing ports;
- whether it may feed a Join;
- human diagnostic label;
- structural/evaluation/action role.

SessionAction:

- receives `activate`;
- emits `complete`;
- requires exactly one complete route in a pipeline;
- cannot feed `all_pass`;
- does not require pass/fail;
- does not gain a return-to-Session route.

Keep validation of missing/archived action references conditional on the supplied action catalog,
as Persona validation is today.

### 7. Stage projection and compilation

In `src/shared/workflow-stages.ts`, replace the uniform `Stage` interface with:

```ts
type Stage = EvaluationStage | SessionActionStage;
```

Evaluation stages preserve the current member/Join wiring. SessionAction stages contain one
action member, have no Join, and route `complete` onward. Update:

- projection and blocker analysis;
- compilation and stable edge reuse;
- stage/node names, contents, and summaries;
- focus/order helpers shared by renderers;
- old graph round-trip fixtures.

A freehand action wired with pass/fail, mixed into a Join, or fanned out beside another member is
valid only if general graph validation permits its literal ports, which it should not. Pipeline
blockers must still explain structural shapes that are valid graphs but not linear pipelines.

### 8. Publish gate and minimal consumers

Update workflow validation/publish manager inputs with the SessionAction catalog. Publishing
resolves active actions and writes exact snapshots. Add a temporary, explicit
`session_action_runtime_unavailable` publication diagnostic until Phase 2 supplies the execution
handler. Draft save remains allowed so API and fixtures can round-trip the new graph.

Update exhaustive server/web readers enough to parse and render an action node read-only:

- WorkflowCanvas node mapping and node type registry;
- node labels and version history;
- RunPipeline/ladders fallback naming for a version fixture;
- workflow counts and summaries, adding `sessionActionCount` only if a displayed count needs it;
- export/import validation.

Do not add palette or Pipeline add-menu exposure. Any UI path that would publish or bind the node
remains disabled with the runtime-unavailable sentence.

## Data, API, migration, and compatibility

- New table only; no existing row is rewritten.
- New graph kinds and ports are append-only and unknown to older builds. Older builds must refuse
  rather than reinterpret them.
- Existing drafts and published graphs serialize identically.
- Existing Persona publish transactions retain their atomic behavior while action snapshotting is
  added to the same boundary.
- Built-in Pull Request is addressable by stable id but not yet offered as an executable node.
- No workflow version is appended in this phase.
- No delivery or attempt schema changes occur yet.

## Focused tests and verification

Add or extend focused tests for:

- exact prompt preservation, Unicode normalization, CAS conflicts, archive, name reservation,
  duplicate, built-in read-only behavior, and addressability;
- source Markdown to generated built-in parity;
- HTTP status/error/body-limit behavior;
- Registry snapshot and exhaustive SSE updates;
- draft/published schema acceptance and malformed completion/skill rejection;
- graph ports, missing routes, Join exclusion, reference validation, reachability, and cycles;
- stage projection/compilation for first, middle, last, and multiple action stages;
- stable node/edge ids and byte-stable old graph round trips;
- publish snapshots and outdated-source reporting;
- runtime-unavailable publish refusal;
- database upgrade from a pre-action fixture.

Run:

```sh
npm run session-actions
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

If the generator command is named differently, use and document the final package script. Build is
required because the generated built-in and shared graph contracts enter packaged code.

## Exit criteria and merge gate

- Every SessionAction field has one canonical shared type and Zod boundary.
- Built-in Pull Request is generated from exact Markdown and never seeded into SQLite.
- CRUD and CAS behavior is complete through HTTP and SSE.
- Published snapshots are immutable and transactionally resolved.
- Graph and Pipeline round trips preserve old identities and action identities.
- No visible authoring control can publish an action before Phase 2.
- Existing workflow, Persona, built-in, export, and version tests pass unchanged or with only
  additive expectations.
- Full validation commands are green.

## Downstream handoff

Phase 2 may rely on:

- the exact `session_action`, `complete`, `session_turn`, and `pull_request` spellings;
- `SessionActionSnapshot` being complete and immutable;
- action nodes being singleton Pipeline stages with only a complete route;
- built-in Pull Request's stable source id and required skill;
- publish refusing action graphs only because the runtime capability is absent.

As built, those live at these names:

| Contract | Where |
|---|---|
| Completion registry | `SESSION_ACTION_COMPLETION_KINDS` in `src/shared/workflow.ts` |
| Node capabilities (ports, required routes, Join eligibility, role, label) | `WORKFLOW_NODE_CAPABILITIES` in `src/shared/workflow-graph.ts` |
| Snapshot projections, stated once for both publishers | `personaSnapshotOf` / `sessionActionSnapshotOf` in `src/shared/workflow.ts` |
| Stage union and its shared readers | `Stage`, `stageMembers`, `stageNodeIds`, `stageSeamGate`, `stageMemberKey` in `src/shared/workflow-stages.ts` |
| The one draft validation | `WorkflowStore.validateDraft` - the library card, the diagnostics route and Publish all call it |
| Catalog CAS and transactional publish | `WorkflowStore.listSessionActionsInTransaction`, used inside `publishWorkflow`'s transaction |
| Registry/SSE | `Registry.upsertSessionAction`, `session_action_upsert` / `session_action_remove` |

The publish gate is **one boolean**, `SESSION_ACTION_RUNTIME_AVAILABLE` in
`src/shared/workflow-graph.ts`, read through `WorkflowGraphValidationInput.sessionActionRuntimeAvailable`
and injected into `WorkflowStore` as its last constructor argument (defaulting to the constant, the
way `builtins` does). Phase 2 replaces it with the per-adapter availability check that document
already specifies; the injection point is what let Phase 1 prove the snapshot and transaction rules
without a runtime, and it is the seam to widen rather than a flag to leave behind.

Phase 2 must not:

- widen `WorkflowVerdictNode` to include SessionAction;
- reinterpret complete as pass/fail;
- resolve live action text during a run;
- expose authoring before recovery and continuation tests pass;
- alter the legacy `pr_handoff` delivery path.

## Cross-phase audit record

- The source plan's broad arbitrary-placement requirement is intentionally not implemented here;
  Phase 1 owns only the durable representation that Phase 2 consumes.
- The built-in action is created now because snapshot and name-reservation behavior belong to the
  catalog owner, while its `pull_request` verifier remains Phase 4's runtime responsibility.
- The stage union is changed before execution so Phase 2 receives a truthful action shape and does
  not build a temporary third evaluation member.
- UI parsing/rendering is included only where exhaustive unions require it. Authoring is withheld,
  so this phase leaves no user-visible dead control.
- Reconcile this record after review if Phase 1 changes a shared name, migration, or publish gate;
  every downstream phase file must be updated before scheduling its implementation.

Reconciled after implementation:

- The publish gate is a VALIDATION diagnostic rather than a store-only refusal, so the Publish
  control is disabled where an operator can read the reason instead of becoming a 409 against a
  button that looked enabled. It is injectable for the same reason `builtins` is, which is what
  makes the snapshot and publish-transaction rules provable before a runtime exists.
- Two shared helpers were extracted rather than added: `personaSnapshotOf` beside
  `sessionActionSnapshotOf`, because the store and the built-in workflow catalog are two publishers
  of the same snapshot shape, and `WorkflowStore.validateDraft`, because three call sites were
  independently assembling the same validation input.
- The generator was split into `scripts/builtin-markdown.ts`, shared by `npm run personas` and the
  new `npm run session-actions`. `npm run personas` writes byte-identical output, pinned by its
  existing drift test.
- NO affordance for an action node is offered anywhere in the browser: not add, not configure,
  not reorder, not remove. An earlier attempt kept `Delete node` in Graph view on the argument
  that deletion is an escape hatch for a graph that arrived through the raw draft API; review
  rejected that, correctly - this phase's constraint names removal explicitly, and half an
  authoring loop is still authoring. The refusal is enforced in three places, because an
  affordance withheld in one and left open in another is the same affordance: the rail omits
  the button, `removeSelection` refuses the node, and the canvas marks it `deletable: false`
  so React Flow's delete key cannot reach it either. `duplicateNodes` refuses one for the
  related reason - duplicating is an add control by another name. A graph that arrived through
  the raw API leaves the same way it came, or with the workflow.
- Driving the real builder found two dead controls the unit tests did not: an "Add reviewer or
  check" picker on an action stage, and a Duplicate button that lit up for a selected action and
  then did nothing. Both are fixed and pinned in `test/session-action-render.test.ts`.
