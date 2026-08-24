# Phase 1 - The phase meter on the board card

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).
Design record: [`mockups.html`](mockups.html), Option A.

This is the plan's only phase. It ships the whole feature as one vertical slice.

## Outcome

A board session card for an **externally driven ai-conductor worker** draws a five-segment
**phase meter** showing how far its run has got, which phase it is in, whether anything failed,
and what got skipped. Hovering a segment opens a popover listing that phase's steps with their
individual states.

The operator can triage a pipeline run from the board without opening Runs or the conversation
pane. Today that card says one word (`⇶ add-widgets · Build`).

## Entry criteria and dependencies

- **Direct phase dependencies: none.** This is the first and only phase.
- Depends on the planning session's pull request merging, which is what publishes this file and
  the plan beside it to the default branch.
- No migration, no feature flag, no rollout gate.

## Scope

In scope:

1. Widen `Tooltip` to accept rich content in addition to a string.
2. A new phase-meter leaf component plus its popover content.
3. A board-card registry entry so the meter is operator-toggleable.
4. Render it on `SessionTile`, fed by the run `BoardView` already looks up.
5. Styles, in the board-tile block of `styles.css`.
6. Update `docs/pipelines.md`.
7. Tests, including the required `e2e/` spec.

Explicit non-goals:

- **No change to `SessionPipelineLink`, and no SSE widening.** The run data is already in the
  browser; see the findings below.
- **No gate verdicts on the card.** They stay detail-only.
- **No meter on the console rail row or the console detail band.** They keep today's chip.
- **No meter on a managed Pipeline host** (`Session.task.pipelineRun`). `TaskPipelineRunTileFlag`
  is untouched.
- **No second copy of the phase fold.** Import the existing derivation.
- No writing of any engine-owned file. Mission Control never writes provider state.
- No new hover primitive beside `Tooltip`.

## Repository findings

Verified in this worktree. Line numbers are where the fact was read, not a promise they will not
move.

### The run is already in the browser

- `useEventStream` holds `pipelineRuns` as a `Map` keyed by the run's own identity
  (`src/web/useEventStream.ts:197`), seeded from the connect snapshot (`:281`) and kept live by
  `pipeline_upsert` / `pipeline_remove` (`:437`, `:440`).
- `App.tsx` derives `pipelineRunByKey` (`src/web/App.tsx:1737`) and passes it down (`:2070`).
  `SessionViewProps.pipelineRunByKey` is `ReadonlyMap<string, PipelineRun>`
  (`src/web/components/layouts/types.ts:242`).
- `BoardView` already reads that map for `pipelineRunObserved`
  (`src/web/components/layouts/BoardView.tsx:167`).
- `PipelineRun.steps` is `PipelineStep[]`, each `{ name, state }`
  (`src/shared/pipeline.ts:262`).
- `pipelineRunKeyOf` accepts any `{ provider, repoRoot, slug }` structurally
  (`src/shared/pipeline.ts:407`), so a `SessionPipelineLink` can be passed directly with no
  adapter.

**So the join is `pipelineRunByKey.get(pipelineRunKeyOf(session.pipeline))` and nothing else.**

### The fold already exists

`src/web/pipelines/pipeline-run-model.ts`:

- `pipelineStrip(provider, steps, gates)` → `{ phases, outOfBand, unknown }` (`:281`). `phases`
  is one `PipelinePhaseCard { phase, steps }` per entry of `PIPELINE_PHASES`, already filtered to
  exclude out-of-band steps.
- `pipelinePhaseStatus(steps)` → `PipelineStatus | null` (`:318`). Precedence is
  `failed > in_progress > stale > all-finished > partial > pending`, and it sets
  `degraded: true` with a tooltip when the phase finished having skipped something.
- `pipelineStepStatus(state)` → `PipelineStatus` (`:223`), for the popover rows.
- `pipelineEyebrow(run)` → `"DECIDE · Plan · step 10 of 22"` (`:356`), counted over the run's
  **own** sequential steps rather than the frozen table's 22.

Two consequences that shape the implementation:

- `pipelinePhaseStatus` reads only `step.state`. It never looks at a gate verdict, so
  **`pipelineStrip` can be called with an empty `gates` array** and the card needs no fetch.
- `pipelineStrip` returns out-of-band steps in their own pile. The meter draws the five phase
  segments only. An out-of-band step has no slot in the sequence, so putting it in a segment
  would claim the run walked past something that was never on its path.

`PipelineStatus` is `{ tone, label, tooltip?, skipKind?, degraded? }` with
`PIPELINE_STATUS_TONES = ["running","waiting","passed","failed","stopped"]`
(`src/web/workflows/pipeline-bits.tsx:32`, `:34`, `:49`). The tone classes already exist in CSS:
`.workflow-running|waiting|failed|passed|stopped` (`src/web/styles.css:1107-1120`).

