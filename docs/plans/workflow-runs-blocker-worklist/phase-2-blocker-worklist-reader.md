# Phase 2: The Blocker Worklist reader pane

## Outcome

The "Reviewer verdicts" section of the Workflow runs reader pane becomes a two-column blocker
worklist: the changes a run is asking for on the left, the selected one in full on the right,
passing reviewers behind a segmented control, and a stalemate card when reviewers have failed
consecutive rounds.

This is the phase a person sees.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 1.
- Requires `runChangeWorklist` and `ChangeWorklistRow` exported from `run-model.ts`, with rows
  pre-sorted and `state` partitioning `open` from `resolved` and `unconfirmed`. Also requires
  `runStalemates` for the windowed stalemate card.

## Scope

- Replace the `Reviewer verdicts` section in `WorkflowRunView`.
- Render a stalemate card from Phase 1's windowed `runStalemates`, so the fact finally reaches
  this page and describes the round being viewed.
- Styles for the new surface in `src/web/styles.css`.
- Update the existing e2e spec that asserts the old section, and add one for the worklist.

### Non-goals

- The stage pipeline, the run header, the round scrubber, the run rail and its filters. All
  unchanged.
- The `Captured intent and evidence` section, the deliveries, model-call and timeline
  sections, and the audit disclosure. All unchanged and still below the worklist.
- Any route change. Selection is local state.
- Any server, schema or wire change.
- New `data-testid` attributes. Prohibited by the repository's e2e contract.

## Repository findings

- The section to replace is `WorkflowRuns.tsx:972-1047`, which maps `reviewAttempts` through
  `CheckCard` (225-265), `VerdictCard` (374-424), or a bare-attempt fallback (1005-1019), then
  renders two `<details>` join-packet disclosures (1022-1046).
- `reviewAttempts` is built at `WorkflowRuns.tsx:563-592` from
  `reviewerAttempts(roundAttempts.filter(a => a.sessionAction === null), version?.graph)`.
  The worklist replaces the *verdict* rendering; **check outcomes still need `CheckCard`**, and
  the empty-state arms (`inspectorOnly`, `reviewerlessVersion`) still need their sentences.
  This is the part of the mockup that is under-specified: it drew only persona verdicts.
- `detail.repeatOffenders` reaches this component and is discarded. `WorkflowLadder.tsx:483-487`
  is the only renderer, using the sentence `{personaName} has failed {rounds} rounds running.`
  Reuse that wording so two surfaces do not describe one fact two ways.
- Existing per-node actions already exist and are wired: `POST .../set-persona-directive` and
  `.../remove-persona-directive` (`WorkflowRuns.tsx:930-934`), `POST .../set-nodes-disabled`
  (924-927). Both are **withheld once the run is terminal** - the worklist's per-change actions
  must respect the same rule.
- `copyFeedbackAction` (`run-actions.ts:73-90`) backs the header's Copy feedback and is
  disabled unless a delivery payload or verdict exists. "Copy this change" is a new, narrower
  action over a single `ChangeWorklistRow`.
- `PersonaDirectiveEditor.tsx` is the existing modal for "critical Persona feedback"; the
  worklist's "Give this reviewer feedback" opens it rather than inventing a second editor.
- The e2e fail fixture (`e2e/fixtures/fake-claude.mjs:259`) emits **one** requested change,
  titled `E2E requested change`, with **no `path`**. Any spec asserting a file line will fail.
- `e2e/specs/workflow-run-reviewer-verdicts.spec.ts` asserts the old section's behavior
  (structural nodes must not render as verdict cards). It reads cards by their chip. **It will
  break** and must be updated in this phase, not left for later.

## Implementation steps

### 1. Derive and partition, all at one round

In `WorkflowRunView`, call `runChangeWorklist(detail, viewed?.round ?? null)` once. Partition by
`state` into `blocking` and `archive`. Keep the existing `reviewAttempts` derivation for checks
and for the `Passed` segment.

**The round argument is the load-bearing part.** `reviewAttempts` is built from
`detail.attempts.filter(a => a.submissionId === viewed?.id)` (`WorkflowRuns.tsx:563`), so the
`Passed` segment already follows the round scrubber. Passing `viewed?.round` makes the worklist
follow it too. Without it, scrubbing to round 3 leaves `Blocking 3` and `Archive` describing
round 10 while `Passed 4` describes round 3, and the segmented control shows three counts from
three different moments.

