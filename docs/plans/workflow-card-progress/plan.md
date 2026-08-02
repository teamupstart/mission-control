# Showing a bound workflow run on the session detail pane: the stage ladder

> Follow-up, 2026-07-28: the operator selected the D′ Board-tile disclosure from
> `board-tile-expandable-mockups.html`. A bound Board tile now fetches the same run detail,
> shows the consequential rung while collapsed, and expands in place to the existing ladder.
> The original phase boundary below is retained as the design record it supersedes.

Source design: `docs/plans/workflow-card-progress/mockups.html`, **Option D - stage ladder**,
selected by the operator. Options A (gate rail), B (reviewer roster) and C (repair loop) are
not in scope; the collapsed grid card keeps today's chip, which is what Option D's own parity
row says shipping D alone means.

## The problem

The asymmetry is not cosmetic. Three of the run states an operator most needs to act on are
invisible from the session surface: a reviewer's actual objection, a run parked at the Inspector
gate, and a repair delivery whose write may or may not have landed.

## What ships

A vertical **stage ladder** in the Console and Board detail pane (`ConsoleDetail.tsx`): a spine
with one rung per stage, reviewers nested under their stage, and the failing stage's verdict
opened inline where the operator is already looking.

Four run states, drawn in the mockups as D1-D4:

| State | Rung behaviour |
|---|---|
| Reviewing | Passed stages collapsed to a line; the running stage lists its members with live status |
| Changes requested | The failed stage expands the objection in the reviewer's own words |
| Inspector gate | The gate is its own rung carrying PR number, target head and posture |
| Delivery uncertain | Its own rung with the shipped sentence and the two resolution actions |

Height is the axis a detail pane has, which is the whole argument for a ladder rather than a
rail. It is explicitly **not** put on the collapsed 330px grid card or the board tile.

## Investigated findings

Verified against `main` at `985aaa23`.

### The derivation already exists and must not be duplicated

`RunPipeline` (`RunPipeline.tsx:35`) already draws a run over its published graph, and every
piece of derivation it uses is reusable as-is:

- `projectStages(graph)` → `StagePipeline { sessionId, endId, endOutcome, stages }`, with
  `Stage { joinId, members }` and `StageMember` a discriminated union of
  `{kind:"persona", personaId}` / `{kind:"check", slot}` (`workflow-stages.ts:44-77`).
  **Stages are a pure projection of the graph and are persisted nowhere**
  (`workflow-stages.ts:11-19`).
- `stageName` / `stageSummary` / `nodeLabel` (`workflow-stages.ts:139/171/183`).
- `run-model.ts`'s `reviewerStatus:240`, `checkStatus:276`, `stageStatus:297`, `endStatus:323`,
  `submissionStatus:184`, `latestAttemptsFor:112`, `verdictOf:126`, `verdictMeta:531`,
  `gateWaitSentence:370`, `gateSummaryStatus:386`, `deliveryStateView:408`,
  `checkStatusView:455`, `checkOutcomeOf:466`, `runRounds:168`.

