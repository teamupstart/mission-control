# Phase 1 - `panel_vote`: Persona panel vote

## Outcome and value

The second product ensemble strategy: 2-5 members implement independently (as in
Best-of-N), then M independent single-lens Persona judges each score **all** eligible
artifacts in parallel; a pure aggregation ranks them and the disagreement between judges
is surfaced beside the recommendation instead of averaged away. The human still confirms.
Value: the first genuinely new operator signal after v1 - where the lenses disagree is
information one comparative call cannot produce - at the smallest possible delta, which is
why the engine plan names it the smallest second strategy.

## Entry criteria and direct dependencies

- Engine plan Phase 8 merged (task `915fea1a-0479-4d47-a4bd-d5ee3eebbfd5`): the kernel is
  released and its test-only panel fixture proves parallel evaluators compose on generic
  primitives.
- This planning session's PR merged (phase artifacts on the default branch).

## Scope

- Append `panel_vote` to `ENSEMBLE_STRATEGY_IDS` (`src/shared/ensemble.ts`) and fill both
  exhaustive registries (descriptor in shared, compiler in
  `src/server/ensembles/strategies/`).
- Config schema: the Best-of-N roster shape (2-5 members, approach hints) plus a panel of
  2-5 judges, each an optional Persona reference with optional runner/model overrides
  resolved through the existing Persona ladder at attempt time; snapshot exact Persona
  revisions at creation, as the kernel does for the comparative evaluator's guidance.
- Compiled plan: spawn -> collect-all -> evaluate (panel) -> decision -> finalize
  (human-confirmed select-one), reusing the kernel's stage primitives.
- Panel evaluator executor: M parallel tool-less structured calls through the daemon
  review scheduler, one `ensemble_evaluations` row per judge, each recording its
  evaluator snapshot, actual runner/model, bounded input, and typed per-artifact scores.
  A judge's malformed or interrupted result fails that judge's attempt only, with the
  kernel's bounded retry.
- Aggregation: a pure shared function (rank aggregation over per-judge scores plus a
  disagreement measure per artifact); quorum policy in the compiled plan - the evaluation
  stage succeeds when at least two judges succeed, otherwise it fails with retry exposed.
- Result renderer in the Ensemble detail: per-judge scorecards, aggregate rank, and a
  visible disagreement indicator; a Dispatch preset card. Both use the generic
  member/stage/evaluation data - no new route or event.
- README: document the strategy and its quorum semantics.

## Non-goals

Auto-promotion from votes; pairwise tournaments; new terminal outcomes; using the panel
inside Workflow (Workflow Personas remain pass/fail about one subject); per-member
Workflows.

## Repository findings and inherited contracts

At planning time (`57ea5bc`) none of the ensemble kernel exists; Personas and
`runJobStructured` do (`src/server/workflows/personas.ts`, `src/server/llm/jobs.ts`).
Re-verify every kernel name against the merged code before implementing; the engine plan
is authoritative for intent, the merged kernel for spelling. Inherited: evaluators
recommend only; anonymized subjects; data fencing; scores live on evaluation rows;
review-scheduler concurrency; hard budgets.

## Implementation steps

1. `src/shared/ensemble.ts`: append the id; add the `panel_vote` descriptor (schema,
   defaults, form spec, capabilities, launch estimate including M judge calls).
2. Shared pure aggregation module (beside the descriptor or in `@shared`), with fixtures.
3. `src/server/ensembles/strategies/panel-vote.ts`: compiler emitting the fixed plan and
   snapshotting judge Personas.
4. Panel evaluator executor beside the comparative one, reusing its evidence-packet
   assembly and anonymization.
5. Detail renderer + Dispatch preset card.
6. Tests: aggregation fixtures (ties, partial quorum, disagreement); compiler
   validation (judge count bounds, unknown Persona rejected at creation); engine scenario
   with fake judges including one failing judge; renderer markup test.

## Data / API / migration

None. New persisted content is confined to evaluation rows' JSON and the strategy
snapshot; no table, route, or event changes.

## Verification

Focused new tests, then `npm run typecheck && npm test && npm run build`. In the running
app: dispatch a panel_vote run with two members and three judges against a scratch repo;
confirm per-judge rows, aggregate recommendation, disagreement display, and
human-confirmed finalization.

## Merge / exit criteria

All of the above green; a panel_vote run reaches `awaiting_decision` with M evaluation
rows and completes select-one finalization; no `EnsembleEngine` branch tests the strategy
id.

## Downstream handoff

Later phases may rely on: the `panel_vote` id, the shared aggregation function, and the
panel evaluator executor's shape (parallel judges -> one row each). They must not change
its quorum semantics or move scores onto members.

## Cross-phase audit record

- 2026-07-23: created; independent of Phases 2-4; only shared touchpoint is appending to
  the strategy registries beside them.
- 2026-07-25: implemented. Three kernel generalizations were needed and are the ones
  Phases 2-4 inherit, so they are recorded here rather than left to be rediscovered:
  `EnsembleEvaluatorPolicy` became a discriminated union (the kernel's own comment
  anticipated this); `ReviewOutcome` carries a LIST of evaluation records so a driver can
  settle several rows in one attempt, and `ReviewPersist.beginEvaluation` takes the row's
  ordinal and method; and `ReviewDriver.recover` moved the "is this crashed attempt
  already a completed review" question from the engine to the driver. Persona resolution
  also moved from a hard-coded `evaluator.personaId` path in `EnsembleManager` to a
  `StrategyDescriptor.personaRefs` seam, since a panel names one Persona per judge.
  `panel_vote` ships ONE review stage with a `panel_review@1` driver rather than M review
  stages: the engine services one review at a time per run, so M stages would be M
  sequential calls and no quorum. Built-in single-lens rubrics (Correctness,
  Maintainability, Risk, Evidence, Scope) were added so the strategy is useful without
  Persona setup, and duplicate built-in lenses are refused at validation.