The scrubber therefore keeps exactly the meaning it has today - *which round am I looking at* -
and now governs this section as well as the pipeline above it. That is what "unchanged" means
for the scrubber: unchanged behavior, not a control that some of the page ignores. A person who
scrubs back to round 3 sees what round 3 was asking for, with `roundsOpen` counted up to round 3
rather than up to today.

### 2. Selection state, over a discriminated union

`Blocking` holds two kinds of thing - open changes and failing checks - so the selection cannot
be a bare `ChangeWorklistRow.key`. Those two id spaces are unrelated (`ChangeWorklistRow.key` is
`nodeId + path + title`; a check is identified by `attempt.id`) and nothing stops them colliding
as raw strings. Model the item explicitly:

```ts
type WorklistItem =
  | { kind: "change"; key: string; row: ChangeWorklistRow }
  | { kind: "check"; key: string; attempt: WorkflowNodeAttempt; outcome: WorkflowCheckOutcome };
```

Namespace the keys when building the list - `` `change:${row.key}` `` and
`` `check:${attempt.id}` `` - so one `selectedKey` string can address either without ambiguity,
and build `blocking` as `WorklistItem[]` with the failing checks first. Every consumer below
branches on `kind` rather than sniffing the shape.

`const [selectedKey, setSelectedKey] = useState<string | null>(null)`, resolved to the first
`blocking` item when null, mirroring how `roundId` is held. Reset when `detail.run.id` changes.
If `selectedKey` no longer resolves - after a refresh, or after the reader scrubs to a round
where that change had not been raised yet - fall back to the first blocking row rather than
rendering an empty pane. Do not clear the selection on every scrub: a change present in both
rounds should stay selected as the reader moves between them.

### 3. The rail

- Segmented control: `Blocking {n}` / `Passed {n}` / `Archive {n}`. Implement as buttons with
  `aria-pressed`, not `data-testid`.
- **Blocking holds failing checks as well as open changes.** A check is not a
  `ChangeWorklistRow` and never will be, but a failed command is a blocker in exactly the sense
  this segment means - it is why the run stopped. Failing checks sort **above** the persona
  changes, because a red command gate usually explains the persona objections underneath it.
  `Blocking {n}` counts both.
- Blocking rows, persona changes: title, path when present, `{personaName} · round
  {firstRound}`.
- **Two reviewers can produce two near-identical rows, and that is correct.** The key includes
  the owning node, so if Code Risk and Test Evidence both ask for the same thing on the same
  file you get one row each. Do not dedupe them in the view: they carry different rationales and
  evidence, they resolve independently, and each one's actions target a different persona.
  The `{personaName}` on the row is what distinguishes them, so it is never optional.
- Blocking rows, failing checks: the existing `CheckCard`, unchanged, so the command, exit code,
  output tail and truncated-byte count survive the redesign intact.
- Archive rows, `state: "resolved"`: green rail, `Resolved in round {lastRound}`.
- Archive rows, `state: "unconfirmed"`: **amber rail, not green**, worded to claim neither
  outcome - `Last raised in round {lastRound}` with a second line reading *"{persona} has not
  passed since, so this was never confirmed fixed."*

  Both halves of that are load-bearing. Green would tell the operator a reviewer is satisfied
  while the stalemate card at the foot of the same rail says it has failed every round. But
  wording it as *rephrased* is the opposite error and just as wrong: a reviewer that stops
  raising this change **because it is fixed** while separately raising something unrelated lands
  in this same state, and telling that operator their fix was merely reworded is a false claim
  about their own work. The state means *not known*, so the row has to say not known.
- Passed segment: one line per passing reviewer, plus checks whose outcome is `passed`,
  `skipped` or `unavailable`. The latter two are **degraded passes**, not failures
  (`CHECK_OUTCOME_STATUSES` marks them `degraded: true`); they keep their amber chip in
  `Passed` and must not be silently drawn as green.
- Stalemate card at the foot when `runStalemates(detail, viewed?.round ?? null)` is non-empty,
  using the ladder's sentence so one fact is worded one way across both surfaces.

  **Render the windowed signal, not `detail.repeatOffenders`.** The payload field is computed
  over the run's whole submission list and anchored on its newest one, so it cannot be re-scoped
  by the viewed round. Rendered directly it would put "failed 10 rounds running" under segments
  describing round 4 - the reader's own future, on the rail this design keeps insisting must
  agree with itself. `detail.repeatOffenders` stays untouched for the ladder and the alert
  engine, which do want the latest-anchored answer.

