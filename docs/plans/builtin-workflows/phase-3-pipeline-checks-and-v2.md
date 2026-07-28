# Phase 3: Pipeline checks and No-Mistakes Review v3

Source plan: `docs/plans/builtin-workflows/plan.md`
Index: `docs/plans/builtin-workflows/phased-plan.md`

## Outcome and value

Check nodes become first-class in the Pipeline editor, and the shipped **No-Mistakes Review**
gains a deterministic first stage: version 3 records the `typecheck` and `test` checks before
it reaches any Persona. The production command-execution runtime remains a separate unit, so
this build records configured checks as not run and passed.

This is the phase where the two independent graph and catalog halves meet. It is also the
phase that proves the built-in version list was worth building: versions 1 and 2 keep
resolving for every binding already pinned to them. The original phase reserved version 2 for
this gate, but the merged base shipped version 2 first with Live delivery defaults. The
append-only version contract therefore places the gate at version 3. The command-execution
headline remains contingent on the separate runtime unit.

## Entry criteria and dependencies

Direct prerequisites: **Phase 1 and Phase 2**, both merged.

Before starting, run `npm run typecheck` against the merged base. This is the first point at
which the `builtin` flag and the `check` kind exist in one tree, and a conflict between them
surfaces here rather than inside the work.

## Scope

In scope:

- `StageMember` becomes a discriminated union so a stage can hold checks as well as Personas.
- `projectStages` / `compileStages` / `stageBlockers` / `stageExpressible` handle checks.
- `PipelineEditor.tsx` and `pipeline-bits.tsx` render and edit check members.
- No-Mistakes Review version 3, appended to the built-in catalog.
- README, tests.

Explicit non-goals:

- **Version 1 is not modified.** It stays in the catalog, byte-identical.
- **No new node kind, no new slot.** Both vocabularies are inherited and append-only.
- **No change to command resolution or consent.** Phase 2 owns them.
- **No production command-execution runtime.** This phase consumes the Check execution seam;
  a separate unit must supply its crash-safe process and worktree lifecycle.
- **No second built-in workflow.** One workflow, three versions.
- **No migration.** Still nothing stored.

## Repository findings this phase depends on

- Before this phase, `StageMember` was
  `{ nodeId: string | null; personaId: PersonaId }`. `nodeId: null` marks a member the editor
  added that no graph has yet, and `compileStages` is the only minter of real ids.
- The invariant at the top of `workflow-stages.ts` is
  `projectStages(compileStages(p, g)) === p`. Widening the member type must preserve it, and
  the existing round-trip test is the place that proves it.
- `compileStages` emits a join exactly when `members.length > 1`, wires every member's `pass`
  and `fail` into the join's `result`, and reuses every surviving node and edge id so CAS
  autosave and undo do not churn. A check member must take the same path, which is why the
  validator already accepts a check as a Join predecessor (Phase 2, `workflow-graph.ts:198`).
- `LAYOUT` (`workflow-stages.ts:60`) is coherent with `autoLayout` in `WorkflowCanvas.tsx`:
  same origin, column and row spacing. Positions stay derived, never hand-placed.
- `stageExpressible` returns false for check-containing graphs after Phase 2. This phase
  removes that narrowing and the `stageBlockers` sentence that explains it.
- Phase 1 established `BUILTIN_WORKFLOWS` as a list of versions per workflow with
  `definition.currentVersionId` naming the newest, precisely so this phase appends.
- Phase 2 established that an unconfigured slot is `skipped` and passes. Without that, shipping
  check gates in a built-in would break the workflow on every unconfigured machine.

## Implementation steps, in execution order

### 1. Widen the stage member (`src/shared/workflow-stages.ts`)

```ts
export type StageMember =
  | { nodeId: string | null; kind: "persona"; personaId: PersonaId }
  | { nodeId: string | null; kind: "check"; slot: WorkflowCheckSlot };
```

Adding the discriminant to **both** arms rather than leaving the Persona arm bare is what
makes every existing `member.personaId` read fail typecheck until it says which kind it meant.
A bare arm plus an optional `slot` would compile everywhere and be wrong in the places nobody
revisited.

