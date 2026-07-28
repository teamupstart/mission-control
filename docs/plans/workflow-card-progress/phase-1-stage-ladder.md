# Phase 1: The stage ladder, read-only

Part of `docs/plans/workflow-card-progress/phased-plan.md`. Source plan:
`docs/plans/workflow-card-progress/plan.md`. Source design: `mockups.html`, Option D.

## Outcome

A bound workflow run is readable from the session it is reviewing. The Console and Board detail
panes gain a vertical stage ladder: a spine with one rung per stage, reviewers nested under
theirs, and the failing stage's objection opened inline in the reviewer's own words.

The value is the three states that are invisible today without two clicks: which stage is
executing, who objected and what they said, and whether the run is parked at the Inspector gate
or on an uncertain delivery. Today all of that is one pill reading `Preview · R2`.

## Entry criteria and dependencies

- **Direct prerequisite: the planning session's pull request.** This phase's artifacts
  (`plan.md`, `phased-plan.md`, this file) must be on the default branch first.
- No other phase. This is the root implementation phase.

## Scope

- `useWorkflowRunDetail` - the one client path to `GET /api/workflow-runs/:id`.
- `WorkflowLadder` - the vertical renderer, drawing the four states in `mockups.html` D1-D4.
- Inline wiring into `ConsoleDetail`'s conversation tab.
- The freehand-graph fallback.
- A `wf-ladder-*` CSS section.
- README and tests.

### Non-goals

- **No in-place actions.** The gate and delivery rungs render their state and offer "Open run".
  Recheck Inspector and the two delivery resolutions are Phase 2. This is deliberate: it keeps
  the phase reviewable and leaves an operable surface, strictly better than today's chip.
- **No repeat-offender line.** Phase 3.
- **No change to `WorkflowRunSummary`, the SSE event pair, or any server file.** This phase is
  browser-only apart from README.
- **No refactor of `WorkflowRuns.tsx`.** Its `load()` is entangled with round selection,
  mutations and event/call paging. It keeps its own fetch; the hook is new, and what must not be
  duplicated is derivation, which neither does.
- **No ladder on the collapsed grid card, the board tile or the console rail.** They keep
  `WorkflowChip` / `WorkflowTileFlag` / `WorkflowRailMark` exactly as they are.

## Repository findings

- `ConsoleDetail` (`src/web/components/layouts/ConsoleDetail.tsx`) already reads the run:
  `const workflowRun = view.workflowRunBySession?.get(session.id) ?? null;` (`:102`). It renders
  `WorkflowChip` in its header at `:245`. The conversation tab (`:377-427`) stacks `GoalLine`,
  activity, `PaneDialogPrompt`, `ForemanStrip` (`:382`), `NomistakesStrip` (`:393`),
  `NomistakesFixLog` (`:401`) and `TranscriptPanel` (`:408`).
- `SessionViewProps` already carries `workflowRunBySession`, `onOpenWorkflowRun` and
  `onBindWorkflow` (`types.ts:117-119`). **No new prop is required.** If one becomes necessary it
  goes in `SessionViewProps` *and* `cardProps` (`types.ts:156-192`), never on a single view.
- `WorkflowRunDetail` (`workflow.ts:1312-1334`) is the response of `GET /api/workflow-runs/:id`
  (`routes.ts:965-979`), which answers 200 / 404 `workflow_run_not_found` / 500
  `workflow_run_corrupt` / 503. `inspectorGate` is filled only by `WorkflowManager.decorateRun`
  (`manager.ts:578-600`).
- `WorkflowRuns.tsx`'s `load()` (`:1278-1297`) is the pattern to extract: `workflowRequest`
  (`workflowApi.ts:12`), a `loadGeneration` counter so a slow response cannot overwrite a newer
  one, and a re-trigger on `[selected, selectedSummary]` (`:1298-1303`) - a moving SSE summary is
  what refreshes detail. `workflowRunLoadError` (`run-model.ts:37`) turns a thrown
  `WorkflowApiError` into a sentence.
- Every derivation the ladder needs already exists; see the phased plan's findings. The ones this
  phase calls: `projectStages`, `stageName`, `stageSummary`, `nodeLabel`, `orderedSubmissions`,
  `selectedSubmission`, `latestAttemptsFor`, `nodeStatusesForSubmission`, `verdictOf`,
  `verdictMeta`, `reviewerStatus`, `checkStatus`, `checkOutcomeOf`, `checkStatusView`,
  `stageStatus`, `endStatus`, `submissionStatus`, `gateWaitSentence`, `gateSummaryStatus`,
  `deliveryStateView`, `runStatusLabel`, `shortSha`.
- `workflowRunTone` (`session-bits.tsx:142`) is the shared 5-value tone vocabulary
  (`running | waiting | blocked | passed | failed`) already used by the chip, tile flag, rail mark
  and `PipelineStatusChip`.
- `.detail-conv` uses child combinators: `> .transcript` (`styles.css:13444`),
  `> .transcript .transcript-log` (`:13448`), `> .nm-log-open` (`:13465`). A new child is safe;
  do not wrap `.transcript` in anything.
