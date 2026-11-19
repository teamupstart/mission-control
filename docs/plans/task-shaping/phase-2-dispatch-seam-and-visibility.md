# Task shaping - Phase 2: Dispatch seam and visibility

## Outcome

A dispatched task is shaped. With the flag on and a shaper registered, the pending tile reads
"Shaping context", the worker's first prompt ends with a "Task context" section, and the
session shows what it received and whether anything was degraded. A failing or slow shaper
never stops the launch. With Phase 1 this completes the first slice (D3).

## Entry criteria and dependencies

- Phase 1 is merged. No other phase.

## Scope

- The seam in `Dispatcher.dispatch` and the section in turn one.
- `Task.shaping`, its column, the delivered-text table and its route.
- "Shaping context" in the pending tile, the chip, the viewer, the board and rail marker.
- The `shaping` field in task reads, including the MCP tools.

Not here: assignment into a live session and pipelines (non-goals), Settings (Phase 3).

## Repository findings

- **The seam.** `src/server/dispatcher.ts`: `taskPlanDiscovery` at line 718, the closure at
  721 to 731, its two calls at 732 and 743. Dependencies are injected through the constructor's
  `deps` object, where `standingInstructions?: typeof standingInstructionsForLaunch` sits
  (line 349). FR-05 will add `appendRepoTaskSkills` to the same closure: keep this edit to one
  awaited call before the closure and one helper call inside it.
- **Persistence.** `claim_warnings` is the model in `src/server/db.ts`: `addColumn(d, "tasks",
  "claim_warnings", "TEXT")`, `readTaskClaimWarnings` spread by `rowToTask`, and the upsert
  column lists.
- **Types.** `Task.claimWarnings` and `TaskSummary.claimWarnings` in `src/shared/types.ts`.
- **Progress copy.** `phaseCopy` in `src/web/components/PendingDispatch.tsx` already swaps the
  line when `task.provisioning` is set. That field is derived and never persisted, wired in
  the `Dispatcher` constructor through `registry.setTaskProvisioningSource`.
- **Session surfaces.** `StandingInstructionsChip` and `TaskClaimWarnings` are rendered in
  `src/web/components/layouts/ConsoleDetail.tsx`. The chip's modal is the pattern for the
  viewer.
- **Task reads.** `get_task` and `list_tasks` in `src/mcp/server.ts` return JSON records built
  by the daemon.

## Steps

1. **Seam.** Add `shapeTask` to the dispatcher's injected dependencies. After
   `taskPlanDiscovery`, when `featureEnabled("task-shaping")`, build the input from
   `provisioned`, the worktree paths, the runtime and the after-work workflow, mark shaping in
   progress, await `shapeTask`, clear the mark, and run the existing settled check. Append
   `section` through one helper, after `withTaskKindContract`, so both `composeTurnOne` calls
   carry it. An empty section changes nothing.
2. **Record.** `Task.shaping` and `TaskSummary.shaping`, column `tasks.shaping`, and table
   `task_shaping_text (task_id primary key, text, created_at)` for the delivered section.
   The record describes the task's latest launch and nothing older. Every dispatch settles it
   at the seam, whether or not shaping ran, through one database function in one transaction,
   and the task patch carries the result. A launch that received a section replaces the
   summary and the text together. A launch that received none, because no shaper applied or
   the flag is off, sets the column to null and deletes the row together. A task that has no
   record is not written to. `GET /api/tasks/:id/shaping` returns both, or neither when the
   task has no record.
3. **Progress.** A derived, unpersisted mark in the manner of `Task.provisioning`.
   `phaseCopy` reads "Shaping context" while it is set.
4. **Chip and viewer.** A `ShapingChip` beside the standing-instructions chip: "Context: N
   entries", or an amber "Context degraded". Its viewer, "Context this session received",
   lists each shaper's origin, outcome, reason, duration and version, each entry, a
   "truncated" note, and a "credential value removed" note for a shaper whose record is
   marked `redacted`. It follows the modal inset rule in the repository instructions.
5. **Marker.** A small degraded marker on the board card and rail row, beside claim warnings.
6. **Task reads.** The JSON record gains `shaping` with `state` and a one-line `summary`.
7. **Docs.** Fill "Seeing what was added" in `docs/task-shaping.md`. Add the turn-one order to
   `docs/dispatch-and-runtimes.md`.

## Data, API and compatibility

- One additive column and one new table, each beside its upgrade path in `db.ts`.
- With the flag off, or with no shaper that applies, turn one, argv and process count are
  byte-identical to today, and no record is written. A record left by an earlier launch of
  the same task is cleared (step 2).
- Order with FR-05 repository task skills when both exist: kind contract, task context,
  repository task skill.

## Tests and verification

- `test/dispatcher-shaping.test.ts`, beside `test/standing-instructions-delivery.test.ts`:
  byte-identical turn one with the flag off and with no shaper; the section's position in both
  turn-one variants; a rejecting or slow `shapeTask` stand-in still launches and marks the task
  degraded; identical text for Claude, Codex and Pi on both runtimes; a shaped launch followed
  by a second dispatch of the same task, once with its shaper switched off and once with the
  flag off, leaves no summary and no text.
- A test that composes a 64 KiB section and delivers it through the SDK, paste and Pi
  launch-argument paths. If one path cannot carry it, lower the maximum and record that here.
- Database tests for the column and table on an upgraded database, and for the one function
  that replaces or clears both in one transaction.
- `renderToStaticMarkup` tests for the chip's states.
- `e2e/specs/task-shaping.spec.ts` with fake agents and `e2e/fixtures/fake-shaper.mjs` (modes
  ok, degraded, slow, garbage): "Shaping context" appears, the chip reads "Context: 2
  entries", the viewer lists them, a slow shaper still launches and shows "Context degraded"
  with its reason, a second dispatch of the same task after its shaper is switched off shows
  no chip, and `expectContentClearsBorder` passes on the viewer.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## Merge and exit criteria

- Every item in the Outcome is demonstrated by a test or spec.
- The byte-identical tests pass.
- A launch that received no shaping context shows none: no summary, text or chip from an
  earlier launch of the same task.
- No model tokens are spent by any test.

## Handoff

Later phases may rely on the task record and the viewer showing whatever the engine returns,
including the `origin` and `sha256` that Phase 4 fills. They must not add a second writer of
`tasks.shaping`.

## Cross-phase audit

- Uses only Phase 1's `shapeTask` contract. No change to Phase 1 was needed. Owns D7, D11 and
  the dispatch half of D3.
- Checked against Phase 4: the viewer already renders `origin`, so that phase adds no session
  surface.
- Review of the plan pull request, 2026-11-19, the operator's choice: the record is cleared
  by a launch that received no section. Before, step 2 replaced the text only when a launch
  was shaped and wrote nothing otherwise, so an unshaped retry kept showing the earlier
  launch's summary and text. The viewer also gained the note for a `redacted` shaper, which
  Phase 5 sets.
