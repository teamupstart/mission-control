# Ensemble strategies - beyond best_of_n v1

Status: ideas / for review (not a committed plan)
Owner: ai-harness (Mission Control)
Aligned with: `docs/plans/best-of-n-swarm-dispatch/plan.md` (the Ensemble engine plan,
"Multi-Agent Ensembles: Best-of-N First") - this document uses its vocabulary and respects
its release decisions.
Companion to: `docs/plans/feature-ideas/plan.md` (where the idea started as "Best-of-N
swarm dispatch")

The engine plan settled the foundation: a reusable **Ensemble** orchestration layer above
Tasks and the Dispatcher, with Best-of-N shipping as its first versioned strategy
(`best_of_n` v1), not as the engine's name or schema. Every member is a normal Task; a
strategy is an immutable recipe composing seven policies; evaluators recommend and humans
promote; artifacts are immutable Git snapshots; outcomes are not always a single winner.

This document is the strategy roadmap on top of that kernel: which strategies exist in the
design space, what each one is as a **recipe composition**, which primitive (if any) it
needs beyond `best_of_n` v1, and which are worth building next.

## What the engine plan changed about this brainstorm

The first draft of this document assumed the feature-ideas framing: race N builds, a judge
scores, the winner survives, the rest are reaped. The engine plan materially corrects
those assumptions:

One idea from the first draft survived by landing in v1 already: **persona-seeded
diversity** is the roster's per-member `approach` hint. Two to five members with
deliberately different briefs (MVP-first, risk-first, perf-first, DX-first) is a
configuration of `best_of_n` v1, not a new strategy. What remains worth building is a
preset library of good hint packs (the plan's "reusable ensemble presets" follow-up).

## The recipe frame

The first draft organized strategies by three dials (generate / select / spend). The
engine's seven-policy recipe subsumes them:

- *Generate* became `LaunchPolicy` (fixed_roster, replicated, matrix, adaptive_waves,
  roles) plus `InformationPolicy` (isolated by default; directed artifact-sharing when a
  strategy declares it) plus the member templates and approach hints.
- *Select / combine* became the `evaluate` / `advance` / `decision` stages,
  `EvaluatorPolicy` (deterministic gate, all-at-once comparative, pairwise, Persona panel,
  human-only, hybrid pipeline) and `FinalizationPolicy` with four terminal outcomes:
  **selected, synthesized, retained, no_consensus**.
- *Spend* became waves, `maxMembers` / `maxConcurrentMembers`, stage attempt caps, and the
  hard budgets no driver or LLM may exceed.

## The strategies, restated as recipe compositions

Grouped by what they change relative to `best_of_n` v1 (fixed roster 2-5, isolated,
git_snapshot artifacts, spawn -> collect-all -> compare-all -> human decision ->
select-one).

### Already in v1 or configuration-only

- **Persona-seeded diversity** - `best_of_n` v1 with distinct `approach` hints per roster
  row. Follow-up worth shipping: preset hint packs in the Dispatch strategy card.
- **Human A/B decision** - `EvaluatorPolicy` already includes human-only; the Best-of-N
  detail already ends in a human decision over anonymous scorecards. A dedicated pairs UI
  and Foreman preference learning from picks are later, independent ideas; the engine's
  blind A/B evaluator calibration follow-up is the measurement version of the same
  instinct.

### Named in the engine plan's pattern table

### Extensions this document adds beyond the engine plan

- **Divergence mining** (extends consensus / no-consensus) - the earlier draft's most
  novel idea, restated on the kernel: a consensus evaluator diffs the N artifacts'
  *decisions*, not their code. What all members agree on becomes the summary; each
  divergence becomes a structured option set feeding the `decision` stage, so the
  human answers exactly the questions the fleet could not settle - the same
  human-authority stage Best-of-N already ends in, fed by evaluator output instead of a
  scorecard. New primitive: none beyond consensus/no-consensus itself; it is an evaluator
  whose typed result the decision stage renders as options. It is the most Mission
  Control-shaped strategy in the set because its product is decisions, and the dashboard
  already knows how to ask those.
- **Design-off (plan-first fan-out)** - members produce design documents, not
  implementations; the comparison happens where candidates are cheap, and exactly one
  build follows. On the kernel this is a `plan` (or `markdown_report`) ArtifactAdapter -
  capture/summarize/materializeForEvaluation are natural for a document, and the
  adapter's optional `restore` is the designed seam for "turn the winning plan into a
  build Task" (`materializedTaskId` already exists on the selected outcome). Deliberately
  deferred by the v1 non-goal on scout/transcript ensembles, and rightly so - but it
  remains the best value-to-cost strategy in the set once a second artifact kind is
  earned, and it is the one that justifies bigger rosters (eight cheap plans cost less
  than one implementation).
- **Spec-first guidance** (the earlier "rubric-first", corrected) - half of it already
  landed: evaluator guidance (built-in rubric or one Persona revision) is **snapshotted at
  ensemble creation**, before any artifact exists, which is exactly the
  criteria-before-artifacts property the idea wanted. The stronger half - a wave-0 "spec"
  member whose artifact (acceptance criteria) becomes the evaluator guidance for later
  waves - is a small new primitive (artifact-as-guidance) worth considering alongside
  evaluation profiles, which would make those criteria executable.

## Recommendation

1. **Ship `best_of_n` v1 exactly as the engine plan specifies**, and treat persona hint
   presets as its first cheap follow-up - that is the surviving form of "persona seeding
   is a free upgrade".
2. **Persona panel vote second**, agreeing with the engine plan: it is the smallest
   delta (parallel evaluators plus aggregation), it reuses Persona snapshots verbatim,
   and disagreement-between-lenses is the first genuinely new signal the operator gets.
3. **Pull divergence mining forward** as the consensus strategy's evaluator: it fits the
   evaluator-recommends / human-decides safety design perfectly, needs no new destructive
   authority, and turns ensembles from a slot machine into a question-finding machine.
4. **Design-offs when the second ArtifactAdapter is earned**: the plan adapter is the
   highest-leverage follow-up in the adapter seam, because it moves N to where candidates
   are cheap and composes with everything else (panel vote over plans, tournament over
   plans, divergence mining over plans).
5. The composed endgame, restated on the real boundaries: a **design-off ensemble**
   (plan artifacts, divergence-mining evaluator) resolves the open questions with the
   human; its restored winner briefs **one build** (or a small `best_of_n` run); promotion
   hands the selected snapshot to **one pinned Workflow version** for Persona
   review/repair and the Inspector gate. Two ensemble runs and a Workflow, composed at
   promotion boundaries - never one graph, exactly as the engine plan's Workflow
   separation requires.

Flow of that composed sequence: a design-off
ensemble fans out cheap plan members from one pinned base; its consensus evaluator files
agreements and posts divergences to the decision stage; the human's selections plus the
winning plan brief a single implementation Task (via the artifact adapter's restore); if
the operator raced a small best_of_n on the build, its human-confirmed winner is restored
to its exact snapshot; the pinned Workflow version then binds to that one session and owns
review, repair, and gates.

## Adopted decisions (2026-07-23 dashboard review)

1. **Priorities after `best_of_n` v1**: Persona panel vote, divergence mining, design-off
   (the plan ArtifactAdapter), and top-K synthesis. The other strategies stay catalogued
   here but are not scheduled.
2. **This document's extensions are folded into the engine plan**: divergence mining, the
   plan ArtifactAdapter, and spec-first guidance now appear in
   `docs/plans/best-of-n-swarm-dispatch/plan.md`'s "Likely follow-ups" (and its
   source plan), each marked as adopted from this review, along with the priority order
   above.
3. **A phased implementation plan follows**: phase documents live beside this file and are
   scheduled as dependency-linked Mission Control tasks, sequenced after the engine plan's
   own implementation phases (`best_of_n` v1 is the prerequisite kernel for all four
   selected strategies).
