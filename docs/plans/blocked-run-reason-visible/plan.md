# Say why a workflow run is blocked

## The problem

On 10 September 2026 a No-Mistakes Review run stopped 1.27 seconds after it started. Evidence
capture had re-hashed a registered screenshot, found the file had been overwritten by a later
Playwright run, and refused the whole submission. The daemon wrote an exact, correct, human
sentence into the run's `gate_state_json`:

```json
{"error":"Evidence image changed after it was staged; register it again","code":"image_changed"}
```

Nobody saw it. The operator found the run two hours later, could not tell why it was blocked, and
asked. Answering took a read of the state database and four source files.

The sentence exists. Four surfaces try to tell the operator something, and all four fail on this
phase:

| Surface | Where | What it says today |
| --- | --- | --- |
| Desktop and in-app alert, fired at the moment of the block | `src/shared/alerts.ts:403` | Title `No-Mistakes Review blocked`, body `run.phase.replaceAll("_", " ")` &rarr; **"image evidence capture"** |
| Line strip and Review drawer, grouped by phase | `src/web/lib/line-review-groups.ts:171` via `blockedPhaseClause` | **"image evidence capture"** |
| Runs rail row remedy clause | `src/web/workflows/run-model.ts:2692` via `blockedPhaseClause` | **"image evidence capture"** |
| Run detail header | `src/web/workflows/WorkflowRuns.tsx:2846` | **nothing at all** |
| Gate packet disclosure | `src/web/workflows/WorkflowRuns.tsx:3274` | The real message, as raw JSON, inside a collapsed `<details>` labelled *Join and gate packet* |

The run detail silence is the interesting one, because it is not an oversight. `runNoMoveReason`
returns `null` whenever `runNextMove` returns a descriptor, and the comment at
`WorkflowRuns.tsx:2704` states the invariant deliberately: *"the header cannot show a primary and an
excuse for not having one at once."* That invariant is right for the phases it was written for. It
fails here because `resubmitAvailability` correctly treats `blocked` as recoverable, so the page
concludes "there is a button, so no paragraph is needed" for a failure the reader has not been told
about. The operator is shown a resubmit control for a cause they cannot see, and clicking it without
fixing the underlying file reproduces the block.

## Decisions taken

Reviewed and submitted in the Mission Control dashboard on 10 September 2026. Every recommended
option was adopted, so the plan below is the resolved scope rather than a menu.

| Decision | Adopted |
| --- | --- |
| Which surfaces carry the reason | **All four, including the alert.** `BLOCKED_PHASE_CLAUSES` moves into `src/shared/` so the notification fired at the moment of the block names the cause. |
| Name the failing evidence item | **Yes.** `inspectReservedSource` attaches the item's `displayName` and `clientItemId`, and the phase detail records them. |
| Phase coverage | **The whole capture family, plus an exhaustiveness test** so no future blocked phase can ship unnamed. |
| The session's swallowed second completion | **Show it, do not fix it here.** The display half is step 7; the behavioral fix stays out of scope. |
| After this plan | Create a phased implementation plan and schedule the dependent tasks. |

## What the codebase already provides

Nothing here needs inventing. Three mechanisms exist and are unused by this phase.

**A typed phase-detail contract.** `WORKFLOW_RUN_PHASE_DETAIL_KEYS` in
`src/shared/workflow-lifecycle.ts:353` already declares `image_evidence_capture: ["error", "code"]`,
alongside `capture_error: ["error", "code"]`, `capture_interrupted: ["error"]` and
`stale_capture: ["error"]`. `decodeWorkflowRunLifecycle` classifies all four as `opaque` today. A
`capture_failure` arm on the `WorkflowGateDetail` union, following the `check_cleanup` precedent at
`workflow-lifecycle.ts:646`, gives every surface a typed read of a payload that is already persisted
and already bounded.

**A sentence slot for exactly this shape.** `runRefusedSentence` in `run-model.ts:1616` exists to
explain *a run that still has a move*. Its own doc comment names the problem verbatim: *"The header's
existing sentence is the NO-MOVE one: it explains an empty action row. A refused resubmission is the
opposite shape - the daemon said no, and put a different button in place of the one that was clicked
- so nothing drew the reason."* It handles `unchanged_repository` and `unchanged_evidence`. It has no
case for the capture family. It already renders at `WorkflowRuns.tsx:2858` with styling at
`styles.css:1776`.

**The offending item's identity, at the throw site.** `inspectReservedSource`
(`src/server/workflows/images.ts:588`) holds the whole `WorkflowReservedEvidence` row, including
`clientItemId`, `displayName` and `sourceLocator`, when it calls `inspectOpenFile`. The error it
raises names none of them, so a run with eleven reserved items says only "an evidence image changed".

## The client is already served the data

`WorkflowRun.gateState` is `WorkflowJson | null` (`src/shared/workflow.ts:3656`) and reaches the
browser today. `src/shared/workflow-lifecycle.ts` is browser-safe and `WorkflowRuns.tsx` already
imports from it. No route changes, no new fields on the wire, no migration.

```
                                    persisted today, read by nobody
  gate_state_json  {"error": "...", "code": "image_changed"}
         |
         +--> decodeWorkflowRunLifecycle()      kind: "opaque"   <-- add "capture_failure"
                     |
                     +--> runRefusedSentence()      run detail header sentence
                     +--> blockedPhaseClause()      Line strip, Review drawer, Runs rail
                     +--> workflow alert body       the notification at the moment it blocks
```

## Proposed change

