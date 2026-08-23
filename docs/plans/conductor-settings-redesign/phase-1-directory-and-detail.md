# Phase 1 - Directory and detail

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

This is the only phase. It delivers the whole approved change.

## Outcome

The Conductor settings category stops rendering every repository in the workspace and becomes a
master-detail page: a searchable, filterable directory that opens on the repositories Conductor
manages, beside a detail pane with room for everything a repository's cramped row cannot hold
today. On the machine this plan was written against that is **1 row instead of 202**.

Three smaller drifts land with it: the category becomes reachable from the settings palette at
every one of its controls, its rail row grows a status dot, and it stops borrowing another panel's
switch class and rolling its own radio group.

## Entry criteria and dependencies

- The planning pull request that publishes `plan.md`, `phased-plan.md` and this file has merged to
  the default branch. The scheduled task is gated on it, so this is automatic.
- No other phase. There is nothing to inherit.

## Scope

- `src/web/components/ConductorPanel.tsx` - replace the `Workspace repositories` card with a
  directory column and a detail column; move the four configuration cards below them; swap the
  Engineer host radios to `sc-seg`; stop using `skill-switch`.
- `src/web/styles.css` - the Conductor master-detail, directory and tile rules; remove the
  `.conductor-repo*` rules the old list owned; drop `sc-solo`'s 760px cap for this panel.
- `src/web/lib/settings-search.ts` - five new entries so all six anchors are reachable.
- `src/web/lib/settings-dots.ts` and `src/web/components/SettingsPage.tsx` - a `conductor` dot case
  and its `dotLabel` arm; pass the new pipelines callback to the panel.
- `src/web/App.tsx` - supply that callback.
- `docs/pipelines.md` - rewrite the "five cards" section to the shipped shape.
- `test/conductor-panel.test.ts` and `e2e/specs/settings-conductor.spec.ts` - rework the affected
  cases and add the bound spec.

### Non-goals

- **The lede, the `01/02/03` commissioning ladder and the plugin prose stay.** Trimming them was
  explicitly deferred in the review, so they are out of scope here.
  `test/settings-sidebar-render.test.ts` fingerprints the panel by the string "Conductor
  commissioning progress", which keeps passing only while they remain.
- **No repo-scoped pipelines deep link.** See the decision below.
- **No server change.** No route, schema, migration, or worker moves. `MAX_PIPELINE_REPOS = 50` and
  the consent model are untouched.
- **No `ConsoleTable` generalization.** The rejected "console split" alternative wanted it; this
  shape does not.

## Repository findings

These were read in this repository. Several contradict what the design drawing implies, which is
why they are recorded rather than left to be rediscovered.

1. **All six `conductor/*` anchors already render statically.** `ConductorPanel` has one
   unconditional `return` (`:385`), `.sc-controls` (`:438`) is not behind a config guard, and
   `ConsoleCard` always emits `data-anchor={anchor}` (`settings-console.tsx:77`). The five new
   search entries therefore need no new markup. That property is load-bearing:
   `renderToStaticMarkup` runs no effects, so an anchor moved behind a "config loaded" conditional fails
   `test/settings-search.test.ts:124-132` with *"a jump to nothing"*.
2. **The master-detail precedent** is `TaskSourcesPanel.tsx:1067-1162` with
   `.ts-master-detail` / `.ts-list-col` / `.ts-detail-col` (`styles.css:18019-18032`).
   `.ts-list-col` is `flex: 0 0 clamp(260px, 32%, 360px)`; the stack breakpoint is
   `@media (max-width: 900px)` at `styles.css:18053-18059`. The shape is the model; the `ts-`
   classes are not, because borrowing another panel's vocabulary is exactly the drift this phase
   removes from `skill-switch`.
3. **The width opt-out.** `.settings-pane > .settings-section` caps at 900px (`styles.css:17024`)
   and `.sc-solo` caps this panel at 760px (`styles.css:18636`). Task sources opts out with
   `.settings-pane > .ts-panel { max-width: none }` (`styles.css:17027`). This panel needs the
   same treatment: `sc-solo` leaves its class list, and the panel gains its own opt-out rule.
