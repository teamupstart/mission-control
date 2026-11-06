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
(`supervisor.ts:714`) when `acceptedGoal` is passed, which `sdk/deliver.ts:62-67` does for a
human origin; `captureHookGoalPrompt` (`registry.ts:8320-8329`) on the prompt hook. In
`deliverSdk` (`pending-turns.ts:881-990`) the boundary is `await send(...)` at line 897;
`accepted === null` (line 912) and a throw before `acceptanceBoundaryCrossed` (line 975) are
the positive "nothing landed" outcomes. In `supervisor.send` (`supervisor.ts:692-740`)
`handle.send(turn)` is the boundary. A send made while a turn is running is queued by
`TurnStream` (`harness/claude/sdk.ts:288-320`) and reported `steered`; Claude dequeues it after
that turn, so its prompt hook can fire after the running turn's `completeWorkCycle`, which runs
on the harness's turn-end signal and increments the work cycle's `generation` (`db.ts:5060`).

## Implementation steps

1. `injections.ts`: a second map, same ceilings, keyed by fingerprint, whose entries are
   `open` (sent, not acknowledged), `confirmed` or `captured`, each stamped with its creation
   time and the generation of its own turn: the session's completed work-cycle generation plus
   one, or plus two when a cycle is active at the send, because the send is queued behind it.
   An entry for an idle session is eligible at creation; a queued one becomes eligible when
   the turn before it completes. API: `expectHumanEcho(sessionId, text)`; `confirmHumanEcho(sessionId, text): { captured: boolean }`
   (marks confirmed, reports whether the hook already captured); `markHumanEchoCaptured(sessionId, text)`,
   the only transition to `captured`, which every door calls after, never before, its own
   `captureAcceptedPrompt` has returned a goal; `releaseHumanEcho` (drops an entry that is not
   captured); `claimHumanEcho(sessionId, text): "skip" | "capture" | "none"` ("skip" for a
   captured entry, which it consumes; "capture" for an open or confirmed entry, whose state it
   leaves unchanged; "none" when nothing matches); `expireHumanEchoes(sessionId, completedGeneration, now)`
   drops entries whose own turn generation is at most `completedGeneration` and marks the
   entries of the next turn eligible, stamping `eligibleAt = now`. Age is checked lazily on
   every read: `claimHumanEcho`, `confirmHumanEcho`, `markHumanEchoCaptured` and
   `releaseHumanEcho` take `now` (defaulting to `Date.now()`), drop a matching eligible entry
   older than 120 seconds since `eligibleAt` before answering, and then answer as if it never
   existed. No timer is needed. `forgetInjections` clears both maps.
2. `supervisor.send`: when `acceptedGoal` names a bound conversation (`accepted.noteKey !== id`;
   the launch-generation branch of `captureGoalBestEffort` is unchanged and registers no
   expectation), expect before `handle.send`; after it resolves, confirm; when the hook has not
   already captured, run `captureGoalBestEffort`, which now returns whether
   `captureAcceptedPrompt` returned a goal, and on true call `markHumanEchoCaptured`. On false
   (the registry refused the prompt, or the Goal write threw and was logged) the entry stays
   confirmed, so a later echo answers "capture" and records the turn. Release in the catch path
   when the driver refused before accepting.
3. `deliverSdk`: expect before `await send(...)`; after acceptance, confirm and, when not
   already captured, call `captureAcceptedPrompt`, then `markHumanEchoCaptured` only when it
   returned a goal; the existing catch that logs a failed Goal write leaves the entry confirmed
   for the echo. Release on `accepted === null` and in the catch branch that calls
   `releasePendingTurn`. Uncertain outcomes leave the entry open.
4. `captureHookGoalPrompt`: after the launch-echo check and before `isDaemonAuthoredPrompt`,
   call `claimHumanEcho` for the submitted text, then for the reshaped prompt: on "skip" return
   without capturing; on "capture" run the existing `captureAcceptedPrompt` call, then
   `markHumanEchoCaptured` only when it returned a goal, and return; a null return or a throw
   leaves the entry as it was, so the acknowledgement path records the turn. Claim, capture and
   mark are one synchronous stretch with no await, so the acknowledgement path, which resumes
   on a later tick, sees either the untouched entry or the captured one. On "none" fall through
   to the existing checks.