The check routing is the one place this phase decides something Phase 1's model cannot express,
so state it once here as the rule: **`checkOutcomeOf(attempt)` is asked first, exactly as it is
today (`WorkflowRuns.tsx:991-992`), and its `status` picks the segment** - `failed` goes to
Blocking, everything else to Passed. Nothing about checks flows through `runChangeWorklist`.

### 4. The detail pane

Branch on the selected `WorklistItem`'s `kind` first. The two arms share only the previous/next
control; everything else differs, and the check arm is not a degraded version of the change arm.

**`kind: "check"`** - render the existing `CheckCard` for `attempt` and `outcome`, unchanged, so
the command, exit code, retained output tail and truncated-byte count are all preserved. None of
the per-change actions apply to a command gate: **withhold** Copy this change, Open file, Give
this reviewer feedback and Disable, rather than rendering them disabled. A check has no persona
to give feedback to, and a disabled-looking button that could never become enabled is a worse
answer than no button.

**`kind: "change"`** - the reviewer's verdict summary, a `chip` for its state, confidence, runner
and model from `verdictMeta`. Facts row: file (or "No file cited"), first raised, rounds open,
evidence count. The rationale in full. Evidence quotes. Then the action row:

- **Copy this change** - title, path, rationale to the clipboard.
- **Open file** - only when `path` is present.
- **Give this reviewer feedback** - opens `PersonaDirectiveEditor` for that `row.nodeId`.
- **Disable {personaName}** - the existing `set-nodes-disabled` call for that `row.nodeId`.

Withhold the two mutating actions when the run is terminal, matching the existing per-node
menus.

Previous / Next walk the current segment across both kinds, so the reader can page from a failed
check straight into the persona objections underneath it without changing segment.

### 5. Empty and degenerate states

Every arm the old section had must survive:

- No reviewers activated yet, reviewerless workflow: keep the existing sentences.
- **Inspector-only round.** The existing sentence, "This Inspector repair round ran no
  Personas", is round-scoped and stays true of the `Passed` segment - no Persona attempted this
  round. It is **not** true of `Blocking`, which legitimately carries the changes still open as
  of this round, inherited from the last `full_workflow` round exactly as `inheritedPasses`
  already models for the strip. So scope the sentence to `Passed` rather than letting it
  describe the whole section, and let `Blocking` show the carried changes. A reader scrubbed to
  an Inspector round should still see what the run is waiting on; that is the one thing an
  Inspector round is about.
- Reviewers ran and all passed: the rail opens on `Passed` with `Blocking 0`, and the detail
  pane says the run has nothing outstanding rather than rendering blank.
- A run with checks but no personas still shows its checks - passing ones under `Passed`,
  failing ones under `Blocking`.
- A run blocked **only** by a failed check, with every persona passing, still opens on
  `Blocking` with that check selected. This is the case the original draft of this phase
  dropped entirely.
- A change whose persona stops raising it while raising something unrelated lands in
  `unconfirmed`, and its row must not claim the finding was rephrased. See step 3 for the
  wording; this is the degenerate case that wording exists for.

### 6. Styles

Add the worklist styles to `src/web/styles.css` beside the existing `.wf-run-*` block, reusing
the existing tokens and chip classes. Two independent scroll regions (rail and detail) sit
under an already-tall pipeline; give the split a bounded height so the page does not grow a
third scrollbar.

### 7. Tests

- **Update** `e2e/specs/workflow-run-reviewer-verdicts.spec.ts`. Its requirement survives the
  redesign - structural nodes must still not appear as things a reviewer said - so re-point it
  at the worklist rather than deleting it.
- **Add** `e2e/specs/workflow-run-blocker-worklist.spec.ts`: drive a real dispatch with a
  Persona carrying `E2E_FAIL_VERDICT`, open the run, and assert the change appears in the
  Blocking segment, that selecting it shows its rationale, and that the Passed segment holds
  the passing reviewer. Assert by role and accessible name only. Do not assert a file path -
  the fixture emits none.
