# Pipeline reader unification

Make the Pipelines tab draw ONE reader for a feature, whichever side of the specification
handoff it is on, and leave the phase meter's progress semantics to the already-approved
`pipeline-attempt-recovery` Phase 3.

Status: decisions resolved by the operator on 2026-09-03. They are requirements below, not
implementation-time choices.

## Incorporated operator decisions

1. **Leave the phase meter to Phase 3.** This plan stays presentational and edits no progress
   derivation, so it cannot conflict with `pipeline-attempt-recovery` Phase 3 step 6.
2. **The board session card draws one bar with both segments, always present.** Phase 3's
   segmented model must keep the Engineer segment complete and visible while the implementation
   segment fills beside it. The bar is never retargeted and never absent. Recorded here because
   Phase 3 owns the segmentation that could otherwise blank it.
3. **After handoff the unified reader keeps the commission's Engineer attempts and specification
   handoff, collapsed by default.**

## Why

`src/web/pipelines/PipelineRuns.tsx:239` picks one of three readers and never composes two:

```
commission ? <commission pane>   // header, meter, Engineer attempts, handoff
: run       ? <PipelineRunView>  // strip, gate verdicts, control verbs
:             <empty state>
```

The two describe **one 22-step sequence split by who owns the files**, not two sequences.
`ENGINEER_STEP_NAMES` (`src/shared/pipeline.ts:328`) is the leading prefix of the run's own
step table `AI_CONDUCTOR_STEPS` (`src/shared/pipeline.ts:1034`): `worktree`, `memory`,
`explore`, `complexity`, `prd`, `architecture_diagram`, `architecture_review`, `stories`,
`conflict_check`, `plan`, `coherence_check` appear in both. Ten step names coincide.

Three consequences an operator meets today:

- **Facts are unreachable from the side you are on.** A selected commission offers no step
  ladder, no gate verdicts and no control verbs, because `runActions`, `daemon` and
  `usePipelineRunDetail` are all computed from the *addressed* run and a selected commission
  never sets one. A selected run offers no Engineer attempts and no spec handoff.
- **There is no click-through between them.** The commission pane prints
  `commission.linkedRun.slug` as plain text (`PipelineRuns.tsx:274`), so a commission whose
  implementation run exists is a dead end.
- **The pane changes shape mid-feature.** The same work is described by different furniture
  before and after handoff, which is what makes one thing read as two.

## What this plan does NOT do

**The phase meter's progress semantics are out of scope.** They are already owned, planned
and operator-approved.

`docs/plans/pipeline-attempt-recovery/plan.md:41` names the exact defect:

> `src/web/pipelines/pipeline-run-model.ts:624` synthesizes a commission run with an
> unclassified halt and a denominator that includes work outside Engineer's scope.

`docs/plans/pipeline-attempt-recovery/phased-plan.md:179` names the resolution:

> Progress is segmented instead of using one misleading denominator. During Engineer, show
> the Engineer/DECIDE segment only. After handoff, show that segment complete and the
> implementation segment gated on specification merge.

`phase-3-lifecycle-consumption-and-presentation.md` step 6 carries it, and its exit criterion
is "Engineer progress completes at handoff without counting BUILD or SHIP steps".

That plan was approved for scheduling on 2026-09-03 and is live in the backlog as
`225bc5c3` (Phase 3), gated on `204cb4ba` (Phase 1, running) and `2ec4d2ba` (Phase 2,
running, ai-conductor). **The approved answer is to SEGMENT the two progress records.** An
earlier suggestion in this session to UNION them onto one 22-wide meter is superseded and is
not proposed here.

Per decision 1 this plan is deliberately narrow: the reader composition that no phase owns. It
touches no progress derivation, which also means it cannot conflict with Phase 3 in
`pipeline-run-model.ts`.

## Hard constraint: the board card keeps its bar

**The board session-card progress bar must survive for BOTH a commission and a run.** This is
an operator requirement on this work and on Phase 3's segmentation.

The good news is that this plan requires no change to it whatsoever. All three meter
surfaces already hand both halves to one component:

| Surface | Call site | Props today |
|---|---|---|
| Board session card | `src/web/components/layouts/SessionTile.tsx:285` | `run` = commission's linked run, else session's run; `commission` |
| Console detail | `src/web/components/layouts/ConsoleDetail.tsx:571` | `run` = commission's linked run; `commission` |
| Runs Pipelines pane | `src/web/pipelines/PipelineRuns.tsx:248` | `run` = commission's linked run; `commission` |

`BoardView.tsx:225` already resolves `pipelineRun` to `commission.linkedRun` when a
commission exists and falls back to the session's own correlation, and passes
`pipelineCommission` alongside. `SessionTile.tsx:284` gates on
`shown("pipelinePhases") && ((session.pipeline && pipelineRun) || pipelineCommission)`, so it
draws for a commission with no run and for a run with no commission.

Nothing in this plan edits `SessionTile.tsx`, `BoardView.tsx`, `ConsoleDetail.tsx`,
`PipelinePhaseMeter.tsx`, `pipelineRunForCommission` or `pipelinePhaseMeter`. The board bar
is untouched by construction, not by promise.

What this plan DOES do for it is record the constraint where Phase 3 will read it, because
segmentation is where the bar could regress: a segmented model that renders only the
Engineer segment would blank the board bar the moment implementation begins.

