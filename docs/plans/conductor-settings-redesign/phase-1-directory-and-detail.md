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

### The pipelines action is a tab-level link, not a repo-scoped one

The detail pane carries a navigation action out to the pipelines surface. A repo-scoped
destination does not exist: the grammar has only `#/runs/pipeline` and `#/runs/pipeline/:repoKey/:slug`
(`useWorkflowRoute.ts:352-362`, `:468-478`), there is no `:repoKey`-only form, and the panel holds
no run slug to build the two-segment address with. `PipelineRuns` has no repo-scoping input either
- it renders every observed repository and auto-picks a cross-repository lead run
(`PipelineRuns.tsx:59-63`).

**The tab-level link is what ships.** `{ page: "runs", kind: "pipelines" }` already exists and is exactly
what `App.tsx:2870` navigates to in the opposite direction. The wiring follows `onOpenRuns`
(`WorkflowSettingsPanel.tsx:265-276`, `SettingsPage.tsx:192`, `App.tsx:3007-3014`): an optional
callback prop, separate from `SettingsNavigate`, which is typed to settings categories and cannot
express a route that leaves settings. Optional so the render tests mount the panel without a router.

**The label has to match, and it is "Open Pipelines tab".** A button in a repository's detail
pane saying "Open pipelines" that lands on a cross-repository tab is a small lie, so the mockup in
`plan.md` and `plan.html` names the tab explicitly and the implementation follows it. Repo-scoped
navigation is a legitimate follow-up and is out of scope here.

### One tile row, not a metric row and a chip row

An earlier draft of the mockup drew a read-only overview strip (Workspace / Registered / Dispatch
ready / Need attention) *and* a filter chip row (Managed / All / Ready / Failing). The plan's own
rule is that "the filter tiles are the counts", and two rows of numbers a few pixels apart is the
disagreement `healthCounts` exists to prevent. The four metrics mapped one-to-one onto the four
tiles, so the strip carried no number a tile did not. `plan.md` and `plan.html` now draw the single
row, and this section records why rather than leaving the collapse to be rediscovered.

**One `ConsoleStrip` carries the tiles, and they are the filter:** **Managed**, **All**, **Ready**,
**Failing**, each carrying its count from the shared fold, with **Managed** active on first render.
If the implementer finds a read-only summary genuinely earns its space alongside, that is a
judgement call to make and record - but it must not restate a number a tile already shows.

### The directory is paged, not just scrolled

A bounded scrolling column stops the *page* growing; it does not stop the DOM holding a row per
repository. Under the `All` tile that is 202 rows again, which is the exact defect this phase
exists to remove - so the height budget is not the bound, the pager is.

`docs/agent-guides/change-contracts.md` ("Ledger tables") already states the three properties, and
they are the component's rather than each panel's precisely so a panel cannot skip one:

- **One page of rows, at `CONSOLE_PAGE_SIZE`**, sliced through `consolePage`
  (`settings-console.tsx:324`), which clamps the page rather than trusting it. Its doc comment
  names why it is a named fold and not a `slice`: these lists are polled and filtered, so the row
  count moves under an operator sitting on the last page. Conductor polls at 4s and its tiles are a
  filter, so both halves of that apply here.
- **A height budget on the container, not on the rows**, so the pager cannot end up below the
  budget and out of reach.
- **The pager restarts with the filter**, because changing the tile is a new list.
- **Paging keeps the keyboard's place**: reaching the first or last page disables the button just
  pressed, and a browser blurs a control that becomes disabled, so focus is handed to the button
  that can still act.

**The directory is not a `ConsoleTable`, and must not be made one.** That component owns its own
heading, columns, scroller, pager and caption and has no prop for a selected row, while this list's
whole purpose is to drive the detail pane beside it. The change contract says as much in its last
paragraph - lists that are not settings ledgers keep their own shapes. What carries across is
`consolePage` and the four properties above, not the component. The pager's *markup* costs little
either: `.sc-pager`, `.sc-pager-range`, `.sc-pager-nav` and `.sc-pager-btn` are already in
`styles.css:19217-19264`, and the focus handoff is worked out in `settings-console.tsx:427-441` -
copy that reasoning rather than rediscovering why a disabled button loses focus.

`Managed` is 1 row on this machine, so no pager is drawn in the default state - the contract's
"absent, not disabled, when everything fits on one page". The pager appears when `All` is picked.

### What selection does when the rows move underneath it

The directory changes what it lists for four different reasons - the tile, the query, the page, and
the 4s poll - and the detail pane beside it holds one repository. Every one of those is a chance to
either strand the pane or move it under the operator, so the rule is written out rather than left
to whichever effect happens to fire first.

**Selection is keyed by `pipelineRepoKey(provider, repoRoot)`, never by index, and it is governed
by the union - not by what is currently on screen.**

- **Turning the page does not change it.** The pane keeps showing the repository the operator
  picked while they look for another; clearing it would empty the right-hand column on every page
  turn.
- **Changing the tile or the query does not change it either.** An explicit selection is not
  discarded because a filter stopped matching it - the operator chose that repository, and no
  filter interaction asked to un-choose it.
- **It clears only when the repository leaves the union**, which is the drop-when-gone effect from
  finding 4: consent withdrawn, the engine de-registers it, or a poll simply stops returning it.
  That effect keys on `offeredRepos`, exactly as `TaskSourcesPanel.tsx:1013` keys on the full
  `sources` list rather than on the filtered one.