- **Cover the scrub.** Drive a run to at least two rounds, then scrub back and assert the three
  segment counts move together - specifically that a change first raised in the later round is
  absent from `Blocking` when viewing the earlier one. This is the regression that the whole
  `asOfRound` parameter exists to prevent, and it is invisible to a single-round spec.
  `e2e/specs/workflow-round-limit-grant.spec.ts` already drives a multi-round run; borrow its
  setup rather than building one.
- **Cover a failing check.** Either extend that spec or add a sibling: a workflow whose command
  gate exits non-zero must show that check under `Blocking` with its exit code, not vanish from
  the pane. `e2e/specs/workflow-skipped-status.spec.ts` is the closest precedent for *driving* a
  non-passing check - it publishes a workflow whose command does not exist. Borrow how it
  configures the check, noting it produces `skipped`, not `failed`; a `failed` outcome needs a
  command that runs and exits non-zero.

  **Do not re-point that spec.** It asserts against `.wf-pipeline-strip`, the stage diagram,
  which this phase does not touch, so it neither breaks nor covers the new segment. Verified by
  reading its locators.
- **Add** a `renderToStaticMarkup` case in `test/` pinning the stalemate sentence, mirroring
  `test/workflow-ladder-repeat.test.ts`.

## Data, API and migration

