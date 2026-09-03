# Phase 1 - Unified pipeline feature reader

## Outcome and value

The Pipelines tab draws ONE reader for a feature, whichever side of the specification handoff it
is on. A commission-selected feature gains the run's step ladder, gate verdicts and control verbs
that today only a directly addressed run can reach. A run-selected feature gains the Engineer
attempts and specification handoff that today only a commission can reach. The pane stops
changing shape mid-feature, and a commission whose implementation run exists stops being a dead
end.

The operator-visible change is that one selection now answers every question about a feature.

## Entry criteria and direct phase dependencies

- This planning session's pull request is merged, which publishes the plan paths this phase
  names.
- No other phase. This is a single-phase plan.
- Repository scope: mission-control only. No `repository` or `additionalRepositories` override.

## Scope

- Add one reader component that composes the commission regions and the run regions.
- Resolve `activeRun` AND `activeCommission`, and route every derived value through them.
- Suppress `PipelineRunView`'s own header when a commission header sits above it.
- Collapse the two commission regions by default once a run exists.
- Add a rail affordance from a commission to its observed linked run.
- Disambiguate the two "attempts" headings that now appear in one pane.
- Playwright coverage for the composed reader and the newly reachable verbs.

## Non-goals

- **Do not change any progress derivation.** `pipelineRunForCommission`, `pipelinePhaseMeter`,
  `pipelineStrip`, `pipelineSequentialSteps` and `PipelinePhaseMeter` are untouched. Operator
  decision 1 assigns the phase meter's semantics to `pipeline-attempt-recovery` Phase 3.
- Do not edit `SessionTile.tsx`, `BoardView.tsx` or `ConsoleDetail.tsx`. The board card and
  console meters are correct already and must stay byte-identical in behavior.
- Do not change `test/pipeline-runs-view.test.ts:143` (`step 2 of 3`) or anything in
  `test/pipeline-phase-meter.test.ts`. Those pin the derivation Phase 3 owns.
- Do not add a second selection state, a new route shape, or a new wire field.
- Do not change the rail's grouping or the daemon chip.

## Repository findings and inherited contracts

- `src/web/pipelines/PipelineRuns.tsx:239` holds the either/or:
  `commission ? <commission pane> : run ? <PipelineRunView> : <empty>`. The two arms are
  mutually exclusive, which is the whole defect.
- `PipelineRuns.tsx:70-115` computes `run` from the address bar only, then derives `daemon`,
  `runVerbs`, `runActions`, `runConsoles` and `usePipelineRunDetail` from it. A selected
  commission never sets `run`, so all five are empty. This is the mechanical cause of the
  missing ladder and verbs, not a styling gap.
- `commissionRun` already exists at `PipelineRuns.tsx:76`, resolved from `commission.linkedRun`
  against the `runs` array via `pipelineRunKeyOf`. Reuse it; do not add a second lookup.
- **The blindness is symmetric, and this is the easiest thing in this phase to get half right.**
  `commission` (`PipelineRuns.tsx:73`) is null whenever a run is addressed: `openPipelineRun`
  clears `selectedCommissionId`, so the first arm misses, and the second arm requires
  `selected === null`, so it misses too. Resolving only `activeRun` therefore fixes the
  commission-selected direction and leaves the run-selected direction exactly as broken as it
  is today. Both identities must be resolved.
- Reverse resolution is unambiguous rather than best-effort. The `idx_pipeline_commissions_run`
  unique index (`src/server/db.ts:2914`) covers `(provider, repo_root, run_slug)` where the slug
  is non-null, so a run has at most one commission. `pipelineCommissionForSession`
  (`src/web/components/layouts/types.ts:272`) already performs this lookup by run key; follow it
  rather than inventing a second matching rule.
- `PipelineRunView` takes `actions` as a `ReactNode` slot
  (`src/web/pipelines/PipelineRunView.tsx:220`), so verbs are injected rather than mounted. It
  owns `<header className="pipelines-run-head">` at `:232`, carrying eyebrow, title and facts
  chips. That header is the only part that duplicates a commission header above it.
- `src/web/pipelines/PipelineLadder.tsx:158` records the repository's disclosure idiom: a native
  `<details>` rather than a button plus state, with the reasoning in-file. Reuse it for decision
  3 rather than introducing a second collapse mechanism.
- `openPipelineRun` (`src/web/App.tsx:1409`) already calls
  `setPipelineCommissionSelection(null)` then navigates, so run selection needs no new state.
  Only commission-to-run needs an affordance.
- **Heading collision.** `PipelineRunView` renders a heading `Attempts` (the run's kickback
  attempts, pinned at `e2e/specs/runs-pipelines-tab.spec.ts:311`) while the commission pane
  renders `Engineer attempts` (`PipelineRuns.tsx:249`). Composed into one pane both appear, two
  headings differing by one word describing different things. Disambiguate: keep
  `Engineer attempts` and rename the run's to `Kickback attempts`, updating the existing spec
  assertion. Record the rename in the pull request.
