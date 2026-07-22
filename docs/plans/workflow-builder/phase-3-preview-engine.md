# Phase 3 plan: bindings, context, and manual preview execution

Status: **implementation-ready**

Parent: [Persona-driven workflow builder](./plan.md)

Prerequisites:

- [Phase 1 foundation and Personas](./phase-1-foundation-personas.md)
- [Phase 2 builder and publishing](./phase-2-builder-publishing.md)

## Outcome

An operator can bind an immutable workflow version to a live session, manually submit the session's
work, execute Persona reviews concurrently against one immutable evidence snapshot, inspect
structured pass/fail output and an event timeline, send no automatic terminal input, repair the
session, and resubmit a fresh review round. Runs and attempts recover safely after a daemon restart.

Preview mode means exactly that: the engine computes and displays feedback but never types, commits,
pushes, opens a PR, or changes the session.

## Prior-phase prerequisites

Phase 3 executes only:

- `PublishedWorkflowGraph`, never a mutable draft;
- embedded `PersonaSnapshot`, never live Persona guidance;
- validated completion policy and immutable version metadata;
- directional ports and shared graph validation from Phase 2;
- tables, row parsers, model registries, and page shell from Phase 1.

The implementation task begins by running all Phase 1 and Phase 2 targeted tests. A failure in
snapshot immutability, publish idempotency, or graph validation blocks engine work.

## Scope

### Included

- Workflow defaults and per-binding execution settings.
- Session-to-version bindings and manual submission routes.
- Deterministic evidence capture and intent-first context snapshots.
- `workflow-context` structured compaction with deterministic fallback.
- Strict Persona verdict schema and provider-neutral fresh LLM calls.
- Durable activation, fan-out, all-pass Join, retries, cancellation, and repair rounds.
- Preview feedback, run detail, and append-only event timeline.
- Run-summary SSE and session layout parity.
- Restart recovery, session disappearance, `/clear`, explicit reattach, and Reset cleanup.

### Deferred

- Live terminal delivery and the `workflow` turn origin: Phase 4.
- Foreman-triggered submission: Phase 4.
- Inspector final-gate execution and Inspector-only resubmission: Phase 5.
- Retention pruning, cost attribution, notifications, and final UI polish: Phase 6.

## Workflow defaults and binding settings

Phase 2's workflow settings are defaults for a future binding, not global execution state. Add:

```ts
export type WorkflowTriggerMode = "manual" | "foreman_complete";
export type WorkflowDeliveryMode = "preview" | "live";

export interface WorkflowBindingDefaults {
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  maxRepairRounds: number;
}
```

Store `WorkflowBindingDefaults` in both the mutable definition and immutable version beside the
completion policy. Phase 2 edits these defaults. A binding copies them and may override them without
mutating the version.

Phase 3 only permits active behavior for `manual` plus `preview`. The binding dialog may display
`foreman_complete` and `live` as Phase 4 options, but it must refuse to save an active binding with
either value until Phase 4 lands. Durable rows written by a newer build with unsupported modes load
as blocked and visibly explain the version mismatch.

```ts
export interface WorkflowBinding {
  id: WorkflowBindingId;
  workflowVersionId: WorkflowVersionId;
  workflowId: WorkflowId;
  noteKey: string;
  sessionId: string;
  triggerMode: WorkflowTriggerMode;
  deliveryMode: WorkflowDeliveryMode;
  maxRepairRounds: number;
  state: "active" | "paused" | "orphaned" | "archived";
  createdAt: number;
  updatedAt: number;
}
```

`noteKey` is the durable identity. `sessionId` is the last synthetic live identity and can change on
restart or `/clear`. Do not add a workflow field to `Session`; App joins top-level run summaries to
sessions.

Exactly one active binding may own one `note_key`. A version can have many bindings and one session
can have sequential archived bindings, but never two active workflows competing to interpret its
completion.

## Run and submission contracts