### `Tooltip` renders its label in exactly two places

`src/web/components/Tooltip.tsx`, current signature:

```ts
export function Tooltip({ label, children }: { label: string; children: ReactElement })
```

`label` is rendered twice, and they are different jobs:

1. The **description** node - `<span id={id} className="tt-desc">{label}</span>` - always
   rendered, visually hidden, and what the trigger's `aria-describedby` resolves to. **This must
   stay plain text.** Rendering JSX here would put markup into an accessible name.
2. The **visible bubble** - `<span aria-hidden className={...}>{label}</span>` - already
   `aria-hidden`, so rich content here is safe.

Because the bubble is already `aria-hidden` and already `pointer-events: none`
(`styles.css:20930`), a read-only popover needs nothing else from it. The `pointer-events: none`
is a feature here: the popover cannot steal the hover from the segment that opened it. It also
means the popover content must stay non-interactive, which the design is.

`.tooltip` is `width: max-content; max-width: 260px; padding: 5px 9px; text-align: center`
(`styles.css:20909`). A rich bubble needs `text-align: left` and its own padding, so the
component must put a class on the bubble when the label is rich.

### The registry, and where the meter must not go

`src/web/lib/board-card.ts` is the single registry (`DISPLAY_ITEMS` at `:55`), and
`DisplayItemId` is derived from the array (`:165`), so adding an entry is type-safe with no
second list to update. `SessionTile` reads it through `useDisplayItems()` (`:151`) and gates
regions with `shown("...")` (`:246`, `:256`, `:270`).

The meter is a body region, like the existing `workflow` item (`board-card.ts:71`), so it takes
a `group: "card"` entry.

It must **not** go in `.tile-marks`. The registry header forbids putting attention flags in the
list, because an operator must not be able to configure themselves into missing "this session
needs you". The meter is progress, not an alert; a halted run's attention signal stays where it
already is. `test/board-card-items.test.ts` enforces the registry rule.

### The step list is per repository

`AI_CONDUCTOR_STEPS` (`src/shared/pipeline.ts:757`) is a frozen display copy and explicitly not
an authority. ai-conductor builds its effective step list from config, and **its own
`.ai-conductor/config.yml` disables `manual_test` and inserts two custom SHIP steps**
(`maintain-documentation`, `release-disposition`). So a card observing that repository sees names
this build does not know.

`pipelineStepOrder` already sorts an unknown step last, and `pipelineStrip` already returns
unknown steps separately. The meter must therefore compute geometry from `run.steps`.

## Implementation steps, in execution order

### 1. Widen `Tooltip` to accept rich content

`src/web/components/Tooltip.tsx`.

Add an exported content type and widen the prop additively:

```ts
/** Rich tooltip content: what the bubble paints, and the sentence a screen reader gets. */
export interface TooltipContent {
  content: ReactNode;
  /** The accessible description. Plain text, because `aria-describedby` resolves to it. */
  description: string;
}

export function Tooltip({
  label,
  children,
}: {
  label: string | TooltipContent;
  children: ReactElement;
}): React.JSX.Element
```

Inside, derive the two renderings once:

```ts
const rich = typeof label !== "string";
const description = rich ? label.description : label;
const painted = rich ? label.content : label;
```

Then use `description` in the `.tt-desc` node and `painted` in the bubble, and add a class to
the bubble when `rich` so CSS can switch to left-aligned, unpadded layout:

```ts
className={`tooltip tt-${tip.placement}${rich ? " tt-rich" : ""}`}
```

Constraints to hold:

- **The string arm must be unchanged.** Every existing call site passes a string; this is a
  widening, not a migration.
- **Keep the measurement in the `measure` ref callback.** The existing comment is explicit that
  this is what keeps the component silent under the `renderToStaticMarkup` every component test
  in `test/` uses. Do not move it to a layout effect.
- Do not touch `mergeDescription`, `describeLabelControls`, the disabled-trigger anchor path, or
  the handler-merging `cloneElement`. They are the reason this primitive is being widened rather
  than duplicated.
- The two-stage flip already measures real bubble height, so a taller rich bubble flips correctly
  with no change. Verify this rather than assuming it.

### 2. The phase-meter leaf

New file under `src/web/pipelines/` (suggested `PipelinePhaseMeter.tsx`).

Export one component taking the run and the link:

```ts
export function PipelinePhaseMeter({
  run,
  link,
  onOpen,
}: {
  run: PipelineRun;
  link: SessionPipelineLink;
  onOpen?: () => void;
}): React.JSX.Element | null
```

Build the view model from the existing fold - do not re-derive:

- `const { phases } = pipelineStrip(run.provider, run.steps, [])` - empty gates, per the finding
  above.