4. **Selection is plain local state, keyed by id, and is not addressable.** Task sources holds
   `useState<string | null>` (`:936`) with two effects that matter here:
   - drop the selection and hand focus back when the selected item disappears between polls
     (`:1008-1017`);
   - auto-select the first item so master-detail always has a detail (`:1019-1024`).
   The settings route grammar is category-only by design (`settings-registry.ts:317-322`), so the
   selected repository has no hash form and gaining one would be a change to that grammar. The
   key is `pipelineRepoKey(provider, repoRoot)` rather than a list index, because `useConductor`
   polls every `POLL_MS = 4000`.
5. **The counts and the filter are one fold.** `healthCounts` (`TaskSourcesPanel.tsx:786-804`)
   exists as one function precisely so a strip and a chip cannot disagree. The same reasoning
   applies here.
6. **`ConsoleStrip` is the tile component** (`settings-console.tsx:169`), with `aria-pressed`
   tiles that *are* the filter, which is what a read-only metric row would not be.
7. **`.sc-seg` has no CSS of its own**; layout comes from `.sc-field` (`styles.css:18881`) and
   `.sc-seg-row` / `.sc-seg-opt` (`:18943-18988`). `InspectorSettingsPanel.tsx:307-326` is already a
   two-option instance and is the closest model. `is-on` is applied by hand; there is no
   `:has(input:checked)` rule.
8. **`ConsoleSwitch` replaces `skill-switch`** (`settings-console.tsx:96`, `tone="ok"`). Its track
   is 38x22px against the old 15x15px checkbox, so the row's vertical alignment needs adjusting
   rather than assuming.
9. **`settingsRailDot`'s `id` already accepts `"conductor"`** (`settings-dots.ts:59-61`) - a
   `case` is enough, with no type widening. But `dotLabel` (`SettingsPage.tsx:81-108`) switches on **tone** before
   category, so reusing `live` or `armed` without a `category === "conductor"` arm makes a screen
   reader announce the Inspector's or YOLO's sentence on the Conductor row. A *new* tone instead
   needs a new `.settings-dot-<tone>` rule and a rank slot in `settingsGearDot`
   (`settings-dots.ts:98-104`).
10. **Both test fixtures build `pipelines: { present: true, observing: 0 }` only**
    (`test/settings-search.test.ts:65-70`, `test/settings-sidebar-render.test.ts:88-96`) - no
    `observedRepoKeys`, no `launchRuntime`. A dot keyed off `observedRepoKeys` reads `undefined`
    there, which makes `observing` the safer field unless the fixtures are extended deliberately.

## Decisions this phase makes

Two places where the approved drawing meets a repository that disagrees. Both are settled here so
the implementing agent does not have to reopen them.

### "Open pipelines" is a tab-level link, not a repo-scoped one

The mockup shows an **Open pipelines** button in the detail pane. A repo-scoped destination does
not exist: the grammar has only `#/runs/pipeline` and `#/runs/pipeline/:repoKey/:slug`
(`useWorkflowRoute.ts:352-362`, `:468-478`), there is no `:repoKey`-only form, and the panel holds
no run slug to build the two-segment address with. `PipelineRuns` has no repo-scoping input either
- it renders every observed repository and auto-picks a cross-repository lead run
(`PipelineRuns.tsx:59-63`).

**The tab-level link is what ships.** `{ page: "runs", kind: "pipelines" }` already exists and is exactly
what `App.tsx:2870` navigates to in the opposite direction. The wiring follows `onOpenRuns`
(`WorkflowSettingsPanel.tsx:265-276`, `SettingsPage.tsx:192`, `App.tsx:3007-3014`): an optional
callback prop, separate from `SettingsNavigate`, which is typed to settings categories and cannot
express a route that leaves settings. Optional so the render tests mount the panel without a router.