- `PersonaVerdict` (`workflow.ts:1260-1275`) is discriminated on `verdict`; the fail arm carries
  `summary`, `requestedChanges: RequestedChange[]` and `confidence`. `RequestedChange`
  (`:1252-1258`) has `title`, `rationale`, `evidence[]`, optional `path`/`line`.
- `maxRepairRounds` defaults to 5 (`workflow.ts:387-390`), bounds 1-20 (`:32-33`).

## Implementation steps

### 1. `src/web/workflows/useWorkflowRunDetail.ts` (new)

```ts
export type WorkflowRunDetailState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; detail: WorkflowRunDetail };

export function useWorkflowRunDetail(
  runId: WorkflowRunId | null,
  updatedAt: number,
): WorkflowRunDetailState;
```

- Fetch `GET /api/workflow-runs/${encodeURIComponent(runId)}` through `workflowRequest`.
- Hold a generation counter in a ref; discard a response whose generation is stale, exactly as
  `WorkflowRuns`' `loadGeneration` does. Without it a slow response for run A overwrites the
  detail of run B after the operator switches sessions.
- Re-run on `[runId, updatedAt]`. `updatedAt` is `WorkflowRunSummary.updatedAt` from SSE, which
  is the existing refresh signal.
- `runId === null` returns a stable `{ state: "loading" }`-equivalent without fetching; the caller
  gates on the run existing.
- Map a thrown error through `workflowRunLoadError` so the sentence matches the Runs page.
- The discriminated return is the contract: a caller cannot read `detail` without having handled
  loading and error.

### 2. `src/web/workflows/WorkflowLadder.tsx` (new)

Props:

```ts
{
  summary: WorkflowRunSummary;
  detail: WorkflowRunDetail;
  onOpenRun: () => void;
}
```

It **never fetches**; the caller owns the hook.

Derive, in this order:

1. `const submission = selectedSubmission(detail, null)` - the latest round.
2. `const attempts = latestAttemptsFor(detail, submission.id)`.
3. `const statuses = nodeStatusesForSubmission(detail, submission.id)`.
4. `const pipeline = detail.version ? projectStages(detail.version.graph) : null`.
5. If `pipeline === null` (freehand graph, or a missing version) render the **fallback**: the
   existing `WorkflowChip` plus a button calling `onOpenRun`, and nothing else. Do not render an
   empty ladder and do not embed a canvas.

Render, as a `<ul className="wf-ladder">` of `<li className="wf-ladder-rung">`:

- **Header** (`wf-ladder-head`): `⌁ {summary.workflowName}`, `v{summary.workflowVersion}`, the
  status word from `runStatusLabel(summary.status)` toned by `workflowRunTone(summary)`, and
  `round {summary.round} / {summary.maxRepairRounds}`. Read the bound from the summary; the
  mockups' "/ 6" is wrong, the default is 5.
- **Session rung** - terminal node, status from `submissionStatus(submission, …)`.
- **One rung per `pipeline.stages` entry**, in order:
  - name from `stageName(stage, index, personaNames)`, sub from `stageSummary(stage)`;
  - status from `stageStatus(members.map(m => m.status))`;
  - member status from `reviewerStatus` for a persona and
    `checkStatus(raw, checkOutcomeFor(nodeId))` for a check. **`checkOutcomeFor` must be threaded**
    - it is `checkOutcomeOf(attempts.get(nodeId))` - or a skipped check reads as "Passed" for a
    command that never ran;
  - **a passed stage collapses to its one-line form** (name + state, no member list). A running
    or failed stage lists members. This is what keeps the ladder's height honest and it is how
    D2 and D3 are drawn;
  - a failed stage additionally renders `wf-ladder-why`: the fail arm's `summary` from
    `verdictOf(attempt)`, prefixed by the member's name, clamped to three lines in CSS.
- **Inspector gate rung** when `detail.inspectorGate` is non-null and its `state.waitReason` is
  non-null: name "Inspector gate", state from `gateSummaryStatus(summary.gate)`, sentence from
  `gateWaitSentence(state.waitReason)`, and a meta row with `summary.gatePrNumber`,
  `summary.gateHeadShort` and `summary.reviewPosture`.
- **Uncertain-delivery rung** when `detail.deliveries` contains one in state `"uncertain"`:
  label and sentence verbatim from `deliveryStateView("uncertain")`. No buttons this phase.
- **End rung** - terminal, `pipeline.endOutcome`, status from `endStatus(...)`.
- A single `wf-ladder-actrow` with one "Open run" button calling `onOpenRun`.

Every rung carries exactly one of `is-passed | is-running | is-failed | is-waiting | is-pending`
and optionally `is-terminal`, so CSS owns the spine and node shape.

### 3. `src/web/components/layouts/ConsoleDetail.tsx`

In the conversation tab, between `NomistakesFixLog` (`:401-407`) and `TranscriptPanel` (`:408`),
gated on `workflowRun`:

```tsx
{workflowRun && (
  <WorkflowLadderPanel
    run={workflowRun}
    onOpenRun={() => view.onOpenWorkflowRun?.(workflowRun.id)}
  />
)}
```

