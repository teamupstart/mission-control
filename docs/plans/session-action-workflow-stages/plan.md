# SessionAction workflow stages and the built-in Pull Request action

Status: proposed

## Outcome

Mission Control gains a reusable SessionAction library and an authorable SessionAction stage in
the workflow builder. A SessionAction sends an exact, versioned instruction to the workflow's
bound session, waits for that action turn to finish, captures fresh evidence, and continues only
the downstream portion of the graph against that new evidence.

The first built-in action is **Pull Request**. It invokes the existing `pull-request` skill,
requires durable proof of the resulting PR, and ships as the last authored stage of a new
No-Mistakes Review version. The existing Inspector completion policy remains outside the graph,
but the Pipeline builder and run views render it as a fixed footer stage after End.

This plan adopts the operator's three decisions:

1. SessionActions are revisioned reusable library entities. Published workflow versions snapshot
   the selected action exactly as they snapshot Personas.
2. SessionActions may appear anywhere in a linear pipeline. After the action turn settles,
   Mission Control captures fresh evidence and continues only downstream stages.
3. Inspector remains the immutable workflow completion policy. It is presented as a fixed footer
   stage rather than converted into an authorable graph node.

## Recommendation: phased implementation

Do not one-shot this change.

The visible node is the smallest part. The selected behavior crosses four independently risky
contracts:

- a new revisioned catalog and published snapshot type;
- a new graph node and a second semantic kind of stage;
- a durable session-write and wait/resume lifecycle;
- a new intra-round evidence checkpoint that continues downstream instead of restarting at
  Session.

The checkpoint is the critical boundary. Today one `WorkflowSubmission` owns one immutable
evidence snapshot and activating a new submission starts at Session. Reusing that submission
after a SessionAction would make upstream attempts and downstream attempts claim they reviewed
the same evidence when they did not. Creating an ordinary repair submission would safely capture
new evidence but incorrectly rerun the graph from the top and consume a repair round. A distinct
continuation segment is therefore required before the UI can honestly expose actions in arbitrary
positions.

The recommended implementation is four dependency-linked phases. Each phase keeps the existing
workflow behavior valid, and the feature remains hidden from authors until its runtime can execute
published nodes.

## Current repository findings

### The graph is durable; stages are projected

`WorkflowDraftGraph` and `PublishedWorkflowGraph` are the stored and executed forms. The Pipeline
model in `src/shared/workflow-stages.ts` is a browser-safe projection that compiles back into the
graph while preserving node and edge identities.

Today `StageMember` is exactly Persona or Check, and every stage is an all-pass evaluation wave.
A SessionAction is not another evaluation member:

- it does not return a Persona verdict;
- it must not emit repair feedback merely because delivery or execution failed;
- it writes to the bound conversation;
- it may change the repository and invalidate the current evidence snapshot;
- it must run alone rather than in parallel with evaluators.

The stage projection should therefore become a discriminated union instead of widening the
existing `members` array with a third item that only works when it is alone.

### The second half of Pull Request already exists

`WorkflowManager.preparePr` already resolves the bound session's `pull-request` skill, renders a
bounded deterministic packet, persists a `pr_handoff` delivery, applies the normal Live-delivery
consent gates, and waits for Inspector-owned durable PR provenance. It also handles refused and
uncertain writes and recovers prepared deliveries after restart.

That implementation is currently coupled to:

- `WorkflowCompletionPolicy.kind === "inspector"`;
- `missingPrAction`;
- `WorkflowInspectorGateState`;
- a run that has already reached End.

The new node should extract and reuse the handoff and delivery mechanics. Versions already
published with `missingPrAction: "offer_prepare_pr"` or `"prepare_pr"` must continue through the
legacy post-End path unchanged.

### Session completion can be observed, but stale idle must not count

`settledIdle` is the shared positive idle predicate. The workflow resumption observer already
combines it with conversation identity, `needs-you` checks, delivery state, and repository probes.

A newly delivered SessionAction cannot treat the session's pre-delivery idle state as completion.
The durable action attempt must first observe pickup after the recorded transcript anchor or a
post-delivery working/activity transition, and only then accept a later settled-idle state. This is
the same race the work queue guards against when it types into an idle pane.

