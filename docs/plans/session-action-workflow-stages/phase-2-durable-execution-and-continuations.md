# Phase 2: Durable SessionAction execution and evidence continuations

Source plan: [`plan.md`](plan.md)

Phased index: [`phased-plan.md`](phased-plan.md)

## Outcome and value

Published workflows can execute a `session_action` node safely. Mission Control prepares and
delivers the immutable action prompt to the bound session, proves that the session picked it up,
waits for the resulting turn to settle, captures a fresh repository snapshot, and activates only
the action's downstream route against that new evidence.

The runtime remains correct across daemon restarts, delivery uncertainty, multiple actions in one
repair round, and later repair. This phase enables the generic `session_turn` completion adapter.
The `pull_request` id remains a reserved catalog contract, but publishing a graph that uses it
continues to be refused until Phase 4 installs its durable proof adapter.

## Entry criteria and direct dependencies

Direct prerequisite: Phase 1 is merged.

Before editing:

1. Read the source plan, phased index, Phase 1 downstream handoff, root `AGENTS.md`, architecture
   guide, change contracts, and ensemble extension guide.
2. Re-open the merged shared tuples, graph capability descriptor, SessionAction snapshot, store,
   engine, capture service, delivery service, recovery paths, and session settled-idle logic.
3. Run `git status --short`, preserve unrelated work, and run the Phase 1 verification suite.
4. Confirm that published SessionAction graphs are still blocked and no browser authoring control
   exposes them.

## Scope

In scope:

- An append-only `waiting` node-attempt state for action attempts that are neither runnable
  evaluators nor terminal results.
- A new `session_action` workflow-delivery kind linked durably to its owning node attempt.
- Immutable action snapshot persistence on attempts for audit and restart recovery.
- Delivery preparation, approval, send, uncertainty, and retry behavior using existing workflow
  delivery policy.
- Durable post-send pickup evidence followed by `settledIdle` completion observation.
- A completion-adapter registry with a fully supported `session_turn` adapter and an explicitly
  unavailable `pull_request` adapter.
- A `(round, segment)` submission identity that captures fresh evidence without consuming a repair
  round.
- Downstream-only edge seeding and activation after action completion.
- Recovery, cancellation, reset, retention, export, summaries, and diagnostics for every new
  durable state.
- Server capability reporting and adapter-specific publish validation.
- Focused runtime and migration documentation.

Explicit non-goals:

- No SessionActions library UI or builder controls.
- No fixed Inspector footer presentation.
- No Pull Request completion proof, PR-specific status, or No-Mistakes Review v8.
- No change to legacy `pr_handoff` preparation after End.
- No action-authored commands, webhooks, arbitrary tools, or model invocation.
- No parallel action execution against the same bound session.

## Repository findings and inherited contracts

### Action delivery is a durable side effect

Use the existing workflow-delivery ledger, approval switch, repository allowlist, note identity,
pane lock, prepared payload, and uncertain-write recovery. Do not send directly from the graph
engine. An action attempt becomes `waiting`, and the manager coordinates its one durable delivery.

### Idle is not proof of completion

The target session is commonly idle before delivery. Persist an anchor that identifies the
successfully sent payload and require a later pickup signal before accepting a settled idle. The
pickup signal must come from durable transcript or harness state newer than the anchor. A stale
idle event, process restart, or observer resubscription cannot complete the action.

### Continuation is not repair

`round` continues to count repair. `segment` identifies successive immutable evidence snapshots
within that round. Action completion creates `segment + 1`; evaluator failure creates `round + 1`
at segment zero. Only the latter consumes `maxRepairRounds` and restarts from Session.

### Completion is adapter-owned

The generic observer proves pickup and settled idle. A server-owned completion adapter may require
additional durable evidence before the attempt completes. Its result is one of:

```ts
type SessionActionCompletionDecision =
  | { kind: "complete"; continuationExpectation?: unknown }
  | { kind: "waiting"; reason: string }
  | { kind: "blocked"; code: string; detail: string };
```

The concrete expectation must be a closed discriminated union before persistence. It cannot be an
unvalidated JSON escape hatch. `session_turn` returns complete after pickup and settled idle.
`pull_request` is registered as unavailable until Phase 4.

## Implementation steps

### 1. Append durable runtime contracts

In shared workflow contracts and schemas:

- append `waiting` to the node-attempt-state tuple;
- append `session_action` to workflow-delivery kinds without changing `pr_handoff`;
- add `segment` to submission identity and summaries;
- add parent-submission and continuation-node provenance;
- add action wait reasons and public run-status projections;
- define adapter availability and completion-decision contracts;
- keep Persona/check verdict and feedback shapes unchanged.

Use explicit exhaustive switches. Do not treat `waiting` as queued, running, passed, or failed.
Scheduling limits count only work that consumes an evaluator runner; session action waits do not
silently occupy a model execution slot.

