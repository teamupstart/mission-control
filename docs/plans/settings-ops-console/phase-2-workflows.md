# Phase 2 - Workflows adopts the console shape, without growing a second run list

Source plan: [`plan.md`](plan.md). Direct prerequisite: **Phase 1**, which owns the rename
of the shared module and class vocabulary (D1) and must merge first.

## Outcome

**Settings → Workflows** stops being a flat stack of a checkbox, a repo editor, three number
boxes and a twelve-row `<dl>`, and becomes the console's control column: cards, a posture
line, a switch that carries its blast radius in its colour, and a **health strip whose tiles
navigate** to the runs they count. Two things become legible that are not today:

1. **Retention has a readout.** The panel sets three limits and shows no measurement of the
   thing being limited. `maxCompletedRuns` is capped at 1000 by default and the only related
   number on the page is "Retained runs", sitting under *Health*, unconnected to it.
2. **The twelve health scalars stop being a wall.** Six of them are zero on a healthy
   install; the two that mean "somebody must look" (`uncertainDeliveries`,
   `waitingDeliveries`) read identically to the four that are ordinary throughput.

## The finding that shapes this phase

**Workflows must not get a ledger.** `src/web/workflows/WorkflowRuns.tsx` (~1,560 lines) is
already the run list: cursor paging over `GET /api/workflow-runs`, SSE reconciliation
against `workflowRunSummaries`, per-run actions (resubmit, retry, cancel, prepare-pr,
recheck-inspector, restart-full, delivery retry/resolve), a state `<select>` over all ten
statuses, and `RUN_FILTER_CHIPS` (`All | Running | Needs you | Done`). The Workflows page
header already carries a **"Workflow settings →"** button pointing the other way.

A run table in the settings panel would duplicate the row renderer, the paging, the SSE
reconciliation and the filter axis, in a third CSS vocabulary, and would then disagree with
the real one the first time either changed. `useShipping` sets the precedent for the
opposite instinct - it reuses the Inspector's `/api/inspector/prs` rather than adding a
second route, because *"a second route returning the same rows under another name is how
the two eventually disagree about which PRs exist"*. The same argument forbids a second
run list here.

So this panel takes **the leaves and a strip**, and not the split. Its single column stays a
single column.

## Scope

In:

- The panel redrawn with `ConsoleCard` / `ConsoleSwitch` / `ConsoleState`, all four existing
  anchors preserved.
- A **navigating** health strip (`ConsoleLinkStrip`), tiles counting `WorkflowStatus` scalars
  and deep-linking into the Workflows page's run list, pre-filtered.
- A retention readout: what the limits are measured against.
- One new scalar, `deliveredDeliveries`, because "did Live delivery ever actually type
  anything in" is currently unanswerable fleet-wide.

Out:

- Any run table, run row, cursor or SSE subscription in this panel.
- Any change to what retention deletes or when. This phase reports the pressure; it does not
  re-tune the sweep.
- Threading `workflowRuns` from `App.tsx` into `SettingsPage`. Not needed once the strip
  navigates rather than lists, and it would put an unbounded map behind a settings panel.

## Repository findings this phase is built on

- `WorkflowSettingsState` (`src/web/useWorkflowSettings.ts`) is `{ config, status, update, error }`,
  polling `/api/workflows/config` and `/api/workflows/status` every 5000ms. `update` PUTs the
  **whole** `WorkflowConfig` blob, not a patch. Its exported poll helpers
  (`applyWorkflowPoll`, `pollRacedByWrite`, `pollIsLatest`) and the `adopted` one-shot flag
  exist so a poll cannot clobber a half-typed retention box - **keep all of that**; it is the
  same class of guard as `useInspector`'s write clock.
- `WorkflowStatus` (from `WorkflowManager.status()`, i.e. `store.workflowStatusCounts()` plus
  five in-memory fields) carries: `retainedRunCount`, `activeRuns`, `queuedPersonaCalls`,
  `runningPersonaCalls`, `waitingDeliveries`, `uncertainDeliveries`, `inspectorGates`,
  `lastRecoveryAt`, `lastRetentionAt`, `lastRetentionCompacted`, `lastRetentionDeleted`,
  `lastRetentionError`. All fleet-wide SQL scalars; **no** per-run breakdown, no repo
  dimension, no time bucketing.
- `retainedRunCount` is `SELECT COUNT(*) FROM workflow_runs` - **every** run row, not just
  finished ones. It is therefore not directly comparable to `maxCompletedRuns`, which counts
  completed/cancelled families. Do not render it as "N of 1000 used" without fixing that.
- The panel currently renders those twelve as a `<dl className="wf-settings-health-grid">`,
  with a hint stating the privacy contract: *"Counters only... No prompt, diff, transcript,
  Persona guidance, model output or delivery payload passes through here."* That contract is
  a feature and survives this phase verbatim.
- There is **no** count of `delivered` deliveries anywhere - not in `workflowStatusCounts()`,
  not on `WorkflowRunSummary`, not on any route. `workflow_deliveries` has the rows
  (`state = 'delivered'`, `deliveredAt`), and `listDeliveriesByState(state)` exists but is
  used only by recovery.
- Retention compaction blanks delivery `payload` and coarsens `error`, so any delivery
  readout can show state and timing but never content - which is consistent with the privacy
  contract above.
- `WorkflowSettingsPanel` is the one settings panel that does **not** receive `onNavigate`
  (`SettingsPage.tsx` passes only `state`). The navigating strip needs a way out of the
  panel; see below.

## Implementation