### Existing submissions cannot represent a checkpoint honestly

`workflow_submissions` currently has one row per repair round, enforced by the unique
`(run_id, round)` index. Attempts and edge receipts are scoped to a submission. A SessionAction
continuation needs multiple immutable evidence snapshots inside the same repair round:

```text
repair round 1, segment 0: initial evidence -> upstream stages -> SessionAction
repair round 1, segment 1: fresh evidence -> downstream stages -> another SessionAction
repair round 1, segment 2: fresh evidence -> remaining stages -> End
```

Only an actual fail/repair transition increments the repair round and restarts from Session.
Action continuations increment the segment and preserve the repair budget.

## Product and domain model

### SessionAction entity

Add a new shared entity, separate from Persona:

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

type SessionActionCompletion =
  | { kind: "session_turn" }
  | { kind: "pull_request" };
```

`promptMarkdown` is exact text. Validation may inspect length and non-emptiness but must not trim,
normalize newlines, expand variables, or interpret template syntax.

`requiredSkillId` names a skill capability, never a command. At dispatch time the daemon resolves
the current harness-native invocation with `requiredSkillCommand`. A missing, disabled, drifted,
or not-yet-loaded skill blocks before any write. The command is re-resolved immediately before
send, as the current PR handoff does, so a prepared packet cannot invoke a stale link.

`completion.kind` selects a server-owned completion adapter:

- `session_turn`: completes after verified pickup followed by settled idle;
- `pull_request`: requires the same turn boundary plus durable matching PR provenance.

The completion vocabulary is append-only because it reaches operator rows and immutable published
graphs. The initial UI creates ordinary actions with `session_turn`. Pull Request is the built-in
`pull_request` action. Duplicating it preserves its completion adapter and required skill so an
operator may customize the exact instruction without losing PR verification.

### Built-in Pull Request action

Ship one compiled built-in SessionAction:

| Field | Value |
|---|---|
| Name | Pull Request |
| Description | Prepare the reviewed work as a reviewer-ready pull request |
| Required skill | `pull-request` |
| Completion | `pull_request` |
| Prompt | The current deterministic PR handoff instruction, authored as exact Markdown |

Treat it like built-in Personas and workflows:

- compiled into the application, not seeded into SQLite;
- read-only and always available unless shadowed by an impossible/pre-feature conflict;
- Duplicate creates an operator-owned revisioned copy;
- its normalized name is reserved;
- published workflow versions snapshot the exact prompt, skill id, completion adapter, name,
  description, source id, and source revision.

Author the prompt under `docs/session-actions/pull-request.md` and compile it through a generator.
Do not hand-edit the generated module. Either add `npm run session-actions` or generalize the
existing built-in Persona generator into one workflow-assets command without changing the
existing `npm run personas` contract.

### Published snapshot

Add `SessionActionSnapshot`:

```ts
interface SessionActionSnapshot {
  sourceSessionActionId: SessionActionId;
  sourceRevision: number;
  name: string;
  description: string;
  promptMarkdown: string;
  requiredSkillId: string | null;
  completion: SessionActionCompletion;
}
```

A draft node points at the live action id. Publishing resolves active actions and replaces the
reference with this snapshot. Editing or archiving the source later cannot change a run pinned to
the published version. History reports outdated and archived sources the same way it does for
Persona snapshots.

### Graph node and stage model

Add draft and published node variants:

```ts
// Draft
{ id: string; kind: "session_action"; sessionActionId: SessionActionId; position: Point }

// Published
{ id: string; kind: "session_action"; action: SessionActionSnapshot; position: Point }
```

Add a `complete` source port. It is append-only beside the existing persisted ports. A
SessionAction receives `activate` and emits only `complete`. Delivery refusal, uncertain writes,
session loss, and verifier failure are attempt/run states, not graph outcomes and not routes back
to Session.

Change the pipeline projection to:

```ts
type EvaluationStage = {
  kind: "evaluation";
  joinId: string | null;
  members: Array<PersonaStageMember | CheckStageMember>;
};

type SessionActionStage = {
  kind: "session_action";
  member: SessionActionStageMember;
};