Update in order: the `isPersonaNode` helpers, `projectStages` (emit the right member per node
kind), `compileStages` (mint a `check` node with its slot, otherwise identical), `stageName`
and `nodeLabel` (a check's label is its slot), and `stageBlockers` (drop the Phase 2 sentence).
`stageExpressible` stops rejecting checks.

Preserve the round trip. A stage mixing a Persona and a check is legal and should be tested,
because the compiler treats members uniformly and the projection must too.

### 2. Pipeline editor (`src/web/workflows/`)

- `PipelineEditor.tsx` holds no pipeline state: after every edit it re-projects the draft. That
  does not change. What changes is the add affordance, which now offers Personas and check
  slots, and the reviewer row, which renders a slot chip instead of a Persona name.
- `pipeline-bits.tsx`: `ReviewerRow` gains a check variant. Put it there, not inline in the
  editor, per the shared-leaf rule.
- Keyboard parity is not optional: the existing ⌥↑/⌥↓ member reorder and Delete must work on a
  check member exactly as on a Persona. `workflow-builder-a11y.test.ts` is the pin.
- `styles.css`: any new class goes in the matching feature section. Grep the file when
  renaming one.

### 3. No-Mistakes Review version 3

Append to the built-in catalog. Versions 1 and 2 stay untouched.

The v3 pipeline, in stage order:

| Stage | Members |
|---|---|
| 1 | Check `typecheck`, Check `test` |
| 2 | Intent Conformance Judge |
| 3 | Code Risk Reviewer, Test Evidence Auditor, Documentation Steward |

Stage 1 is the cheap deterministic gate, for the reason this plan reversed the earlier
decision: a change that does not compile should not consume four model calls. Stage 2 remains
the cheap intent gate. Stage 3 is the fan-out.

Two checks in one stage means `compileStages` emits their named join, and both must pass before
Intent Conformance runs. On an unconfigured machine both are `skipped` and pass, so the graph
follows the same Persona review path as version 2.

`definition.currentVersionId` moves to version 3. `draftRevision` increments so the definition
reads as changed.

Write each version as its own complete frozen `StagePipeline` literal. Shared stage arrays
would let a future version edit rewrite an older version silently. Node ids are named in the
literal and edge ids are derived deterministically from their endpoints, so nothing durable
is minted at module load.

Reuse a node id across versions when it is the same logical node, such as Intent Conformance,
so attempt rows keep naming the same reviewer. Version 3 adds fresh ids only for its new
checks and their Join.

### 4. README

Update the Built-in workflows section: No-Mistakes Review now ships at version 3 with a
deterministic first stage, which slots it names, the current execution-runtime limitation, and
that an unconfigured slot passes with a note so it is safe with no configuration. Note that a
binding pinned to version 1 or 2 keeps running that version, which is how every published
version already behaves.

## Data, API and compatibility

- **Versions 1 and 2 keep resolving.**
  `getWorkflowVersionById("builtin-workflow:no-mistakes-review@1")` and its `@2` counterpart
  must still answer after this phase. This is the single most important compatibility fact
  here and it has its own test.
- **No migration, no new durable field.**
- **A binding pinned to v1 or v2 keeps its behavior.** Adopting v3 means creating a new
  binding, which is the same gesture adopting any new published version already requires.
- **An upgraded install sees v3 as current** with no operator gesture, because the catalog is
  compiled in and `currentVersionId` names the newest.

## Tests and verification

Extend `test/workflow-stages.test.ts`:

- Round trip for a pipeline containing check members, mixed stages included.
- `compileStages` reuses surviving node ids when a check member is added or removed, so
  autosave does not churn.
- A check-containing graph is now stage-expressible and `stageBlockers` is silent.

Extend `test/builtin-workflows.test.ts`:

- The catalog holds versions 1, 2 and 3, ascending, with `currentVersionId` naming 3.
- **Version 1's complete version artifact is unchanged**, including its Persona snapshots,
  asserted against a literal so a future edit cannot silently rewrite history.
- Version 3's Persona snapshots equal the current built-in Persona catalog. Any later
  referenced guidance change must append another version rather than rewriting version 3.
- v3 validates clean, projects to the three-stage pipeline above, and round-trips.
- v3's check nodes name slots present in `WORKFLOW_CHECK_SLOTS`.

Extend `test/builtin-workflows-store.test.ts`:

- `getWorkflowVersionById` resolves all three version ids.
- Binding rows naming v1 or v2 still resolve after the catalog gains v3. This is the
  regression the phase split can produce and it is checked directly.

Extend `test/workflow-pipeline-editor.test.ts`, `test/workflow-pipeline-render.test.ts` and
`test/workflow-builder-a11y.test.ts` for the check member: render, add, delete, reorder.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual, on a fresh `HARNESS_HOME`: No-Mistakes Review shows v3, renders in the Pipeline editor
with the deterministic stage first, and binds. With no commands configured, a submission
passes stage 1 with skip notes. With a command configured, this build records the check as not
run and passed because no production caller supplies the execution dependency. Exercise the
real v3 graph through the engine's execution seam to prove that a failing typecheck stops the
run before any Persona attempt.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- A binding created against v1 or v2 before this change still resolves and still runs after it.
- The shipped workflow renders in the Pipeline editor, not Graph view.
- Through the engine execution seam, a failing stage-1 check spends zero Persona calls.
- Without a production execution dependency, configured checks are visibly not run and pass.
- An unconfigured machine follows the same Persona review path as v2.
- README updated in this change.

## Downstream handoff

No numbered phase is scheduled after this one. The production check-execution runtime remains
a separate dependency-linked unit. If the configuration follow-up named in the source plan is
taken up later, it may rely on:

- `checkCommandFor` as the single resolution point, so a default-branch file becomes a second
  source behind one helper rather than a second matcher.
- The built-in version list, so a v4 is an append.

It must not rename a slot, a built-in slug, or a version id.

## Cross-phase audit record

- **Inherited from Phase 1's corrected defect**: every built-in version declares frozen node
  ids and derives stable edge ids. The shared compiler may calculate routes and positions at
  module load, but no minted UUID reaches the published graph. Phase 1's audit record has the
  full reasoning.
- **Against Phase 1**: consumes the versions-list catalog exactly as Phase 1 promised. No
  change to `builtinWorkflowId` / `builtinWorkflowVersionId`, the store merge, or the refusals.
  Version 1 immutability is asserted in this phase's tests rather than assumed.
- **Against Phase 2**: consumes the `check` kind, `WORKFLOW_CHECK_SLOTS`, and the
  unconfigured-slot-passes rule. This phase changes `stageExpressible`, which Phase 2
  explicitly handed over. No other Phase 2 contract is touched.
- **Reconciliation performed while writing this phase**: the v3 pipeline puts two checks in one
  stage, which makes them Join predecessors. Phase 2's validator change (a Join predecessor may
  be a Check) is what allows it. That requirement was already in Phase 2 before this phase was
  written, so no edit back was needed; recorded here because a reader of Phase 2 alone would
  not see why that rule matters.
- **Reconsidered and rejected**: splitting this into "pipeline support" and "v3" as separate
  phases. The pipeline work has no consumer other than v3, and v3 must not ship without it or
  the flagship built-in forces every operator into Graph view. Recorded in `phased-plan.md`.
