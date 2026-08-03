# Phase 2 - Grouping by reason, and the strip's split count

Source plan: [`plan.md`](plan.md) · index: [`phased-plan.md`](phased-plan.md) · mockups:
[`../../mockups/line-review-drawer/index.html`](../../mockups/line-review-drawer/index.html)
(the section headed **Option B**)

## Outcome

Thirty-one rows that all say the same sentence become **one bar** that says it once, with one
control:

```
▸  30 runs · session gone        Their sessions were removed, so the reviewers were      [Dismiss all]
   No-Mistakes Review v8            cancelled mid-flight…  Fix Busy State… · +27
```

And the strip stops claiming thirty-one decisions are waiting on you: `32 waiting on you`
becomes `1 needs you · 31 stalled`.

## Entry criteria and dependencies

**Direct phase dependency: Phase 1.** This phase consumes `blockedPhaseClause` and `runRemedy`
and must not redefine them. Branch from the default branch after Phase 1 has merged.

## Scope

1. A pure `groupReviewRuns()` fold, threshold **3**.
2. The group bar in the Review drawer, with one `Dismiss all`.
3. `foldReview` splits its amber half, and the drawer's header count splits with it.
4. Every doc comment, README paragraph and test that carries the old single-number wording.

### Non-goals

- **No new field on `WorkflowRunSummary`.** Phase 1 owns the whole wire contract. Grouping is a
  client-side fold over data the browser already has.
- **No change to `workflowRunWaitsOnOperator`.** It is shared with the command palette and the
  drawer's row-level amber. This phase changes *presentation*, not the predicate - see the risk
  below.
- **No generalization to `DecideDrawer` or `IntakeDrawer`.**

## Repository findings

Verified against the working tree.

### The bucket overlap - the one real correctness trap

`src/shared/workflow.ts:607`:

```ts
export function workflowRunWaitsOnOperator(
  run: Pick<WorkflowRunSummary, "status" | "actionWait">,
): boolean {
  return run.status === "blocked" || sessionActionWaitsOnOperator(run.actionWait);
}
```

Today's `waiting` count is the **union** of "blocked" and "parked on an operator action wait". A
single run can be both. If this phase reports `needs you` and `stalled` as two numbers, they must
be **mutually exclusive and sum to the old total**, or the strip will claim more attention than
the fleet owes. Decide the rule once, state it in the fold's doc comment, and pin it with a test
that constructs a run which is `blocked` *and* carries `actionWait: "needs_operator"`.

The recommended rule: **`stalled` = `status === "blocked"`; `needs you` = waits on the operator
but is not blocked.** A blocked run cannot act on an action wait anyway - `orphanBinding` cancels
its attempts - so "stalled" is the truer word for the overlap.

### The fold and its constraints

- `src/server/line-summary.ts:242` `foldReview`, and the `sentence(...)` helper at `:51` which
  joins parts with exactly `" · "` and drops empty parts.
- The separator matters: `LineStrip.stageLabel` does `fold.sentence.replaceAll(" · ", ", ")` to
  build the accessible name, and `test/line-strip-render.test.ts:59` asserts no `·` survives into
  any `aria-label`. Any new part must be joined by `sentence()`, not concatenated by hand.
- `LineTone` is `"neutral" | "working" | "idle" | "attention"` (`src/shared/line.ts:38`). There is
  no red tone on the strip, so the tone rule stays "amber when either number is non-zero",
  which is equivalent to today's and keeps `test/line-strip-render.test.ts:79-85`'s wire array
  green.
- The sentence is quantised on purpose: `lineSummaryEqual` compares the string, so a sentence that
  changes every tick emits an SSE frame every tick.
- `.ls-sub` is one line, `nowrap`, ellipsized (`styles.css:14357`). A longer sentence clips rather
  than wraps, but `test/line-strip-electron.test.ts` pins the strip's height budget - keep the
  wording tight.
- The e2e strip selectors match `^Review,`, which `stageLabel` builds from the label, count and
  noun, entirely upstream of the sentence. **Sentence changes are safe for those selectors.**

### The drawer must move with the strip

