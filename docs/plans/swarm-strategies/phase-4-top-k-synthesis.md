# Phase 4 - `top_k_synthesis`: graft the best of K

## Outcome and value

Winner-takes-most instead of winner-takes-all: N members implement independently, the
comparative evaluator ranks them, the top K (2-3) advance, and a **fresh synthesis
member** - launched from the pinned run base with directed visibility of exactly those K
artifacts - produces one combined implementation carrying explicit lineage
(`parentArtifactIds`). The human decides between the synthesized artifact and the rank-1
original; finalization materializes the choice. Value: the runners-up's best ideas stop
being reaped with their worktrees, using the outcome kind (`synthesized`) and lineage
fields the kernel already defines.

## Entry criteria and direct dependencies

- Engine plan Phase 8 merged (task `915fea1a-0479-4d47-a4bd-d5ee3eebbfd5`): its
  extension-proof suite exercises a synthesized outcome on fake members, so the stage
  primitive exists at least test-only.
- This planning session's PR merged.

## Scope

- Append `top_k_synthesis` to `ENSEMBLE_STRATEGY_IDS`; descriptor (roster 3-5, K of 2-3,
  approach hints, optional guidance Persona) and compiler.
- Compiled plan: spawn -> collect-all -> evaluate (comparative, reused) -> advance
  (top K by rank; non-destructive - eliminated members stop, nothing is reaped) ->
  synthesize (one member from run base, information policy granting exactly the K
  advanced artifacts) -> collect -> decision -> finalize.
- **Productionize the synthesize stage**: if the merged kernel left the synthesize
  executor test-only after engine Phase 8, this phase owns making it product-grade - the
  synthesis member template, the server-rendered input appendix (bounded, attributed
  materializations of the K artifacts; never sibling worktree paths or ref names), and
  the derived artifact's `parentArtifactIds` capture. If it shipped product-grade, this
  phase only consumes it; record which at implementation time.
- Synthesis member prompt appendix: the task, the K attributed design/diff
  materializations under the kernel's data fencing, an instruction to produce one
  coherent implementation (not a concatenation), no pushes/PRs, explicit submission.
- Decision: the operator chooses the synthesized artifact or the rank-1 original;
  finalize maps that to outcome `synthesized` (with `memberId`/`artifactId` of the
  synthesis) or `selected`, both through the kernel's human-confirmed transaction and
  exact-snapshot restore.
- Detail renderer: lineage display (which parents fed the synthesis), the two-way
  decision, and the familiar scorecards for the first evaluation; Dispatch preset card;
  README.

## Non-goals

Multiple synthesis rounds; synthesizing plans (Phase 3's kind; a later composition);
letting the evaluator or a driver choose synthesis vs original (human only); K > 3.

## Repository findings and inherited contracts

No kernel at planning time; `parentArtifactIds`, the `synthesized` outcome, directed
`InformationPolicy`, and the advance primitive are all defined by the engine plan and
delivered by its tasks - re-verify their merged spelling. Inherited: every cross-member
influence is server-rendered and visible in the run timeline; the synthesis member's
input is bounded evidence, not filesystem access to siblings; hard budgets count the
synthesis member against `maxMembers`.

## Implementation steps

1. `src/shared/ensemble.ts`: append the id; descriptor with K bounds and a launch
   estimate that includes the synthesis member and second collect.
2. `src/server/ensembles/strategies/top-k-synthesis.ts`: compiler; validation that K is
   at least 2 and less than the roster, and that advancement input is the completed
   comparative evaluation.
3. Synthesize stage production work per the scope bullet (or its consumption, recorded
   either way in this file's audit record at implementation time).
4. Renderer (lineage + two-way decision), preset card, README.
5. Tests: compiler bounds; scenario from fake members through advance, synthesis
   submission, and both decision branches; a test that the synthesis member's appendix
   contains only the K advanced artifacts' materializations; renderer markup test.

## Data / API / migration

None. Lineage, advancement, and the synthesis input all live in existing member,
artifact, stage-attempt, and evaluation rows.

## Verification

Focused tests, then `npm run typecheck && npm test && npm run build`. In the app: run a
3-member ensemble with K=2, watch the synthesis member launch with the two
materializations, and complete both decision branches across two runs (accept synthesis;
fall back to the original).

## Merge / exit criteria

A top_k_synthesis run reaches the decision with a submitted synthesis artifact whose
lineage names exactly the advanced parents; both terminal outcomes finalize correctly;
eliminated members' refs survive; no engine branch tests the id.

## Downstream handoff

Later work may rely on: the `top_k_synthesis` id and the production synthesize stage
(template + bounded attributed input appendix). It must not grant synthesis members
broader visibility than their declared inputs.

## Cross-phase audit record

- 2026-07-23: created; independent of Phases 1-3. Reuses the kernel's comparative
  evaluator (like Phase 3) precisely so no cross-phase dependency exists; a
  panel-evaluated synthesis is a later composition.
