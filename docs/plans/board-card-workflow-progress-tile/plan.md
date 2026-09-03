# Board card workflow progress tile

Replace the single stage rung on Board session cards with a **stage track plus a repair-round
budget meter**, default on, with today's rung tile still reachable from the same panel every other
card option lives in.

## Decisions

Resolved in the Mission Control dashboard on 2026-09-03. These are settled; the alternatives are
recorded at the end of this document rather than left open.

| Decision | Adopted |
| --- | --- |
| Design | **Option B** - stage track plus repair-round budget |
| Setting mechanism | **New `DISPLAY_ITEMS` entry**, absent from the hidden defaults so it ships on |
| The 250px name/status collision in today's tile | **Fix it in the same change** |
| Follow-up | Create a phased implementation plan |

## Why change the tile at all

The tile that ships today shows exactly **one** rung of a five-stage pipeline.
`workflowLadderPeekView` sorts the stages by `peekPriority` and spends the tile's one slot on the
most consequential one (`src/web/workflows/WorkflowLadderPeek.tsx:75`). That is the right call for a
single slot, and it is still a single slot: everything the run has already done, and everything it
has left, is invisible until you expand the tile.

Live run `dc5208cd` makes the cost concrete. Its commands stage reports **"None ran"** - both
`typecheck` and `test` were skipped against the run's per-command budget - and its Pull Request
stage reports **"Could not run"**. The failed rung outranks the degraded one, so the tile names the
Pull Request and the reader never learns the checks did not execute. Both facts fit on a bar.

The second thing a bar fixes is the shape of the run. `9d6bdc91` and `b5659b19` are continuation
segments where three stages were carried forward rather than re-run. Today that is one line of
prose - "3 stages carried from Round 4" - under a rung named "Stage 1". As a bar it is three
hatched segments you read without a sentence.

The third is the repair budget. Round is text in the header today (`R2 / 5`), which means "how much
budget is left" is arithmetic on two numbers whose relationship the label does not explain. Live run
`b5659b19` reads `R6 / 5`, and what that actually means is that the run is on its **last affordable
round**: `maxRepairRounds` counts *repair* rounds after the initial submission, so the legal range is
1 to `maxRepairRounds + 1`, and `round > maxRepairRounds` is the exact inequality
`workflowRunGaveUp` uses for "another round is not affordable"
(`src/shared/workflow.ts:1763`, `:1779`). Nothing on the card says that today, and `R6 / 5` reads
like an error rather than the top of the range.

## What is on screen now

Header, then one rung: stage name, its contents line, its status label, a chip per member, one error
sentence, and the carried line. Round is text in the header.

## The design

Three rows under the existing header, which is otherwise unchanged except that the round counter
leaves it.

**Row 1 - the stage track.** One segment per stage in one bar, sized by equal `flex-grow` with a
hittability floor. Segment tone is the stage's own `PipelineStatus` tone, so the five-colour
vocabulary is unchanged:

- A passed stage fills solid.
- A **carried or skipped** stage fills **hatched**. "Resolved without running" must not read as
  either "passed" or "not started", and this is the distinction today's tile can only make in prose.
- A pending stage is the neutral track.
- A failed stage fills solid in the danger tone.
- The stage the tile would otherwise have named carries the `is-now` ring, so it is findable without
  relying on colour - which matters most on the run where the colour is the point.

Right of the bar, `3 / 5 stages`. The count rides the bar row rather than the caption because at a
250px column a caption carrying name plus status plus count truncates the **name** - the one part a
reader cannot reconstruct.

**Row 2 - the caption.** The active stage's name, then its status label. Full tile width.

**Row 3 - the repair budget.** The label `rounds`, one pip per round the run can reach, then
`R2 / 5`.

The pip count is **`maxRepairRounds + 1`**, not `maxRepairRounds`: the first pip is the initial
submission and the rest are the repair rounds it is allowed after that
(`src/shared/workflow.ts:136`). Rounds before the current one are grey, the current one is the run's
tone with a ring.

When the current pip is the **last** one - `round > maxRepairRounds`, the same inequality
`workflowRunGaveUp` reads - it takes the danger tone and the row gains the word `no repairs left`.
The word matters: a bare red dot in a row of grey ones would read as a round that *failed*, when what
it means is that no further round is affordable. That is `b5659b19`'s real state, and it is worth
saying out loud, because `R6 / 5` reads like a bug and is not one.

There is no overflow pip and no out-of-range case to draw. Granting more rounds raises
`maxRepairRounds` itself (`src/server/workflows/manager.ts:2494`), so the meter grows a pip rather
than overflowing.

**Then the error sentence**, when there is one, at full tile width.

## Measured height, live runs

Measured with `getBoundingClientRect()` on the rendered tiles at both board column widths - a
typical 300px, and the 250px that `.board-col`'s own `min-width` allows.

