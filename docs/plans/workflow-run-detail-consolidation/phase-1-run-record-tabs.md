# Phase 1: Run record tabs - shell, Deliveries, Intent

> Line numbers in this document are locators as of the branch's merge base, not identities.
> Find the symbol or heading; treat a drifted number as drift.

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

The workflow run detail page stops stacking its records and starts offering them. A tab bar sits
where the Review worklist section is today; the worklist is the first and default tab, and Deliveries
and Intent join it as siblings. Repair delivery goes from four 560px cards to four table rows.
Captured intent leads with the refined goal and collapses its nine human decision bodies, which is
the 2,996px block that dominates the page today.

Measured against run `2a8b89dc` round 2, this phase removes roughly 5,100px of the 7,997px total
without hiding anything: every field and every action is still reachable, and the tab labels carry
the counts so an unvisited pane still reports.

## Entry criteria and dependencies

No phase dependencies. Requires a checkout of the default branch with the plan artifacts present.

## Scope

- A `RunRecordTabs` container in `src/web/workflows/WorkflowRuns.tsx` owning the tab list, the
  selected pane, the counts and the amber badge.
- Review worklist becomes the default pane, unchanged internally.
- The deliveries section becomes the Deliveries pane, rewritten as a ledger.
- The captured context section becomes the Intent pane, with per-decision disclosures.
- The `pane` field on the runs route.
- `runRecordSummary` in `src/web/workflows/run-model.ts`.
- CSS for the tab panes and the ledger table.

## Non-goals

- Image evidence and Evidence readiness. They stay as their own sections below the tab container
  until Phase 2 moves them. This is a deliberate intermediate state: the page is shorter and
  operable, and the two remaining sections behave exactly as they do today.
- The Inspector gate and the Foreman completion claim. Phase 3.
- The Review worklist's internals: its rail, its segment control, its change detail pane and its
  Persona directive controls are not touched.
- Workflow-owned model calls and the Timeline.

## Repository findings

- `.workflow-tabs` already exists in `src/web/styles.css` with `.workflow-tabs button.active`
  and `.workflow-tab-badge`. `src/web/pipelines/RunsKindTabs.tsx` is the working reference for a
  `role="tablist"` usage. Reuse both; do not introduce a second tab family.
- The Review worklist section (around line 2465) carries
  `useTourTargetRef<HTMLElement>("library:run-worklist")`, declared near line 1849, and
  `src/web/tour/tours/library.ts` steps onto it. The ref must stay on a node that is present in
  the DOM whenever the worklist pane is the selected one. Since the worklist is the default pane
  this is satisfied by rendering the default pane eagerly; confirm the tour still passes rather than
  assuming it.
- The deliveries section is `WorkflowRuns.tsx:2652-2741`. Its heading already switches between
  "Repair delivery" and "Deliveries to the session" depending on whether any delivery is a session
  action; the pane label replaces both with "Deliveries", and the distinction moves to the row's
  Kind column, which already renders `deliveryKindLabel` from `run-model.ts:1344`.
- `e2e/specs/workflow-session-action-run.spec.ts` asserts
  `getByRole("heading", { name: "Deliveries to the session" })`. That heading is gone; the spec must
  assert the pane and the row instead.
- The captured context section is `WorkflowRuns.tsx:2742-2866`, including the three degraded arms
  (`not_captured`, `corrupt`, and the unreadable-context arm). Those arms are states of the Intent
  pane, not separate sections, and must keep their `role="alert"` copy.
  `test/workflow-runs-render.test.ts` asserts two of them (search for `Captured intent and evidence`).
- `useWorkflowRoute.ts` parses `#/runs/:runId` and serialises it in `missionRouteHash`. Query
  parameters are read once for both `runs` spellings and only survive if they have a typed field, so `pane` needs a
  field on the runs route, a parse arm and a serialise arm.

## Implementation steps

1. **`src/shared/` is not involved.** Confirm this before starting: nothing in this phase changes a
   wire contract. If a step seems to need one, stop and re-read the plan.

2. **Add the pane id union and the route field.** In `useWorkflowRoute.ts`, declare the pane ids as a
   `const` tuple with a type guard beside `LIBRARY_SURFACES`, add an optional `pane` to the `runs`
   route, parse it from the `pane` query parameter alongside `status`/`workflowId`/`session`, and
   serialise it in `missionRouteHash`. An unrecognised value takes the default rather than being
   carried into the address bar. Phase 2 and Phase 3 add their ids to this tuple and nothing else.