- CSS already present and reusable: `.pipelines-reader` (`src/web/styles.css:14093`),
  `.pipelines-section` (`:14435`), `.pipelines-attempts` (`:14434`),
  `.pipelines-run-head` (`:14222`).
- The board card needs no edit. `BoardView.tsx:225` already resolves `pipelineRun` to
  `commission.linkedRun` when a commission exists, falls back to the session's own correlation,
  and passes `pipelineCommission` alongside; `SessionTile.tsx:284` gates on
  `shown("pipelinePhases") && ((session.pipeline && pipelineRun) || pipelineCommission)`.

## Implementation steps

### 1. Add `src/web/pipelines/PipelineFeatureReader.tsx`

One component, six regions, rendered in fixed order, each gated on having evidence:

1. Header. Identity from `activeRun` when one exists - slug, group chip, tier - and from
   `activeCommission` otherwise. This direction is deliberate: it keeps a run-addressed heading
   reading the run's own slug instead of switching to a commission's `planSlug`, which the
   existing specs assert (`e2e/specs/runs-pipelines-tab.spec.ts:289`).
2. `PipelinePhaseMeter` with `activeRun` and `activeCommission`. Unchanged component.
3. Engineer attempts. When `activeCommission` exists.
4. Specification handoff. When `activeCommission.handoff` exists. The implementation-run line
   becomes a button that calls the run-selection callback rather than printing the slug as text.
5. `PipelineRunView` with `activeRun`, the fetched detail, the actions slot, and its own header
   suppressed. When `activeRun` is non-null.
6. Blockers and errors from both sources, deduplicated so one stop is stated once.

Move the commission pane markup out of `PipelineRuns.tsx:240-280` into regions 1, 3, 4 and 6
rather than rewriting it. Props: `activeCommission`, `activeRun`, `detail`, `actions`,
`onSelectRun`.

Regions 3 and 4 wrap in `<details>` with `open` set from the absence of `activeRun`, per
decision 3: expanded while authoring is the live work, collapsed once implementation is, and
always reachable.

### 2. Resolve both identities in `PipelineRuns.tsx`

```ts
const activeRun = run ?? commissionRun;
const activeCommission = commission ?? commissionForRun(commissions, activeRun);
```

`commissionForRun` matches `commission.linkedRun` against a run by `pipelineRunKeyOf` and
returns null for a null run. Put it in `pipeline-run-model.ts`'s sibling position only if it
needs a test of its own; a local helper in this component is acceptable, but it must not
duplicate a matching rule that `types.ts:272` already states differently.

Then reroute, keeping the existing comments' reasoning intact:

- `usePipelineRunDetail` receives `activeRun`'s provider, repo root, slug and updated-at, with
  the same null fallbacks the current call uses for a missing run.
- `daemon` looked up from `activeRun`'s repository rather than `run`'s.
- `runVerbs`, `runActions`, `runConsoles` all keyed off `activeRun`.
- Every commission region reads `activeCommission`, never the raw `commission`.

Selection precedence is unchanged: an addressed run still wins over a commission's linked run, so
a deep link keeps naming exactly one thing. Resolving a commission from a run adds a region to
the pane; it never changes which feature is addressed.

The phase meter stays out of scope and stays correct: `pipelineRunForCommission` returns
`linkedRun` whenever a commission is linked, so handing it a resolved commission beside its own
run yields the same run it yields today. No progress derivation is edited or read differently,
which is what keeps decision 1 intact.

### 3. Replace the either/or

The reader becomes one branch: render `PipelineFeatureReader` when there is either a commission
or an `activeRun`, and the empty state otherwise. The empty state and its Conductor-settings
button are unchanged.

### 4. Add `showHeader` to `PipelineRunView`

One optional prop defaulting to `true`, suppressing only the `pipelines-run-head` header block at
`:232`. When suppressed, the `actions` slot moves into the composed header so the verbs do not
disappear with it. Document in-file why the prop exists.

### 5. Rail affordance

A commission row whose `linkedRun` is observed gets a secondary control opening the run address
directly, so the rail can still address either identity. Reuse the existing `pipelines-row` idiom
and `Tooltip`; do not add a new row shape.

### 6. Styles

Extend `.pipelines-reader` and `.pipelines-section` for the composed order and the two
`<details>` disclosures. Around 35 lines. No new colour tokens.

## Data, API, migration and compatibility

None. Browser-only. No schema, no persisted state, no wire contract, no generated artifact, no
migration. The tab and every route it calls already ship.

## Tests and verification

Per `AGENTS.md` this is a UI behavior change and requires Playwright coverage.

