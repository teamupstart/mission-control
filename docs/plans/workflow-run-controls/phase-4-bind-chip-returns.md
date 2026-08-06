# Phase 4 - The bind chip returns after a run finishes

## Outcome

The `＋ workflow` chip stops vanishing forever. Today a session that has *ever* had a workflow run
hides the chip permanently, because the gate is "any run at all" rather than "an open run". After this
phase a session whose run has finished offers the chip again, matching every other held affordance,
all of which already release on a terminal run.

Value: this is the other half of the dead end Phase 3 fixes from the run page. Without it, a session
whose review completed can never be reviewed again from the session surfaces - the board tile, the
card, and the console detail header all stay silent.

## Entry criteria and dependencies

- **Direct phase dependencies: none.** Runs concurrently with Phase 1, and may merge in any order
  relative to Phases 1, 2 and 3.
- Independent by construction: this phase touches only `SessionCard.tsx` and `ConsoleDetail.tsx`,
  neither of which any other phase edits.

## Scope

In scope:

1. Change the two bind-chip gates from `!workflowRun` to "no **open** run", using the shared
   `workflowRunIsOpen` predicate.

Non-goals:

- **Do not change `workflowRunBySession`** in `App.tsx`. See the findings; narrowing the map would
  break four other surfaces.
- No change to `WorkflowChip`, the ladder, the Workflows tab, the held tag, or backlog drop
  acceptance. All four already behave correctly and are the evidence that this gate is the outlier.
- No change to the bind dialog's conflict handling.

## Repository findings

This phase is one condition in two files, and the investigation is entirely about proving the fix does
**not** belong in the obvious place.

### The map must not change

`workflowRunBySession` (`src/web/App.tsx:966-974`) keeps the newest run per session by `updatedAt`,
terminal runs included, and the source list is unfiltered end to end
(`App.tsx:183` ← `useEventStream.ts:154` ← `manager.runs()` at `manager.ts:797-799` ←
`store.listRunSummaries()` at `store.ts:2491-2497`, a `SELECT` with no status filter).

Narrowing it looks tempting and is wrong. The display consumers **deliberately want terminal runs**:

- `WorkflowChip` renders the outcome of a finished run - `workflowRunTone` maps `completed → "passed"`
  and `failed`/`cancelled → "failed"` (`src/web/components/session-bits.tsx:141-146`), and
  `workflowRunLabel` produces "Approved", "Preview cancelled", "Preview failed" (`:159-175`).
  Narrowing the map deletes the Approved chip.
- The board tile's ladder is gated on `workflowRun &&` (`SessionTile.tsx:215-224`).
- The console's Workflows tab body (`ConsoleDetail.tsx:460-465` → `SessionWorkflowsPane`) would fall
  back to "No workflow is bound to this session."

Meanwhile every consumer that needs "open" **already re-narrows for itself**, which is why they are
all correct today:

- `heldSessionIds` - `if (workflowRunIsOpen(run.status)) held.add(sessionId);` (`src/web/lib/held.ts:22-31`)
- `sessionIsHeld` - `return run != null && workflowRunIsOpen(run.status) && tone === "idle";` (`held.ts:47-51`)
- `canAcceptTask` - `if (workflowRun != null && workflowRunIsOpen(workflowRun.status)) return false;`
  (`BacklogColumn.tsx:405`), whose comment states the rule: "`workflowRunIsOpen` decides, so a
  terminal run releases the drop target the same instant"

So the two bind-chip gates are the only consumers that misread a terminal run, and the fix belongs at
those two call sites.

### The two gates

`src/web/components/SessionCard.tsx:271`:

```tsx
{!workflowRun && onBindWorkflow && (
```

`src/web/components/layouts/ConsoleDetail.tsx:286`:

```tsx
{!workflowRun && view.onBindWorkflow && (
```

Both render a `workflow-bind-chip` button labelled `＋ workflow`, tooltipped "Bind a published workflow
version". `WorkflowChip` returns `null` on a null run, so chip and bind-chip are mutually exclusive by
construction today; after this change a finished run shows **both** the outcome chip and the bind chip,
which is the intent - the outcome is history, the bind chip is the next action.

### The predicate is available and browser-safe

`workflowRunIsOpen` is exported from `src/shared/workflow.ts:1119-1132` beside the status union, with a
docstring naming exactly this hazard: "a surface carrying its own copy of the array is how one of them
would keep counting a finished run as live." `src/shared/workflow.ts` has no `node:` imports (its
imports are `./llm.ts`, `./inspector.ts`, `./model-choice.ts`, `./model.ts`, `./allowlist.ts`,
`./builtin-workflow.ts`) and is already imported by six web modules under the `@shared/` alias,
including `src/web/lib/held.ts` and `BacklogColumn.tsx` - both neighbours of the files this phase
edits. **Use it; do not write a local terminal-status list.**