`WorkflowLadderPanel` is a thin wrapper (same file as the ladder) that calls
`useWorkflowRunDetail(run.id, run.updatedAt)` and renders loading, error and ready states. Keeping
the hook in the wrapper is what lets `WorkflowLadder` stay a pure renderer the tests can drive
with a literal detail object.

Place it **after** `NomistakesFixLog` and **before** `TranscriptPanel`, and do not wrap
`.transcript`: `styles.css:13444` selects it as a direct child of `.detail-conv`.

### 4. `src/web/styles.css`

A new `/* ---- workflow stage ladder ---- */` section, placed in feature order beside the console
detail section rather than at the end of the file.

- Prefix every class `wf-ladder-`. **Do not reuse `wf-pipeline-*`**: those rules are shared by the
  Runs monitor and the authoring Pipeline editor, and a shared rule means a detail-pane tweak
  silently restyles both.
- The spine is drawn on `.wf-ladder-rung:not(:last-child)::before` so the line never overshoots
  the terminal node.
- Tone colours come from the shared `workflow-${tone}` classes plus the existing `--idle`,
  `--working`, `--danger`, `--attention` tokens. **Name no vendor and add no token named after
  one** (`agent-accent.test.ts` fails on an agent id appearing in this file).
- `wf-ladder-why` clamps to three lines.

### 5. `README.md`

In "Workflows and Personas", document that a bound run now renders as a stage ladder in the
Console and Board detail panes, that it is a reading surface, and that a run on a
non-stage-expressible version links out to the Runs page instead.

### 6. Tests

- `test/workflow-ladder-render.test.ts` - `renderToStaticMarkup` over `WorkflowLadder` with a
  literal `WorkflowRunDetail` for each of the four states in `mockups.html`. Assert:
  the running stage lists its members; a passed stage does **not**; the failed stage's markup
  contains the reviewer's verdict summary; the gate rung carries the PR number and the
  `gateWaitSentence` text; the uncertain rung carries the exact `deliveryStateView` sentence.
- `test/workflow-ladder-checks.test.ts` - **the regression that matters most**: a check whose
  attempt completed but whose recorded outcome is `"skipped"` must not render as "Passed", and
  must carry `checkStatusView("skipped").sentence`. Build the detail with an attempt whose
  `output_json` holds a `WorkflowCheckOutcome` with `status: "skipped"`.
- `test/workflow-ladder-fallback.test.ts` - a version whose graph is not stage-expressible
  renders the chip-plus-link fallback and no `wf-ladder-rung`.
- Extend nothing in `session-leaf-parity.test.ts`; assert only that it still passes.

## Data, API and compatibility

- **No schema change, no migration, no new route, no SSE change.** This phase reads an existing
  endpoint.
- `detail.version` is `WorkflowVersion | null`; a null version takes the same fallback as a
  freehand graph.
- The response can be 404 or 500 for a run the summary still names (a retention sweep can delete
  a run between SSE and fetch). The error state renders the sentence and the "Open run" link, and
  never an empty ladder.

## Tests and verification

```
npm run typecheck
npm test
npm run build
```

Manual, per the repository's "Verifying" rule - and note that `:5173` serves whichever checkout
started Vite, so confirm you are looking at your own build:

- A session with a bound run in Console and in Board detail shows the ladder inline in the
  conversation tab, above the transcript.
- The grid card, board tile and console rail are unchanged.
- A run parked at the Inspector gate shows the gate rung with its PR number.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- The four drawn states render; the freehand fallback renders; a skipped check never reads as
  passed.
- README updated in this same change.
- No file under `src/server/` is modified.

## Downstream handoff

Phases 2 and 3 may rely on:

- **`useWorkflowRunDetail(runId, updatedAt)`** and its discriminated return. Neither phase changes
  the signature.
- **`WorkflowLadder` is a pure renderer.** Phase 2 adds callback props; it must not make the
  component fetch.
- **`wf-ladder-*`** is the CSS namespace, and `workflow-${tone}` is the tone vocabulary.
- **The rung state classes** `is-passed | is-running | is-failed | is-waiting | is-pending` and
  `is-terminal`.
- **The freehand fallback is settled** and neither later phase revisits it.
- **All derivation comes from `run-model.ts` / `@shared/workflow-stages.ts`.** A derivation a
  later phase needs is added *there*, so both drawings can reach it - never inline in the ladder.

Neither later phase may change: the collapse rule for passed stages, the threading of
`checkOutcomeFor`, or the decision that the Runs page keeps `RunPipeline`.

## Cross-phase audit record

- Written first; no earlier phase to reconcile against.
- Reviewed against the source plan's four adopted decisions: decision 2 (inline seam) and
  decision 3 (freehand fallback) are implemented here in full. Decision 1 (Runs page keeps
  `RunPipeline`) is honoured by this phase touching no file under `src/web/workflows/` other than
  the two new ones. Decision 4 (repeat-offender) is deferred to Phase 3 and nothing here blocks
  it.
- The non-goal "no in-place actions" was checked against Phase 2's needs: the gate and delivery
  rungs are rendered here, so Phase 2 adds an action row to existing markup rather than
  restructuring it.