**The label has to match.** A button in a repository's detail pane saying "Open pipelines" that
lands on a cross-repository tab is a small lie. Prefer copy that does not promise scoping.
Repo-scoped navigation is a legitimate follow-up and is out of scope here.

### One tile row, not a metric row and a chip row

The mockup draws a read-only overview strip (Workspace / Registered / Dispatch ready / Need
attention) *and* a filter chip row (Managed / All / Ready / Failing). The plan's own rule is that
"the filter tiles are the counts", and two rows of numbers a few pixels apart is the disagreement
`healthCounts` exists to prevent.

**One `ConsoleStrip` carries the tiles, and they are the filter:** **Managed**, **All**, **Ready**,
**Failing**, each carrying its count from the shared fold, with **Managed** active on first render.
If the implementer finds a read-only summary genuinely earns its space alongside, that is a
judgement call to make and record - but it must not restate a number a tile already shows.

## Implementation shape

The route below is the order the work falls into, not a script. Each item names what the finished
state looks like; where the repository disagrees with one, the repository wins.

1. **Partition and count.** One fold over `offeredRepos(...)` returns the four buckets and their
   counts. *Managed* is `registered || enabled`. *Ready* is the existing dispatch-ready condition
   (`config?.enabled && repo.enabled`). *Failing* is a repository whose `PipelineRepoStatus` carries
   an error. It is one function, read by both the tiles and the list.
2. **Filter state.** A single object holding the active tile and the query, mirroring
   `SourceDirectoryFilters` (`TaskSourcesPanel.tsx:780-784`). The search haystack spans the whole
   union regardless of the active tile - name and `repoRoot`, lowercased substring, as today
   (`ConductorPanel.tsx:366-371`).
3. **Selection state.** `useState<string | null>` keyed by `pipelineRepoKey`, with the
   drop-when-gone and auto-select-first effects from finding 4. Focus returns to the row, falling
   back to the list container, as `TaskSourcesPanel.tsx:847-853` does.
4. **The directory column.** A search input on `.field-input`, the `ConsoleStrip` tiles, then a list
   of short rows - name, a status dot, and the ready mark. Rows are buttons carrying `aria-current`
   for the selected one (`TaskSourcesPanel.tsx:906-909` explains why `aria-current` and not
   `aria-selected`). The list's height is bounded so it scrolls in its own column. Under it, a count
   sentence naming both the filter and the whole, so the empty case on a fresh machine reads as
   "nothing registered yet" rather than as a broken page.
5. **The detail column.** For the selected repository: name, path, the three setup facts, the
   observation switch, the health line from the existing `repoHealthLine`, the ingest mode, the last
   read, any row error, and the primary action - **Register and observe**, **Enable observation**,
   or the ready state - reusing the existing handlers unchanged. The switch keeps
   `aria-label={`Observe pipelines in ${repo.name}`}`.
6. **Layout.** The two columns are wrapped together, the four `ConsoleCard`s move below them,
   `sc-solo` goes and the width opt-out arrives. The lede, the ladder and the plugin prose stay put.
7. **The switch and the radios.** `ConsoleSwitch` (`tone="ok"`) takes over from `skill-switch`, with
   the row alignment adjusted for the larger track. `.conductor-runtime-choice` gives way to the
   `sc-field sc-seg` structure modelled on `InspectorSettingsPanel.tsx:307-326`, and its CSS goes
   with it.
8. **CSS.** The Conductor master-detail, directory, row and empty-state rules arrive with a stack
   breakpoint; `.conductor-repos`, `.conductor-repo*` and `.conductor-runtime-choice` leave, having
   no markup left.
9. **Search entries.** Five `kind: "jump"`, non-risky entries in `settings-search.ts` for
   `conductor/pipelines`, `/detection`, `/enabled`, `/launch-runtime` and `/foreman-triage`, each
   with a distinct id, a label that collides with nothing, and honest keywords.
10. **The rail dot.** A `conductor` case in `settingsRailDot` and its `dotLabel` arm. Findings 9 and
    10 frame the tone choice; whichever way it goes is worth stating in the pull request.
