# Phase 2 - `consensus`: divergence mining

## Outcome and value

A non-destructive strategy that turns N independent attempts into **questions instead of
a winner**. Members work isolated as in Best-of-N; a consensus evaluator diffs the
artifacts' *decisions*, not their code: what all members agree on is filed as consensus,
and each divergence becomes a typed question with attributed options. The decision stage
presents those options to the operator; the run terminates `retained` with every artifact
kept and the answers recorded. Value: the swarm stops being a slot machine and becomes a
machine for finding the questions worth asking - the most Mission Control-shaped strategy
in the set, and it needs no new destructive authority.

## Entry criteria and direct dependencies

- Engine plan Phase 8 merged (task `915fea1a-0479-4d47-a4bd-d5ee3eebbfd5`).
- This planning session's PR merged.

## Scope

- Append `consensus` to `ENSEMBLE_STRATEGY_IDS`; descriptor + compiler as in the kernel's
  registry pattern. Config: 3-5 members (two artifacts rarely produce meaningful
  consensus), approach hints, optional guidance Persona for the evaluator.
- Compiled plan: spawn -> collect-all -> evaluate (consensus) -> decision -> finalize
  (retained). Finalization is non-destructive: worktrees are reaped after the decision as
  usual, artifacts and the decision record are all kept; no candidate is "the winner".
- Consensus evaluator: one tool-less structured call over the anonymized evidence packet
  (reusing the comparative evaluator's assembly, fencing, and caps). Typed result:
  `agreements: string[]` and `divergences: Array<{ question; options: Array<{ label;
  rationale; artifactIds }> }>`, bounded in count and length, validated with the kernel's
  discipline (anonymous labels mapped back server-side only after validation).
- **The one new primitive - evaluator-derived decision options**: the compiled decision
  stage renders its pending decision from the evaluation result's divergences instead of
  a strategy-static scorecard. This extends the generic decision *rendering* and the
  decision stage's persisted input; the operator's answers travel through the existing
  generic `decide` action and are stored on the stage attempt output. No new route,
  event, or table.
- Detail renderer: consensus strip, divergence cards with per-option member attribution
  and votes, recorded answers after the decision; Dispatch preset card; README section.

## Non-goals

Automatically briefing a follow-up build from the answers (the operator can dispatch one,
or a design-off run does this end-to-end later); a `no_consensus` failure heuristic
beyond "zero agreements and zero divergences is an evaluator failure, retry"; posting to
any surface outside the Ensemble detail.

## Repository findings and inherited contracts

Same baseline as Phase 1: no kernel code exists at planning time; re-verify names against
the merged kernel. Inherited: candidate diffs are untrusted (a divergence option's label
and rationale are model output over untrusted input - cap, fence, and render as text,
never as markup or executable identity); `retained` outcome exists in the kernel's
outcome union; the generic `decide` operator action exists.

## Implementation steps

1. `src/shared/ensemble.ts`: append id; descriptor with the divergence result schema
   shared so the browser renders typed divergences.
2. `src/server/ensembles/strategies/consensus.ts`: compiler; validation that the
   evaluation result references each eligible artifact at least once across
   agreements/divergences or fails the attempt.
3. Consensus evaluator beside the comparative one.
4. Decision-stage input wiring: persist the validated divergences as the decision stage's
   input; renderer shows them; answers recorded on the attempt output.
5. Detail renderer + preset card + README.
6. Tests: result validation (missing artifact coverage, oversize options, injected
   markup stays inert text); scenario with fake members producing known divergences;
   decision round-trip storing answers; renderer markup test.

## Data / API / migration

None. Divergences and answers live in evaluation rows and stage attempt input/output
JSON.

## Verification

Focused tests, then `npm run typecheck && npm test && npm run build`. In the app: run a
3-member consensus ensemble on a scratch repo, answer both divergences, confirm the run
completes `retained` with artifacts restorable and answers visible.

## Merge / exit criteria

A consensus run reaches the decision with rendered divergences, records answers, and
terminates `retained`; nothing was reaped destructively without confirmation; no engine
branch tests the id.

## Downstream handoff

Later phases may rely on: the `consensus` id, the shared divergence result schema, and
the evaluator-derived decision-options pattern (Phase 3's design-off may reuse it over
plan artifacts). They must not repurpose the divergence schema for pass/fail verdicts.

## Cross-phase audit record

- 2026-07-23: created; independent of Phases 1, 3, 4. Phase 3 noted as a potential future
  consumer of the decision-options pattern; no dependency taken.