```ts
export type WorkflowRunStatus =
  | "capturing"
  | "running"
  | "waiting_for_session"
  | "waiting_for_pr"
  | "waiting_for_inspector"
  | "waiting_for_new_head"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type WorkflowSubmissionMode = "full_workflow" | "inspector_only";

export interface WorkflowRunSummary {
  id: WorkflowRunId;
  bindingId: WorkflowBindingId;
  workflowId: WorkflowId;
  workflowVersion: number;
  workflowName: string;
  sessionId: string | null;
  noteKey: string;
  status: WorkflowRunStatus;
  phase: string;
  round: number;
  maxRepairRounds: number;
  activePersonaNames: string[];
  failedPersonaCount: number;
  bypassedPersonaReview: boolean;
  updatedAt: number;
}
```

Phase 3 creates only `full_workflow` submissions. The `inspector_only` enum remains reserved and is
first transitioned in Phase 5.

Every manual submit or resubmit carries a client-generated `requestId`. Store its source and non-null
stable key on the submission, for example `manual:<binding-id>:<request-id>`, with a unique index.
The first submission also supplies the run's initial trigger key. Repeating one request returns the
existing run and submission instead of starting another. Phase 4 uses the same submission-level
identity for retried Foreman claims.

## Evidence and context snapshot

Create `src/server/workflows/context.ts` and shared wire types for a bounded
`WorkflowContextSnapshot`.

```ts
export interface WorkflowContextSnapshot {
  primaryGoal: {
    rawPrompt: string;
    refined: string | null;
    sourceNoteKey: string;
  };
  humanDecisions: Array<{
    decision: string;
    rationale: string | null;
    source: { kind: "transcript" | "review" | "foreman_episode"; id: string };
  }>;
  constraints: string[];
  acceptanceCriteria: string[];
  priorPersonaFeedback: PersonaFeedbackSummary[];
  session: {
    agent: AgentType;
    name: string;
    cwd: string | null;
    branch: string | null;
  };
  evidence: {
    headSha: string | null;
    diffFingerprint: string;
    diff: string;
    diffTruncated: boolean;
    workingTreeDirty: boolean;
    workingTreeStatus: string[];
    transcript: TranscriptMessage[];
    transcriptAnchor: number | null;
    transcriptTruncated: boolean;
    standards: StandardsDocument[];
    standardsTruncated: boolean;
  };
  compaction: {
    status: "model" | "fallback";
    runner: LlmRunnerId | null;
    model: string | null;
    error: string | null;
  };
}
```

### Deterministic capture

Capture:

- `SessionGoal.prompt` as the raw primary goal and refined goal text when available;
- human-authored transcript turns, defined as user turns with no `origin`;
- answered plan/input review decisions and their typed rationale;
- Foreman episodes whose `resolvedBy` is `you`, preserving question, answer, and rationale;
- current session identity, cwd, branch, HEAD, branch diff, bounded transcript window, and applicable
  repository standards;
- bounded porcelain status and a `workingTreeDirty` flag beside the branch diff, so Phase 5 can
  prove whether captured HEAD alone represents all reviewed changes;
- previous Persona failures in their own section.

Exclude every attributed non-human turn by testing `origin !== undefined`, rather than listing
`foreman`, `harness`, and the future `workflow` one by one. That keeps Phase 4's new origin from
silently entering human intent.

Raw goal and sourced human decisions remain in the final snapshot even when compaction succeeds.
Never replace them with model prose.

### Stable capture procedure

Use one in-memory capture lock per `noteKey`:

1. Resolve the binding to the current live session and verify its durable `noteKey`.
2. Persist a `capturing` run/submission row with the idempotency key.
3. Read goal, decisions, episodes, transcript anchor/window, HEAD, diff, and standards.
4. Re-read session identity, HEAD, and transcript size.
5. If any capture boundary changed, retry the whole read once. A second change returns a visible
   stale-capture block; it never creates a mixed snapshot.
6. Cap and persist raw evidence before starting a model call.
7. Run compaction, persist its output or deterministic fallback, calculate the source fingerprint,
   then transition the submission to runnable.