- Per phase: `pipelinePhaseStatus(card.steps)`, its step count, and its finished count
  (`done` or `skipped`).
- The current phase is the one containing `run.lastStep`; resolve it through
  `pipelinePhaseOfStep`, and treat "no phase" as "no ring" rather than defaulting to a phase.

Render:

- **A caption row**: the `⇶` glyph, the slug, the current phase as one word, and `n/N`.
  - `n/N` counts the run's **own** sequential steps. Reuse `pipelineEyebrow`'s counting rather
    than writing a second counter; if its string shape does not fit the caption, extract the
    count from the same helper rather than recomputing it beside it.
  - The slug keeps today's affordance: a button that calls `onOpen` and stops propagation, so
    clicking it opens the run in Runs instead of drilling into the console. `PipelineChip`
    (`session-bits.tsx:285`) is the existing pattern for exactly this.
- **The bar**: five segments in `PIPELINE_PHASES` order.
  - `flex-grow` is that phase's step count **from this run**. Never a hardcoded `1/1/9/5/6`.
  - A fill element inside each segment, width = `finished / total` as a percentage.
  - Tone class from the phase status, reusing `.workflow-*`.
  - The current phase's segment gets a ring modifier.
  - `degraded` gets the hatch modifier.
  - Each segment is wrapped in `<Tooltip label={{ content, description }}>`.
- **The popover content** per segment: phase name, status label, one row per step with a glyph
  and tone from `pipelineStepStatus`, struck through when skipped, plus a footer carrying the
  halt sentence when `run.halt` is set and this is the failing phase, or the skip explanation
  from the phase status's own `tooltip` when it is degraded.
  - The `description` string is the plain-text form, e.g.
    `"Decide: running. 6 of 9 steps finished."` Do not stringify the JSX.

Tolerance rules, all three from the findings:

- Geometry from `run.steps`.
- A step with no placeable phase still counts in `n/N`. It is a step the run really has, so it
  must not vanish from the total. It has no segment, which is correct.
- Return `null` for a run whose sequential step list is empty, rather than drawing an empty bar.

### 3. The registry entry

`src/web/lib/board-card.ts`. Add one entry to `DISPLAY_ITEMS` with `group: "card"`, placed
beside `workflow` since it is the same kind of thing. Write the `description` in the file's
established voice: what it shows, and what the operator loses by hiding it.

Do not add anything to `.tile-marks`.

### 4. Render it on the card

`src/web/components/layouts/SessionTile.tsx`.

- Add an optional `pipelineRun?: PipelineRun | null` prop.
- Render between the activity ticker and `WorkflowLadderPanel`, gated on the new `shown(...)` id
  and on both `session.pipeline` and the joined run being present.
- Fail open: a session with no `session.pipeline`, or a link whose run is not in the map, renders
  nothing at all. This is the overwhelmingly common case - `Session.pipeline` is null on every
  fleet with no pipeline provider enabled.

### 5. Pass the run

`src/web/components/layouts/BoardView.tsx`, in the existing `tile` closure beside
`pipelineRunObserved`:

```tsx
pipelineRun={
  s.pipeline ? (props.pipelineRunByKey?.get(pipelineRunKeyOf(s.pipeline)) ?? null) : null
}
```

`pipelineRunKeyOf` is already imported in this file for `pipelineRunObserved`.

### 6. Styles

`src/web/styles.css`, in the board-tile block (around `:25138-25730`, near `.wf-tile-peek` which
is the closest precedent).

- Caption row, bar, segment, fill, ring, hatch, and the rich-bubble popover layout
  (`.tooltip.tt-rich`).
- **Tokens only.** No new hex values. The tone colours come from the existing `.workflow-*`
  classes; anything else is `color-mix(in oklab, ...)` against a token, which is this file's
  convention.
- A `min-width` floor on a segment so a one-step phase stays visible and hittable. SETUP and
  UNDERSTAND hold one step each in the default sequence, so at proportional width they are
  slivers; this floor is the reason they remain a usable hover target.
- Add a `@media (prefers-reduced-motion: reduce)` arm if any transition is introduced. The
  surrounding block already does this for the activity glyph and the disclosure.

### 7. Documentation

`docs/pipelines.md`, the "On the fleet" section. It currently says a correlated card carries "a
pipeline chip (`⇶ add-widgets · Build`)". Update it to describe the meter, and state the two
scope boundaries this phase sets deliberately: board card only, and externally driven workers
only.

## Data, API, and migration

**None.** No schema change, no migration, no persisted field, no route, no SSE frame, no MCP
tool, and no change to any wire contract. The only cross-process fact this phase relies on -
that the projection carries whole runs - is already true and already tested.

This is worth stating rather than omitting: it is why the phase has no compatibility section and
why it can merge in any order relative to unrelated work.

## Tests and verification

### Unit and component (`test/`)