3. **Add `runRecordSummary` to `run-model.ts`.** One function over `WorkflowRunDetail` and the viewed
   submission returning what the labels and the panes need: delivery counts by state, the newest
   delivered timestamp, and the intent facts (decision count, total decision characters, compaction
   status, snapshot flags). Keep it a pure selector with a `node:test` case; the view must not count
   anything itself.

4. **Build `RunRecordTabs`.** A component in `WorkflowRuns.tsx` taking a pane registry of
   `{ id, label, count, blocking, render }`. It renders a `.workflow-tabs` `role="tablist"` with one
   `role="tab"` per pane carrying `aria-selected`, arrow-key movement between tabs, and the count as
   a small pill; `blocking` renders the amber `.workflow-tab-badge`. A pane whose `render` returns
   null is omitted from the bar entirely. Selecting a tab updates the route.

5. **Select a blocking pane when the route names none.** The badge alone does not satisfy the plan's
   constraint that a blocking state is surfaced *without a click*, so the initial selection resolves
   in this order, deterministically:

   1. the pane the route names, **when that pane is registered and its `render` returns content for
      this run**. An explicit pane wins over a blocking one, so a link and the back button stay
      honest. It wins only under that condition: a pane is conditional (Phase 3's Completion is
      absent on a run with no gate and no claim), so a stale or hand-typed
      `pane=completion` would otherwise select a tab that is not in the bar and leave the container
      showing nothing. An unavailable pane is ignored for selection and falls through to the rules
      below. Do not rewrite the hash on load to erase it: rewriting history under a reader who has
      just arrived costs them the back button, and the next tab they pick updates the route anyway;
   2. the worklist, when the worklist itself is blocking. It is the primary object, and a run with
      both an open change and a refused delivery should not bury the change;
   3. the first blocking pane in tab order;
   4. the worklist.

   `blocking` means "this pane holds something that stops the run", never "this pane has warnings".
   In this phase that is a refused or uncertain delivery on Deliveries, and a corrupt or unreadable
   captured context on Intent. Later phases add their own conditions under the same rule.

   **This changes the library tour's assumption.** `src/web/tour/tours/library.ts` has a `run-moving`
   step whose `prepare` calls `context.navigation.showRun(...)` and whose `ready` requires the
   resolved element, so on a run with a refused delivery the worklist would not be mounted and the
   step would fall back to its "the run is opening" copy. Make that `prepare` open the run on the
   worklist pane explicitly rather than relying on the default.

6. **Move the worklist in.** The existing section becomes the first pane. Keep the `aria-label`,
   keep `tourWorklistRef` on the pane's root, and keep the join and gate `<details>` packets that
   currently sit inside that section with it.

7. **Write the Deliveries pane.** A stat strip (delivered, refused, uncertain, newest) over a table
   with one row per delivery: round and segment, kind, state chip, delivered time, payload hash and
   character count, plus a disclosure that expands the payload in place. Rows are filtered to the
   viewed round with an explicit control to show every round. Preserve, unchanged: the pruned-payload
   sentence, `ErrorLine`, the retry button for a refused delivery with its bound-session tooltip, and
   every `deliveryResolutionActions` button for an uncertain delivery with its confirm dialog. A
   refused or uncertain delivery sets `blocking` on the pane.

8. **Write the Intent pane.** Lead with the refined goal. Render the snapshot facts as a chip row
   (compaction status, HEAD, working tree, diff, transcript, standards) and keep the full evidence
   snapshot `<details>` with its fact list and its pruned-retention copy. Then four disclosures:
   original goal, human decisions, acceptance criteria, compacted constraints.

9. **Collapse the human decisions.** This is the submitted decision and the largest single win. Each
   decision becomes one row carrying its source kind and id, its character count, whether it has a
   rationale, and its first line clamped to a single line. Clicking a row expands that decision's
   body and its rationale in place. Nothing is truncated on expansion; the full text is still there.
   Keep the three degraded arms (`not_captured`, `corrupt`, unreadable) as states of this pane with
   their existing `role="alert"` copy.

10. **CSS.** Add the pane, stat strip, ledger table and disclosure-row rules to `styles.css` near the
   existing `.wf-run-*` block. Do not re-declare any horizontal inset inside a modal; nothing in this
   phase renders into one.

