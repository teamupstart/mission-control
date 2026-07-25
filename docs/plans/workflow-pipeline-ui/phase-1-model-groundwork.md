# Phase 1 - Model groundwork

## 1. Outcome

Session fan-out is legal, proven at the engine, and a shared stage projection/compiler module
exists with its API frozen for the UI phases. No user-visible change ships in this phase; it exists
so phases 2 and 3 are pure UI work against a tested contract.

## 2. Entry criteria and dependencies

- Direct prerequisites: none (first phase).
- The approved source plan (`docs/plans/workflow-pipeline-ui/plan.md`) with its adopted decisions:
  fan-out relaxed to at-least-one; graph view co-equal; derived stage names only.

## 3. Scope

1. Relax the validator's `session_submitted_route` rule.
2. Prove engine fan-out with a test (no engine code change expected).
3. Create `src/shared/workflow-stages.ts`: projection, compiler, expressibility, blockers,
   vocabulary.
4. Update the workflow-builder spec sentence that states the old rule.

Non-goals: any component, stylesheet or route change; any change to diagnostics codes (they are a
stable UI/test contract); any persisted-model change (decision 3 adopted derived naming).

## 4. Repository findings this phase relies on

- `validateWorkflowGraph` emits `session_submitted_route` when submitted-edge count `!== 1`
  (`src/shared/workflow-graph.ts:169-175`). Zero and two currently produce the same message.
- `connectionAllowed` (`workflow-graph.ts:265-274`) is stateless and needs no change: with the rule
  relaxed, the second submitted edge it already permits becomes legal.
- The engine fans out structurally: `edgesFrom` returns all matching edges and one receipt is
  written per outgoing edge (`src/server/workflows/engine.ts:74-76`, `:180-184`); receipts are
  idempotent per `(submission_id, edge_id)` (`INSERT OR IGNORE` + unique index, `db.ts`). Persona
  activation is first-receipt-wins (`engine.ts:213-228`), so N submitted edges queue N attempts.
- `test/workflow-graph.test.ts:36` pins fan-out from a persona `pass` as valid; the same file pins
  the old session rule and must be updated, not deleted.
- The spec sentence lives in `docs/plans/workflow-builder/phase-2-builder-publishing.md` (fan-out
  rules, near line 186).

## 5. Implementation steps

1. **Validator.** In `src/shared/workflow-graph.ts`, change the session check to error only when
   `submitted.length === 0`. Keep the code id `session_submitted_route`; reword the message to
   "Session needs a submitted route." (the exactly-one phrasing becomes false). No other rule
   changes.
2. **Spec.** Update the fan-out sentence in
   `docs/plans/workflow-builder/phase-2-builder-publishing.md` to state that `submitted` may fan
   out and that zero routes remain an error. One sentence, same section.
3. **Validator tests.** In `test/workflow-graph.test.ts`: update the pinned rule case; add a case
   asserting a graph with two `submitted` edges to two personas (each with pass/fail routes and a
   join) is `{ valid: true }`; keep the zero-route error case.
4. **Engine test.** In `test/workflow-engine.test.ts` (same harness as existing cases): a published
   graph with `session.submitted -> P1.activate` and `session.submitted -> P2.activate` activates
   both persona attempts from one submission, and restart replay does not duplicate receipts.
5. **`src/shared/workflow-stages.ts`** (browser-safe, no `node:` imports), exporting:
   - `StagePipeline`: `{ sessionId, endId, endOutcome, stages: Stage[] }` with
     `Stage = { joinId: string | null, members: { nodeId, personaId }[] }`. A single-member stage
     has `joinId: null`.
   - `projectStages(graph): StagePipeline | null` - returns the pipeline exactly when the graph is
     stage-expressible: one Session, a linear chain of stages, each stage one Persona (pass onward,
     fail to Session) or N Personas + one `all_pass` (every member's pass and fail into the join,
     join pass onward, join fail to Session), one End reached by the final stage, no other nodes or
     edges.
   - `stageBlockers(graph): string[]` - human sentences naming what blocks projection ("Two End
     nodes", "Security reviewer's fail route does not return to Session"), for the Graph-view
     banner. `stageExpressible(graph)` is `stageBlockers(graph).length === 0`, and
     `projectStages` returns non-null exactly then.
   - `compileStages(pipeline, previousGraph): WorkflowDraftGraph` - deterministic emission. Id
     reuse: session and end keep their ids; a surviving member keeps its persona node id (keyed by
     `member.nodeId`); a surviving stage keeps its join id; an edge with the same
     `(source, sourcePort, target, targetPort)` as one in `previousGraph` keeps that edge's id;
     everything else mints `crypto.randomUUID()`. Positions are generated (column per stage, row
     per member, constants coherent with the existing auto-layout spacing).
   - `stageName(stage, index, personas): string` - derived naming: the persona's name for a
     single-member stage, `Stage N` for multi-member.
   - `nodeLabel(node, personas): string` - "Session", persona name (or "Missing persona"),
     `stageName`-consistent join label, End outcome. Published persona nodes read the snapshot
     name; draft nodes resolve through the personas list.
6. **`test/workflow-stages.test.ts`**, opening comment stating what is at stake (round-trip
   stability is what keeps autosave, undo and versions honest). Cases:
   - Round-trip: `projectStages(compileStages(p, g))` deep-equals `p` for representative pipelines
     (1 stage x 1 member; 1 stage x 3 members; 3 stages mixed).
   - Compiled output always passes `validateWorkflowGraph` (with the relaxed rule).
   - Id stability: add a member, remove a member, reorder stages - unaffected node and edge ids are
     preserved verbatim against `previousGraph`.
   - Taxonomy: non-expressible graphs return blockers and null projection (two Ends; pass fan-out
     to a non-join persona chain; a fail routed only into the join with no join-fail return; a
     join whose predecessors sit in different stages; an isolated node).
   - `nodeLabel` over draft and published node shapes.

## 6. Compatibility

- Relaxing validation is read-compatible: every previously valid graph stays valid; summaries'
  `errorCount` can only decrease.
- A fan-out graph published by this build re-validates as invalid on older builds (publish-time
  only; published versions are immutable and older engines execute fan-out correctly). Noted in the
  README line this phase adds.

## 7. Tests and verification

`npm run typecheck`, `npm test`, `npm run build`. New suite `workflow-stages.test.ts`; updated
`workflow-graph.test.ts`, `workflow-engine.test.ts`. Any test touching the db sets `HARNESS_HOME`
to a fresh temp dir before imports (house rule).

## 8. Merge and exit criteria

- All suites green on Node 24 and 26; no UI diffs; README gains one line under the Workflows
  section noting parallel first-wave review is supported.
- `workflow-stages.ts` exports exactly the API above.

## 9. Downstream handoff

Later phases may rely on: the relaxed validator; the exported names and signatures of
`projectStages`, `compileStages`, `stageBlockers`, `stageExpressible`, `stageName`, `nodeLabel`,
`StagePipeline`, `Stage`; the id-reuse guarantees of `compileStages`; and diagnostics codes being
unchanged. They must not change these without editing this phase's tests.

## 10. Cross-phase audit record

- 2026-07-25: `stageBlockers` added to the phase-1 API (phase 2's Graph-view banner needs reasons,
  not a boolean); `projectStages` defined as consistent with it.