## Design

### One reader, composed from what exists

Replace the either/or with a single `<PipelineFeatureReader>` that renders whichever regions
have evidence, in a fixed order, and never fewer than one:

1. Header: eyebrow, title, caption. Sourced from the commission when there is one, else the run.
2. Phase meter. Unchanged component, unchanged props.
3. Engineer attempts. When a commission exists. Expanded before handoff; collapsed by default
   once a run exists, per decision 3.
4. Specification handoff. When `commission.handoff` exists, collapsed by default once a run
   exists. The implementation-run line becomes a button that selects the run rather than plain
   text.
5. Run strip, gate verdicts and control verbs, by mounting the existing `PipelineRunView`.
   When a run exists, whether it was addressed directly or reached through a commission.
6. Blockers and errors, from both sources, deduplicated.

`PipelineRunView` is reused as-is. Its own header stays suppressed when a commission header is
already above it, which is the only prop it gains.

### One resolved run, so the run-shaped wiring stops being commission-blind

Today `run` is the addressed run only. Introduce one resolved value and feed everything from it:

```ts
const activeRun = addressedRun ?? commissionRun;
```

and route `usePipelineRunDetail`, `daemon`, `runVerbs`, `runActions` and `runConsoles` through
`activeRun` instead of `run`. That is what gives a commission-selected feature its ladder,
its verdicts and its park / unpark / grant verbs, and it is the substantive behavior change in
this plan.

Selection precedence is unchanged: an addressed run still wins over a commission's linked run,
so a deep link keeps naming exactly one thing.

### Rail

Unchanged grouping. Two additions:

- A commission row whose `linkedRun` is observed gets a secondary affordance opening the run
  address directly, so the rail can still address either identity.
- Selecting a run continues to clear the commission selection through the existing
  `openPipelineRun` (`src/web/App.tsx:1409`). No new state.

## Flow change

Before, the reader is an either/or over two identities:

```mermaid
flowchart LR
  Sel[Selection] --> C{commission?}
  C -- yes --> CP[Commission pane: meter, attempts, handoff]
  C -- no --> R{run?}
  R -- yes --> RV[PipelineRunView: strip, verdicts, verbs]
  R -- no --> E[Empty state]
```

After, one reader composes regions from whichever evidence exists:

```mermaid
flowchart LR
  Sel[Selection] --> Res[Resolve activeRun = addressed ?? commission.linkedRun]
  Res --> RD[PipelineFeatureReader]
  Com[Commission evidence] --> RD
  Run[Run evidence via activeRun] --> RD
  RD --> Out[Header, meter, attempts, handoff, strip, verdicts, verbs]
  Res --> Det[usePipelineRunDetail on activeRun]
  Det --> RD
```

## Sequencing against Phase 3

Recommended: land this **before** Phase 3, kept strictly presentational.

- It edits `PipelineRuns.tsx` and adds one component. Phase 3's step 6 edits
  `pipeline-run-model.ts`. Disjoint files, no conflict.
- Phase 3 then inherits one reader to verify rather than two, which shrinks its step 7.
- Phase 3 is gated on two running phases and one of them is in another repository, so this
  is not blocked behind that gate.

## Tests

Behavior changes, so per `AGENTS.md` this needs a Playwright spec.

- `e2e/specs/runs-pipelines-tab.spec.ts`: extend. A selected commission with an observed
  linked run shows Engineer attempts AND the run strip AND a control verb in one pane.
  Selecting the run directly shows the same regions. The handoff's implementation-run control
  navigates to the run address.
- `e2e/specs/pipeline-controls.spec.ts`: extend. Control verbs are reachable for a
  commission-selected feature, which today they are not.
- The same spec pins decision 3: before handoff the Engineer attempts region is expanded, and
  once a linked run is observed it is collapsed but still reachable by its disclosure control.
- `e2e/specs/conductor-planning-continuity.spec.ts`: keep the existing board-card and console
  meter assertions green, unchanged. They are the regression guard for the board bar.
- `test/pipeline-runs-view.test.ts`: extend for the composed reader's region presence.
  `pipelineRunForCommission` assertions stay as they are, including the `step 2 of 3` case at
  `:143`, because this plan does not change that derivation. Phase 3 owns updating it.
- `test/pipeline-phase-meter.test.ts`: untouched.

Definition of done: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run smoke`, `npm run test:e2e`.

## Documentation

- `docs/pipelines.md`: describe one reader and the commission-to-run relationship. Leave the
  "Provider evidence is the source of truth" paragraph at `:34` alone; Phase 3 revises it.
- No change to `docs/ui.md` unless the rail affordance needs naming.

## Risks

- **Reader height.** Composing regions makes the pane taller and `PipelineRunView` is already
  the tallest thing on the tab. Decision 3's collapsed default bounds this, since the two
  commission regions stop contributing height once implementation is the live work. If the
  composed pane still clips, add Electron geometry coverage per `AGENTS.md` rather than only
  asserting markup.
- **Phase 3 drift.** If Phase 3 lands first, this plan's `activeRun` change still applies but
  the reader must be re-read against whatever segmented meter it introduces.
- **Double-stated halts.** A commission blocker and a run halt can describe one stop. The
  reader deduplicates; the spec should pin that it says it once.