None.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright install chromium   # once per machine
npm run test:e2e
```

`npm run test:e2e` is mandatory here: this is a UI change, and the repository's contract
requires a Playwright spec for every UI change with no exemptions.

## Merge and exit criteria

- The worklist renders for a run with open changes, and selecting a row shows its detail.
- **A failed check renders under `Blocking` with its exit code and output tail**, and a run
  blocked only by a failed check does not present as having nothing outstanding. Skipped and
  unavailable checks render under `Passed` keeping their degraded chip.
- **Everything in the rail describes the round the scrubber points at, the stalemate card
  included.** Scrubbing to an earlier round moves `Blocking`, `Archive`, `Passed` and the card
  together, and `roundsOpen` is counted up to that round rather than to today. Nothing in this
  section states a fact from a round later than the one being viewed.
- **No Archive row claims a reviewer is satisfied while the stalemate card says otherwise.** A
  `"unconfirmed"` row claims neither outcome - not resolved, and not rephrased either - and does
  not take the green rail. Verify
  by eye on a run that has both an unconfirmed row and a `repeatOffenders` entry for the same
  persona; this is a two-elements-agreeing assertion that markup shape alone cannot make.
- A change carried from an earlier round says which round raised it and how many rounds it has
  been open; a resolved one says which round resolved it.
- The stalemate card renders, using the same sentence as the ladder, from the windowed
  `runStalemates` rather than the latest-anchored `detail.repeatOffenders`.
- Every empty and degenerate arm from the old section still renders its sentence.
- The pipeline, header, round scrubber and run rail are unchanged in behavior.
- The updated and new e2e specs pass; the full unit suite, typecheck, lint, build and smoke
  are green.

## Downstream handoff

There are no later phases. Future work that touches this surface should know:

- Selection is local state by design. Routing it means touching `parseMissionRoute`,
  `missionRouteHash` and the `onFilters` handler in `App.tsx:2408-2412`, which drops any route
  field it does not spread.
- The worklist and the stalemate card must keep agreeing about what a round is. Both descend
  from the round-folding rule in `repeat-offender.ts`.

## Cross-phase audit record

- **Reconciled against Phase 1.** Phase 1 promises pre-sorted rows and a `state` that
  partitions the segments; this phase does no sorting and no re-filtering, so the contract
  holds in both directions.
- **Discrepancy found and resolved.** Phase 1's handoff described the rows as sufficient for
  the section, but the section it replaces also renders **check outcomes** and three empty-state
  sentences that carry no requested changes at all. `runChangeWorklist` was not widened to
  cover checks - that would have made it a view model rather than a change model. Instead this
  phase keeps the existing `reviewerAttempts` / `checkOutcomeOf` path for the `Passed` segment
  and uses the worklist only for the `Blocking` and `Archive` segments. Phase 1's scope is
  unchanged; its handoff section is the record of the boundary.
- **Checked the e2e fixture against the mockup.** The mockup drew a path on every row; the
  fixture emits none and the type makes it optional. Both phases record the pathless case, and
  Phase 1's test list pins it so this phase inherits a derivation that cannot crash on it.
- **Confirmed no concurrency.** Phase 2 depends on Phase 1 and there is no third phase, so
  there is nothing to run in parallel and no merge-order ambiguity.
- **Inspector round 6, `minor`, accepted.** Step 4 described the detail pane purely as a
  `ChangeWorklistRow`, while step 3 had already put failing checks into the same `Blocking` list
  and step 2 held the selection as a bare key - with no rule for telling the two id spaces apart
  (`ChangeWorklistRow.key` versus `attempt.id`, never reconciled). Step 2 now defines a
  `WorklistItem` discriminated union with namespaced keys, and step 4 branches on `kind` up
  front instead of leaving the check case to a retroactive sentence in step 5. That sentence is
  gone; step 5 keeps only the degenerate cases.
- **Inspector round 6, `major`, accepted, resolved in Phase 1.** The third state asserted the
  finding had been *rephrased*, which is unknowable and sometimes false - a reviewer that stops
  raising a change because it is fixed, while raising something unrelated, landed in the same
  state. The row would have told that operator their fix was merely reworded. Phase 1 renamed the
  state `unconfirmed`; this phase's wording changed with it, from "Rephrased after round N" to
  "Last raised in round N" plus "{persona} has not passed since, so this was never confirmed
  fixed". The amber rail stays: the claim being avoided is satisfaction, in both directions.
- **Inspector round 5, `major`, accepted.** This phase rendered the stalemate card straight from
  `detail.repeatOffenders` while claiming in its own exit criteria that the rail describes the
  viewed round. That field is latest-anchored and cannot be re-scoped, so scrubbing back would
  have left the card six rounds ahead of the segments above it. Now renders Phase 1's
  `runStalemates(detail, viewed?.round ?? null)`. The exit criterion was widened from "all three
  segment counts" to everything in the rail, which is what it should have said.
- **Inspector round 4, `minor`, accepted, derived in Phase 1.** A reworded finding marked its old
  key resolved, so Archive could read "Resolved in round 5" for the same persona the stalemate
  card at the foot of the rail calls a repeat offender. Phase 1 now emits a third `state`,
  `"unconfirmed"`. This phase owns the wording and the colour: unconfirmed rows take an amber rail
  and read as rephrased, because green would be the element making the false claim. Added to the
  exit criteria. **Superseded by round 6**, which found that "rephrased" was itself a false claim
  in the other direction; the amber rail survived, the wording did not.
- **Inspector round 3, `major`, accepted, resolved in Phase 1.** The change key carried no
  author, so two personas raising identically-normalizing titles on one file would have merged
  into a single row with one `nodeId` - and this phase wires "Disable {persona}" and the
  directive editor straight off that node, so one reviewer's objection would have become
  un-actionable and its evidence invisible. Fixed in Phase 1 by putting `nodeId` in the key.
  This phase gained one rule as a consequence: near-identical rows from different reviewers must
  **not** be deduped in the view, since they resolve independently and their actions target
  different personas.
- **Inspector round 2, `major`, accepted.** Step 1 called a whole-run `runChangeWorklist(detail)`
  while keeping the round-scoped `reviewAttempts` for `Passed`, so the segmented control would
  have shown three counts from two different moments as soon as anyone touched the scrubber. The
  worklist is now windowed by the viewed round through Phase 1's new `asOfRound` parameter, which
  is the earliest place that can own it - re-windowing rows here would have split one rule across
  two phases. The Inspector-only empty state was scoped to `Passed` in the same pass: it was
  written for a round-scoped section and is false of a `Blocking` segment that legitimately
  carries changes forward. A new e2e case pins the scrub.
- **Inspector round 1, `major`, accepted.** Step 3 originally routed checks to `Passed` only,
  which left a *failing* check with no segment at all: it is not a `ChangeWorklistRow` so it
  cannot enter Blocking, and it is not passing so the wording excluded it from Passed. Today
  every check renders regardless of outcome, so as drafted the redesign would have dropped a
  failed command gate's exit code and output tail from the page. Failing checks now sort into
  Blocking above the persona changes, with the segment rule stated explicitly, two new
  degenerate cases, an exit criterion and e2e coverage. Re-checked against Phase 1: this is
  resolved entirely inside Phase 2 by keeping the existing `checkOutcomeOf` path, so Phase 1's
  scope and signatures are unchanged and the change model stays a change model.