The ladder is therefore **a new leaf rendering over an existing derivation**, not a new
derivation. This materially lowers the cost the mockups estimated ("the most expensive client
one"). A second copy of any of the above is the specific failure this plan exists to prevent.

### The data is detail-only, and that is deliberate

`WorkflowRunSummary` (`workflow.ts:1277-1299`) is what SSE carries, and it holds **no stage or
member structure at all** - only `activePersonaNames`, `failedPersonaCount`, `round`,
`maxRepairRounds`, `gate`, and the two delivery counters. Graphs, attempts, verdicts and events
never travel over SSE by design (`workflow.ts:1328-1332`).

Everything the ladder draws lives on `WorkflowRunDetail` (`workflow.ts:1312-1334`), served by
`GET /api/workflow-runs/:id` (`routes.ts:965-979`). So Option D's stated cost is confirmed
exactly: **no SSE widening, one HTTP fetch on open.**

One consequence the mockups did not note: `WorkflowRunDetail.inspectorGate` is filled **only**
in `WorkflowManager.decorateRun` (`manager.ts:578-600`); `store.runDetail` sets it to `null`
(`store.ts:3879`). The gate rung's PR number, findings and posture are reachable through that
route and nowhere else.

### Three corrections to the mockups

1. **`maxRepairRounds` defaults to 5, not 6.** `DEFAULT_WORKFLOW_BINDING_DEFAULTS`
   (`workflow.ts:387-390`); bounds are 1-20 (`workflow.ts:32-33`). The mockups' "round 2 / 6"
   is illustrative. The ladder reads `summary.maxRepairRounds` and never hardcodes a bound.
2. **The uncertain-delivery actions are not plain buttons.** "Discard and send new round"
   requires a typed confirmation phrase, `DISCARD AND SEND A NEW REPAIR ROUND`, and is disabled
   when no session is bound (`WorkflowRuns.tsx:930`). "Mark delivered" has its own confirm body.
   Both POST `/api/workflow-deliveries/:id/resolve` (`routes.ts:1050`). A card-side button that
   fired either directly would be a destructive action behind one click that the Runs page
   deliberately puts behind a phrase.
3. **The shipped sentences already exist and must be reused, not retyped.**
   `deliveryStateView` (`run-model.ts:401-405`) is the verbatim source for
   "The write was lost or may have landed. It is never sent again automatically - inspect the
   pane, then resolve it below." `checkStatusView` (`run-model.ts:455`) supplies
   "No command is configured for this slot here, so the gate passed without running."

### The degraded-check rule already has a mechanism

The mockups' "do not tint a degraded stage green" is enforceable today rather than newly
invented. `WORKFLOW_CHECK_STATUSES` is `passed | failed | skipped | unavailable`
(`workflow.ts:791-792`), only `failed` blocks (`checkOutcomePasses:808`), and an unconfigured
slot is recorded `"skipped"` with a note (`checks.ts:250-256`). `RunPipeline` threads this
through `checkOutcomeFor`, whose doc comment states the exact trap: "a skipped or unavailable
check still finishes as a passing attempt, so without this the chip would report 'Passed' for a
command that was never spawned." The ladder must pass `checkOutcomeFor` for the same reason.

### The built-in the mockups draw is real

`BUILTIN_WORKFLOWS` holds one entry, `no-mistakes-review`, currently at **version 4**
(`builtin-workflows.ts:365-414`). Its stages match the mockups exactly: stage 1 is two checks
(`typecheck`, `test`), stage 2 is the single-member Intent Conformance Judge, stage 3 is Code
Risk Reviewer + Test Evidence Auditor + Documentation Steward, bookended by `nmr-session` and
`nmr-end` with `endOutcome: "Complete"` and an `inspector` completion policy.

**Version 4 reuses version 3's pipeline** and differs only in its completion policy, which moved
from being one fact about the workflow to one fact per version. v4 sets
`onFindings: "inspector_only"` where v3 set `"restart_workflow"`, so Inspector findings now
produce an inspector-only submission instead of restarting the whole review
(`fix(workflows): recheck Inspector without rerunning Persona reviews`, #305).
`missingPrAction: "offer_prepare_pr"` is unchanged across all four.

That has a consequence the ladder must respect: **a round can legitimately contain no persona
review at all.** `runRounds` already flags such a round `inspectorOnly`, and
`WorkflowRunSummary.bypassedPersonaReview` records that it happened. A ladder that drew the full
stage list for an inspector-only round would show three reviewers as pending forever in the run
state that is now the normal path after findings.

### The session-to-run join is by session id, but the binding's identity is not

`App.tsx:587-595` builds `workflowRunBySession` by taking the most recently updated run per
`run.sessionId`. The durable binding, however, is keyed on `noteKey = agentSessionId ?? id`
(`registry.ts:5382-5384`), which a `/clear` rotates. The ladder inherits this join and must not
invent a second one.

### Where it can go in the detail pane

`ConsoleDetail.tsx` offers three seams, all real:

### Non-stage-expressible graphs are a case the mockups never drew

`projectStages` returns `null` for a graph that is not stage-expressible, and `RunPipeline`
falls back to a read-only `WorkflowCanvas` (`RunPipeline.tsx:76-92`). Hand-built graphs predate
stages and a run of one must stay watchable. A ladder has no canvas, so this plan must say what
the detail pane does for such a run.

## Adopted decisions

Submitted by the operator on 2026-07-27. These are requirements, not open questions.

## Non-goals

- No change to `WorkflowRunSummary` or the SSE event pair. The ladder fetches detail.
- No ladder on the collapsed grid card or console rail. The later D′ follow-up replaced the
  Board tile's `WorkflowTileFlag` with a compact rung that expands to this same ladder.
- No new workflow execution behaviour. This is a reading surface; every action it offers routes
  to an existing endpoint with its existing confirmation.
- No second copy of any stage projection or status derivation.

## Verification

- `npm run typecheck`, `npm test`, `npm run build` and the bundle smoke check green, on Node 24
  and Node 26 as CI runs them.
- A bound run in each of the four drawn states renders correctly in Console and Board detail.
- A run whose version is not stage-expressible still renders whatever decision 3 selects.
- A check that never ran never reads as "Passed".
- `session-leaf-parity.test.ts` still passes: the other three session drawings are unchanged.