type Stage = EvaluationStage | SessionActionStage;
```

Pipeline validation and compilation enforce:

- an evaluation stage contains one or more Persona/Check members and retains all-pass behavior;
- a SessionAction stage contains exactly one action;
- an action cannot share a Join or run in parallel;
- action `complete` reaches the next stage or End;
- actions may appear in any pipeline position and more than one may appear;
- failures from downstream evaluation stages still return to Session and start a new repair round
  from the top;
- freehand graphs that violate these rules remain editable in Graph view and explain why they are
  not pipeline-expressible.

Replace hard-coded `persona || check` and `OUTCOME_KINDS` branching with explicit browser-safe node
capabilities for source ports, target ports, stage eligibility, required routes, and human labels.
Keep server execution handlers separate from this shared descriptor data.

### Fixed Inspector footer

Inspector remains `WorkflowCompletionPolicy`, not `WorkflowDraftNode` or `Stage`.

When the policy kind is `inspector`, Pipeline builder, published-version detail, Run Pipeline,
workflow ladder, and Board preview render a fixed footer after End:

```text
Session -> authored stages -> End -> Inspector final gate
```

The footer:

- is read-only and cannot be dragged, deleted, joined, or targeted by graph edges;
- reflects the draft or pinned version's findings and missing-PR policies;
- opens or focuses the existing workflow property controls when editable;
- carries live wait/posture state in run views;
- does not appear in Graph view as a React Flow node.

This presentation must not imply Inspector ran before End. End remains the graph-success boundary,
and the completion policy still claims that successful boundary afterward.

## Durable execution model

### Attempt lifecycle

Append `waiting` to `WORKFLOW_NODE_ATTEMPT_STATES`. A SessionAction attempt moves:

```text
queued -> running -> waiting -> completed
                         |-> error/retry_wait for infrastructure before delivery
                         |-> blocked run for refused or uncertain delivery
                         |-> cancelled when the run/session is superseded
