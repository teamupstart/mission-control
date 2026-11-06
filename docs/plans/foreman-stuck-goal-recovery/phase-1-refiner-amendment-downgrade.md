# Phase 1: A rejected amendment resolves as steering

## Outcome and value

The goal refiner no longer latches a session when the model calls an instruction an amendment
and its proposed objective fails the preservation check. The revision resolves as steering, the
objective and its version stand, the reason is logged, and Foreman's prompted wrap-up can reach
the bound workflow again. Five sessions on the operator's machine are latched this way today.

## Entry criteria and dependencies

The planning pull request that publishes these artifacts. No phase dependencies. Anchors
verified at `74eaf9434`.

## Scope and non-goals

In scope: the rejection branch in `src/server/goal/refiner.ts`, the option-pick prompt rule,
the attachment-line normalization (D1), one fake-agent marker, one Playwright spec,
`docs/sessions.md`. Non-goals: duplicate SDK capture (Phase 2), routes or controls (Phase 3),
the stall surface (Phase 4), the parse and transport branches, `resolvedSessionIntent`,
`mayChangeObjective`, the frozen run contract.

## Repository findings and inherited contracts

`refiner.ts:384-398` sets `failedFor`, upserts `relationship: "unclear"` and returns; the path
at lines 400-430 computes the steer values and `registry.resolveGoal` (`registry.ts:8563`)
records the steering note. `comparableObjective` (`refiner.ts:205`) has one caller. `RULES` in
`prompt.ts:35-69` defines `steer` at lines 50-51. `test/goal-refiner.test.ts` drives the real
loop against a fake `claude` whose modes `shrink` and `negate` return non-preserving amendments.
`e2e/fixtures/fake-claude.mjs:698-713` answers goal jobs.

## Implementation steps

1. Rejection branch: keep the condition; inside it call `console.error` with "[goal] <session>:
   amendment at revision <n> did not preserve the objective; treated as steering: <first 160
   characters of the proposed objective>", set `relationship = "steer"` and a local rationale of
   `goalLine("Treated as steering: the proposed amendment did not retain the current objective. " + r.value.reason, 480)`.
   Do not return; let the existing path run with that rationale.
2. `comparableObjective`: drop lines whose trimmed text matches `/^\/\S+$/` before folding.
3. `prompt.ts`, under `steer`: when the objective explicitly offers choices, a reply naming one
   of them is steering, not an amendment.
4. `fake-claude.mjs`: before the `initial` fallback, answer `amend` with a non-prefixed objective
   when the instruction contains `E2E_AMEND_SHRINK`.
5. `docs/sessions.md`: "a narrower amendment stays unresolved" becomes the steering outcome with
   the "Treated as steering" rationale; attachment path lines are ignored by the comparison.
6. Update the refiner's header comments that describe the latch.

## Data, API and compatibility

No schema, route or wire change. Latched rows need no migration: the next retry of their head
takes the new branch.

## Tests and verification

`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- `test/goal-refiner.test.ts`: rewrite both fail-closed amendment tests to assert objective,
  text and version unchanged, `resolvedPromptRevision` advanced, `steer`, empty
  `pendingPrompts`, a rationale starting `Treated as steering`, one `console.error`
  (`t.mock.method`), one spawn; add the attachment-line case (a trailing `/tmp/uploads/shot.png`
  line, objective repeated without it plus an addition, version advances to 2).
- `test/goal-steering-log.test.ts`: one steering row with the marker rationale.
- `test/foreman-reads-goal.test.ts` or new `test/goal-prompt.test.ts`: the option-pick sentence.
- `e2e/specs/goal-amendment-downgrade.spec.ts`: dispatch, send `E2E_AMEND_SHRINK pick option B`,
  poll `/api/sessions/:id/goal` until resolved as `steer` with the objective unchanged, open
  `Foreman intent`, assert "steering" with `Treated as steering`, and that the Goal line tooltip
  no longer says wrap-up is paused. `npm run build`, then run that spec.
- `npm run typecheck`, `npm run lint`.

## Merge and exit criteria

All of the above pass; `automatic wrap-up remains paused` remains only in the lost-prompt branch;
`docs/sessions.md` describes the outcome.

## Downstream handoff

A rejected amendment is a `steer` with a rationale starting `Treated as steering:` and a steering
row at its revision. Do not change the marker, re-introduce a latch, or widen the normalization.

## Cross-phase audit record

2026-11-05: audited against Phases 2-4; no shared code; Phase 3 matches the marker.