### 2. Migrate submissions, attempts, and deliveries

Update the fresh schema and additive upgrade path together.

For `workflow_submissions` add:

- `segment INTEGER NOT NULL DEFAULT 0`;
- `parent_submission_id TEXT`;
- `continuation_node_id TEXT`;
- `continuation_node_attempt_id TEXT`.

Replace the unique `(run_id, round)` index with `(run_id, round, segment)`. Resolve the exact
existing index name from merged source, drop only that verified index, and recreate it after the
column exists. Existing rows become segment zero. Add foreign keys or equivalent row-boundary
validation consistent with the current database conventions.

For `workflow_node_attempts`, add a nullable immutable `session_action_snapshot_json`. Require it
for action attempts and reject it for evaluator attempts at the row boundary.

For `workflow_deliveries`, add nullable `node_attempt_id`. Require it for `session_action`, reject
cross-run/cross-submission links, and leave it null for historical `pr_handoff` rows. Add the
minimal indexes needed for attempt recovery and uniqueness. The database must prevent two active
action deliveries from being prepared for one attempt.

Upgrade tests must cover a realistic active database with submissions, attempts, receipts,
deliveries, and built-in workflow versions. Prove old rows remain readable and receive segment
zero without changing their ids.

### 3. Make every submission query segment-aware

Audit all reads, writes, comparators, selectors, exports, retention jobs, summaries, and tests that
assume one submission per round. Order submission identity by `(round, segment)`, not insertion
time. Repair-budget calculations use only `round`.

An attempt, receipt, context snapshot, evidence bundle, and verdict remain scoped to exactly one
submission. Do not let a downstream attempt on a child segment read the parent segment's context
through a latest-by-run query.

Add helpers that make intent explicit:

```ts
submissionForRepairRound(runId, round)
submissionForSegment(runId, round, segment)
latestSubmissionForRun(runId)
```

Names may follow merged conventions, but call sites must not keep an ambiguous query.

### 4. Activate action attempts without evaluator dispatch

Extend the engine's node capability dispatch:

- an activated action node creates one attempt with its published snapshot and `waiting` state;
- it does not enqueue Persona/check work or emit a verdict;
- the manager prepares its delivery through the workflow-delivery service;
- no outgoing receipt is emitted before the action and continuation complete;
- action refusal, authorization loss, exited session, or infrastructure failure blocks the run
  with action-specific diagnostics and never generates repair feedback.

Enforce at most one active action delivery per bound session. If graph branches could make two
actions ready concurrently, serialize them deterministically by the existing stable node order.
Document this as a bound-session safety rule rather than relying on current graph shapes.

### 5. Render and prepare the exact action packet

Render from `session_action_snapshot_json`, never the mutable catalog. The packet contains a small
stable Mission Control envelope plus the exact prompt Markdown. If `requiredSkillId` is present,
resolve it through the bound harness at preparation and again immediately before send, using the
same safe required-skill path as existing PR handoff.

Persist the final payload before approval or typing. Preview may prepare and display the packet but
must never type, start pickup observation, or auto-complete. Live preserves the existing Workflows
switch, repository allowlist, note identity, conversation match, pane lock, and refusal semantics.

### 6. Prove delivery pickup and settled completion

After a confirmed send, persist a transcript/harness anchor sufficient to distinguish pre-send
state from later activity. Build one restart-safe observer that:

1. confirms the bound conversation is still the intended target;
2. observes a pickup signal newer than the anchor;
3. ignores idle transitions before pickup;
4. treats `needs-you` as waiting for operator input, not settled completion;
5. waits for `settledIdle` after pickup;
6. invokes the completion adapter;
7. records waiting or blocked reasons durably;
8. advances exactly once when the adapter returns complete.

Reuse the existing session lifecycle source. Do not add a second process poller or infer durable
removal from `state === "exited"`. Handle `session_remove`, eviction, daemon restart, and a stale
conversation as explicit blocked/recovery cases.

### 7. Add the completion-adapter registry and capability gate

Create a server-owned registry keyed by the append-only completion ids. Each descriptor owns:

- availability;
- any required snapshot validation;
- post-settle durable proof;
- continuation capture expectations;
- public waiting labels;
- recovery behavior.

Implement `session_turn` completely. Register `pull_request` as unavailable with a stable
diagnostic, not a placeholder that returns success. Publish validation may now accept action graphs
only when every referenced snapshot's completion adapter is available. Capability responses used
by later UI must expose this same registry result, so the client never invents support.

### 8. Capture a child evidence segment atomically

When an adapter completes, create the next segment through the existing capture service with an
`allowUnchanged` mode. An action may legitimately update only remote state or conversation state;
unchanged local files are not an error.

The continuation transaction must:

