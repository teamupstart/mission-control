# Phase 4: Surface a stalled Foreman-complete binding

## Outcome and value

When a session bound at Foreman Complete has finished a work cycle but its goal is unresolved,
the console detail's bind chip says so and the bind dialog offers the two ways forward:
**Accept objective as is** (Foreman then verifies and claims on its next tick) and the existing
**Submit bound version** (a manual run that freezes the current objective and carries the
`unreconciled` badge). Today that state is a silent dead end.

## Entry criteria and dependencies

Phase 3 merged (the accept route and `api.acceptGoal`), and the planning pull request that
publishes these artifacts. Anchors verified at `74eaf9434`. D2 (chip and dialog, no board tile)
and D4 (the control in the dialog notice) are requirements.

## Scope and non-goals

In scope: `workflowCompletionStall` in `src/web/lib/held.ts`, the chip's stalled state in
`ConsoleDetail`, the notice band in `WorkflowBindingDialog`, host wiring in `App.tsx`, styles,
tests, one Playwright spec, `docs/workflows.md`. Non-goals: the board tile, any new wire field,
the submit route and what it freezes (D3), the drawer (Phase 3).

## Repository findings and inherited contracts

The chip (`ConsoleDetail.tsx:601-640`) reads `view.workflowBindingBySession` and
`view.workflowRunsBySession` (lines 206-210) and takes its tooltip from `workflowBindChipTitle`
(`held.ts:171`, pinned by `test/workflow-bind-chip-title.test.ts`). `Session.goal` carries the
revision pair and `relationship`; `Session.workCycle` carries `generation`, `active`,
`completedAt`; `workflowRunIsOpen` is the open-run predicate. `WorkflowBindingDialogHost`
(`App.tsx:4612`) does not receive `workflowRunsBySession` (`App.tsx:2140`); the dialog computes
`existing` and offers **Submit bound version** when it is active. A band that draws a background
carries `.modal-bleed`.

## Implementation steps

1. `held.ts`: export `workflowCompletionStall(session, binding, runs)` returning a string or
   null: true only for an `active` `foreman_complete` binding, no open run, an unresolved goal
   (`resolvedPromptRevision < promptRevision` or `relationship === "unclear"`), and a completed
   cycle (`generation >= 1`, `active === false`, `completedAt !== null`). The string:
   "<name> v<n> is waiting on this session's goal: Foreman cannot call the work complete while
   the latest instruction is unresolved. Click for ways to proceed."
2. `ConsoleDetail.tsx`: compute the stall beside `workflowBinding`; when set, use it as the chip
   tooltip and add `stalled` to the chip class; the accessible name is unchanged.
3. `App.tsx`: pass `workflowRunsBySession` to the host; the host forwards it.
4. `WorkflowBindingDialog.tsx`: derive the stall from the live `session`, `existing` and the
   session's runs; when set, render `section.modal-bleed.workflow-binding-stall[role=status]`
   above the session `dl` with the sentence and two buttons: **Accept objective as is**
   (`api.acceptGoal`, disabled in flight, errors in `p.wf-error[role=alert]`) and **Submit bound
   version**, which triggers the footer's existing `perform(true)`. Do not duplicate the submit
   logic. The accept button renders only when `session.goal.text` (the card's objective summary)
   is set, the drawer's rule; the submit button stays either way.
5. `styles.css`: `.workflow-binding-stall` and `.workflow-bind-chip.stalled` (amber mark).
6. `docs/workflows.md`: the stall state, the notice and both actions, beside the existing
   **Submit bound version** paragraph.

## Data, API and compatibility

No server or wire change; the predicate reads fields every card already carries.

## Tests and verification

`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- `test/workflow-bind-chip-title.test.ts` or new `test/workflow-completion-stall.test.ts`: a
  table over the predicate, each conjunct false yielding null; the stalled case names the
  workflow and version.
- `test/console-detail-header.test.ts`: a stalled fixture renders the `stalled` chip and
  tooltip; an unstalled one keeps today's title.
- A `renderToStaticMarkup` case for the band, in the pattern of `test/foreman-intent-drawer.test.ts`:
  a stalled session whose goal has no objective shows the notice with **Submit bound version**
  only.
- `e2e/specs/workflow-stall-chip.spec.ts`: publish a `foreman_complete` preview workflow and
  bind it from the chip (as `workflow-bind-chip-returns.spec.ts` does); send a plain follow-up
  and wait for `unclear`; `POST /hooks/Stop` with the harness token (as
  `dispatch-and-converse.spec.ts:709-720` does); assert the stall tooltip; open the dialog,
  assert both buttons and `expectContentClearsBorder`; click **Accept objective as is** and
  assert the notice and stall state clear. Second case: **Submit bound version** yields a run
  whose Intent tab shows the `unreconciled` badge. `npm run build`, then run that spec.
- `npm run typecheck`, `npm run lint`, full `npm run test:e2e` before merge.

## Merge and exit criteria

All of the above pass; the full Playwright suite is green; `docs/workflows.md` describes both
actions.

## Downstream handoff

Nothing depends on this phase. It must not add wire fields or a second accept path.

## Cross-phase audit record

2026-11-05: audited against Phases 1-3; consumes Phase 3's route unchanged; the predicate's
conditions match `decidePromptedWrapup` step 8 and the work-cycle gate in
`prompted-wrapup.ts:276-285`.
