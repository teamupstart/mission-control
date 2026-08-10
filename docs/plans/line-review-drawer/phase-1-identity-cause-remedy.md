# Phase 1 - Durable identity, the blocked cause, and inline remedies

Source plan: [`plan.md`](plan.md) · index: [`phased-plan.md`](phased-plan.md) · mockups:
[`../../mockups/line-review-drawer/index.html`](../../archive/mockups/line-review-drawer/index.html)
(the section headed **Option A**)

## Outcome

A row in the Line's Review drawer says **who it is**, **why it stopped**, and **what to do about
it**. Today it says a GUID, the word `Blocked`, and nothing.

After this phase, a run whose session was removed reads:

```
Fix Busy State for Diff Link          Evidence → Reviewers stopped     Blocked · session gone     [Dismiss] [Open run]
No-Mistakes Review v8 · round 4/5
```

## Entry criteria and dependencies

**Direct phase dependencies: none.** This is the first phase; it branches from the default
branch once the planning pull request has merged.

Baseline confirmed green on the planning branch: `npm run typecheck`, `npm run lint` (exit 0,
warnings pre-existing), and `test/line-drawer.test.ts` + `test/line-summary-fold.test.ts` +
`test/workflow-external-source.test.ts` (63 passing).

## Scope

1. A durable session title on the run summary, and a three-step name resolution in the drawer.
2. A `phase → clause` map, so a blocked row states its cause.
3. A `phase → remedy` descriptor, and the argument-free action buttons on the row.
4. The tone correction: blocked is red, not amber; cancelled reviewers read as stopped, not
   waiting.
5. The title column widened to fit real titles.
6. The two tests and the README paragraph that encode the old "never a mutation" rule.

### Non-goals

- **Grouping.** Phase 2 owns `groupReviewRuns()` and the group bar.
- **The strip's split count.** Phase 2 owns `foldReview`. This phase leaves the strip's
  sentence alone, so the strip still reads "N waiting on you" over a drawer whose rows are now
  individually explained. That is a consistent, if coarse, intermediate state.
- **`Reattach`.** It needs a session picker. It stays on the run page and in
  `WorkflowBindingDialog`.
- **No agent accent dot.** Deliberately refused in the source plan: a second denormalized
  column on a payload that ships for every run on every change.
- **No change to `DecideDrawer` or `IntakeDrawer`.**

## Repository findings

Verified against the working tree. Read these before writing code; where the repository
disagrees with what follows, trust the repository and record the deviation in the pull request.

- `src/web/components/line/ReviewDrawer.tsx:154` -
  `sessionName={(run.sessionId && named.get(run.sessionId)) || run.noteKey}`. `named` is built at
  `:120` from the `sessions` prop, which holds live sessions only.
- `src/server/workflows/store.ts:125` `WORKFLOW_RUN_SUMMARY_SELECT` already has
  `JOIN workflow_bindings b` and selects `b.note_key, b.session_id`. Adding `b.session_name` is a
  projection change - no new join, no new statement, so
  `test/workflow-pagination.test.ts`'s statement-count budget (its `instrumentedStore`) is
  unaffected.
- `src/server/workflows/store.ts:2626` `runSummaryFromRow` builds the summary. Its comment at
  ~2691 states the optional-field convention: omit the key entirely rather than emit `null`,
  because summaries ship over SSE for every run on every change. `session_name` is coalesced to
  `""` on write (`store.ts:558`), so an empty string must be omitted, not emitted.
- `src/shared/workflow.ts` `WorkflowRunSummary` documents its optional/append-only convention in
  the block comment on `externalSource`. Follow it.
- `src/web/workflows/run-model.ts` already holds the sibling maps this phase copies:
  `RUN_STATUS_LABELS` (~622), `GATE_WAIT_SENTENCES` (~644), `GATE_SUMMARIES` (~665),
  `runTriageSteps` (~1297), `runTriageSentence` (~1329), `runTriageRound` (~1348).
- `phase` is `string`, not a union. `orphanBinding` (`store.ts:5212`) writes a caller-supplied
  reason straight into it. `src/shared/alerts.ts:369` already handles this with
  `run.phase.replaceAll("_", " ")` - reuse that as the fallback so two surfaces cannot disagree.
- All four remedy routes take `{ requestId }` and nothing else that lacks a default
  (`src/shared/protocol.ts:2799-2827`; routes at `src/server/routes.ts:1084,1094,1104,1144`).
  `restart-full` additionally accepts an optional `confirmation` string, and the daemon
  independently demands the phrase (`manager.ts:1718`).