At a 300px column:

| Live run | What it is | Today | Adopted (B) |
| --- | --- | --- | --- |
| `563ea79c` | R1, one stage cleared, four waiting | 74px | 91px |
| `dc5208cd` | R2, commands skipped, PR could not run | 117px | 134px |
| `6bf9ee3e` | R2, every review passed, PR could not run | 117px | 134px |
| `9d6bdc91` | R4, three stages carried, PR complete | 92px | 91px |
| `b5659b19` | R6 of 5, on its last affordable round | 92px | 91px |

At a 250px column:

| Live run | Today | Adopted (B) |
| --- | --- | --- |
| `563ea79c` | 74px | 91px |
| `dc5208cd` | 117px | 134px |
| `6bf9ee3e` | 117px | 148px |
| `9d6bdc91` | 110px | 91px |
| `b5659b19` | 110px | 91px |

Read that honestly, because the adopted design is **not** the shortest of the three that were
offered and on several runs it is taller than today:

- On a run carrying an error sentence it costs 17px at 300px and up to 31px at 250px. The sentence
  gets the full tile width where today's rung indents it behind a 31px spine, so it wraps sooner.
- On an early run it costs 17px.
- On a healthy or carried run it saves 1px at 300px and 19px at 250px.

What is bought with that: five stages instead of one, the skipped-versus-pending distinction, and
the repair budget as a meter rather than arithmetic. And a **flat** height - 91px on every run of a
given shape, because a bar does not grow with the number of stages or members. Today's tile is
74px, 92px or 110px depending on how many members the picked rung happens to have, which is what
makes a column of them ragged.