5. Expiry at turn end: where the registry completes a work cycle on the harness's turn-end
   signal (`completeWorkCycle`), call `expireHumanEchoes` for that session with the generation
   the completion produced. Entries whose own turn just completed are dropped; entries queued
   for the next turn become eligible and keep their state, so a follow-up Claude acknowledged
   mid-turn and dequeued after the Stop still meets its hook, which captures it or skips it. A
   session that never finishes a turn relies on the lazy age check in step 1 for entries
   eligible at creation: the next claim for the same text drops the stale entry, answers
   "none", and the arrival is captured through the ordinary hook path. An entry still queued
   behind an unfinished turn is bounded by the per-session ceiling and `forgetInjections`; the
   only hooks that can match it are its own echo and that of an identical retype, which the
   retype's own send captures.
6. `docs/sessions.md`: extend "counted once, not twice" to every SDK follow-up; each delivered
   turn is captured by exactly one door, and a retype is its own send, so it is still heard.
7. Update the `isSeededLaunchEcho` comment describing the two doors.

## Data, API and compatibility

No schema, route or wire change. In memory like the authorship ledger; a restart between
delivery and echo lets one duplicate through, which Phase 1 makes harmless.

## Tests and verification

`node --test --import ./test/setup-state.mjs --import tsx <file>`:

- `test/pending-turn-manager.test.ts`: a delivered follow-up echoed by a `UserPromptSubmit`
  with the same prompt text raises `promptRevision` by one whether the echo arrives before or
  after acknowledgement; an early echo followed by a refused acknowledgement (`accepted ===
  null`) yields exactly one revision; an early echo followed by an uncertain acknowledgement
  (`markBoundaryUncertain`) yields exactly one revision; an early echo whose capture fails
  (`t.mock.method(registry, "captureAcceptedPrompt")` throwing once, and separately a stale
  note key that makes it return null) leaves the expectation in place, the acknowledgement
  records the turn, and exactly one revision exists; a refused send with no echo captures
  nothing and leaves no entry; a successful send with no echo followed by an identical retype
  yields one revision per send; a follow-up delivered while a work cycle is active (the driver
  answers `steered`), then that cycle's completion, then the follow-up's echo, yields exactly
  one revision and the echo answers "skip"; once the follow-up's own turn completes its entry is
  gone, so a later hook-only arrival of the same text is captured; with no turn end at all, a
  captured entry for an idle send older than 120 seconds (clock injected through the manager's
  `now` dependency and the ledger's `now` parameter) no longer answers "skip", so a later
  identical hook-only arrival is captured.
- `test/sdk-supervisor.test.ts`: a direct `send` with `acceptedGoal` plus a matching echo
  yields `promptRevision 2` in either order; acknowledgement first, the send's capture marks
  the entry captured, so the later echo answers "skip" and `captureAcceptedPrompt` ran once; an
  early echo whose capture throws once is recorded by the acknowledgement, exactly one
  revision; a driver refusal releases the entry; an early echo followed by a driver refusal
  yields exactly one revision.
- A ledger test (new `test/human-echo-ledger.test.ts`): the open / confirmed / captured
  transitions, "skip" versus "capture" versus "none", a claim leaving the entry's state
  unchanged so a second claim before the mark still answers "capture", `markHumanEchoCaptured`
  as the only path to captured, release never dropping a captured entry, turn stamping (plus
  one for an idle session, plus two during an active cycle), expiry at the entry's own
  generation and not at the one before it, eligibility stamped at the previous turn's
  completion, the lazy age check from eligibility on claim, confirm, mark and release with an
  injected `now`, the per-session ceiling, and `originOf` never reporting a human echo.
- `npm run typecheck`, `npm run lint`.

## Merge and exit criteria

All of the above pass. Manual check: one SDK follow-up shows `promptRevision 2`.

## Downstream handoff

One revision per accepted human turn on SDK sessions, captured by exactly one door, and an
entry is marked captured only after that door's capture returned a goal; an unconsumed entry
expires when its own turn completes or by age once eligible. Do not add a third capture door,
mark an entry captured before a capture succeeds, expire an entry at the end of the turn it was
queued behind, give `TurnOrigin` a human value, or let an entry outlive the turn it belongs to.

## Cross-phase audit record

2026-11-05: audited against Phases 1, 3 and 4; no shared code with Phase 1.