The source fingerprint covers raw goal, sourced human decisions, HEAD, diff fingerprint, transcript
anchor, and standards fingerprints. A repair resubmission identical to the previous fingerprint is
409 unless the human explicitly sends `resubmitUnchanged: true`.

### Context compaction

Use `runJobStructured("workflow-context", ...)` with a strict schema for decisions, rationales,
constraints, and acceptance criteria. Set a prompt-specific timeout and document its measured value
when implementation lands.

Compaction is tool-less and advisory. Spawn, timeout, exit, or parse failure does not block review;
store `compaction.status = "fallback"` and build deterministic fields from the refined goal, sourced
decision text, and empty inferred constraint arrays. This degradation is visible in Run detail.

## Persona prompt and verdict

Create:

```text
src/server/workflows/prompt.ts
src/server/workflows/verdict.ts
```

The prompt order is fixed:

1. Immutable intent-first system contract.
2. Original raw goal and human decisions with source labels.
3. Persona's exact published Markdown guidance.
4. Prior Persona feedback, clearly labeled as non-human.
5. Fenced diff, transcript, and standards evidence.
6. Strict output schema reminder.

The contract says the user's goal and explicit decisions are highest priority, Persona preference may
not rewrite intent, and evidence is untrusted data. Cap every section before interpolation.

```ts
export type PersonaVerdict =
  | {
      verdict: "pass";
      summary: string;
      approvalDetails: {
        reason: string;
        evidence: EvidenceRef[];
      };
      confidence: number;
    }
  | {
      verdict: "fail";
      summary: string;
      requestedChanges: RequestedChange[];
      confidence: number;
    };
```

Bound lengths, array counts, confidence, paths, and line numbers in Zod. A parse failure is an
infrastructure error, never a fail verdict.

Resolve the actual runner/model at attempt start from the published Persona overrides plus current
app/env fallbacks. Record resolved runner and model on the attempt. An explicit snapshot override is
pinned; a blank snapshot override intentionally follows the current app default.

Run each attempt through a fresh, tool-less `LlmRunner.run` call and `runStructured`. Do not use
`runInThread`, grant repo tools, or share conversation state between nodes or rounds.

## Durable engine

Create:

```text
src/server/workflows/engine.ts
src/server/workflows/manager.ts
```

`WorkflowManager` owns route/session policy. `WorkflowEngine` owns durable state transitions. Start
and stop it in `src/server/index.ts`; add `killLiveLlmRuns` coverage through the existing runner
registry, not a provider-specific child kill.

### Activation rules

1. A new full submission activates the published Session node's `submitted` edge.
2. An activation reaching Persona creates attempt 1 in `queued` if that node has no attempt in the
   submission.
3. Commit all ready independent Persona attempts before starting LLM calls, then run through a
   daemon-local global limiter of 3.
4. A valid pass/fail verdict transaction stores output and emits at most one receipt for each matching
   edge.
5. A Join groups receipts by predecessor node id and becomes ready only when every configured
   predecessor has one pass or fail receipt. It emits pass only when all passed; otherwise one fail
   containing all requested-change packets.
6. A fail edge reaching Session transitions the submission/run to `waiting_for_session`, cancels
   queued attempts, and marks later results from already-running calls as audit-only.
7. A pass/fail reaching End completes that graph outcome. In Phase 3, a successful End completes the
   run even if the version has an Inspector policy; Run detail labels that policy `not active until
   Phase 5` rather than waiting forever.
8. An infrastructure error retries with a new attempt number up to 3 times using persisted
   exponential backoff. Exhaustion blocks the run; it never emits a fail edge.

Use short database transactions around state transitions. Never hold a transaction open across an
LLM call, filesystem read, or terminal operation.

### Restart recovery

On daemon boot:

- parse every active run and immutable version;
- change `running` tool-less attempts to retryable `interrupted` errors and queue the next attempt if
  budget remains;
- recompute ready nodes from durable receipts;
- preserve waiting-for-session, blocked, cancelled, and completed states;
- never re-emit a receipt already protected by its unique index;
- fail visibly on a missing/corrupt version rather than reading the current draft.

## Bindings and routes

Routes:

```text
GET    /api/workflow-bindings
POST   /api/workflow-bindings
PATCH  /api/workflow-bindings/:id
DELETE /api/workflow-bindings/:id
POST   /api/workflow-bindings/:id/submit
POST   /api/workflow-bindings/:id/reattach
GET    /api/workflow-runs
GET    /api/workflow-runs/:id
POST   /api/workflow-runs/:id/resubmit
POST   /api/workflow-runs/:id/retry
POST   /api/workflow-runs/:id/cancel
```

All mutations use Phase 1 schemas and `parseBody`.

- Binding creation resolves a live session, derives `noteKey` server-side, and requires an immutable
  version.
- Binding PATCH may change actual modes/round cap only while no run is active. Phase 3 accepts only
  manual/preview active modes.
- Delete archives the binding and cancels an active preview run in one policy operation.
- Submit/resubmit use a request id and return the existing durable object on retry.
- Retry is available only for an exhausted infrastructure attempt, not a Persona fail.
- Cancel is idempotent and prevents future receipt emission.
- Full Run GET returns bounded context, attempts, verdicts, receipts, and events. List returns
  summaries.

## Session lifecycle invariants

These belong in Phase 3 because bindings and runs become real here:

- Session disappearance pauses an active binding/run as orphaned. A cwd match is a hint only.
- `/clear` changes the agent conversation key and pauses the binding; it never silently follows the
  new session.
- Reattach is explicit, checks agent/cwd/repo compatibility, updates `noteKey` and synthetic session
  id, and records an event.
- Extend `resetSession` as the one cleanup owner. After a successful reset, remove or cancel all
  binding, active run, submissions, attempts, receipts, delivery records, events, and evidence rows
  scoped to the pre-reset `noteKey`. Reusable Personas, workflow definitions, and versions remain.
- A failed reset clears nothing.

Add no absence-based pruning. Only positive session removal, explicit reattach, Reset, cancellation,
and later retention policy change durable workflow state.

## SSE and layout parity

Add `workflowRunSummaries: WorkflowRunSummary[]` to snapshot and `MissionState`, plus upsert/remove
events. Run-detail data stays on HTTP; SSE carries the compact status only.

App joins an active summary to a Session by current synthetic session id after the daemon has already
resolved the binding. Pass `workflowRunBySession` through `SessionViewProps` and `cardProps`; do not
add it to one layout component.

Create shared leaf pieces in `session-bits.tsx`:

- `WorkflowChip` for cards/details;
- `WorkflowTileFlag` for Board overview;
- `WorkflowRailMark` for Console rail.

Use one `workflowRunTone` helper for running, failed/waiting, blocked, and complete presentation.
Update SessionCard, ConsoleDetail, SessionTile, and RailRow together. Clicking opens the Runs tab for
that run.

## Runs and binding UI

Add:

```text
src/web/workflows/BindingDialog.tsx
src/web/workflows/RunList.tsx
src/web/workflows/RunDetail.tsx
src/web/workflows/ContextSnapshot.tsx
```

### Binding

- Open from a published version or a session detail action.
- Pick the published version and show defaults copied from it.
- Phase 3 locks active choices to Manual and Preview with honest Phase 4 explanations.
- Show the durable session name, agent, cwd, branch, and current version before confirmation.

### Run detail

- Header: workflow/version, session, round, status, timestamps, actual runner/model per attempt.
- Graph overlay: queued/running/pass/fail/error/waiting states on immutable nodes.
- Context: raw goal first, compact decisions/rationale, evidence truncation and fallback flags.
- Verdict cards: approval details or requested changes, never one ambiguous output field.
- Join card: predecessor results plus combined repair packet.
- Timeline: append-only workflow events.
- Preview actions: Copy feedback, Open session, Resubmit, Resubmit unchanged with confirmation,
  Retry infrastructure error, Cancel.
- No Send button in Phase 3.

## Implementation order

1. Add binding defaults and binding/run/context/verdict shared contracts and schemas.
2. Extend store row parsers and transactional methods.
3. Implement deterministic context capture, stable-boundary checks, fingerprinting, compaction, and
   fallbacks.