### The client plumbing that already exists - reuse it, do not reinvent

- **There is no wrapper in `src/web/lib/api.ts` for any of these routes.** Workflow mutations go
  through `workflowRequest` in `src/web/workflows/workflowApi.ts`, which throws
  `WorkflowApiError` carrying `status` and `body`. Import it directly.
- **`src/web/workflows/run-action-store.ts`** owns pending state and `requestId` idempotency,
  keyed module-level by `` `${runId}:${action}` `` so two surfaces cannot double-fire one intent.
  It retains the `requestId` across a *failed* response and discards it only on success, which is
  what makes a retry replay the same intent. Exports `runAction`, `isRunActionPending`,
  `useRunActions(runId, onSettled)`. `RunActionId` is a free `string`; the convention
  (`WorkflowRuns.tsx:1877`) is **one action id per intent, direction included**.
  - Note `useRunActions` takes a *single* `runId`. A drawer with N rows either calls the hook
    per row or uses the bare `runAction` / `isRunActionPending` module functions.
  - Note also that the run page's own cancel/restart/retry/resubmit currently *bypass* this store
    via a local `mutate()` with an inline `crypto.randomUUID()`. Prefer the store; do not copy
    `mutate`.
- **`src/web/workflows/WorkflowConfirmModal.tsx`** is the shared confirmation dialog, already used
  by seven surfaces. Its `WorkflowConfirmRequest` carries `title`, `body`, `confirmLabel`,
  `confirmHint`, optional `danger`, optional `requirePhrase`, and `onConfirm`. **Do not roll a
  new dialog and do not invent a two-click inline confirm** - the modal renders through `Overlay`
  with a registered id, which is the only reason `esc` closes the confirm before the drawer
  (`App.tsx:1404` stands the drawer's key handler down while any overlay is open). Hold one
  `confirm` state at drawer level, not per row; only one overlay can be open.
- **The closest precedent is not the run page.** `WorkflowLadderPanel`
  (`src/web/workflows/WorkflowLadder.tsx:614-826`) is a secondary surface that mounts run actions
  off a `WorkflowRunSummary` - exactly this situation. Copy the shape of its `runPost` helper
  (`:738-748`), its `localError ?? controller.error` plumbing (`:801`), and its confirm-modal
  mounting (`:821`).
- **Errors are inline `role="alert"`, never toasts.** There is no toast system and `App.tsx` has
  no general error channel to pass down (its only error state is a bespoke launcher flash). Keep
  error state local to the drawer, as the ladder panel does. `.line-drawer-body` is height-capped,
  so decide deliberately where an error line lives - inside the capped body it will scroll.
- **`workflowRuns` arrives by SSE** (`App.tsx:169`), so the list self-refreshes after a mutation;
  the drawer does not need to re-fetch. The drawer is also *conditionally mounted*
  (`App.tsx:2269`), so an action that settles after the drawer closes hands its refresh to
  whatever run surface is mounted next - which the action store already handles.

### Which guards are reachable from a summary alone

This matters because the revised rule is "the summary alone proves the run is stopped".

| Remedy | Guard | Summary-only? |
| --- | --- | --- |
| `Dismiss` (cancel) | `!["completed","cancelled","failed"].includes(run.status)` | yes |
| `Resubmit` | `run.status === "waiting_for_session"` | yes |
| `Retry` | `status === "blocked" && phase === "infrastructure_error"` | yes - the run page's extra `nodeAttemptId` comes from `detail.attempts`, but it is **optional** server-side, so omit it |
| `Restart` (restart-full) | the run page guards on `detail.inspectorGate`, which is **not** on the summary. Use the coarser summary-only guard this plan actually wants - blocked at a round-limit phase - and say so in a comment | yes, with a coarser guard |

`restart-full` also carries `requirePhrase: "RESTART FULL WORKFLOW"` on the run page, and the
daemon enforces it. That is a heavy interaction for a triage drawer. Keep the phrase (the daemon
requires it and weakening the guard is not this phase's call), and if it reads badly in the
drawer, record that in the pull request rather than dropping the confirmation.
- `orphanBinding` cancels the run's queued reviewer attempts. A summary for such a run therefore
  has `activePersonaNames: []`, which `reviewerTriageStatus` (~1260) currently renders as a
  waiting `Reviewers` chip. That is the chip this phase corrects.

## Implementation steps

In execution order.

### 1. The wire contract

- `src/shared/workflow.ts` - add `sessionName?: string` to `WorkflowRunSummary`, beside the
  other optional fields, with a doc comment saying what it is (the binding's captured session
  title), why it is optional (append-only, and an older daemon's payload must still parse), and
  why it matters (a run outlives the session it reviewed; this is the only human name left).
  Do not use the word `repeatOffenders` anywhere in the comment -
  `test/workflow-repeat-offender.test.ts:165` asserts its absence from this interface body.

### 2. The server projection

- `src/server/workflows/store.ts` - add `b.session_name` to `WORKFLOW_RUN_SUMMARY_SELECT`.
- In `runSummaryFromRow`, emit `sessionName` with the same conditional-spread pattern
  `externalSource` uses, so an empty captured name produces no key at all.

### 3. The clause map

- `src/web/workflows/run-model.ts` - add `BLOCKED_PHASE_CLAUSES: Record<string, string>` and
  `export function blockedPhaseClause(phase: string): string`, placed with the other lookup
  maps. Clauses are short and lower-case; they render in a 190px mono column. The mapping is in
  the source plan's phase table - implement every row of it, and fall back to
  `phase.replaceAll("_", " ")` for anything unmapped.
- Extend `runTriageSentence` so a stopped run appends its cause: `Blocked · session gone`. Keep
  the existing behaviour for every other status byte-for-byte - `test/line-drawer.test.ts`
  asserts `"Reviewing · … running"`, bare `"Reviewing"`, and the uncertain-delivery suffixes,
  and `src/web/lib/palette-index.ts:266` renders the same sentence in the command palette.
- Cover the one non-blocked case the fleet is sitting on: `status = "waiting_for_session"` with
  `phase = "reattached_resubmit_required"` reads *reattached, needs resubmit*.

### 4. The remedy descriptor

- `src/web/workflows/run-model.ts` (or a sibling beside `run-actions.ts` if that reads better) -
  `runRemedy(run: WorkflowRunSummary): RunRemedy | null`, returning the single argument-free
  action for the run's phase per the source plan's table, or `null` when the only move is
  `Open run`. It must decide from the summary alone - see the guard table above.
- `RunRemedy` carries at least a stable `kind` (which doubles as the `RunActionId`, so it must be
  one id per intent), a button `label`, the route path, and the `WorkflowConfirmRequest` for the
  destructive ones. Reuse the confirm copy the run page already writes for Cancel and Restart
  (`WorkflowRuns.tsx:778-806`) rather than composing new wording for the same act.

### 5. The drawer

- `src/web/components/line/ReviewDrawer.tsx`:
  - Resolve the row name in three steps: live session name → `run.sessionName` → `run.noteKey`.
    Render the GUID case as a dim mono identifier rather than a bold title.
  - Tone the state column by outcome, and give a blocked row a **red** leading edge while amber
    keeps meaning "it is your turn".
  - Render a cancelled-reviewer chip as a stopped/grey `Reviewers stopped` rather than an amber
    `Reviewers`. Derive it from what the summary proves - a blocked run with no active personas -
    and not from a new field.
  - Render the remedy button beside `Open run`, with `Open run` demoted to the secondary slot.
    Disable it while `isRunActionPending` for that intent, and give it the pending tooltip the
    run page uses (`runActionTooltip`, `run-actions.ts:145`).
  - Hold one `confirm` state and one `localError` at drawer level, mount
    `<WorkflowConfirmModal>` as a sibling of `<LineDrawer>`, and render the error as an inline
    `role="alert"` - the shape `WorkflowLadderPanel` already uses.
  - **Rewrite the component's doc comment** to state the revised rule: *no fetch and no run
    detail; actions only where the summary alone proves the run is stopped and the route needs no
    argument beyond the run id.* Say why `Reattach`, `Resolve delivery` and `Disable a reviewer`
    are still excluded.
- `src/web/App.tsx` - **probably nothing to add.** `workflowRuns` already arrives by SSE and
  there is no api client, toast channel or error surface in App worth threading down. If the
  drawer needs a prop it does not have, prefer adding it there over widening App's state.
- `src/web/styles.css` - the blocked tone, the stopped chip, and `.line-run-who` 240px → 340px.
  The existing comment on that rule explains the 240px choice; replace it with one that explains
  340px, and take the space from the chip rail.

### 6. Documentation

- `README.md`, the stage-drawers section - the sentence *"None of them fetches, and none of them
  mutates: every action that changes a run or records a decision stays on the full page, one
  click deeper"* is now false for Review. Restate the rule as implemented, and update the
  **Review** row of the drawer table to mention the cause and the inline remedy.

## Tests and verification

### Rewritten deliberately

- `test/line-drawer.test.ts` - *"the Review drawer offers escalation and never a mutation"*
  asserts the absence of `Retry`, `Cancel run`, `Disable`, `Recheck`, `Reset`. It is the codified
  old rule. Rewrite it to assert the **new** rule precisely: the argument-free remedies are
  present, and `Reattach` / `Resolve` / `Disable` are still absent. Do not simply delete it - the
  boundary is the point, and an assertion that the drawer still refuses picker-shaped actions is
  what stops the next change eroding it.
- `test/workflow-external-source.test.ts:774` - pins the summary's exact key set. Add
  `sessionName`. Note it asserts twice (again at ~827) with a manual run that has no external
  source; the conditional-spread means the two lists differ, so check both.

### Added

- `test/line-drawer.test.ts` - `blockedPhaseClause` for a mapped phase and for an unmapped one
  (the fallback); `runTriageSentence` for a blocked run; `runRemedy` per phase including the
  `null` case; `ReviewDrawer` markup renders the durable `sessionName` when the session is gone,
  the live session name when it is present, and the GUID only when there is genuinely nothing
  else.
- A store test that `runSummaryFromRow` carries `sessionName` off the binding and omits the key
  when the captured name is empty. `test/workflow-pagination.test.ts` and
  `test/workflow-sse.test.ts` both already seed bindings with a `sessionName`; follow their setup
  rather than inventing a third.

### e2e - required, and the one that proves the phase

`e2e/specs/line-drawers.spec.ts`. Read [`e2e/README.md`](../../../e2e/README.md) first.

The spec seeds a run the way the existing Review test does (dispatch → persona carrying
`E2E_FAIL_VERDICT` → workflow → publish → bind → submit), then kills the session and asserts the
drawer.

Two constraints, both verified:

- **The run state cannot be seeded by writing SQLite.** Run summaries are served from an
  in-memory map on the `Registry`, not re-read per request. Drive the daemon:
  `POST /api/sessions/:id/kill`.
- **`EXIT_LINGER_MS` is a hardcoded 8s** (`src/server/registry.ts:259`) between the session
  exiting and `session_remove` firing, and it is not env-tunable. Poll
  `/api/workflow-runs/:id` for `{ status: "blocked", phase: "session_disappeared" }` with an
  explicit timeout - the `expect` default is 10s, the per-spec budget is 60s.

Assert the user-visible consequence: the row shows the binding's captured title (the fake agent
titles deterministically), the state reads `Blocked · session gone`, and the remedy button is
reachable by role and accessible name. Select by role/label/placeholder - **never** add a
`data-testid`.

### Commands

```sh
npm run typecheck
npm run lint
node --test --test-concurrency=2 --import tsx test/line-drawer.test.ts
npm test
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- All commands above pass.
- A Review row for a run whose session was removed shows the binding's title, `Blocked · session
  gone`, and a working remedy - demonstrated by the e2e spec, not by diff inspection.
- The GUID appears only when there is no live session name and no captured `sessionName`, and it
  is not bold.
- README matches the implementation.
- No unrelated edits in the worktree.

## Downstream handoff

Phase 2 may rely on, and must not change:

- `WorkflowRunSummary.sessionName` - optional, append-only, omitted when empty.
- `blockedPhaseClause(phase: string): string` - including the `replaceAll("_", " ")` fallback.
  Phase 2 labels its group bars with this.
- `runRemedy(run, name?): RunRemedy | null` and the `RunRemedy` shape. Phase 2's `Dismiss all`
  is this phase's cancel remedy applied to a set, and must not introduce a second cancel path.
- `runRowIdentity(run, liveSessionName): { name, isIdentifier }` - the three-step name
  resolution, which Phase 2 reuses when it lists a group's member titles.
- The revised drawer rule in the component doc comment and README, which Phase 2 extends to
  cover a batch action rather than restating.

Phase 2 will change `foldReview` in `src/server/line-summary.ts`. This phase must not.

## Implementation record - what the repository changed

Written after the phase shipped. The plan above is the proposal; this is what the code said
back, and every item was checked against the daemon rather than argued.

1. **`Restart` moved off `round_limit` and onto `waiting_for_new_head`.** The source plan maps
   a round-limit block to `POST /workflow-runs/:id/restart-full`. `manager.restartFull` refuses
   when `latest.round > run.maxRepairRounds` (`manager.ts:1758`) - and that inequality IS the
   definition of the `round_limit` block, so the button could never once have succeeded there.
   It also requires an active Inspector gate and `status === "waiting_for_new_head" ||
   latest.mode === "inspector_only"`. Only the first of those two arms is on a summary, so
   `waiting_for_new_head` is the one state where a summary proves the daemon will accept a
   restart, and that is where the remedy lives. All four decided remedies still ship.
2. **`round_limit` takes `Dismiss` instead.** Nothing argument-free revives an out-of-rounds
   run - `resubmit` refuses it on the same inequality, and raising the budget is a binding
   edit - so the honest remedy is the one `session_disappeared` already gets: stop counting a
   run that will never move again. Both alternatives stay one click away through `Open run`.
3. **`inspector_round_limit` is not a phase.** `transitionInspectorGate` writes it as an EVENT
   kind and sets the phase to `round_limit` (`manager.ts:2727-2733`). The clause map keeps the
   entry as insurance and says so; nothing depends on it.
4. **The clause for `reattached_resubmit_required` is `reattached`, not `reattached, needs
   resubmit`.** The full phrase makes a 51-character sentence in a column that holds ~40. The
   clause's job is why it stopped and the button beside it says what to do - and that button
   already reads `Resubmit`, so the dropped half was the row repeating itself.
5. **Two columns widened, not one, and a third got a floor.** `.line-run-state` went 190px →
   240px because the causes it now carries do not fit 190 (`Blocked · out of Inspector rounds`
   is ~199px), and `.line-run-ops` got `min-width: 170px` with a right-aligned reservation:
   only a stopped row carries a remedy, so without a floor the two-button rows widened the
   trailing column and shoved their cause 71px left of the cause on the row above. The e2e
   spec asserts the two rows' `.line-run-state` share an x, and that assertion was checked
   against the unfixed stylesheet before it was trusted.
6. **A fifth chip tone, `stopped`.** `PIPELINE_STATUS_TONES` had four and none of them said
   "cancelled where it stood". Its only consumer is `pipeline-bits.tsx` itself, so the
   vocabulary extension is local.
7. **`LineDrawer` grew a `notice` slot.** A drawer that can act has to be able to say it
   failed, and `.line-drawer-body` is capped and scrolls - an alert inside it is scrolled away
   by the list the failed action was taken from. The slot sits between the header and the body
   and the two read-only drawers pass nothing.
8. **Blocked runs sort below runs genuinely waiting on a person.** `triageOrder` was a single
   `workflowRunWaitsOnOperator` bit, which is true of both. The predicate itself is untouched -
   the strip's count, this drawer's count and the command palette all still read it - this is
   presentation only, and it matches the mockup's own row order.
9. **`App.tsx` needed nothing**, exactly as this phase predicted. The remedy plumbing is
   `runAction` + `workflowRequest` + `WorkflowConfirmModal`, all held inside the drawer.
10. **A third test was rewritten** beyond the two this phase named: `test/line-drawer.test.ts`'s
    ordering-and-marking case encoded the old single amber tone. It now asserts both tones and
    the three-tier order.

## Cross-phase audit record

- **Written first, no prerequisites.** Owns the entire wire contract change so Phase 2 needs no
  server field of its own.
- **Revised after reading the client action plumbing.** The source plan named `src/web/App.tsx`
  as the wiring seam; the repository disagreed. `WorkflowLadderPanel` is an existing secondary
  surface doing exactly this off a `WorkflowRunSummary`, `WorkflowConfirmModal` is the shared
  dialog, and `workflowRequest` - not `lib/api.ts` - is the transport. The steps above were
  rewritten to point at those, and the guard table was added because two remedies' run-page
  guards read run *detail* the summary does not carry.
- **Checked against Phase 2 after it was written.** Phase 2 consumes `blockedPhaseClause` and
  `runRemedy` exactly as exported here; no signature change was needed. The decision to tone
  blocked rows red lives here rather than in Phase 2, because a red row is correct before any
  grouping exists.
- **Deliberate intermediate state recorded.** Between this phase merging and Phase 2 merging, the
  strip still says "N waiting on you" while the drawer explains each row individually. That is
  coarse but not contradictory - both still read `workflowRunWaitsOnOperator`. Phase 2 refines
  the wording in both surfaces at once, which is why the split is not attempted here.
