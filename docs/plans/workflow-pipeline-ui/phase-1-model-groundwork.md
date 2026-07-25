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
     `Stage = { joinId: string | null, members: { nodeId: string | null, personaId }[] }`.
     `nodeId: null` marks a member that does not exist in any graph yet (the editor adding a
     reviewer constructs it that way); only `compileStages` mints the real id. `joinId: null`
     means no join node is bound - because the stage has one member, or because the stage is new;
     the compiler needs a join exactly when `members.length > 1` and mints one iff `joinId` is
     null then. Projection always returns fully-identified pipelines (no nulls).
   - `projectStages(graph): StagePipeline | null` - returns the pipeline exactly when the graph is
     stage-expressible: one Session, a linear chain of zero or more stages, each stage one Persona
     (pass onward, fail to Session) or N Personas + one `all_pass` (every member's pass and fail
     into the join, join pass onward, join fail to Session), one End reached by the final stage, no
     other nodes or edges. **The zero-stage projection is first-class**: `stages: []` is what both
     the canonical empty pipeline (the single edge `session.submitted -> end.terminal`, a valid
     0-reviewer workflow that completes on submission) and the fresh-draft state (Session + End
     with no edges at all, invalid but draftable) project to - this is what lets a brand-new
     workflow open in Pipeline mode (phase 2) without editing the graph on open.
   - `stageBlockers(graph, personas?): string[]` - human sentences naming what blocks projection
     ("This graph has 2 End nodes; a pipeline has exactly one.", "Security reviewer's fail route
     does not return to Session."), for the Graph-view banner. `personas` is optional and only
     resolves draft reviewer names; omitting it cannot change how many blockers there are, so
     `stageExpressible(graph)` is `stageBlockers(graph).length === 0`, and `projectStages` returns
     non-null exactly then. A parallel stage is named in a blocker the way `stageName` names it
     ("Stage 2's all-pass join ..."), never by a node id.
   - `compileStages(pipeline, previousGraph): WorkflowDraftGraph` - deterministic emission. Id
     reuse: session and end keep their ids; a member with a non-null `nodeId` keeps it; a stage
     with a non-null `joinId` keeps it; an edge with the same
     `(source, sourcePort, target, targetPort)` as one in `previousGraph` keeps that edge's id;
     every null identity and every genuinely new edge mints `crypto.randomUUID()`. Callers recover
     minted ids by re-projecting the compiled graph - the phase-2 editor's state after every edit
     IS `projectStages(draft)`, so it never holds a stale pipeline with nulls. Positions are
     generated (column per stage, row per member, constants coherent with the existing auto-layout
     spacing). A zero-stage pipeline compiles to the canonical empty form (the direct
     `submitted -> terminal` edge) - so a fresh no-edge draft is canonicalized by the FIRST edit,
     never by merely opening it.
   - `stageName(stage, index, personas): string` - derived naming: the persona's name for a
     single-member stage, `Stage N` for multi-member.
   - `nodeLabel(graph, node, personas): string` - "Session", persona name (or "Missing persona"),
     End outcome. Published persona nodes read the snapshot name; draft nodes resolve through the
     personas list. The graph parameter exists for `all_pass` joins, which carry no stage context
     of their own: when `projectStages(graph)` succeeds, the join's label is the `stageName` of
     its stage; otherwise the label is context-free and derived from the graph's edges -
     "All-pass join · k predecessors" (distinct sources into its `result` port). Never an id in
     either case.
6. **`test/workflow-stages.test.ts`**, opening comment stating what is at stake (round-trip
   stability is what keeps autosave, undo and versions honest). Cases:
   - Round-trip: `projectStages(compileStages(p, g))` deep-equals `p` for representative pipelines
     (zero stages; 1 stage x 1 member; 1 stage x 3 members; 3 stages mixed).
   - Empty pipeline: the fresh-draft graph (Session + End, no edges) projects to `stages: []` with
     no blockers; compiling that projection emits the direct `submitted -> terminal` edge and
     passes `validateWorkflowGraph`.
   - Compiled output always passes `validateWorkflowGraph` (with the relaxed rule).
   - Id stability: add a member, remove a member, reorder stages - unaffected node and edge ids are
     preserved verbatim against `previousGraph`.
   - New-member identity: compiling a pipeline containing `nodeId: null` members mints fresh ids
     that collide with nothing in `previousGraph`, and `projectStages` of the compiled graph
     returns the same pipeline with every null replaced by its minted id (round-trip is exact for
     fully-identified pipelines and exact-up-to-minted-ids otherwise).
   - Taxonomy: non-expressible graphs return blockers and null projection (two Ends; pass fan-out
     to a non-join persona chain; a fail routed only into the join with no join-fail return; a
     join whose predecessors sit in different stages; an isolated node).
   - `nodeLabel` over draft and published node shapes, including a join in a stage-expressible
     graph (stage-consistent label) and the same join in a non-expressible graph (predecessor-count
     label); no case may return a node id.

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
- 2026-07-25 (Inspector round 1, PR #244): `nodeLabel` signature corrected from `(node, personas)`
  to `(graph, node, personas)` - a bare `all_pass` node carries no stage context, so the promised
  stage-consistent join label was underivable; the non-expressible fallback label is now defined
  explicitly. Consumers in phases 2-3 pass the draft or published graph they already hold.
- 2026-07-25 (Inspector round 2, PR #244): the zero-stage projection is now defined - phase 2's
  "brand-new workflow opens in Pipeline mode" exit criterion contradicted the previous 1..k-stage
  expressibility rule. `stages: []` projects from both the fresh no-edge draft and the canonical
  `submitted -> terminal` form; compile canonicalizes on first edit only. Round-trip tests extended
  to cover it; phase 2's empty-state wording aligned in the same change.
- 2026-07-25 (implementation): `stageBlockers` gained an OPTIONAL second `personas` argument. Its
  own worked example ("Security reviewer's fail route ...") names a reviewer, and a draft Persona
  node carries only a `personaId` - so with the one-argument signature every blocker about a draft
  reviewer, which is the Graph-view banner's whole case, would have read "Missing persona". The
  argument defaults to `[]`, so the frozen one-argument call still compiles and still answers
  expressibility identically; `stageExpressible` passes nothing on purpose. Published graphs need
  no list: `nodeLabel` and the projection read the immutable snapshot names off the nodes.
- 2026-07-25 (Inspector round 3, PR #244): `Stage.members[].nodeId` became `string | null` - a
  reviewer being added has no graph node yet, and requiring an id would have forced the editor to
  mint one, breaking the compiler's id-ownership contract. Null identities are minted by
  `compileStages` alone; callers recover them by re-projecting, which is the phase-2 editor's
  state model anyway. `joinId: null` redefined to also cover new multi-member stages.