1. verify the action attempt is still the current waiting attempt;
2. reserve `(run_id, round, segment + 1)` exactly once;
3. persist parent and continuation-node provenance;
4. capture a fresh context snapshot and repository evidence;
5. validate any adapter-supplied expectation against that capture;
6. mark the action attempt complete;
7. emit the action node's `complete` receipt into the child submission;
8. activate only nodes reachable from that receipt in the child submission.

If capture fails or the expectation no longer matches, keep a diagnosable waiting/blocked state and
do not activate downstream nodes. Retrying must resume the same reserved continuation or safely
replace an incomplete reservation according to existing transaction conventions. It must never
create two child segments.

The receipt provenance must explicitly allow its source attempt to belong to the parent submission
while the receipt activates the child submission. Tighten validation so this cross-submission link
is legal only for the child's declared continuation attempt.

### 9. Preserve repair semantics after continuation

If a downstream evaluator fails on segment N, build repair feedback from the current round's
relevant evaluator outcomes while preserving action provenance for audit. The repair submission is
`round + 1, segment 0`, captures new evidence after the repair turn, and activates from Session as
today. It may execute the action again if the new graph path reaches it.

Action blocking never spends the repair budget. Cancel and reset must close or supersede waiting
attempts and deliveries consistently. A resumed run must not strand an action merely because the
last durable submission is a nonzero segment.

### 10. Recovery, retention, exports, and observability

On manager startup, reconcile:

- waiting attempt with no delivery;
- prepared delivery;
- approved but unsent delivery;
- uncertain delivery;
- sent but not picked-up delivery;
- picked-up but active session;
- settled session with adapter waiting;
- adapter complete but continuation capture interrupted;
- child segment persisted but receipt/activation interrupted.

Prefer idempotent state transitions and existing delivery reconciliation. Never automatically
retype an uncertain payload.

Update retention/export code so parent-child submissions, action snapshots, attempt links, and
deliveries remain intelligible. Add bounded structured logs and run diagnostics without logging
full prompts or repository evidence.

## API, data, and compatibility notes

- Existing API clients that omit segment receive stored/default segment zero through server-owned
  creation. Do not allow clients to choose arbitrary segment numbers.
- Existing workflow versions and runs retain their ids and behavior.
- Existing `pr_handoff` deliveries remain valid with null `node_attempt_id`.
- A Phase 1 published action graph remains blocked until its adapter becomes available; after this
  phase, `session_turn` graphs may publish and run, while `pull_request` graphs remain refused.
- Run-state payload additions are additive. Every browser and Electron exhaustive switch must be
  updated even though authoring remains hidden.

## Focused tests

Add or extend tests for:

- fresh and upgraded database schemas, including active legacy rows;
- append-only tuple order and strict row parsing;
- `(round, segment)` uniqueness and deterministic ordering;
- all latest-submission and repair-budget queries;
- action activation without evaluator dispatch;
- exact snapshot rendering and required-skill resolution at both gates;
- Preview never typing or completing;
- Live authorization, refusal, pane-lock, and note-identity behavior;
- stale idle rejection, pickup proof, settled idle, `needs-you`, and exited/removed sessions;
- adapter availability and publish refusal for `pull_request`;
- unchanged and changed repository continuation capture;
- downstream-only activation and cross-submission receipt provenance;
- two ordered actions in one round;
- downstream evaluator failure followed by round-incrementing repair;
- cancellation and reset while waiting;
- restart at every delivery, observation, adapter, capture, receipt, and activation boundary;
- uncertain writes never being automatically resent;
- legacy workflow and `pr_handoff` behavior remaining unchanged.

Run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

Add focused single-file commands to the implementation PR description. Runtime changes also need
a manual Live proof in a disposable repository and a Preview proof that no text is typed.

## Exit criteria

- A published custom `session_turn` SessionAction executes once and resumes downstream work on a
  fresh child segment.
- Two actions execute in order in one repair round without consuming repair budget.
- Restart tests prove no duplicate send, completion, segment, receipt, or downstream activation.
- `pull_request` remains impossible to publish and has a clear capability diagnostic.
- Old workflow versions, submissions, deliveries, and No-Mistakes behavior are unchanged.
- Typecheck, lint, tests, build, smoke, and manual runtime proofs pass.

## Downstream handoff to Phase 3

Phase 3 may expose only completion adapters reported available by the server. At this boundary that
means `session_turn`. The compiled Pull Request action may remain addressable for immutable history,
but it must not appear as an addable action until Phase 4 enables `pull_request`.

Phase 3 must consume the runtime's segment and wait-state projections rather than re-derive state
from attempts or session activity. It must not add browser polling, direct action delivery, or a
client-owned adapter list.

## Cross-phase audit

- Phase 1 contracts are consumed without renaming identifiers.
- Arbitrary placement is now truthful because each action creates fresh evidence and resumes only
  downstream nodes.
- The PR-specific proof remains owned solely by Phase 4.
- The Inspector remains outside the graph and untouched.
- No visible authoring control has been released before the runtime recovery suite passes.
