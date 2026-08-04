# Phase 2 - Seeded lived-in fleet

Part of [phased-plan.md](phased-plan.md); source plan [plan.md](plan.md). Read both, and
[phase-1-demo-launcher-and-scenario-player.md](phase-1-demo-launcher-and-scenario-player.md),
before starting. This file is the proposed route, not a specification: follow it where
the repository agrees, use your own judgement where it does not, and record deviations in
the pull request.

## 1. Outcome and value

`npm run demo -- --fresh` no longer opens onto an empty dashboard. It rebuilds
`~/.mission-control-demo` and seeds it so the first paint is a fleet that looks lived-in:
tasks in several states (done, running, backlog, held), resolved and pending reviews, a
workflow with run history, a schedule, a nonzero cost chip, and a couple of session cards
with rich conversations, dirty worktrees, and one waiting prompt. A demo starts at the
interesting part instead of manufacturing history in front of the audience.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 1 merged. The seeder is invoked by Phase 1's `--fresh`
  path, drives the scenario players Phase 1 installed, and lives inside the state-root
  layout Phase 1 owns.
- Requires `npm run build` at runtime, as Phase 1 does.

## 3. Scope and non-goals

In scope:

- `scripts/demo/seed.mjs` (the seeder), seed scenario additions under
  `scripts/demo/scenarios/`, the `--fresh` hook in `scripts/demo/launch.mjs`, README
  updates.

Non-goals:

- No record/replay of real sessions (Option D, deferred).
- No changes under `src/` or `e2e/`.
- No PR/Inspector history seeding (out of scope per the source plan).
- Origin chips on seeded history (turn attribution is in-memory only; accepted gap,
  documented in the README section).

## 4. Repository findings and inherited contracts

Inherited from Phase 1 (must not change): state-root layout, launcher flags, scenario
schema and `MISSION_DEMO_SCENARIO_DIR`, the daemon/Foreman env split, the identity
assertions, and the factored boot-and-wait function the seeder reuses for its quiet boot.

Findings this phase leans on:

- **Replay through real routes is the primary mechanism.** The e2e specs already
  demonstrate every seeding path as plain HTTP against the daemon: `POST /api/tasks` and
  `POST /api/tasks/:id/dispatch` (dispatch cuts a real worktree and starts a player
  session), `POST /mcp/reviews` and `POST /api/reviews/:id/resolve` (pending and resolved
  prompts), `POST /api/workflows` then `/publish` then bindings/submit
  (`e2e/specs/workflow-submit-accepted.spec.ts:20-47` is the compact recipe),
  `POST /api/schedules`, `POST /api/personas`, `PUT /api/ui/config`. What those routes
  leave behind in the DB, transcripts, and worktrees IS the lived-in state.
- **Sessions that should look suspended can be real ones.** A dispatched SDK session
  whose daemon is stopped cleanly becomes a `suspended` `sdk_sessions` row
  (`src/server/sdk/store.ts`) and is restored as a resumable card on the next boot -
  so the seeder gets suspended cards by dispatching sessions and then stopping the
  daemon, not by fabricating rows.
- **The cost chip needs `usage_ledger` rows** (recomputed per snapshot from the ledger,
  `src/server/registry.ts:587`). No public route feeds arbitrary ledger history, so this
  is the one place direct SQLite writes are the fallback: performed only while the
  daemon is stopped, using `node:sqlite`, the same tool `e2e/specs/ship-log.spec.ts`
  already uses against a demo-grade DB. Never against `~/.mission-control`.
- **Diff/Files need dirty worktrees.** A scenario whose `editFile` steps run and whose
  session then completes leaves real uncommitted edits in the task's worktree; the
  seeder just needs scenarios that stop short of any cleanup.

## 5. Implementation steps

1. **Seed scenarios** (`scripts/demo/scenarios/`): add narratives designed to leave
   good-looking residue - one that completes with a multi-file diff, one that ends
   waiting on a question (a pending prompt survives the daemon stop), one long
   conversation with TodoWrite narration for the transcript reader, plus scenario
   titles that read like a real backlog.
2. **`scripts/demo/seed.mjs`**:
   - Accept the state root and port; require the daemon NOT running.
   - Quiet boot via Phase 1's boot-and-wait function (`--no-foreman`, no browser).
   - Drive the routes in a deterministic order: create personas/workflow, publish,
     create tasks (a mix: some dispatched now, some left in backlog, one held), dispatch
     the session-backed ones, feed each player its prompts, raise one review and resolve
     an older one, create a schedule, run one workflow submission to completion so run
     history exists.
   - Wait on durable signals, not sleeps: task status flips, review rows, run summaries
     (poll the same routes the dashboard reads).
   - Stop the daemon cleanly so running SDK sessions suspend.
   - With the daemon stopped, write `usage_ledger` rows spanning a few days so the cost
     chip and any spend views have shape. Keep the writer tiny and schema-tolerant:
     insert through column lists, never positional, so later migrations do not silently
     corrupt seeds.
   - Print a summary of what was seeded.
3. **`--fresh` hook** in `scripts/demo/launch.mjs`: after rebuilding the state root and
   installing players/scenarios, run the seeder, then continue into the normal boot
   (with Foreman, opening the dashboard). Without `--fresh`, an existing state root
   boots as-is - persistence is the point of the decision.
4. **README**: extend the Demo mode section - what the seeded fleet contains, that
   `--fresh` takes a few minutes (it replays real work), and the documented gaps
   (no origin chips on seeded turns, no PR/Inspector history).

## 6. Data, API, and compatibility

- No schema changes, no route changes, no `src/` changes.
- The only direct DB writes are the `usage_ledger` inserts against the demo DB while its
  daemon is stopped. The daemon-is-only-writer boundary holds at runtime; the seeder
  never opens `~/.mission-control`. Guard the writer with the same root-path assertion
  the launcher uses.
- Seeds survive daemon upgrades the same way real state does: the daemon migrates the
  demo DB on open. A seed rebuilt with `--fresh` always reflects current schema.

## 7. Tests and verification

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.
- Extend `npm run demo -- --check` to run a reduced seed (one task, one review) and
  assert the residue via the same routes: task count, a pending review, a restored
  suspended session after reboot, a nonzero `usage_ledger` sum.
- Manual verification for the PR: `--fresh`, then screenshots of the first paint -
  fleet with mixed states, a conversation with history, a Diff view with edits, the cost
  chip nonzero, the waiting prompt answerable.
- No Playwright spec: dashboard UI unchanged (state the reasoning in the PR, as in
  Phase 1).

## 8. Merge and exit criteria

- `npm run demo -- --fresh` followed by `npm run demo` (no flag) both boot into the
  seeded fleet; `--check` passes.
- Definition of done checks green; README matches behavior.
- PR carries the first-paint screenshots and the seeded-content summary.

## 9. Downstream handoff

Later work (deferred Option D record/replay, or a packaged-app entry point if Option C
is ever revisited) may rely on:

- The seeder being idempotent per `--fresh` (it always starts from a rebuilt root).
- Scenario files as the single authoring surface for both live playback and seeding.
- The quiet-boot + drive-routes + stop pattern as the way demo state is manufactured.

Nothing else is promised; this is the final scheduled phase.

## 10. Cross-phase audit record

- 2026-08-04: initial version. Reconciled against Phase 1: added the requirement that
  the launcher factor boot-and-wait apart from open-and-attach (recorded in Phase 1's
  audit record and handoff), because the seeder needs a quiet boot; confirmed the
  scenario schema needs no extension for seeding (residue comes from ordinary steps),
  so the schema contract in `phased-plan.md` is unchanged.
