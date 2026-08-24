# Phase 3 - Episode-scoped convergence and escalation

## Outcome

The hold-recover loop terminates. The verifier's gap-strike machinery works across
work-cycle generations, so a repeated demand is visible as repeated instead of eternally
fresh; and the recovery attempt budget survives the generation bump, so three futile
hold-deliver-hold cycles of one intent episode escalate to a human instead of resetting to
"attempt 1/3" forever. A new accepted human prompt still correctly resets everything.

## Entry criteria and dependencies

- Direct prerequisite: Phase 2 merged. This phase re-keys the attempt continuity that
  Phase 2's shared delivery helper feeds, and extends the decision persistence Phase 1's
  verdicts write.

## Scope and non-goals

In scope: additive persisted-shape extensions (gap kind/severity/strikes, decision and
recovery episode keys), feeding prior gaps into the next prompted verify, episode-keyed
attempt continuity, and the compatibility tests that pin legacy rows.

Non-goals: no change to the escalation surface itself (the existing attempt-4 path renders
attention as today); no change to markers as per-delivery idempotency keys; no change to
delivery timing (Phase 2) or verdict inputs (Phase 1); no UI change - the drawer already
renders episodes and free-text gap kinds.

## Repository findings this phase builds on

- Every prompted verify currently runs `round: 0, priorGaps: []`
  (`src/server/foreman/worker.ts:1991-2022`), so the verify prompt's REUSE-GAP-IDS and
  strike mechanics (`src/server/foreman/queue-prompt.ts:126-130, 218-233`) never engage on
  this path.
- The persisted `PromptedCompletionGap` is `{ id, path, detail }`
  (`src/shared/types.ts:1390-1397`); `PromptedCompletionDecision` carries logicalKey,
  generation, outcome, summary, gaps, decidedAt (`types.ts:1408-1417`); neither knows the
  intent episode.
- `PromptedRecoveryState` (`types.ts:1449`) has no episode key; `recoveryStateMatches`
  (`src/server/foreman/ship-shepherd.ts:71-87`) requires the generation to match, so a
  nudge-response's new generation abandons the previous state and `decideShipShepherd`
  restarts at attempt 1 (`ship-shepherd.ts:144-162`). The attempt-4 escalation
  (`ship-shepherd.ts:188-198`) is therefore unreachable for a responsive session.
- The intent episode key is already resolved on the prompted path
  (`promptedIntentKey`, `src/server/foreman/prompted-wrapup.ts:105-108`) and carried on
  the candidate; the direct-shipping latch already uses episode keying for exactly this
  re-arm-on-new-intent semantic (`prompted-wrapup.ts:216-234`) - this phase applies the
  same idea to recovery continuity.
- `PROMPTED_RECOVERY_REASONS` and delivery states are append-only persisted vocabularies
  (`types.ts:1421-1441`); the change contracts forbid renaming or reordering them.
- `shipRecoveryMarker` includes the generation and attempt - it stays the per-delivery
  idempotency key and is NOT re-keyed; only attempt continuity changes.

## Implementation steps

1. **Shapes** (`src/shared/types.ts`, additive and optional throughout):
   - `PromptedCompletionGap` gains `kind?`, `severity?`, `strikes?`.
   - `PromptedCompletionDecision` gains `episodeKey?: string | null`.
   - `PromptedRecoveryState` gains `episodeKey?: string | null`.
   Legacy JSON with the fields absent must parse to today's meaning; the daemon's
   consume and recovery-claim schemas accept the new fields additively.

2. **Persist verdict detail** (`src/server/foreman/worker.ts` and the daemon consume
   route): `consumePromptedCycle` passes the candidate's episode key and, for held
   outcomes, each blocking gap's kind, severity, and its updated strike count.

3. **Feed prior gaps forward** (`worker.ts`, prompted verify): when the queue's current
   decision is `held`, its `episodeKey` equals the candidate's, and its generation is
   older than the candidate's, map its gaps (with strikes) into `priorGaps` and set
   `round` to the count of consecutive held decisions for this episode. A legacy decision
   without an episode key feeds nothing (today's behavior). The verifier then reuses gap
   ids, and its verdict's `resolved` list retires them.

4. **Episode-keyed attempt continuity** (`src/server/foreman/ship-shepherd.ts`):
   `recoveryStateMatches` accepts a state whose `episodeKey` matches the input's episode
   and whose reason matches, even when the generation differs - the attempt then advances
   (`current.attempt + 1`) exactly as a same-generation retry does today, so the third
   delivered attempt is followed by the attempt-4 escalation. Same-generation semantics,
   `confirmed_undelivered` retry behavior, and the 40/80-minute backoffs are unchanged. A
   state without an episode key (legacy) matches only by today's rules and never
   mis-continues. The recovery claim carries the episode key so the daemon persists it.

5. **Reset on new intent**: no sweep - a later accepted human prompt advances the episode
   key, the comparison fails, and continuity starts fresh, mirroring the direct-shipping
   latch's re-arm semantics.

6. **Documentation**: the Foreman docs page updated in Phases 1-2 gains the convergence
   and escalation behavior: strikes across generations, three attempts per intent episode,
   then escalation.

## Data, API, and compatibility

- All persisted changes are additive optional JSON fields inside existing columns
  (`prompted_decision`, `prompted_recovery`); no schema migration, no renamed or reordered
  append-only values.
- Compatibility is behavior, not just parsing: a legacy recovery state must not continue
  its attempt count onto a new episode-keyed candidate, and a legacy decision must not
  feed prior gaps. Both directions are pinned in tests.

## Tests and verification

- `test/foreman-ship-shepherd.test.ts`: three held cycles across three generations of one
  episode reach attempt 4 and escalate; a new episode resets to attempt 1; legacy states
  (no episode key) behave exactly as today; `confirmed_undelivered` still retries the same
  attempt.
- `test/prompted-wrapup.test.ts` / `test/prompted-wrapup-worker-e2e.test.ts`: prior gaps
  and round feed forward only on matching episode; strikes accumulate in the persisted
  decision; a verdict resolving a gap id retires it; legacy decisions feed nothing.
- `test/ship-recovery-http.test.ts`: claim endpoint round-trips the episode key; old
  payloads without it are accepted.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/foreman-ship-shepherd.test.ts test/prompted-wrapup.test.ts test/prompted-wrapup-worker-e2e.test.ts test/ship-recovery-http.test.ts
npm run typecheck
npm run lint
npm test
```

## Merge and exit criteria

- All verification above passes; the pull request is reviewable and merged.
- End state matches the source plan: evidence-grounded verdicts (Phase 1), in-pass
  delivery (Phase 2), and a loop that either converges or escalates within three attempts
  per intent episode (this phase), with legacy persisted state behaving unchanged.

## Downstream handoff

This is the final phase. What the system now guarantees, for anything built later: every
prompted completion decision and recovery state carries its intent episode; attempt
budgets are per (task, episode, reason); markers remain per-delivery idempotency keys.

## Cross-phase audit record

- 2026-08-24: written after Phases 1-2 and audited against them. Phase 1's gap-kind
  vocabulary (C2) is consumed here unchanged; Phase 2's single delivery entry point (C3)
  is preserved - continuity changes keying only, adding no second ledger or delivery path.
- 2026-08-24: final whole-set audit - every source-plan requirement and submitted decision
  maps to exactly one phase (evidence input, structural clause, fallback: Phase 1;
  immediate delivery under `keepShipTasksMoving`: Phase 2; strikes, episode budget,
  escalation, compatibility: Phase 3); serial merge order confirmed.