```

`waiting` means the action request is durably prepared or delivered and the observer owns further
progress. It is not scheduled by the engine's Persona or Check limiters.

Add `session_action_snapshot_json` to `workflow_node_attempts` rather than putting action data in
`persona_snapshot_json`. The run's immutable version remains authoritative; the attempt copy makes
history, recovery diagnostics, and retention independent of re-resolving a live library entity.

Add nullable `node_attempt_id` to `workflow_deliveries`. Legacy Persona, Inspector, PR-handoff,
and unchanged-evidence deliveries keep null. New SessionAction deliveries always name their
attempt. This prevents two action nodes in one submission from being deduplicated or completed as
if they were the same packet.

Append `session_action` to `WORKFLOW_DELIVERY_KINDS`. Preserve `pr_handoff` for old workflow
versions and their current recovery paths. Both route through shared delivery preparation,
consent, pane locking, refusal, uncertainty, and retry helpers.

### Pickup and turn completion

At successful send, persist:

- delivery id and attempt id;
- session id and note key;
- pane token when available;
- delivered timestamp;
- transcript anchor;
- expected repository and checkout context;
- action source segment and evidence fingerprint.

The action observer may advance only after:

1. the exact delivery is `delivered` or an operator has explicitly resolved an uncertain write as
   delivered;
2. the same conversation is still bound;
3. activity after delivery proves pickup, using a post-anchor transcript change or a post-send
   working/activity transition;
4. the session later satisfies `settledIdle` and is not `needs-you`;
5. the completion adapter's extra proof succeeds.

An idle state inherited from before delivery never completes the action. A permission question,
session exit, conversation replacement, or unresolved uncertain write never completes it either.

Preview delivery prepares and displays the exact packet but does not type it. The action remains
waiting until the operator sends or executes it through an explicit action. Do not auto-complete a
Preview action from unrelated later session activity.

### Pull Request completion adapter

The `pull_request` adapter adds these requirements:

- resolve and invoke the snapshotted required skill;
- accept only durable Mission Control PR adoption provenance, never `Session.prUrl` alone;
- require the adoption to belong to the bound session and canonical repository;
- require an open PR whose observed remote head matches the freshly captured continuation HEAD;
- reject an adoption older than the action attempt unless an already-open adopted PR matches the
  exact source artifact at activation;
- idempotently reuse a matching adopted PR instead of creating a second PR;
- preserve Inspector and Shipping ownership/veto behavior during the handoff window.

The generic action observer establishes settled turn completion first. The PR adapter then reads
the current local head and waits until durable PR provenance adopts that exact head. Continuation
capture is constrained to the proven head; if the head changes before capture completes, the
adapter returns to waiting for matching adoption. A delayed adoption signal must not cause a
second action delivery.

### Evidence continuation segments

Migrate `workflow_submissions` with:

```text
segment                       INTEGER NOT NULL DEFAULT 0
parent_submission_id          TEXT
continuation_node_id          TEXT
continuation_node_attempt_id  TEXT
```

Replace the unique `(run_id, round)` index with `(run_id, round, segment)`. Existing rows remain
`segment = 0`. Initial and repair submissions always start at segment zero. A completed
SessionAction creates segment `N + 1` in the same repair round.

The continuation transaction must:

1. prove the parent is the latest segment and the action attempt is still waiting;
2. insert or reserve the child submission with an idempotent trigger key derived from run, round,
   parent
   submission, node, attempt, and source evidence fingerprint;
3. move the run to a dedicated action-capturing phase without clearing unrelated Inspector state;
4. capture fresh context and evidence and validate any completion-adapter expectation;
5. mark the action attempt completed exactly once;
6. seed the child continuation receipt and append one continuation-created event.

Capture the child through the existing bounded evidence and context-compaction pipeline, but allow
unchanged repository evidence. SessionActions may change only external state or add useful
conversation context. An unchanged checkout is therefore not the same refusal as an unchanged
repair submission.

After capture, activate the published graph from the completed action's outgoing `complete` edge,
not from Session. Persist the continuation source attempt on the submission and use it to seed the
new segment's edge receipt. The cross-segment source is intentional provenance: the action attempt
occurred against the parent evidence and its completion authorized downstream work against the
child evidence. Validate that the attempt belongs to the parent submission and node before writing
the receipt.

Every attempt in one segment reads only that segment's immutable context and evidence. The UI and
export format identify both repair round and segment. Max repair rounds compare only `round`, so
arbitrary action count never consumes repair budget.

If a downstream evaluator fails, the normal repair delivery and resubmission path creates round
`N + 1`, segment zero and restarts at Session. It does not resume from the most recent action.

### Recovery and cancellation

Startup recovery must distinguish:

- queued action attempt with no delivery: safely prepare once;
- prepared delivery: retain and send only when Live and authorized;
- sending delivery: existing uncertainty rules apply;
- delivered action without pickup: continue waiting;
- picked-up action without settled idle: continue waiting;
- completed action with child capture missing: recreate idempotently;
- child submission stuck in capture: use the existing capture-resume boundary;
- captured child without seeded continuation receipt: seed once and activate;
- PR action settled without matching provenance: wait without redelivery;
- terminal/cancelled run: cancel waiting attempts and deliveries without advancing.

Reset and binding archive paths must remove/cancel the new rows through the existing run-family
cleanup. Durable `session_remove` and startup reconciliation must park or block an action; they must
not infer completion from disappearance.

## API, persistence, and event contracts

### Database

Add a `session_actions` table following `personas`:

```text
id, name, normalized_name, description, prompt_md,
required_skill_id, completion_kind, revision,
archived_at, created_at, updated_at
```

Add the attempt, delivery, and submission columns described above. Update both fresh table SQL and
`migrate()`, and recreate the submission uniqueness index only after `segment` exists. Add upgrade
tests from the immediately preceding schema and from a fixture with active workflow rows.

No built-in SessionAction is inserted into SQLite.

### HTTP and validation

Add Zod schemas and bounded routes analogous to Personas:

- `GET /api/session-actions?includeArchived=`;
- `GET /api/session-actions/:id`;
- `POST /api/session-actions`;
- `PATCH /api/session-actions/:id` with expected revision;
- `DELETE /api/session-actions/:id` for soft archive.

Create/update accepts exact prompt Markdown, optional required skill id, and a completion adapter.
The server must restrict completion adapters to the closed shared registry. Skill ids are data, not
commands, and receive conservative length/character bounds.

Add SessionAction catalog entries to workflow validation and publish input so:

- a missing action invalidates publish;
- an archived action remains readable in an existing draft but cannot be newly published;
- publish snapshots the revision resolved inside the same transaction as Persona snapshots;
- built-ins remain addressable even when display-shadow rules hide one.

### Registry and SSE

Add the catalog to `MissionState` and the registry snapshot, plus exhaustive
`session_action_upsert` and `session_action_remove` events in `useEventStream`. Archive is an upsert
because the entity remains addressable. Keep full prompt text off workflow summary records; it may
ride the action catalog as Persona guidance does today, or use bounded HTTP detail if snapshot size
would make the initial SSE materially larger. Measure the four built-in Persona payload precedent
before choosing.

Action-attempt and continuation transitions continue through the existing workflow-run upsert.
Full prompts, evidence, deliveries, and attempt output remain on run detail and export routes.

## Builder and library UX

### SessionActions tab

Add `#/workflows/actions` beside Workflows, Personas, and Runs.

