# Ensemble strategies - beyond best_of_n v1

Status: ideas / for review (not a committed plan)
Owner: ai-harness (Mission Control)
Aligned with: `docs/plans/best-of-n-swarm-dispatch/plan.md` (the Ensemble engine plan,
"Multi-Agent Ensembles: Best-of-N First") - this document uses its vocabulary and respects
its release decisions.
Companion to: `docs/plans/feature-ideas/plan.md` (where the idea started as "Best-of-N
swarm dispatch")
Rendered: `plan.html` beside this file - open that for the visual version.

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

| Earlier assumption | Engine plan reality | Consequence for these ideas |
|---|---|---|
| The judge picks and reaps | The comparative evaluator **recommends; it does not promote**. A human confirms; destructive finalization always requires human confirmation | Every strategy below is advisory evaluation plus human authority; none may auto-select, auto-reap, or auto-publish |
| Losers are discarded | Loser worktrees are reaped only after promotion; **immutable snapshot refs survive** until explicit delete | Synthesis, restore, and audit stay possible after any strategy completes; "no wasted ideas" is a kernel property, not a strategy |
| Candidates race from whatever HEAD | One full **base SHA is pinned** before any member launches; provisioning verifies it | Comparison validity is the kernel's job; strategies never re-solve it |
| Idle means done | Completion is an explicit `submit_candidate_result` **MCP submission** (plus a manual fallback) | Every strategy's barriers key off submissions and artifacts, never hook silence |
| Each strategy is its own feature | One `EnsembleStrategyRecipe` composes **seven policies** (launch, information, artifact, stages, stop, finalization, member-workflow) over a small durable stage vocabulary | A "new strategy" is a composition plus at most one new primitive; if it needs new tables/routes/events, that is evidence of a new primitive, not a new strategy |
| The rubric's tests feed the no-mistakes gate directly | v1 runs **no repository commands**; evidence is split into *reported by member* vs *observed by Mission Control*; safe repo-owned evaluation profiles are a follow-up | "Rubric-first" splits into what v1 already gives (snapshotted evaluator guidance) and what needs the evaluation-profile follow-up (executed acceptance checks) |
| Agents could debate freely | Unmediated agent-to-agent communication is a non-goal; **information topology is explicit** and collaboration is artifact-mediated, bounded, and attributed | "Structured debate" collapses into critique/feedback stages over immutable artifacts |
| Design-offs just reuse html-plans | Artifacts go through a pluggable **ArtifactAdapter**; v1 ships `git_snapshot` only, and scout/plan ensembles are an explicit v1 non-goal | Plan-first fan-out is a `plan` artifact adapter follow-up, not a v1 mode - the seam is designed for it |
| Race then verify then ship, one pipeline | Ensemble is the **exploration/selection** stage over N sessions; the one-Session **Workflow** owns review/repair/gates after promotion; they compose at the promotion boundary, never as one graph | The "composed endgame" is a chain of ensemble runs and a Workflow handoff, not a mega-strategy |
| 3-8 candidates whenever useful | `best_of_n` v1 is a fixed roster of 2-5; **launch caps are per-strategy policy** (a tournament may allow 8 at concurrency 4; adaptive waves may show a 2-8 range) | Larger N belongs to the strategies whose evaluation shape can afford it - cheap artifacts or pairwise prompts |

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

- **Deterministic gate then rank** - a hybrid evaluator pipeline: tests/static evidence
  eliminate ineligible artifacts, the comparative model ranks survivors. Blocked on the
  *evaluation profiles* follow-up, because v1 has no safe repository-neutral command to
  run; until then gates can use only observed evidence (diff stats, no-mistakes state when
  present).
- **Persona panel vote** - shipped as `panel_vote` in
  [Phase 1](phase-1-panel-vote.md). M independent single-lens judges review the same
  artifacts, with rank aggregation and visible disagreement; the phase document owns its
  implementation and durable contracts.
- **Pairwise tournament** - bracket / Swiss / round-robin pair comparisons; judges are
  more reliable at "which of these two" than at absolute scores, and each pair is a small
  checkable evaluation row. New primitive: pair scheduler and accumulated standings. This
  is also the strategy that earns rosters larger than five, because its prompts stay
  small.
- **Successive halving (cascade)** - waves: cheap first evaluation culls, the top fraction
  advances to deeper work or review. With matrix launch templates this expresses
  "cheap model drafts wide, expensive model builds the culled few" without any new
  transport. New primitive: multi-wave advancement (spawn -> collect -> evaluate ->
  advance -> repeat).
- **Adaptive sampling** - start small, add batches until a stop rule or hard cap. New
  primitive: the pure strategy driver and spawn-more command, already specified with the
  closed command union and persisted command keys.
- **Critique then revise** - N proposals, cross-assigned critiques, one bounded revision
  round, then compare revised artifacts. All sharing is server-rendered from immutable
  artifacts (this is where the earlier "structured debate" idea lands - an
  artifact-mediated exchange, not a conversation). New primitive: feedback stage and
  revision artifact lineage.
- **Proposer-critic-verifier** - a role roster instead of identical candidates, with
  directed artifact visibility; the verifier accepts, rejects, or requests bounded
  repair. New primitive: role-specific prompts and directed dependencies.
- **Red-team / defender** - one builder plus adversarial reviewers; the terminal artifact
  is the patched work plus a residual-risk report. The earlier draft's "attacks become
  regression tests" survives in two compliant forms: attack findings ride the winner into
  the post-promotion Workflow as review evidence, and executed attack checks arrive with
  evaluation profiles.
- **Top-K synthesis** - select K, then a fresh synthesis member sees exactly those
  artifacts and produces a new combined artifact with explicit lineage
  (`parentArtifactIds`, the `synthesized` outcome). This is the engine-shaped version of
  the earlier "graft the best ideas onto the winner".
- **Consensus / no-consensus** - N independent answers; the run may legitimately end with
  agreement, a minority report, or no consensus, retaining all artifacts. The
  non-destructive terminal outcome already exists in the outcome union.
- **Map-reduce** - shard roster plus a reducer that sees all outputs; comparison may be
  absent entirely. The earlier "facet decomposition" is this pattern; its known risk (the
  seams between independently produced facets) is why the reducer is a first-class member
  whose artifact is the thing evaluated.

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

Flow of that composed sequence (prose form of the diagram in `plan.html`): a design-off
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
   `plan.html`), each marked as adopted from this review, along with the priority order
   above.
3. **A phased implementation plan follows**: phase documents live beside this file and are
   scheduled as dependency-linked Mission Control tasks, sequenced after the engine plan's
   own implementation phases (`best_of_n` v1 is the prerequisite kernel for all four
   selected strategies).