**The state this leaves is real and needs a signal.** Select an unmanaged repository under `All`,
switch back to `Managed`, and the selected key is still perfectly valid in the union - so
drop-when-gone does not fire, and the detail pane shows a repository that has no row in the
directory beside it. Task sources has this behaviour today and gets away with it because its
default filter is *All*, so reaching the state takes deliberate effort. Conductor's default tile is
*Managed*, which is 1 row of 202 here, so it is an ordinary flow rather than a corner: open `All`,
pick something to look at, go back.

So the detail pane says when its repository is outside the current filter, and offers the tile that
contains it - the same shape as the empty-search answer above, and for the same reason: a narrow
default must never leave the operator somewhere that reads as broken with no way back. It is a line
in the pane, not a modal and not a toast.

**Auto-select-first fills a `null` selection from the first row of the current filtered set** -
deliberately *not* `union[0]`, which is what `TaskSourcesPanel.tsx:1022-1023` uses. Under a narrow
default tile, `union[0]` would routinely select a repository that is not on screen, manufacturing
the very off-filter state described above on first render. When the filtered set is empty, nothing
is selected and the pane shows the empty guidance instead; that is the correct answer on a fresh
machine with nothing registered.

## Implementation shape

The route below is the order the work falls into, not a script. Each item names what the finished
state looks like; where the repository disagrees with one, the repository wins.

1. **Partition and count.** One fold over `offeredRepos(...)` returns the four buckets and their
   counts. *Managed* is `registered || enabled`. *Ready* is the existing dispatch-ready condition
   (`config?.enabled && repo.enabled`). *Failing* is a repository whose `PipelineRepoStatus` carries
   an error. It is one function, read by both the tiles and the list.
2. **Filter state.** A single object holding the active tile and the query, mirroring
   `SourceDirectoryFilters` (`TaskSourcesPanel.tsx:780-784`). **The tile and the query are
   conjoined, not alternatives** - `matchesTile && (!needle || haystack.includes(needle))`, the
   shape `TaskSourcesPanel.tsx:838-845` already uses. The haystack itself spans name and
   `repoRoot`, lowercased substring, as today (`ConductorPanel.tsx:366-371`); it is the *fields*
   that are unrestricted, not the row set. Two consequences follow, both deliberate:

   - **A tile's count comes from the whole union, not from the visible rows.** It describes the
     population the tile names, exactly as `healthCounts` does (`:786-804`), so the count does not
     move while the operator types. The alternative - search overriding the tile - would leave the
     active tile and its number describing nothing on screen.
   - **A query matching only unmanaged repositories returns nothing while *Managed* is active.**
     This is the trap the managed-first default creates, and it is the one place the conjunction
     rule is user-hostile, so it gets an answer rather than a bare empty list: when the query
     matches under a wider tile, the empty state names that count and offers the tile. Task
     sources shows only `"No sources match these filters."` (`TaskSourcesPanel.tsx:922`), which is
     enough there because its default tile is *All*; it is not enough here.
3. **Selection state.** `useState<string | null>` keyed by `pipelineRepoKey`, with the
   drop-when-gone and auto-select-first effects from finding 4, behaving as
   "What selection does when the rows move underneath it" above sets out - in particular,
   drop-when-gone keys on the union while auto-select-first reads the filtered set, and neither
   the tile, the query nor the page clears an explicit selection. Focus returns to the row, falling
   back to the list container, as `TaskSourcesPanel.tsx:847-853` does.
4. **The directory column.** A search input on `.field-input`, the `ConsoleStrip` tiles, then a
   list of short rows - name, a status dot, and the ready mark. Rows are buttons carrying
   `aria-current` for the selected one (`TaskSourcesPanel.tsx:906-909` explains why `aria-current`
   and not `aria-selected`). The rows handed to the list are **one page**, sliced by `consolePage`
   from the tile-and-query result, with the page number reset when either changes; the height
   budget sits on the container so the pager stays reachable. Under it, a count sentence naming the
   page, the filter and the whole, so the empty case on a fresh machine reads as "nothing
   registered yet" rather than as a broken page.
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
- **The bound spec, which is the point of the change.** It seeds many repositories through the
  daemon fixture and asserts the page does not render them all: the directory opens on the managed
  set, **and the DOM row count stays at or under `CONSOLE_PAGE_SIZE` after switching to `All`**.
  Asserting only the managed default would pass against a directory that still emits a row per
  repository the moment `All` is picked - the same defect wearing a different filter - so the tile
  switch is the load-bearing half of this spec. It also pages forward once and asserts the
  selection made before the turn is still the one in the detail pane. This is the assertion that
  fails against the panel as it stands today, which is what makes it the useful one to have first.
- **A selection spec**: choosing a repository shows it in the detail pane, and the selection
  survives a poll rather than jumping.
- **An off-filter selection spec**, covering the transition this plan would otherwise leave to
  chance: select a repository under `All`, switch to `Managed`, and assert the detail pane still
  shows it, that it says the repository is outside the current filter, and that taking the offered
  tile brings its row back and leaves the selection unchanged. It also asserts the reverse never
  happens silently - changing a filter does not swap the pane to a different repository.
- **A search-and-filter precedence spec**, because the rule is invisible from either control alone
  and a later change could silently invert it: with *Managed* active, a query matching only an
  unmanaged repository renders no rows and the empty state offers the wider tile; taking that offer
  renders the match. It also asserts a tile's count does not change while the query is typed, which
  is the half of the rule the empty state cannot show.
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
- **Audited against the source plan** after writing: the plan's pipelines action and its
  four-metric overview strip were both found to disagree with the repository or with the plan's own
  stated rule, and both are settled in *Decisions this phase makes* rather than left to the
  implementer.
- **No inherited or outgoing contracts**, since there is no adjacent phase. The three items under
  *Downstream handoff* are recorded for future work, not for a dependent phase.
