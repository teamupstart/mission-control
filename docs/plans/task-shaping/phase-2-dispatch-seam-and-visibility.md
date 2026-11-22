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

Also here: the second call site in `TaskManager.assign` (decision 21 in `phased-plan.md`).

Not here: pipelines (a non-goal), Settings (Phase 3).

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
   `provisioned`, the worktree paths, the runtime, the after-work workflow and `trace`: the
   trace context the session's agent is launched with (`sessionTraceContext` for its session
   id), or null when it is launched with none. Then mark shaping in progress, await `shapeTask`, clear the mark, and run the existing settled check. Append
   `section` through one helper, after `withTaskKindContract`, so both `composeTurnOne` calls
   carry it. An empty section changes nothing.
   **Budget against the whole turn one.** Everything `composeTurnOne` needs is known before
   the seam, so compose both turn-one variants without the section first and measure the
   larger. Each harness entry in `src/server/harness/` declares its delivery path's byte
   ceiling for turn one, null when the path has none, as measured by the delivery test below.
   For example, a launch argument on Linux is capped at 128 KiB by the kernel. A launch
   argument also shares the platform's combined limit for all arguments and the environment
   (`ARG_MAX`, read once with `getconf`), so for that path the allowance is the smaller of
   two remainders: the per-argument ceiling less the larger variant, and the combined limit
   less every other argument and every environment string of this launch, each counted with
   its terminator and pointer. Measure the actual argv and environment the launch will use.
   Pass `maxSectionBytes`: that allowance, less a fixed margin for the section heading, and
   never below 0. Shaping then
   never makes a task that launches today fail to launch. The section is cut instead, and
   the record says it was truncated and why.
2. **Record.** `Task.shaping` and `TaskSummary.shaping`, column `tasks.shaping`, and table
   `task_shaping_text (task_id primary key, text, created_at)` for the delivered section.
   The record describes the latest launch that reached a worker, and nothing else. What
   `shapeTask` returned is held in memory during the dispatch and committed only when turn
   one has been handed to the worker: after `dispatchEmbedded` returns on the SDK arm, and
   after `deliverIntent` on the terminal arm. A dispatch that fails before that point writes
   nothing, so the previous launch's record stays as it was. The commit is one database
   function in one transaction, whether or not shaping ran, and the task patch carries the
   result. A commit that fails is logged and never fails the launch. Each record names the
   session it was delivered to, `sessionId`, set in the same transaction. It follows that
   session across a resume, re-keyed where `session_standing_instructions` rows are re-keyed
   in `src/server/db.ts`. Readers compare it with the session they show, so after a failed
   commit the new session shows no context rather than the previous launch's. The summary
   and the text are settled separately. `tasks.shaping` is set to the summary, or to null when no shaper applied or the flag is off. The `task_shaping_text` row
   is replaced when the section is not empty and deleted when it is. So a launch whose only
   shaper failed or timed out keeps its degraded summary and its reason and has no text row,
   and a launch that no shaper applied to has neither. A task that has no record is not
   written to. `GET /api/tasks/:id/shaping` returns the summary and the text that exist.
   Every reader goes through one shared predicate, `currentShaping(task)` in
   `src/shared/shaping.ts`: the record counts only while its `sessionId` is the task's
   current `sessionId`. Task reads, this route, the board and rail markers, the chip and the
   viewer all use it, so a redispatch whose commit failed shows no earlier context or
   `degraded` anywhere.
3. **Progress.** A derived, unpersisted mark in the manner of `Task.provisioning`.
   `phaseCopy` reads "Shaping context" while it is set.
4. **Chip and viewer.** A `ShapingChip` beside the standing-instructions chip, shown only
   when the task's record names this session: "Context: N
   entries", or an amber "Context degraded". Its viewer, "Context this session received",
   lists each shaper's origin, outcome, reason, duration and version, each entry, a
   "truncated" note, and a "credential value removed" note for a shaper whose record is
   marked `redacted`. It follows the modal inset rule in the repository instructions.
5. **Marker.** A small degraded marker on the board card and rail row, beside claim warnings,
   from `currentShaping(task)`.
6. **Task reads.** The JSON record gains `shaping` with `state`, the `sessionId` it
   describes, and a one-line `summary`, present only when `currentShaping(task)` returns it.