### The server still guards, and the dialog already handles it

Completion does not retire the binding, and the server refuses a *second* binding while the first is
`state = 'active'` - `manager.ts:903-911` returns `reason: "conflict"`, "This conversation already has
an active workflow binding". That is not a blocker: `workflowBindingSelection`
(`WorkflowBindingDialog.tsx:25-51`) returns the active binding as `existing` when the version matches,
so the dialog opens offering a resubmit ("Submit bound version") rather than erroring, and a
*different* version is reported as a `conflict` with explanatory copy at `:385-388`. So the chip
reappearing leads somewhere sensible in both cases, with no server change.

## Implementation steps

1. **`src/web/components/SessionCard.tsx`**
   - Import `workflowRunIsOpen` from `@shared/workflow.ts`.
   - Change the gate at `271` to render the chip when there is no run **or** the run is terminal:
     `(!workflowRun || !workflowRunIsOpen(workflowRun.status)) && onBindWorkflow`.
   - Leave the `event.stopPropagation()` in the click handler; the card is itself clickable.

2. **`src/web/components/layouts/ConsoleDetail.tsx`**
   - Same import and the same gate change at `286`.

3. Consider extracting the condition into a tiny named helper beside `sessionIsHeld` in
   `src/web/lib/held.ts` (for example `sessionCanBind(run)`) so the two call sites cannot drift. This
   is a judgement call for the implementing agent: two call sites is the threshold where the repo's
   own convention (`held.ts` exists for exactly this reason) starts to favour a helper.

## Data, API and migration

None. No route, schema, or wire-contract change. `src/server` is untouched.

## Tests and verification

- **`test/`**: add a `renderToStaticMarkup` case per surface asserting the `＋ workflow` chip is
  **absent** while a run is open (`running`, `waiting_for_session`, `blocked`) and **present** once it
  is terminal (`completed`, `cancelled`, `failed`), alongside the outcome chip. Find the existing
  render tests for these components and extend them rather than adding a new file if one already
  covers the header.
- Add a regression case asserting the held tag and the outcome chip are unchanged for a terminal run,
  pinning that this phase did not touch `workflowRunBySession` semantics.
- **New `e2e/specs/workflow-bind-chip-returns.spec.ts`**: seed a **completed** run and assert the
  `＋ workflow` control is reachable again on the session's card, and that activating it opens the bind
  dialog. Use the completed-run recipe from `e2e/specs/workflow-ladder-members.spec.ts:73-133`
  (`seedApprovedRun`), which returns the **sessionId** - exactly what a per-session chip assertion
  needs, unlike the run-id-returning variants.
  **Do not use the `session_disappeared` route** from `workflow-blocked-resubmit.spec.ts`: it reaches
  `blocked` by killing the bound session, so the session is gone from the fleet and there is no card
  left to inspect.
  `e2e/specs/board-held-by-workflow.spec.ts:359-389` is the nearest precedent for "a terminal run
  released this session" assertions and shows the cancel-to-terminal shortcut if a cheaper terminal
  state is wanted.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- A session whose newest run is terminal offers `＋ workflow` on both the card and the console detail
  header, beside the run's outcome chip.
- A session with an open run still hides it.
- `workflowRunBySession` in `App.tsx` is unmodified, and the Approved chip, the tile ladder, the
  Workflows tab, the held tag and backlog drop acceptance all behave as before.
- No local copy of the terminal-status list was introduced; `workflowRunIsOpen` is used.
- All five verification commands pass.
- README: if it documents the bind chip's visibility, correct it here.

## Downstream handoff

Nothing depends on this phase. It is a leaf.

What a future change must preserve: the bind-chip gate reads openness through `workflowRunIsOpen`, and
`workflowRunBySession` intentionally retains terminal runs for the display surfaces. Those two facts
are a pair - changing either without the other reintroduces this bug or deletes the outcome chip.

## Cross-phase audit record

- **Reconciled against Phases 1, 2 and 3.** No shared files. This phase edits `SessionCard.tsx`,
  `ConsoleDetail.tsx` and possibly `src/web/lib/held.ts`; Phases 1-3 edit `run-actions.ts`,
  `run-model.ts`, `WorkflowRuns.tsx` and `styles.css`. Therefore no merge ordering constraint.
- **Correction applied to Phase 2's audit record.** Phase 2 originally flagged `styles.css` as a file
  shared with this phase. That is wrong: this phase adds no CSS, because `.workflow-bind-chip` already
  exists and is already styled. Phase 2's record has been corrected, and `styles.css` is now owned by
  Phases 1 and 2 only, which are sequential and so cannot conflict.
- **Scope guard recorded.** The tempting fix - narrowing `workflowRunBySession` - is documented as an
  explicit non-goal with the four surfaces it would break, so a later agent does not "simplify" this
  phase into a regression.