11. **The pipelines callback.** A new optional prop on `ConductorPanel`, passed through
    `SettingsPage`'s `case "conductor"`, supplied by `App` as
    `navigate({ page: "runs", kind: "pipelines" })`.
12. **Docs.** `docs/pipelines.md:110-140` currently says "The panel holds five cards"; it will not,
    and its "Workspace repositories" bullet describes a list that no longer exists.

## Tests and verification

- **Unit** (`test/conductor-panel.test.ts`, 23 tests): roughly 9 touch row markup - `:319`, `:346`,
  `:370`, `:390`, `:404`, `:432`, `:448`, plus the two launch-runtime cases at `:143` and `:165`
  once the radios become `sc-seg`. Those need reworking against the new markup; the detection and
  installer cases should survive untouched. A new case pins that the directory defaults to the
  managed filter.
- **Registry tests**: `test/settings-search.test.ts`, `test/settings-dots.test.ts` and
  `test/settings-sidebar-render.test.ts` must all stay green. The last one still expects
  "Conductor commissioning progress".
- **E2E** (`e2e/specs/settings-conductor.spec.ts`, 12 tests): 5 reach rows through
  `page.locator("li.conductor-repo")` or the `Search workspace repositories` placeholder (`:44`,
  `:273`, `:287`, `:380`, plus `:210`'s neighbours). Those become selecting from the directory and
  acting in the detail pane. `:210`'s stale-consent test finds rows by the
  `Observe pipelines in <name>` aria-label and survives if that label is kept.
- **The bound spec, which is the point of the change.** It seeds many repositories through the daemon
  fixture and asserts the page does not render them all - that the directory opens on the managed
  set and the DOM row count stays small. This is the assertion that fails against the panel as it
  stands today, which is what makes it the useful one to have first.
- **A selection spec**: choosing a repository shows it in the detail pane, and the selection
  survives a poll rather than jumping.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` before
  `npm run test:e2e`. Two standing repository constraints apply here, both from `AGENTS.md`:
  e2e spends no model tokens, because every agent binary is redirected by
  `e2e/fixtures/fake-agents.ts`, and `e2e/` selects by role, label or placeholder rather than
  by `data-testid`.

## Merge and exit criteria

- The Conductor panel renders a directory and a detail pane, opening on managed repositories.
- With 200+ workspace repositories present, the page does not render a row per repository, and a
  spec proves it.
- All six `conductor/*` anchors are reachable from the settings palette; the rail row carries a dot
  with a distinct accessible label.
- No `skill-switch` and no `.conductor-runtime-choice` remain in `ConductorPanel.tsx`, and their
  dead CSS is gone.
- `docs/pipelines.md` describes the shipped panel.
- Typecheck, lint, unit, build and the Conductor e2e spec pass.

## Downstream handoff

Nothing depends on this phase. Three things later work should not casually change:

- the `Observe pipelines in <name>` aria-label, which e2e reaches rows through;
- the six anchor names, which the search index and the render test both bind to;
- selection keyed by `pipelineRepoKey`, which is what makes it survive the four-second poll.

Two follow-ups this phase deliberately leaves: collapsing the commissioning ladder into the header
once the overlap with the tiles has been lived with, and a repo-scoped pipelines deep link.

## Cross-phase audit record

- **Sole phase.** Every requirement in `plan.md` and every submitted selection is owned here:
  shape (directory and detail), default contents (managed first), and all three approved
  ride-alongs. The deferred prose-trim is recorded as a non-goal so it cannot be picked up by
  accident.
- **Audited against the source plan** after writing: the plan's "Open pipelines" button and its
  four-metric overview strip were both found to disagree with the repository or with the plan's own
  stated rule, and both are settled in *Decisions this phase makes* rather than left to the
  implementer.
- **No inherited or outgoing contracts**, since there is no adjacent phase. The three items under
  *Downstream handoff* are recorded for future work, not for a dependent phase.