`foldReview`'s doc comment legislates it: *"A strip that says '1 waiting on you' over a drawer
that marks none is the surface arguing with itself, so both read the one shared predicate."*
`ReviewDrawer.tsx:118` computes the same `waiting` and `:126` renders it as the header's
`attention` string. Split both, in this phase, together.

## Implementation steps

### 1. The fold

- New `src/web/lib/line-review-groups.ts` - pure, no React, no fetch.
  - `groupReviewRuns(runs): ReviewRow[]` where a row is either a single run or a group of blocked
    runs sharing a `phase`.
  - **Threshold 3** (the submitted decision): fewer than three sharing a phase renders as ordinary
    rows. Name the constant and comment why - a pair is not a pile, and folding it costs the
    reader the per-row chips while saving one line.
  - Keep the existing triage ordering intent: rows a person can act on first, then by recency.
    Decide where a group sorts and say why in a comment. The existing rule is
    `ReviewDrawer.tsx:29` `triageOrder`.
  - Groups carry the clause from Phase 1's `blockedPhaseClause`, the member count, and enough
    member titles for the bar's secondary line - resolved through Phase 1's three-step name
    resolution, so a group never lists GUIDs either.

### 2. The drawer

- `src/web/components/line/ReviewDrawer.tsx` - render a group bar for a group row and the
  existing row otherwise. One `Dismiss all` per group, which is Phase 1's cancel remedy applied
  to the set; do not introduce a second cancel path.
- **`Dismiss all` confirms with the count echoed** before firing. Cancelling thirty runs from a
  surface one keystroke away is the risk this control carries; `DELETE /api/ensembles/:id` sets
  the local precedent by demanding a `confirmId` echo.
- Decide and document what happens if some cancels fail - a partial failure must not leave the
  bar claiming success.
- Split the header count to match the strip.

### 3. The strip

- `src/server/line-summary.ts` `foldReview` - split the amber half into the two mutually
  exclusive numbers, joined with `sentence()`. Update the fold's doc comment, which currently
  describes the single number.
- Update the stale doc comments the split invalidates: `src/shared/workflow.ts:~597` (the
  predicate's comment names the strip's "N waiting on you") and
  `src/web/components/line/ReviewDrawer.tsx:~25`.

### 4. Styles and docs

- `src/web/styles.css` - the group bar. It is a sibling of `.line-run-row`, at the same rhythm,
  and must not break the drawer's three-row cap arithmetic (`--line-drawer-row-h`,
  `styles.css:14520`) - if a bar is a different height, the cap's
  `calc(var(--line-drawer-row-h) * 3)` no longer lands on a row boundary. Either match the row
  height or restate the cap deliberately.
- `README.md` - the Line section at ~4262 ("A stage turns **amber when it is waiting on you**")
  and the Review row of the stage table at ~4269, which spells out the current single number.
  Document the grouping and the threshold.

## Tests and verification

### Known to break - fix, do not work around

| File | Line | What breaks |
| --- | --- | --- |
| `test/line-summary-fold.test.ts` | ~374 | `assert.match(humanWait.sentence, /1 waiting on you/)` - the fixture is `waiting_for_action` + `needs_operator`, i.e. the *needs you* half |
| `test/line-summary-fold.test.ts` | ~367 | `assert.doesNotMatch(machineWait.sentence, /waiting on you/)` - passes trivially afterwards; retarget it at the new words or it stops proving anything |
| `test/line-drawer.test.ts` | ~215 | `assert.match(html, /1 waiting on you/)` on the drawer header |
| `test/line-strip-electron.test.ts` | ~68 | the Review fixture string `"… ×4 · 1 waiting on you"` - a fixture, not an assertion, but it is the canonical amber example and should move with the change |

`test/line-summary-fold.test.ts:~382` (`a blocked run needs a person even with no action wait`)
asserts tone only and survives - it is the natural place to add the `1 stalled` assertion.

### Added

- `test/line-review-groups.test.ts` **new** - the fold as a pure table: grouping by phase, the
  threshold-of-3 boundary at 2 and 3, ordering, non-blocked runs never grouped, and a group's
  member titles resolved through the three-step name rule.
