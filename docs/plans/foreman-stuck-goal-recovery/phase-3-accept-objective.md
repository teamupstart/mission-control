# Phase 3: Accept the objective as is

## Outcome and value

A person can end a goal pause from the Foreman drawer. **Accept objective as is** records every
pending instruction as steering, confirms the current objective as the completion contract, and
lets Foreman judge completion on its next tick. Every latch path Phase 1 does not resolve on its
own (parse failure, exhausted transport retry, lost legacy prompt, a genuine `unclear` verdict)
gains an exit, and the Goal line names it.

## Entry criteria and dependencies

The planning pull request that publishes these artifacts. No phase dependencies. Anchors
verified at `74eaf9434`. D4 also puts the control in Phase 4's dialog notice.

## Scope and non-goals

In scope: `Registry.acceptGoalObjective`, a list steering writer in `db.ts`,
`POST /api/sessions/:id/goal/accept`, `api.acceptGoal`, the drawer control wired through
`ConsoleDetail`, Goal line tooltip copy, styles, tests, one Playwright spec, docs
(`docs/foreman.md`, `docs/sessions.md`, `docs/agent-guides/change-contracts.md`). Non-goals:
the chip and dialog (Phase 4); any change to `objective`, `objectiveVersion`,
`resolvedSessionIntent`, `claimCompletion` or the frozen snapshot; a "replace objective" action.

## Repository findings and inherited contracts

`SessionGoal` (`types.ts:1204`) and `SetGoalSchema` (`protocol.ts:1770`) describe every field
written. `Registry.mergeGoal` (`registry.ts:8596`) persists and `syncSessionsForGoal` emits
`session_upsert`. `upsertSessionGoalWithSteering` (`db.ts:10743`) writes one row in
`BEGIN IMMEDIATE` with `ON CONFLICT DO NOTHING` and requires `steer` at the resolved revision.
`GET /api/sessions/:id/goal` is `routes.ts:6779`; `api.goal` is `api.ts:2128`; `useIntent`
(`ConsoleDetail.tsx:150`) is keyed on `intentRefreshStamp`; `IntentSummary` is
`ForemanDrawer.tsx:165-215`; `GoalLine` tooltips are `session-bits.tsx:1438-1447`.

## Implementation steps

1. `db.ts`: `upsertSessionGoalWithSteeringNotes(g, notes)` beside the single-note writer, same
   transaction and conflict rule, requiring `steer` and every `note.revision <= g.resolvedPromptRevision`.
2. `registry.ts`: `acceptGoalObjective(id, now)` next to `resolveGoal`. Null without a session or
   goal; `{ accepted: false }` without an objective; unchanged when nothing is pending and the
   relationship is not `unclear`. Otherwise one note per pending revision (instruction = the
   prompt or `(not captured)`, rationale `Accepted by you: the current objective is the completion
   contract.`), or one note at `promptRevision` with `goal.prompt` for an `unclear` goal with
   nothing pending; then merge `steer`, `resolvedPromptRevision = promptRevision`, empty
   `pendingPrompts`, `focus` = `goalLine` of the last instruction, a counting rationale. Never
   pass `objective`, `text`, `source`, `objectiveVersion` or `openingPrompt`.
3. `routes.ts`: `POST /api/sessions/:id/goal/accept`, no body: 404 without a goal, 409 on
   `{ accepted: false }`, otherwise 200 with the full `SessionGoal`.
4. `api.ts`: `acceptGoal(id)` posting to that route, typed `SessionGoal`.
5. `ForemanDrawer.tsx`: an `onAcceptObjective` prop; when resolving or `unclear`, a
   `button.fd-intent-accept` labelled **Accept objective as is** inside `fd-intent-reading`,
   tooltip "Record the pending instructions as steering and let Foreman judge completion against
   this objective", disabled in flight, errors in `p.wf-error[role=alert]`.
6. `ConsoleDetail.tsx`: implement it with `api.acceptGoal(session.id)` and set the drawer's
   intent from the response.
7. `GoalLine`: append "Open Foreman intent to accept the objective as is." to the resolving and
   unclear tooltips. `styles.css`: `.fd-intent-accept`.
8. Docs: `docs/foreman.md` drawer section; `docs/sessions.md` Goal section;
   `docs/agent-guides/change-contracts.md`: only `initial`, `amend` and `replace` change the
   objective; the accept route confirms it, never rewrites it.

## Data, API and compatibility

New route only; no schema or migration. Frozen runs are untouched. A refinement in flight is
abandoned by the compare at `refiner.ts:371-376`.

## Tests and verification

`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- `test/session-goals.test.ts`: steering rows in order; `(not captured)` for a null legacy
  prompt; objective, version, source and opening prompt unchanged; equal revisions; idempotent;
  the `unclear`-with-nothing-pending case; `{ accepted: false }` without an objective.
- A route test (new `test/goal-accept-http.test.ts`): 404, 409, 200, idempotent 200, and a
  `session_upsert` reaching an SSE subscriber.
- `test/prompted-wrapup.test.ts`: an accepted goal yields a `check` candidate.
- `test/prompted-wrapup-worker-e2e.test.ts`: a session skipped for unresolved intent is
  verified, consumed and claims its bound workflow on the tick after acceptance.
- `test/workflow-run-intent-snapshot.test.ts`: a run frozen after acceptance carries the former
  pending instructions as steering and classifies `objective`.
- `test/foreman-intent-drawer.test.ts`: the control renders for resolving and `unclear` only.
- `e2e/specs/goal-accept-objective.spec.ts`: dispatch, send a plain follow-up, wait for
  `unclear`, open `Foreman intent`, assert "needs more context" and the button, click, assert
  "steering", the button gone, equal revisions, objective unchanged. `npm run build`, then run
  that spec.
- `npm run typecheck`, `npm run lint`.

## Merge and exit criteria

All of the above pass; the three docs describe the control.

## Downstream handoff

Phase 4 may rely on the route (404 / 409 / 200 with `SessionGoal`), `api.acceptGoal(id)` and the
`Accepted by you:` marker; it must not change the route.

## Cross-phase audit record

2026-11-05: audited against Phases 1, 2 and 4; the list writer is additive beside Phase 1's
single-note path; Phase 4 adds no second accept path.