The library supports:

- create, select, edit, save with CAS, duplicate, and archive;
- name and description;
- exact Markdown prompt editor and preview;
- optional Required skill selector from the existing skill catalog;
- completion behavior selector with clear consequences;
- built-in/read-only and archived states;
- copy/download/import parity where the existing Persona components can be reused without
  confusing an action with a reviewer.

The completion selector should say what the runtime proves, not expose adapter ids:

- **Session turn finishes**;
- **Pull request is opened and verified**.

Changing name, prompt, skill, or completion behavior increments one revision. A second-tab conflict
preserves the local draft and offers reload or duplicate, matching Persona editing.

### Pipeline editor

The add-stage control groups choices:

- Reviewers: active Personas;
- Checks: the fixed slots;
- Session actions: active SessionActions.

Selecting an action inserts a singleton SessionAction stage. Dropping an action onto an evaluation
stage inserts a neighboring stage rather than creating an illegal mixed stage. Evaluation members
cannot be dropped into an action stage. Keyboard reorder and removal work on the action stage as a
whole, with announcements that name it as an action rather than a reviewer.

The stage card shows:

- action name and `Session action` badge;
- required skill or `No required skill`;
- completion behavior;
- a warning that downstream stages use newly captured evidence;
- archived/missing source state in drafts;
- read-only snapshot metadata in published versions.

Graph view gains a SessionAction palette entry, node renderer, properties editor, activate input,
and complete output. Connection validation follows the shared capability registry.

### Run presentation

Run Pipeline, ladders, Board preview, history, and export show SessionAction states independently
from Persona verdicts and Checks:

- queued;
- preparing;
- preview ready;
- sent;
- working;
- waiting for proof;
- recapturing evidence;
- complete;
- blocked or uncertain.

The round scrubber groups segments under one repair round, for example `Round 1`, `after Pull
Request`, rather than presenting an action checkpoint as a repair. Selecting a segment scopes node
statuses to its evidence snapshot while keeping the action transition between the two visible.

Existing actions for retrying/refusing/marking delivery remain available where appropriate. A PR
action waiting for proof offers Open PR only after provenance exists and must never offer a second
automatic send merely because the Inspector has not observed it yet.

## No-Mistakes Review version 8

Append version 8. Never modify versions 1 through 7.

The authored graph becomes:

| Stage | Kind | Members/action |
|---|---|---|
| 1 | Evaluation | Check `typecheck`, Check `test` |
| 2 | Evaluation | Intent Conformance Judge |
| 3 | Evaluation | Code Risk Reviewer, Test Evidence Auditor, Documentation Steward |
| 4 | SessionAction | Built-in Pull Request |

Stage 4 completes only after the PR turn settles, fresh evidence is captured, and matching durable
PR provenance exists. Its complete route reaches End. End then enters the unchanged Inspector
completion policy, rendered as the fixed footer.

Version 8 keeps:

- `onFindings: "inspector_only"`;
- `resumptionPolicy: "auto"`;
- Foreman Complete and Live binding defaults.