## Tests and verification

- `node:test` for the route: `pane` parses, round-trips through `missionRouteHash`, and an
  unrecognised value falls back without appearing in the hash.
- `node:test` for `runRecordSummary`: counts, the newest timestamp, and the intent facts, including
  the empty and single-delivery cases.
- `renderToStaticMarkup` cases in `test/workflow-runs-render.test.ts` for the tab labels and their
  counts, the delivery row, the collapsed decision row's summary line, and each of the three
  degraded intent arms. Update the assertions at `:1539` and `:1546` to the pane's markup.
- A `node:test` case for the initial-selection order as a pure function over the pane registry and
  the route: an explicit route pane wins over a blocking pane; a route naming a pane that is not
  registered for this run is ignored and the fallback applies; a blocking worklist wins over a
  blocking Deliveries; a blocking Deliveries wins when the worklist is clean; the worklist is the
  final fallback.
- A new Playwright spec in `e2e/`: the worklist pane is selected on load, the Deliveries and Intent
  tabs are reachable by role and accessible name, a delivery row expands its payload, a human
  decision row expands its body, the tab counts match the run, and a refused delivery puts the amber
  badge on the Deliveries tab and its retry button still reaches its route. Assert that on a run
  with a refused delivery the delivery's own content is **visible on first paint**, not merely that
  its tab carries a badge, and that a link naming the worklist pane still opens on the worklist.
- Update `e2e/specs/workflow-session-action-run.spec.ts` to assert the Deliveries pane and a
  session-action row rather than the removed heading.
- Run the library tour spec, including against a run whose blocking pane is not the worklist; the
  `run-moving` step must still find its target rather than falling back.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `npm run test:e2e`.

## Merge and exit criteria

- The run detail page renders the tab bar with three panes, the worklist selected by default.
- Image evidence, Evidence readiness, the Inspector gate and the Foreman completion claim still
  render as their own sections below the container, unchanged.
- Every delivery and intent field and action that rendered before still renders and still works.
- A link carrying `pane` opens on that pane, and changing rounds preserves the selected pane.
- A run whose blocking state is not in the worklist opens on the pane holding it, with no click.
- A route naming a pane that does not exist for the run lands on a valid pane rather than an empty
  container, and does not silently rewrite the address bar.
- All verification above passes.

## Downstream handoff

Phase 2 and Phase 3 may rely on:

- `RunRecordTabs` and the `{ id, label, count, blocking, render }` pane registry. Add a pane; do not
  reimplement the bar, the badge, the keyboard handling or the route wiring.
- The initial-selection order, including its rule that an explicit route pane wins only when that
  pane is registered and renderable. A later pane participates by setting `blocking` honestly; it
  must not add a selection rule of its own, and a conditional pane needs nothing beyond returning
  null from `render`.
- The pane id tuple in `useWorkflowRoute.ts`. Add an id to the union and nothing else.
- `runRecordSummary`. Extend it with new fields; do not count in the view.
- The ledger table and stat strip CSS classes this phase introduces.

They must not change: the worklist's position as the first pane and the final fallback, the tour
ref's node, the selection order, or the semantics of `blocking` (it means "this pane holds something
that stops the run", not "this pane has warnings").

## Cross-phase audit record

- Written first; nothing earlier to reconcile.
- Reconciled against `phased-plan.md` after review. The index had stated "an explicit route pane
  always wins" without this file's presence guard, so the one contract read two ways. The index now
  carries the guard, and this step spells out what "present" means and that a stale value is ignored
  rather than rewritten.
- Reconciled against the source plan after review. The plan requires that a blocking container
  "opens itself"; this file had specified only the amber badge and a worklist default, which is
  weaker than the approved constraint. The selection order in step 5 and its tests restore it, and
  the library tour's `prepare` was pulled into this phase because that rule is what breaks the tour's
  assumption. Phase 2's `blocking` condition was narrowed in the same pass.
- Reconciled against Phase 2 and Phase 3 after both were written. The pane registry gained the rule
  that a pane whose `render` returns null is omitted from the bar, which Phase 3 requires so that
  Completion is absent on a run with no gate and no claim; that rule is owned here rather than being
  special-cased later. No other change was needed: Phase 2 and Phase 3 both consume this phase's
  contracts additively.