### 1. Two new scalars

In `store.workflowStatusCounts()`, beside the existing subqueries:

- `deliveredDeliveries`: `COUNT(*) FROM workflow_deliveries WHERE state = 'delivered'`.
- `completedRunCount`: completed/cancelled run families only - the population
  `maxCompletedRuns` actually caps, so the retention readout can compare like with like.
  `retainedRunCount` stays as it is; it answers a different question and other things read it.

Both are `WorkflowStatus` fields; the type is in `@shared/workflow.ts`.

### 2. Navigation out of the panel

`WorkflowSettingsPanel` needs to reach the Workflows page's run list with a status filter.
The route grammar already exists (`useWorkflowRoute.ts`, `WorkflowRunFilters`, `WorkflowTab`)
and the Workflows page header already links into settings, so this is the return leg.

Pass a `onOpenRuns(filter: WorkflowRunFilters)` prop from `SettingsPage`, the way the other
three panels take `onNavigate`. Do **not** reuse `SettingsNavigate` - it is typed to settings
categories and this leaves the settings page entirely; a second, honestly-typed prop is
cheaper than widening that one.

### 3. `ConsoleLinkStrip`

A sibling of `ConsoleStrip` in `settings-console.tsx`, sharing the tile CSS and nothing else.
Same visual, different semantics: no `active` state, no `aria-pressed`, each tile is a link
to somewhere else. Its doc comment must say why it exists - that `ConsoleStrip`'s tiles are a
filter over rows on the same screen and sum to them, and that these count a fleet-wide scalar
and sum to nothing - so nobody later "fixes" the missing tally.

Tiles, in escalation order, each navigating to the runs list pre-filtered:

| Tile | Count | Tone | Goes to |
|---|---|---|---|
| Needs you | `uncertainDeliveries` | danger | runs, `waiting_for_session` |
| Waiting | `waitingDeliveries` | attention | runs, no filter |
| Inspector gates | `inspectorGates` | attention | runs, `waiting_for_inspector` |
| Running | `activeRuns` | plain | runs, `running` |
| Delivered | `deliveredDeliveries` | ok | runs, `completed` |

The remaining scalars (`queuedPersonaCalls`, `runningPersonaCalls`, the four
`lastRetention*`/`lastRecovery*` fields) are not tiles - they are throughput and sweep
bookkeeping. They stay as a compact key/value list inside the Health card, keeping
`data-anchor="workflows/health"`.

### 4. The cards

- **Live delivery** (`workflows/live-delivery`): `ConsoleCard` with a `ConsoleSwitch` in the
  action slot, `tone="danger"` - this is the one switch in the app that types into a live
  agent's terminal. Keep the `WorkflowConfirmModal` on enable (it goes through the overlay
  registry deliberately; `window.confirm` is invisible to the registry and leaves the fleet's
  global key handler live behind it). Keep `.wf-settings-live-warn` while enabled, and add a
  `ConsoleState` posture line above it: `danger` "Live - repairs are typed into agent
  sessions", `off` "Off - nothing is delivered", `unknown` before the daemon answers.
- **Allowed repositories** (`workflows/allowlist`): the existing inline editor moves inside a
  card unchanged. **Do not** replace it with `TrustGrantSummary` - Workflows is not a column
  of the Trust matrix, and pointing at Trust for a grant Trust does not hold would be a dead
  link. If it should be, that is its own plan.
- **Run retention** (`workflows/retention`): the three number fields, plus the new readout -
  `completedRunCount` against `maxCompletedRuns`, and the last sweep's compacted/deleted
  counts moved here from Health, where they were never about health. Keep `readRetention()`,
  `retentionShortens()` and the danger confirm on a shortening save; keep the draft-as-string
  behaviour and the `adopted` flag.
- **Health** (`workflows/health`): the strip above it, the residual scalars inside it, and
  the privacy sentence verbatim.

## Tests

- Extend `workflow-settings-panel.test.ts` rather than replacing it: its "every control the
  search index points at is on the panel" and "the anchors are drawn before the daemon has
  answered" cases are exactly what a rewrite endangers.
- New: the strip's tiles carry the scalars they claim (a status fixture in, five counts out);
  a tile with a zero count still renders (a missing tile reads as a missing subsystem);
  `ConsoleLinkStrip` renders links, not `aria-pressed` buttons - the one assertion that stops
  it drifting back into a filter.
- New: `deliveredDeliveries` and `completedRunCount` counted from a seeded store
  (`workflow-store` test patterns), including that `completedRunCount` excludes active runs
  while `retainedRunCount` does not.
- Null `status` still renders "Workflow health is unavailable - the daemon has not answered."

## Exit criteria

- The panel is the console's control column, with every existing anchor intact and the
  retention limits shown against a real measurement.
- Clicking a health tile lands on the Workflows page's run list, filtered to that state.
- No run row, cursor or SSE subscription exists in the settings panel.
- `npm run typecheck`, `npm test`, `npm run build` green; README's Workflows section and the
  settings-page console sentence updated in the same change.

## Cross-phase audit

Checked against Phase 1 before writing: this phase adds `ConsoleLinkStrip` beside
`ConsoleStrip` rather than adding a mode to it, so Phase 1's "tiles sum to rows" invariant
and its test survive untouched. It consumes the `sc-` vocabulary and the renamed module and
renames nothing. It adds no route, so it cannot collide with Phase 1's
`GET /api/foreman/episodes`. The only shared file both phases edit is `styles.css`, in
different sections, and `settings-console.tsx`, which Phase 1 finishes before this starts.