Set `missingPrAction: "wait"` for version 8 because the authored PR action owns preparation.
Legacy versions retain their existing `offer_prepare_pr` or `prepare_pr` behavior after End.

Add stable node and edge ids for the new built-in action. Reuse every existing logical node id.
Pin the complete v7 artifact in tests and assert v8 separately so future edits cannot rewrite
published history.

The built-in description and README must no longer say command execution is unavailable once the
separate Check runtime integration changes that fact; update only what is true on the merge base.

## Implementation phases

### Phase 1: catalog, contracts, and hidden graph foundation

Outcome: SessionActions and their immutable snapshots exist, and graphs can represent the new node,
but the builder does not yet offer it and publishing a graph containing one remains feature-gated.

Work:

- shared ids, limits, entity, completion registry, snapshots, node variants, ports, schemas;
- `session_actions` table and CAS store;
- built-in catalog plumbing and generated Pull Request source asset;
- manager, HTTP routes, registry/SSE events;
- publish transaction snapshots SessionActions alongside Personas;
- stage discriminated union, graph capability descriptors, compile/project/blocker round trips;
- Graph/Pipeline read-only rendering sufficient for fixtures, behind the runtime availability gate;
- contract, store, HTTP, SSE, graph, stage, publish, and migration tests.

Exit: operator actions can be created and versioned through the API, published snapshots validate,
and old workflows round-trip byte-for-byte. No UI can publish an executable action yet.

### Phase 2: durable action execution and continuation segments

Outcome: a published SessionAction node can safely send one turn, wait, recapture, and continue
downstream across restart.

Work:

- waiting attempt state and action snapshot attempt column;
- delivery-to-attempt link and generic `session_action` delivery kind;
- submission `segment` and continuation provenance migration;
- atomic action activation/preparation and delivery reuse;
- pickup plus settled-idle observer;
- continuation capture with unchanged evidence allowed;
- downstream entry receipt seeding without Session activation;
- repair-round versus segment queries, budgets, summaries, exports, retention, reset;
- recovery, refusal, uncertainty, retry, cancellation, and session-removal handling;
- engine/store/manager integration tests, including two actions in one repair round.

Keep authoring hidden until this phase passes recovery tests. Existing workflow behavior and legacy
PR handoffs remain unchanged.

### Phase 3: authoring and run UX

Outcome: operators can create, save, reuse, publish, execute, and inspect custom SessionAction
stages from the UI.

Work:

- SessionActions route/tab, library, editor, CAS conflict, duplicate, archive;
- required-skill and completion controls;
- Pipeline add menu, singleton action stages, drag/drop, keyboard and confirmations;
- Graph palette/node/properties support;
- publish availability gate removal;
- Run Pipeline, ladder, Board preview, history, segment scrubber, attempt cards and actions;
- fixed Inspector footer in draft, version, and live-run views;
- responsive styling, accessibility tests, render tests, Electron/runtime visual evidence;
- general SessionAction README documentation.

Exit: a custom action placed between two evaluation stages sends once, recaptures, and only the
downstream stage runs against the new segment.

### Phase 4: Pull Request adapter and No-Mistakes Review v8

Outcome: Pull Request is the built-in verified action and the current No-Mistakes Review opens the
PR before its Inspector footer.

Work:

- extract legacy PR handoff rendering/delivery into the shared action executor;
- `pull_request` completion adapter and provenance matcher;
- already-open matching PR idempotency and delayed-adoption recovery;
- retain the legacy Inspector `missingPrAction` path for versions 1 through 7;
- append built-in workflow version 8 with stable ids and frozen snapshots;
- render PR-specific waiting/proof states and Open PR affordance;
- update README built-ins, workflow authoring, action lifecycle, Inspector gate, Skills, repair and
  retention sections;
- update architecture and change-contract guides for SessionAction catalogs, action handlers,
  continuation segments, append-only completion kinds, ports, attempt states, and delivery kinds;
- complete end-to-end and visual verification.

Exit: a v8 run cannot enter Inspector without a verified PR created or adopted by the Pull Request
stage, and every older built-in version behaves exactly as before.