- `e2e/specs/runs-pipelines-tab.spec.ts`: cover BOTH directions, because one resolution fixes
  only one of them and a spec that drives only the commission side would pass with
  `activeCommission` missing entirely:
  - a selected commission with an observed linked run shows `Engineer attempts` AND the run
    strip (the `Pipeline for <slug>` group) AND `Gate verdicts` AND a control verb, in one pane;
  - **selecting that same run directly shows the same regions**, which is the assertion that
    proves `activeCommission` resolves;
  - a run with no commission renders with no Engineer regions and its own slug in the header,
    so the reverse lookup missing is distinguishable from it returning nothing;
  - the handoff's implementation-run control navigates to the run address.
  Update the `Attempts` assertion at `:311` for the `Kickback attempts` rename.
- `e2e/specs/pipeline-controls.spec.ts`: `Park` and the daemon consoles are reachable for a
  commission-selected feature, which today they are not.
- The same spec pins decision 3: before handoff `Engineer attempts` is expanded; once a linked
  run is observed it is collapsed and still reachable by its disclosure control.
- `e2e/specs/conductor-planning-continuity.spec.ts`: unchanged and green. Its board-card and
  console meter assertions are the regression guard for decision 2's surface.
- `test/pipeline-runs-view.test.ts`: extend for composed region presence. Leave the
  `step 2 of 3` assertion at `:143` exactly as it is.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-runs-view.test.ts test/pipeline-phase-meter.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Add or extend Electron geometry coverage if the composed pane clips, since `PipelineRunView` is
already the tallest thing on the tab and no markup assertion can measure used height.

## Merge and exit criteria

- One reader draws a feature from either selection side; no path renders the old either/or.
- A commission-selected feature with an observed linked run offers the step ladder, gate verdicts
  and the control verbs its state makes useful.
- A run-selected feature shows Engineer attempts and specification handoff, resolved through
  `activeCommission` rather than requiring the operator to have selected the commission.
- A run with no commission renders without Engineer regions and keeps its own slug in the
  header.
- Engineer attempts and specification handoff are collapsed by default once a run exists and
  expanded before handoff.
- No file under `pipeline-run-model.ts` or `PipelinePhaseMeter.tsx` is modified.
- `SessionTile.tsx`, `BoardView.tsx` and `ConsoleDetail.tsx` are unmodified, and the board card
  still draws its bar for a commission with no run and for a run with no commission.
- The two attempts headings are distinguishable.
- All commands above pass.

## Downstream handoff

Later work may rely on:

- `PipelineFeatureReader` being the single reader for the Pipelines tab.
- `activeRun` being the one resolved run every run-derived value in `PipelineRuns.tsx` reads,
  and `activeCommission` being the one resolved commission every commission region reads.
- `PipelineRunView`'s `showHeader` prop existing and defaulting to `true`.

**Requirement carried to `pipeline-attempt-recovery` Phase 3 (operator decision 2, 2026-09-03):**
its segmented progress model must keep the board session card drawing ONE bar carrying BOTH
segments, always present. At handoff the Engineer segment stays complete and visible while the
implementation segment fills beside it. The bar is never retargeted to implementation alone and
is never absent for a feature with either kind of evidence. The board's axis is width, so this
stays one row rather than two stacked mini-bars. Phase 3 owns the segmentation; this phase owns
none of it, and `e2e/specs/conductor-planning-continuity.spec.ts` is the guard.

Phase 3 must not be blocked by this phase: the file sets are disjoint, so the two merge in either
order.

## Cross-phase audit record

- 2026-09-03: single-phase plan, so no inter-phase reconciliation applies. Audited against the
  live `pipeline-attempt-recovery` graph instead. Confirmed disjoint file sets: this phase edits
  `PipelineRuns.tsx`, `PipelineRunView.tsx`, `styles.css` and adds `PipelineFeatureReader.tsx`;
  that effort's Phase 3 step 6 edits `pipeline-run-model.ts`. No shared file, no shared contract,
  no ordering requirement in either direction.
- 2026-09-03: operator decision 1 removed progress-derivation work from this phase's scope. The
  non-goals and exit criteria were written to make that boundary checkable rather than implied.
- 2026-09-03: the `Attempts` / `Engineer attempts` heading collision was found while resolving
  e2e selector seams and assigned here, since composing the two panes is what creates it.
- 2026-09-03, round 1 review: the plan resolved only `activeRun`, which fixed the
  commission-selected direction and left the run-selected direction as broken as before,
  contradicting this phase's own outcome. `commission` is null whenever a run is addressed, so
  the regions gated on it could never render that way. Added `activeCommission` with the reverse
  lookup, pinned the header's identity to `activeRun` so a run-addressed heading does not start
  reading a commission's `planSlug`, and required both directions in the spec rather than one.
  Confirmed the addition stays inside decision 1: `pipelineRunForCommission` returns `linkedRun`
  when a commission is linked, so the meter reads the same run either way and no progress
  derivation is touched.