- The fold from a `PipelineRun` to the meter's view model, over fixtures for:
  - a run mid-`DECIDE` (a running phase, earlier phases done, later ones pending);
  - a **halted** run whose failing phase is `BUILD`;
  - an **all-skipped S-tier** run, asserting the degraded phases are not reported as a plain
    pass;
  - a **stale / kicked-back** run, asserting `waiting` rather than `passed`;
  - a run whose steps include **names absent from the frozen table**, asserting they are counted
    in the total and that the five segments still render;
  - a run with a **one-step phase**, asserting the `min-width` floor is expressed rather than
    left to flex;
  - an **empty** step list, asserting the component renders nothing.
- Assert the segment tones come from `pipelinePhaseStatus` rather than a local map. This is the
  test that stops a second fold appearing later.
- `test/board-tile-render.test.ts` - markup shape on the tile, including that nothing renders
  when `Session.pipeline` is null.
- `test/board-card-items.test.ts` - registry parity for the new item.
- A `Tooltip` test for the node arm: the bubble paints the content, the `.tt-desc` node contains
  the plain-text description and no markup, and the string arm still behaves exactly as before.
- `test/tooltip-coverage.test.ts` must stay green.

### End to end (`e2e/`) - required

A spec asserting:

1. the meter appears on the board card for a correlated session;
2. hovering a segment reveals that phase's status;
3. unchecking the new Settings row hides it.

`e2e/specs/conductor-loops.spec.ts` is the precedent for driving a real correlated card, and
`e2e/specs/board-card-customization.spec.ts` for the registry row.

Two standing constraints, from `AGENTS.md`:

- **Never add `data-testid`.** Select by role, label, or placeholder.
- **Never spend model tokens.** Every agent binary is redirected by
  `e2e/fixtures/fake-agents.ts`; both the one-shot runner and the SDK session must stay faked.

`npm run test:e2e` needs `npm run build` first, and `npx playwright install chromium` once per
machine.

### Commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

### Visual verification

A UI change is not verified by diff inspection. Capture the meter on a real board card in the
built dashboard, in at least a running state and a halted state, at a normal board column width
and at a narrow one. Attach the images to the pull request; never commit them.

## Merge and exit criteria

- All five commands above pass.
- The `e2e/` spec covering the new behavior exists and passes.
- A correlated worker's board card draws the meter; an uncorrelated session's card is
  byte-for-byte what it is today.
- The console rail row, the console detail band, and a managed Pipeline host's card are
  unchanged.
- `SessionPipelineLink` and every SSE frame are unchanged; `test/pipeline-sse.test.ts` still
  passes with its wire budget untouched.
- `docs/pipelines.md` describes what the card now draws.
- Visual evidence attached to the pull request.
- No `data-testid` added, no `title` attribute added, no new hex colour in `styles.css`.

## Downstream handoff

There is no later phase in this plan. These are the contracts a **future** change should inherit
rather than relitigate:

- `Tooltip`'s rich arm is `string | TooltipContent`. A future rich tooltip uses it; it does not
  add a second hover primitive, and it does not put markup in the description node.
- The meter reads `pipelineStrip` / `pipelinePhaseStatus`. Extending it to the console rail row,
  the detail band, or a managed Pipeline host (`Session.task.pipelineRun`) is a rendering change
  at the new leaf's call sites, not a new fold and not a wire change.
- The board-card registry entry id is the operator-visible name for this region. Renaming it
  would be a persisted-preference change, since `hiddenDisplayItems` stores ids.
- The tolerance rules are load-bearing, not defensive: geometry from `run.steps`, unknown steps
  counted, out-of-band steps never given a segment.

## Cross-phase audit record

- **Initial authoring.** Single-phase plan. Sized at roughly 300-400 non-test implementation
  lines (see `phased-plan.md` for the breakdown), which is above the 200-line one-shot threshold
  but below the bar for splitting: the only natural boundary is the `Tooltip` widening at roughly
  35 lines, and carving that out would create exactly the small preparation phase the sizing
  rubric forbids, delivering an unused API arm and no user-visible behavior.
- **Requirement coverage.** Every adopted decision from the source plan is owned here: treatment
  A (steps 2 and 6), extend `Tooltip` (step 1), board tile only (steps 4 and 5, and the
  non-goals), externally driven workers only (step 4's gate and the non-goals).
- **No inherited contracts**, since there is no prior phase. No later phase depends on this one
  inside this plan.
- **Assumption checked against the repository rather than the source plan**: the source plan said
  the card "joins a map it is already being passed", and this was confirmed concretely -
  `pipelineRunByKey` reaches `BoardView` today and `pipelineRunKeyOf` accepts a
  `SessionPipelineLink` structurally, so no adapter and no prop-drilling change is needed beyond
  one line.