- `test/line-summary-fold.test.ts` - the split sentence, and **the overlap case**: one run that is
  `blocked` with `actionWait: "needs_operator"` must be counted once.
- `test/line-drawer.test.ts` - the group bar renders at 3 and not at 2; `Dismiss all` is present
  on a group and confirms; the header's split count.

### e2e - required

`e2e/specs/line-drawers.spec.ts`. A second blocked phase is cheap: bind with
`maxRepairRounds: 1` and let the `E2E_FAIL_VERDICT` persona fail, which blocks at `round_limit` -
so a spec can prove that two different reasons produce two different groups rather than one.
Seeding three same-phase blocked runs costs three dispatch/kill cycles and the hardcoded 8s
`EXIT_LINGER_MS` each; if that exceeds the 60s per-spec budget, prove the threshold in
`test/line-review-groups.test.ts` and assert the bar's rendered consequence in the browser with
whatever count the budget allows. Say which you did and why in the pull request.

Select by role and accessible name; never add a `data-testid`.

### Commands

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## Merge and exit criteria

- All commands pass.
- Three or more blocked runs sharing a reason render as one bar; two render as two rows.
- The strip and the drawer agree on the split wording - no surface says "waiting on you" while
  the other says "stalled".
- `needs you` and `stalled` never double-count a run that is both blocked and action-waiting,
  proven by a test.
- `Dismiss all` confirms with the count before cancelling.
- README matches the implementation.

## Downstream handoff

This is the last phase of the plan. It leaves behind, for anything later:

- `groupReviewRuns()` in `src/web/lib/line-review-groups.ts` - written against workflow runs
  only. A future Decide/Intake grouping should generalize it deliberately rather than copy it.
- The `needs you` / `stalled` vocabulary, now used by both the strip fold and the drawer header.
  A third surface adopting it should read the same fold rather than recompute.

## Implementation record - what the repository changed

Written after the phase shipped. The plan above is the proposal; this is what the code said
back.

1. **The split lives in `src/shared/workflow.ts`, not in two places.** This phase's steps put
   the count in `foldReview` and the header in `ReviewDrawer`, each computing it. That makes
   "the strip and the drawer must agree" a thing two tests assert rather than a thing the code
   guarantees, and the fold's doc comment is explicit that they must never disagree. So
   `workflowRunAttentionSplit` (the two mutually exclusive counts) and
   `workflowRunAttentionParts` (the two phrases) are exported beside
   `workflowRunWaitsOnOperator`, and both surfaces read them.
   `workflowRunWaitsOnOperator` itself is byte-for-byte unchanged, so the command palette's
   "waiting on you" list keeps its meaning; only its doc comment gained a paragraph naming the
   split as presentation.
2. **The split is a SUBTRACTION, not two filters.** `stalled = status === "blocked"`,
   `needsYou = waiting - stalled` where `waiting` is the old single total. The recommended
   rule in the plan is the same rule, but computing `needsYou` as its own filter would let the
   two halves drift out of summing to the total the moment either arm of the predicate grew.
   The overlap case - blocked *and* `actionWait: "needs_operator"` - is pinned in
   `test/line-summary-fold.test.ts`, as this phase asked.
3. **`triageOrder` moved out of `ReviewDrawer.tsx` into `line-review-groups.ts`.** A group's
   POSITION is part of the fold - a bar stands where its newest member stood - so the ordering
   rule and the fold had to be one function or two functions that agree. It is exported and
   still used unchanged for the drawer's live count.
4. **The bar is exactly one row high, and the mockup's explanatory paragraph is not on it.**
   `Option B` draws two lines of prose under the bar's title. The drawer's cap is
   `calc(var(--line-drawer-row-h) * 3)`, so a bar of any other height stops the cap landing on
   a row boundary and leaves half a row peeking over the edge. The paragraph also says what
   the clause beside it already says. What the bar carries is the mockup's other three facts:
   the count, the clause, and the member titles with a `+N`.
