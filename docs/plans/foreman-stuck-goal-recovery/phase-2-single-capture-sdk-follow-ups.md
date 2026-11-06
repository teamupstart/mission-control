# Phase 2: One Goal revision per human turn on an SDK session

## Outcome and value

A human follow-up sent to an Agent SDK session opens one prompt revision, not two. Today the
driver's acknowledgement and the agent's prompt-hook echo each capture the same text, so every
follow-up is classified twice, the second time against a conversation that has moved on: 15
duplicate pairs across 9 sessions on the operator's machine, and the misclassification behind
the incident.

## Entry criteria and dependencies

The planning pull request that publishes these artifacts. No phase dependencies. Anchors
verified at `74eaf9434`.

## Scope and non-goals

In scope: an expected-human-echo ledger, reservations at both human SDK send sites, the claim
in the hook capture path, tests, `docs/sessions.md`. Non-goals: the refiner (Phase 1), routes
or UI, the launch echo (`isSeededLaunchEcho`), terminal sessions, the authorship ledger's
meaning for the conversation log.

## Repository findings and inherited contracts

`Registry.captureAcceptedPrompt` (`registry.ts:8490`) appends unconditionally. Callers:
`pending-turns.ts:931` after the outbox send acknowledges; `SdkSupervisor.send`
(`supervisor.ts:714`) when `acceptedGoal` is passed, which `sdk/deliver.ts:62-67` does for
`origin === "human"`; `captureHookGoalPrompt` (`registry.ts:8320-8329`) on the prompt hook,
which returns early only for `isSeededLaunchEcho` and `isDaemonAuthoredPrompt`. `injections.ts`
keeps a per-session fingerprint map with `pending` counts and `delivered`; `TurnOrigin` has no
human value. In `deliverSdk` (`pending-turns.ts:881-990`) the boundary is `await send(...)` at
line 897; `accepted === null` (line 912) and a throw before `acceptanceBoundaryCrossed`
(line 975) are the positive "nothing landed" outcomes. In `supervisor.send`
(`supervisor.ts:692-740`) `handle.send(turn)` is the boundary.

## Implementation steps

1. `injections.ts`: a second map, same shape and ceilings, with `expectHumanEcho`,
   `confirmHumanEcho`, `releaseHumanEcho` and `claimHumanEcho(sessionId, text): boolean`. One
   expectation owes one claim; confirm marks it delivered so a release cannot take a landed echo
   back; release only decrements an unconfirmed expectation; `forgetInjections` clears both maps.
2. `supervisor.send`: when `acceptedGoal` is passed, expect before `handle.send`, confirm after
   it resolves, release in the catch path when the driver refused before accepting.
3. `deliverSdk`: expect before `await send(...)`; confirm where `captureAcceptedPrompt` runs;
   release on `accepted === null` and in the catch branch that calls `releasePendingTurn`.
   Uncertain outcomes keep the expectation.
4. `captureHookGoalPrompt`: after the launch-echo check and before `isDaemonAuthoredPrompt`,
   return when `claimHumanEcho` is true for the submitted text or the reshaped prompt.
5. `docs/sessions.md`: extend "counted once, not twice" to every SDK follow-up; one delivery
   absorbs one echo, so a retype is still heard.
6. Update the `isSeededLaunchEcho` comment describing the two doors.

## Data, API and compatibility

No schema, route or wire change. In memory like the authorship ledger; a restart between
delivery and echo lets one duplicate through, which Phase 1 makes harmless.

## Tests and verification

`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- `test/pending-turn-manager.test.ts`: a delivered follow-up echoed by a `UserPromptSubmit`
  with the same prompt text raises `promptRevision` by one, whether the echo arrives before or
  after acknowledgement; a refused send followed by a retype is captured; a second echo after
  the expectation is spent is captured as a retype.
- `test/sdk-supervisor.test.ts`: a direct `send` with `acceptedGoal` plus a matching echo
  yields `promptRevision 2`; a driver refusal releases the expectation.
- A ledger test (`test/prompt-authorship.test.ts` or new `test/human-echo-ledger.test.ts`):
  expect / confirm / release / claim semantics, the ceiling, `originOf` never reporting a human
  echo.
- `npm run typecheck`, `npm run lint`.

## Merge and exit criteria

All of the above pass. Manual check: one SDK follow-up shows `promptRevision 2`.

## Downstream handoff

One revision per accepted human turn on SDK sessions. Do not add a third capture door, give
`TurnOrigin` a human value, or make the claim permanent.

## Cross-phase audit record

2026-11-05: audited against Phases 1, 3 and 4; no shared code with Phase 1.