7. **Docs.** Fill "Seeing what was added" in `docs/task-shaping.md`. Add the turn-one order to
   `docs/dispatch-and-runtimes.md`.

## Data, API and compatibility

- One additive column and one new table, each beside its upgrade path in `db.ts`.
- With the flag off, or with no shaper that applies, turn one, argv and process count are
  byte-identical to today, and no record is written. A record left by an earlier launch of
  the same task is cleared when this launch reaches its worker (step 2).
- Order with FR-05 repository task skills when both exist: kind contract, task context,
  repository task skill.
- Schema step 42. 38 went to #1556, 39 to the asynchronous input inbox, 40 to the work unit id
  and 41 to review-message deliveries, all of which merged first, so this phase renumbered as the
  later one. Whichever of this phase and FR-05 merges second
  renumbers its step.

## Rebase note: FR-05 repository task skills (#1565)

This phase and FR-05 share the `composeTurnOne` closure in `Dispatcher.dispatch`. Whichever
merges second resolves it the same way:

1. Run `resolveRepoTaskSkills` first, before the shaping step.
2. Measure turn one with `appendRepoTaskSkills` applied, so the budget sees the turn as sent,
   and call `shapeTask` with the `maxSectionBytes` that leaves.
3. Keep FR-05's block last: the shaping helper `withTaskContext` goes inside
   `appendRepoTaskSkills`, so the order stays kind contract, task context, repository task
   skill.

## Tests and verification

- `test/dispatcher-shaping.test.ts`, beside `test/standing-instructions-delivery.test.ts`:
  byte-identical turn one with the flag off and with no shaper; the section's position in both
  turn-one variants; a rejecting or slow `shapeTask` stand-in still launches and marks the task
  degraded; identical text for Claude, Codex and Pi on both runtimes; a shaped launch followed
  by a second dispatch of the same task, once with its shaper switched off and once with the
  flag off, leaves no summary and no text; a shaped launch followed by one whose only shaper
  times out leaves that launch's degraded summary with its reason, and no text; a dispatch
  whose launch fails after shaping leaves the previous launch's record exactly as it was; a
  launch whose commit fails after it reached its worker leaves a record that names the
  previous session, which the new session does not show.
- The shaping input carries exactly the trace context the session's agent is launched with,
  and none when the agent gets none.
- A delivery test for each path: the SDK, the terminal paste and Pi's launch argument. It
  finds the path's byte ceiling, which that harness entry declares, and delivers a 64 KiB
  section with a short prompt. It then takes a turn one that launches today within 1 KiB of
  the path's ceiling, adds a shaper that returns 64 KiB, and checks that the launch still
  succeeds, with the section cut to what fits and recorded as truncated. For Pi it also
  takes a launch whose turn one is well under the per-argument limit but whose environment
  leaves little room under the combined limit, and checks the same, so neither limit can
  produce `E2BIG`.
- Database tests for the column and table on an upgraded database, and for the one function
  that settles the summary and the text in one transaction, in each of the four combinations,
  and for re-keying the session stamp when a session resumes under a new id.
- `renderToStaticMarkup` tests for the chip's states, including a record that names another
  session, which renders no chip, and the same record on a board card and rail row, which
  render no marker. Unit tests for `currentShaping`, and an HTTP test that task reads and
  the shaping route omit such a record.
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
- A task whose turn one launches without shaping still launches with it, on every delivery
  path.
- A launch shows only its own record: never a summary, text or chip from an earlier launch
  of the same task. A launch whose only shaper failed still shows `degraded` with its reason.
- A dispatch that fails before turn one is handed to the worker changes no record.
- No reader shows a record that names another session, including after a failed commit.
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
- Phase 4 depends on this phase, because its browser spec dispatches a task and reads
  the viewer this phase adds.
- Phase 7 adds routed skills to the summary this phase commits and keeps prompt rows in its
  own table, so `tasks.shaping` still has one writer. `currentShaping` stays exported and
  stable, because FR-05's dispatch inbox reads it. This phase takes the next free schema
  step: `main` is at 35, and FR-05's first phase claims 36 on its own stack.
- Review history: plan validation and the review of pull request #1546 changed this phase
  in several rounds. The rules they produced are stated in the steps above and in
  `phased-plan.md` decisions 9 to 15, and the pull request's review threads record each
  finding and its change.