5. **The caret is implemented, and it is not decoration.** The drawer's standing promise, in
   the README and in `LineDrawer`'s own doc comment, is that the cap is on the panel and never
   on the list - "every row is still in the panel". A fold that hid thirty rows with no way
   back would break it. Members expand in place as ordinary rows in the SAME flat `<ul>`
   (a nested list would not be `.line-drawer-rows > li`, which is the selector the row height
   and therefore the cap arithmetic come from), indented 46px so their titles land exactly
   under the bar's. The e2e spec measures that alignment in a laid-out browser.
6. **Only `dismiss` batches.** A pile of `infrastructure_error` runs still folds into a bar -
   saying the reason once is the point - but carries no `Retry all`: a batch button there is a
   way to fire thirty provider calls by accident, and `Restart…` demands a typed phrase each
   time, which batching would launder into one. A bar over runs with no argument-free remedy
   at all renders with no control, which is honest.
7. **A partial batch failure reports a count.** There is no batch route and inventing one
   would put a second cancel path in the daemon, so `Dismiss all` is N independent POSTs of
   each member's OWN `runRemedy` descriptor. The drawer's one alert reads `2 of 30 runs could
   not be dismissed. <first message>`; cancelled runs leave over SSE, refused ones stay, and
   the bar recounts from what is still there. A single-run remedy still reports the bare
   message, which is what the existing e2e assertion reads.
8. **The e2e seeds three same-phase runs sequentially, and proves one phase rather than two.**
   Two constraints, both found by running it. `e2e/fixtures/fake-claude.mjs` reports one FIXED
   conversation id per daemon, and `createBinding` allows one active binding per note key - so
   two live bindings at once is a 409 and each session must be orphaned (which releases its
   binding) before the next is bound. That is one `EXIT_LINGER_MS` window each. The spec
   therefore builds the pile one run at a time and asserts the threshold from BOTH sides in
   the browser for free: two blocked runs are two rows, and the third turns them into one bar.
   The second blocked phase this phase suggested (`round_limit` via `maxRepairRounds: 1`) was
   dropped - it is not automatic, it needs a `resubmit` per round to reach the limit, and
   "two reasons are two bars" is a pure claim about the fold that `test/line-review-groups.test.ts`
   pins directly. The spec runs in 33s; the per-spec budget is the config's **120s**, not the
   60s this phase assumed.
9. **`waitForIdleSession` gained a `before` set.** It found "the first session that is not
   exited", which returns the PREVIOUS session while it is winding down - so the second seeded
   run bound to a conversation that already had a binding. Naming the new session explicitly
   removes the race for every caller in the file.
10. **Two doc comments and one README section, extended rather than restated**, as this phase
    predicted: `foldReview`'s (which described the single number),
    `workflowRunWaitsOnOperator`'s, and `ReviewDrawer`'s - each keeping Phase 1's wording and
    adding this phase's.

## Cross-phase audit record

- **Written after Phase 1.** Consumes `blockedPhaseClause` and `runRemedy` exactly as Phase 1
  exports them; no signature change was required, so Phase 1 needed no edit.
- **Ownership checked.** The group threshold (3) lives only here. The red blocked tone lives only
  in Phase 1, because a red row is correct before grouping exists. The `sessionName` wire field
  lives only in Phase 1, and this phase adds no server field.
- **One shared file, split by sentence not by section.** Both phases edit the README's Line
  section and both edit `ReviewDrawer.tsx`'s doc comment. Phase 1 owns *"the drawer now mutates,
  and here is the rule"*; this phase owns *"the count splits, and runs group by reason"*. Because
  the phases are sequential this is not a merge conflict, but the Phase 2 implementer should
  expect Phase 1's wording to already be there and extend it rather than restate it.
- **Overlap risk raised here, not in Phase 1.** Phase 1 does not report counts, so the
  blocked-and-action-waiting double-count cannot arise until this phase splits the number. The
  test that pins it therefore belongs here.
- **Predicate untouched.** `workflowRunWaitsOnOperator` keeps its meaning, so the command
  palette's "waiting on you" list and the drawer's row-level amber are unaffected by the
  presentation split.