The 250px error case (148px against today's 117px) is the one number worth watching once this is on
a real board. If it reads as too tall, the sentence is the row to clamp, not the meter.

## The setting

The panel is `BoardCardPanel` (`src/web/components/BoardCardPanel.tsx:100`, "Session display"), the
same one that owns `goal`, `activity`, `workflow`, `pipelinePhases` and the rest. Its checkboxes come
from the `DISPLAY_ITEMS` registry in `src/web/lib/board-card.ts:57`, persisted as
`UiConfig.hiddenDisplayItems` - a list of **hidden** ids, so an id absent from the defaults ships
**on**.

One new registry entry:

```ts
{
  id: "workflowProgressBar",
  group: "card",
  label: "Workflow progress bar",
  description: "Show the run's stages and repair budget as progress meters. Off shows the single active stage in detail.",
}
```

It is **not** added to `UI_CONFIG_DEFAULTS.hiddenDisplayItems` (`src/shared/protocol.ts:2869`,
currently `["worktree"]`), which is what makes the progress bar the default. `SessionTile` reads
`shown("workflowProgressBar")` and passes the variant down to `WorkflowLadderPanel`; unchecking it
returns today's rung tile, unchanged.

This inherits everything the registry already enforces - the gate assertions in
`test/board-card-items.test.ts`, the settings search entries in `src/web/lib/settings-search.ts:180`,
and the live `SessionTile` preview in the panel itself - and adds no second source of truth.

Two consequences of choosing the registry over a dedicated field, both accepted:

- Every other `DISPLAY_ITEMS` entry means "render this or render nothing"; this one means "render
  this or render the other thing". The `description` carries that, and it is the only entry in the
  registry that needs to.
- `test/board-card-items.test.ts:91` requires the **tile** to hold the `shown("<id>")` gate, so the
  gate stays in `SessionTile` and the variant travels as a prop. It does not move into
  `WorkflowLadderPanel`, and there is no second read of `hiddenDisplayItems` anywhere in the tile
  (`:114` pins that).
- The panel's preview mounts a real `SessionTile` against `src/web/lib/board-card-preview.ts`, whose
  `PREVIEW_WORKFLOW_RUN` is at `round: 1` with `workflowVersion: 4`. A round-1 run draws one spent
  pip and nothing else, so the preview needs a round mid-budget for the repair row to show what it
  does. `test/board-card-items.test.ts` already requires the fixture to populate every card item.

## Also in scope: the 250px collision

At a 250px board column - `.board-col`'s own `min-width` - today's tile collides the stage name into
its status label. `.wf-tile-peek-title strong` is `flex: none` and `.wf-tile-peek-state` is
`flex: none; margin-left: auto`, so neither yields and the 8px gap collapses: "Intent Conformance
Judge" runs straight into "Waiting".

The new tile does not have this - the name is on its own row - but the rung tile is now the
**fallback view** a reader deliberately switches to, so it has to be correct at every column width
the board allows. Fixed in the same change: let the title shrink and ellipsize rather than pinning
`strong` at `flex: none`, and keep the gap.

Needs its own regression coverage, and the coverage has to be width-dependent: the defect is
invisible at 300px.

## Implementation notes

- **Do not fork the segmented bar.** `PipelinePhaseMeter` already draws one for ai-conductor
  pipeline phases (`src/web/pipelines/PipelinePhaseMeter.tsx:206`, `.tpm-seg` at
  `src/web/styles.css:27000`), including the neutral track, the `min-width: 9px` hittability floor,
  the `is-now` ring and the `is-degraded` hatch - every decision this tile needs, already argued in
  comments. Extract the segment bar so both meters share it rather than growing a second one that
  drifts. Both meters can appear on the same card (`SessionTile.tsx:283` and `:293` are not mutually
  exclusive), so they must not merely look similar; they must be the same thing.
- **Project the whole stage list, not one rung.** `workflowLadderPeekView` builds the full
  `StagePeek[]` internally and then discards all but one
  (`src/web/workflows/WorkflowLadderPeek.tsx:181`). The bar needs that array exported, and the
  existing view keeps deriving its single rung from it, so the two can never disagree about a
  stage's status.
- **The repair row reads `summary.round` and `summary.maxRepairRounds`** (`src/shared/workflow.ts:3605`
  and `:3669`), and must not invent a third reading of them. `round > maxRepairRounds` already means
  "another round is not affordable" in `workflowRunGaveUp` (`:1779`); reuse that inequality rather
  than restating it. `b5659b19` is live in that state with `status: "completed"`, so the row cannot
  assume it implies failure - `workflowRunGaveUp` also requires a blocked run and a spent phase.
- **Non-stage runs still need an answer.** The peek returns early for an uncertain repair delivery,
  for a waiting GitHub Inspector gate, and for an `inspector_only` round - none of which is a walk
  through the stage graph. Those keep today's rung rendering; the meters are for the stage-shaped
  case, the same way `projectStages` returning `null` already falls through to "no stage-shaped
  preview".
- **A Playwright spec is required.** This is a visible Board change, so `e2e/` covers it before it
  lands: the bar renders for a stage-shaped run, the segment count matches the pipeline, the repair
  row marks the current round, unchecking the setting in the panel returns the rung tile, and the
  choice survives a reload. Selected by role and accessible name - no `data-testid`.
- **The meters are not the accessible interface.** Segment tone, hatching and pips are decoration;
  each segment needs its stage name and status label as its accessible name, each pip needs its
  round, and the caption row must keep naming the active stage in text.

## Alternatives considered and not taken

- **Option A - stage track alone.** The same bar without the repair row. 72px flat, the shortest of
  the three and the cheapest. Rejected because the repair budget is the thing worth watching, and
  Option B is Option A plus one row - so nothing in A is lost by taking B.
- **Option C - gate rail.** One tick per gate rather than per stage (eight for No-Mistakes v10),
  grouped with a gap at each stage boundary and the stage ordinal beneath. Finest granularity: you
  can see one of two reviewers in a stage still out. Rejected for now; it is where member-level
  detail comes back if the stage-level bar proves too coarse on a real board. Its stage labels have
  to be ordinals, not names - five abbreviated stage names at 250px truncate to "comman…",
  "Intent C…", "2 review…", four ellipses that name nothing.
- **A dedicated `UiConfig` boolean with a two-option radio.** Honest about being a variant choice
  rather than a visibility toggle. Rejected for the cost: a new persisted field, new panel markup,
  and its own preview and search-index wiring, all to avoid one `description` line explaining what
  the checkbox does.

## How the renders were made

No fixtures. Every card in the comparison sheet is a real No-Mistakes Review v10 run read from the
running daemon at `127.0.0.1:7317` via `/api/workflow-runs` and `/api/workflow-runs/:id`, projected
through the app's own `projectStages` (`src/shared/workflow-stages.ts:580`) and `run-model.ts` status
helpers, and drawn in real `.tile` chrome against the real `src/web/styles.css`. Stage names, status
labels, tooltips, error sentences, round counters, session names, repositories and branches are all
live values. Heights are `getBoundingClientRect()` measurements of the rendered tiles, not estimates.

The five runs, and why each earned a row:

- `563ea79c` - blocked at R1 with one stage passed and four still waiting. The early-progress shape.
- `dc5208cd` - the run in the screenshot that started this. Commands skipped, three reviewer stages
  passed, Pull Request could not run.
- `6bf9ee3e` - every reviewer passed and the Pull Request still could not run, for a different
  reason. The all-green-but-one shape.
- `9d6bdc91` - a continuation segment at R4 with three stages carried and the PR complete.
- `b5659b19` - the same shape at R6 against a 5-round budget: the only live example of a run on its
  last affordable round, which is the top of the legal range and not an overrun.

Between them they cover every tone the projection can produce: passed, waiting, failed,
degraded/skipped, and carried. **No run was live at capture time**, so no card shows the `running`
tone in flight; that state is inferred from the same `PipelineStatus` vocabulary the other five use,
and it is the one state the Playwright spec has to drive rather than observe.