### 1. Decode the payload once, in shared

Add `{ kind: "capture_failure"; failure: { error: string; code: string | null } }` to
`WorkflowGateDetail`, decoded for the capture-family phases, plus a `workflowCaptureFailure(record)`
accessor mirroring `workflowCheckCleanupBlock`. Tests extend `test/workflow-run-lifecycle.test.ts`,
which already fixtures `image_evidence_capture` at line 143.

### 2. Give the run detail header its sentence

Add a capture-family case to `runRefusedSentence`. It renders in the existing `.wf-run-refused` slot,
beside the resubmit button rather than instead of it, and names the remedy the operator actually
needs:

> Evidence capture refused this round: an evidence image changed after it was staged. Nothing was
> reviewed and no repair round was spent. Re-register the screenshot, then resubmit - resuming would
> re-check the same stale reservation and stop here again.

That last clause matters. `resumeImageEvidenceCapture` (`manager.ts:1876`) deliberately replays *the
same immutable reservation*, so on this failure it is guaranteed to fail identically. An operator
told only "blocked" has no way to know which of the two recoveries is the working one.

### 3. Name the phases in the clause map

Add `BLOCKED_PHASE_CLAUSES` entries for the capture family so the Line strip, the Review drawer and
the Runs rail stop printing phase codes. Three or four words each, per the map's stated grain:
`image_evidence_capture` &rarr; "evidence image changed", `capture_error` &rarr; "capture failed"
(already present), `capture_interrupted` &rarr; "capture interrupted",
`external_artifact_mismatch` &rarr; "artifact moved".

### 4. Name which image, at the source

Have `inspectReservedSource` attach the failing item's `displayName` and `clientItemId` to the error,
and record them in the phase detail. This converts "an evidence image changed" into "steering-context.png
(phase2-steering-disclosure) changed", which is the difference between knowing there is a problem and
knowing what to do about it. It adds two optional keys to
`WORKFLOW_RUN_PHASE_DETAIL_KEYS.image_evidence_capture`, which the whitelist contract explicitly
permits ("An ALLOWED-key whitelist rather than a required-key list").

### 5. Fix the alert body

`alerts.ts:403` prints `run.phase.replaceAll("_", " ")` because the clause map lives in `src/web/`.
Moving `BLOCKED_PHASE_CLAUSES` and `blockedPhaseClause` into `src/shared/` lets the notification that
fires at the moment of the block name the cause. The comment at `run-model.ts:1058` already flags the
duplication as a hazard: *"two surfaces reading one field must not disagree about what an unmapped
code looks like."*

### 6. Stop new phases from arriving unnamed

A test over `WORKFLOW_RUN_PHASES` asserting that every phase whose declared statuses include
`blocked` has a `BLOCKED_PHASE_CLAUSES` entry. This defect is not specific to
`image_evidence_capture`; it is what happens by default when a phase is added, because the fallback
is silent and plausible-looking.

### 7. Show that the session tried again and was refused

The run this plan comes from was retried by its own session an hour after it blocked, and the attempt
left a durable `workflow_completion_blocked` event. That event does reach the Timeline section today,
because `eventLine` falls back to a generic reading of any event kind - but it reads
"Workflow completion blocked / prompted, blocked, image_evidence_capture", filed under round 1 among
every other event, below the fold, and only when the event is inside the fetched page. As a signal
that the work is finished and waiting on a click, it is invisible.

Promote it. When the newest event on a blocked run is a refused completion claim, the header says so
beside the cause:

> This session finished again 1 hour ago and the review could not accept it, because the run was
> already blocked. Its new evidence is staged and waiting; resubmitting is what picks it up.

This is display only. `store.ts:6630` still refuses the claim and still retires the guard; nothing
here changes what the daemon does. Making a blocked-capture run accept a fresh claim is the
behavioral fix, and it is deliberately left to its own plan - see below.

## Not in scope

**The swallowed retry.** An hour after the block, the session re-registered correct evidence and
completed again. `store.ts:6630` only advances a run whose status is not-yet-started,
`waiting_for_session`, `capturing` or `running`; `blocked` falls to the `else` branch, which logs
`workflow_completion_blocked`, **still retires the prompted completion guard**, and returns
`claimed: true` with `submissionId: null`. The session was told it completed. Making a
blocked-capture run accept a fresh claim is a real fix and a behavioral one, and it belongs in its
own plan. Step 7 above makes the attempt visible; nothing in this plan makes it work.

**Making capture tolerant.** Refusing a changed image is correct: the bytes a Persona reviews must be
the bytes the session claimed. Nothing here relaxes that guard.

## Verification

- `test/workflow-run-lifecycle.test.ts` - the new decoder arm, and the payload with and without the
  item identity.
- `test/workflow-runs-model.test.ts` and `test/workflow-run-next-move.test.ts` - the sentence appears
  with the resubmit move rather than instead of it.
- `test/line-review-groups.test.ts` - the strip groups under the new clause.
- `test/workflow-alerts.test.ts` - the alert body carries the clause, not the phase code.
- `test/workflow-runs-model.test.ts` - the refused-completion sentence appears only when a refused
  claim is the newest event on a blocked run, and not on a run that never had one.
- A new spec in `e2e/specs/` seeding a blocked `image_evidence_capture` run through `withDaemonDb`
  (the fixture `workflow-evidence-reserved-refusal.spec.ts` already uses) and asserting the operator
  reads the cause on run detail without opening any disclosure. Per the repository's standing rule,
  this is a UI change and the spec is not optional.