## Compatibility and safety contracts

- Append new durable enum values only; never rename `pass`, `fail`, existing attempt states,
  delivery kinds, trigger sources, check slots, or built-in ids.
- Published action snapshots never resolve mutable library text at runtime.
- A SessionAction never produces `PersonaVerdict` or `persona_feedback`.
- Action delivery failure never routes to Session as a requested code change.
- Every downstream attempt reads the continuation segment's new evidence, never the parent's.
- A continuation segment never consumes `maxRepairRounds`.
- A later evaluation failure starts a new repair round at Session.
- Preview never types and cannot complete from unrelated activity.
- Live action delivery uses the existing Workflows switch, repository allowlist, pane lock, note
  identity, skill availability, and uncertain-write rules.
- PR success requires durable provenance and matching repository/head; `Session.prUrl` is only a
  hint.
- Inspector remains the sole PR review poller. SessionAction adds no second GitHub poll loop.
- Foreman remains HTTP-only and never reads or writes SQLite.
- Built-in No-Mistakes Review versions 1 through 7 remain resolvable and immutable.
- Older builds refuse unknown action nodes and completion kinds rather than defaulting them to a
  Persona, Check, or completed action.

## Test matrix

### Shared and persistence

- SessionAction create/update/archive CAS, exact prompt preservation, normalized-name uniqueness,
  built-in reservation, duplicate, shadow/display and addressability rules.
- Zod bounds and negative malformed action, snapshot, node, port and completion cases.
- Fresh database plus migration with existing workflows, submissions, attempts, receipts and
  deliveries.
- Unique round/segment ordering and repair-budget compatibility.
- Publish snapshots exact action revision and rejects missing/archived sources.
- Export/import and retention preserve action snapshots, segment provenance and bounded output.

### Graph and builder

- evaluation and action stage compile/project round trips with stable surviving ids;
- action at first, middle and last position, plus two actions;
- mixed/parallel action stages rejected with human blockers;
- complete routes validate; missing/fail routes do not get invented;
- Graph and Pipeline edit parity;
- add, remove, reorder, drag/drop, keyboard, focus restoration, confirmation and announcements;
- fixed Inspector footer rendering and non-interactivity.

### Runtime

- exactly one delivery per node attempt across concurrent pumps and restart;
- stale pre-send idle does not complete;
- pickup then settled idle completes generic action;
- needs-input, session exit, note replacement and pane replacement park/block honestly;
- Preview stays waiting; Live obeys both consent gates;
- refused, uncertain, explicitly resolved and retried delivery paths;
- capture creates next segment, allows unchanged repo, and activates only downstream nodes;
- upstream attempts remain tied to parent evidence;
- downstream failure starts next repair round at segment zero;
- multiple actions do not consume repair budget;
- crash at every boundary from attempt insert through receipt activation recovers idempotently.

### Pull Request and built-in workflow

- required skill missing, disabled, drifted and stale-generation refusals;
- unrelated, old, wrong-session, wrong-repository, closed and wrong-head PRs do not complete;
- matching adopted PR completes once; delayed proof does not redeliver;
- existing matching PR reuses safely;
- changed action-turn evidence is recaptured before Inspector entry;
- No-Mistakes Review v7 exact artifact remains frozen;
- v8 stages, ids, snapshot, defaults, `missingPrAction`, and Inspector footer are exact;
- bindings pinned to versions 1 through 7 keep the legacy post-End handoff behavior.

## Validation and definition of done

For each phase:

- focused node:test files with the repository's loader and concurrency;
- `npm run typecheck`;
- `npm run lint`;
- `npm test`;
- `npm run build`;
- `npm run smoke` after the build;
- runtime and visual verification for every phase that changes UI;
- README and linked technical docs updated in the same phase that exposes behavior;
- no generated file hand edits;
- no unrelated worktree changes.

The project is complete only when the published built-in Pull Request action can be selected by an
operator-authored workflow, custom SessionActions can continue through fresh evidence in arbitrary
positions, No-Mistakes Review v8 includes Pull Request before the fixed Inspector footer, legacy
versions remain unchanged, and recovery tests prove no action is sent or completed twice.
