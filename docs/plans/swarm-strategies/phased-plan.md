# Phased plan - ensemble strategies after best_of_n v1

Source plan: `docs/plans/swarm-strategies/plan.md` (this directory)
Engine plan: `docs/plans/best-of-n-swarm-dispatch/plan.md` (committed `c8ccf4a`)
Rendered: `phased-plan.html` beside this file.

## Incorporated decisions (2026-07-23 dashboard review)

1. Priorities after `best_of_n` v1: **Persona panel vote, divergence mining, design-off
   (plan ArtifactAdapter), top-K synthesis**. Nothing else is scheduled; spec-first
   guidance was folded into the engine plan's follow-ups but not selected, so it is a
   non-goal here.
2. The extensions are folded into the engine plan's "Likely follow-ups" (done in the same
   change that produced this file).
3. This phased plan and its dependency-linked tasks are the selected next step.

## Investigated findings

- The engine plan is already scheduled as eight dependency-linked Mission Control tasks
  ("Implement Multi-Agent Ensembles - Phase 1..8"), chained P1 -> P3 -> P4 -> P5 -> P6 ->
  P7 -> P8, with P2 feeding P4. Its Phase 8 ("Extension Proof, Hardening, and Release",
  task `915fea1a-0479-4d47-a4bd-d5ee3eebbfd5`) is the kernel's release gate and already
  proves test-only panel, pairwise, adaptive-wave, and synthesis fixtures compose on the
  generic primitives. Every phase below takes that task as its direct external
  prerequisite; the chain makes the rest transitive.
- Current code (main at `57ea5bc`): Workflow Phases 1-3 are implemented
  (`src/server/workflows/{context,engine,manager,personas,prompt,store,verdict}.ts`);
  `runJobStructured` exists in `src/server/llm/jobs.ts`; `WORKFLOW_TRIGGER_MODES` is
  `["manual", "foreman_complete"]`. No `src/server/ensembles/`, no `ENSEMBLE_*` shared
  constants, no `workflow_binding_claims` exist yet - all of that arrives via the engine
  tasks, so file-level steps in the phase documents cite the engine plan's contracts, and
  each implementing agent must re-verify names against the merged kernel before coding.
- The engine plan's "What adding a strategy should cost" is the boundary each phase is
  held to: append a strategy id, compose policies in one compiler, generic or one focused
  config panel, fixtures and scenario tests, README and a preset card - and **no new
  migration, HTTP route family, ServerEvent variant, useEventStream branch, session prop,
  or layout mark vocabulary**. Where a phase needs a genuinely new primitive it is named
  explicitly and owned by exactly one phase.

## Phases

| Phase | File | Strategy / primitive | Direct prerequisites |
|---|---|---|---|
| 1 | `phase-1-panel-vote.md` | `panel_vote` strategy; evaluator panel + vote aggregation | Engine P8, planning session |
| 2 | `phase-2-divergence-mining.md` | `consensus` strategy; evaluator-derived decision options | Engine P8, planning session |
| 3 | `phase-3-design-off-plan-adapter.md` | `plan` ArtifactAdapter + `design_off` strategy | Engine P8, planning session |
| 4 | `phase-4-top-k-synthesis.md` | `top_k_synthesis` strategy; synthesize stage in product | Engine P8, planning session |

## Dependency graph and concurrency

    engine P8 (external, 915fea1a...) ──┬── Phase 1  panel_vote
    planning session (this session) ────┼── Phase 2  consensus / divergence mining
                                        ├── Phase 3  design_off + plan adapter
                                        └── Phase 4  top_k_synthesis

All four phases are mutually independent and may run and merge **concurrently in any
order** once the engine chain and this planning session's PR have merged. Each appends its
own strategy id and owns disjoint primitives; the only expected overlap is textual
(adjacent entries in the append-only registries), which any merge resolves by keeping both
lines.

## Cross-phase contracts

- Append-only ids, one owner each: `panel_vote` (Phase 1), `consensus` (Phase 2),
  `design_off` (Phase 3), `top_k_synthesis` (Phase 4); artifact kind `plan` (Phase 3).
  No phase renames or reuses another's id.
- Every phase preserves the kernel invariants verbatim: evaluators recommend and never
  promote; destructive finalization requires human confirmation; artifacts are immutable
  and their refs/blobs survive until explicit delete; evaluator calls are tool-less,
  anonymized, fenced, Zod-validated, and scheduled through the daemon review scheduler;
  hard member/concurrency/wave budgets bind every launch.
- Scores, ranks, votes, and divergences live on evaluation rows, never on
  `EnsembleMember`.
- No phase adds a table, route family, ServerEvent variant, or layout mark. The two
  places a phase touches generic surfaces - Phase 2's decision rendering and Phase 3's
  artifact locator union - extend existing discriminated unions their kernel owners
  already declared extensible.
- README: each phase documents its strategy under the Ensembles section it finds; the
  phase that merges first creates the "additional strategies" subsection the others
  append to.

## Merge order and final verification

Merge order among Phases 1-4 is free. Final state: four selectable strategy preset cards
beside Best-of-N in Dispatch, each executing on the unchanged kernel. After the last
merge, run the full suite (`npm run typecheck && npm test && npm run build`) plus each
phase's scenario tests, and verify in the running app that a run of each strategy reaches
its terminal outcome with the layout parity marks intact.