4. Implement Persona prompt/schema/execution and limiter.
5. Implement engine transitions, receipts, Joins, retries, cancellation, and recovery.
6. Add binding/run routes and manual preview submission.
7. Add orphan, reattach, `/clear`, and Reset cleanup.
8. Add run summary SSE and all layout-parity marks.
9. Build binding dialog, Runs tab, graph overlay, context/verdict/timeline views, and preview actions.
10. Update README with preview guarantees, manual repair rounds, errors, and recovery.

## Tests

- `workflow-context.test.ts`: raw goal preservation, origin filtering, decisions/rationale sources,
  caps, stable-boundary retry, fingerprint, compaction success/fallback, and prompt fences.
- `workflow-verdict.test.ts`: pass/fail discrimination, clamps, malformed output, and infrastructure
  separation.
- `workflow-engine.test.ts`: activation, fan-out concurrency, paired Join receipts, aggregate fail,
  End, stale result suppression, attempt backoff, cancel, and idempotency.
- `workflow-recovery.test.ts`: interrupted safe calls retry, receipts do not duplicate, corrupt
  version blocks, and waiting states survive restart.
- `workflow-bindings-http.test.ts`: version pinning, one-active-binding constraint, manual/preview
  enforcement, request idempotency, unchanged fingerprint refusal, retry/cancel, and reattach.
- `workflow-reset.test.ts`: successful Reset clears all session-scoped workflow rows through
  `resetSession`; failed Reset clears none; definitions/versions/Personas survive.
- Extend `workflow-sse.test.ts` for run summaries and reconnect equivalence.
- `workflow-layout-parity.test.ts`: chip/tile/rail/detail status and shared helper output.
- `workflow-run-render.test.ts`: context, verdict, Join aggregate, fallback, waiting, error, and
  cancelled views.
- Provider matrix tests run the same Persona contract against fake Claude and Codex runners.
- Full typecheck and test suite.

## Exit criteria

- A manually bound published workflow runs in Preview without any terminal write.
- Concurrent Persona nodes receive the exact same immutable context snapshot.
- A Join waits for all predecessors and emits one aggregated failure packet.
- Pass always contains approval rationale; fail always contains bounded requested changes.
- User goal and sourced human decisions remain present even when compaction fails.
- Repair resubmission creates a new fingerprint and no old approval can cross rounds.
- Duplicate submit/retry requests cannot duplicate runs, attempts, or receipts.
- Restart recovery retries only safe headless work.
- Session disappearance, `/clear`, reattach, and Reset follow existing product invariants.
- Workflow status appears with equivalent meaning in Cards, Console, and Board.

## Handoff to Phase 4

Phase 4 may add `live` delivery and `foreman_complete` activation to bindings. It must call the same
manual submission and engine entry points with stable idempotency keys. It may not create a second
run engine, bypass the pane lock, treat an ambiguous terminal write as retryable, or teach Foreman to
touch workflow tables.

## Cross-phase audit record

- Initial audit: checked against parent, Phase 1, and Phase 2 plans.
- Prior-plan follow-up required: add `WorkflowBindingDefaults` to definitions and versions so Phase 2
  settings have durable meaning and bindings copy rather than own invisible defaults.
- Parent sequencing follow-up required: orphan/reattach and Reset cleanup move from Phase 4 to Phase
  3 because session-scoped durable state begins here.
- Phase 4 audit: made submission trigger keys explicit for every manual submit/resubmit and added the
  front-loaded delivery records to Phase 3 Reset cleanup. A run-level key alone cannot deduplicate a
  later repair submission.
- Phase 5 audit: reserved explicit PR/Inspector wait statuses and added immutable dirty working-tree
  evidence. A final gate cannot prove that a PR head contains Persona-reviewed changes when staged,
  unstaged, or untracked content still sits outside the captured commit.
- Phase 6 audit: no execution-semantic correction required. Phase 6 instruments the existing fresh
  model calls and treats every retry/recovery rule in this plan as a release gate.
