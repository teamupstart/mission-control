# Phase 3: Pipeline checks and No-Mistakes Review v2

Source plan: `docs/plans/builtin-workflows/plan.md`
Index: `docs/plans/builtin-workflows/phased-plan.md`

## Outcome and value

Check nodes become first-class in the Pipeline editor, and the shipped **No-Mistakes Review**
gains a cheap deterministic first stage: version 2 runs the configured `typecheck` and `test`
commands before it spends a single model call on a change that does not build.

This is the phase where the two independent halves meet and the plan's headline claim becomes
true. It is also the phase that proves the built-in version list was worth building: version 1
keeps resolving for every binding already pinned to it.

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
- No-Mistakes Review version 2, appended to the built-in catalog.
- README, tests.

Explicit non-goals:

- **Version 1 is not modified.** It stays in the catalog, byte-identical.
- **No new node kind, no new slot.** Both vocabularies are inherited and append-only.
- **No change to command resolution or consent.** Phase 2 owns them.
- **No second built-in workflow.** One workflow, two versions.
- **No migration.** Still nothing stored.

## Repository findings this phase depends on

- `StageMember` is `{ nodeId: string | null; personaId: PersonaId }`
  (`workflow-stages.ts:31-39`). `nodeId: null` marks a member the editor added that no graph
  has yet, and `compileStages` is the only minter of real ids.
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
  check member exactly as on a Persona. `workflow-builder-keyboard.test.ts` is the pin.
- `styles.css`: any new class goes in the matching feature section. Grep the file when
  renaming one.

### 3. No-Mistakes Review version 2

Append to the built-in catalog. Version 1 stays untouched.

The v2 pipeline, in stage order:

| Stage | Members |
|---|---|
| 1 | Check `typecheck`, Check `test` |
| 2 | Intent Conformance Judge |
| 3 | Code Risk Reviewer, Test Evidence Auditor, Documentation Steward |

Stage 1 is the cheap deterministic gate, for the reason this plan reversed the earlier
decision: a change that does not compile should not consume four model calls. Stage 2 remains
the cheap intent gate. Stage 3 is the fan-out.

Two checks in one stage means `compileStages` mints a join for them, and both must pass before
Intent Conformance runs. On an unconfigured machine both are `skipped` and pass, so the graph
behaves exactly as version 1 did.

`definition.currentVersionId` moves to version 2. `draftRevision` increments so the definition
reads as changed.

Build the graph with `compileStages` **at authoring time** and paste the result in as a literal
with frozen ids, exactly as Phase 1 does. Do not call `compileStages` at module load:
`workflow-stages.ts:369, 386, 396` mint `crypto.randomUUID()`, and node and edge ids reach
`workflow_node_attempts.node_id` and `workflow_edge_receipts.edge_id` durably. Version 2's ids
must be as stable as version 1's.

Version 2 mints entirely fresh node ids rather than reusing version 1's. The two graphs are
independent immutable artifacts, and a run pinned to one never consults the other, so shared
ids would buy nothing and would invite exactly the cross-version confusion the pin exists to
prevent.

### 4. README

Update the Built-in workflows section: No-Mistakes Review now ships at version 2 with a
deterministic first stage, what it runs, and that an unconfigured slot passes with a note so it
is safe with no configuration. Note that a binding pinned to version 1 keeps running version 1,
which is how every published version already behaves.

## Data, API and compatibility

- **Version 1 keeps resolving.** `getWorkflowVersionById("builtin-workflow:no-mistakes-review@1")`
  must still answer after this phase. This is the single most important compatibility fact here
  and it has its own test.
- **No migration, no new durable field.**
- **A binding pinned to v1 keeps its behavior.** Adopting v2 means creating a new binding, which
  is the same gesture adopting any new published version already requires.
- **An upgraded install sees v2 as current** with no operator gesture, because the catalog is
  compiled in and `currentVersionId` names the newest.

## Tests and verification

Extend `test/workflow-stages.test.ts`:

- Round trip for a pipeline containing check members, mixed stages included.
- `compileStages` reuses surviving node ids when a check member is added or removed, so
  autosave does not churn.
- A check-containing graph is now stage-expressible and `stageBlockers` is silent.

Extend `test/builtin-workflows.test.ts`:

- The catalog holds versions 1 and 2, ascending, with `currentVersionId` naming 2.
- **Version 1's graph is unchanged**, asserted against a literal, so a future edit to the v2
  builder cannot silently rewrite history.
- v2 validates clean, projects to the three-stage pipeline above, and round-trips.
- v2's check nodes name slots present in `WORKFLOW_CHECK_SLOTS`.

Extend `test/builtin-workflows-store.test.ts`:

- `getWorkflowVersionById` resolves both version ids.
- A binding row naming v1 still resolves after the catalog gains v2. This is the regression the
  phase split can produce and it is checked directly.

Extend `test/workflow-pipeline-editor.test.ts`, `test/workflow-pipeline-render.test.ts` and
`test/workflow-builder-keyboard.test.ts` for the check member: render, add, delete, reorder.

Commands: `npm run typecheck`, `npm test`, `npm run build`.

Manual, on a fresh `HARNESS_HOME`: No-Mistakes Review shows v2, renders in the Pipeline editor
with the deterministic stage first, and binds. With no commands configured, a submission passes
stage 1 with skip notes. With a `typecheck` command configured and deliberately broken code, it
fails at stage 1 without running a Persona, which is the whole point and worth watching happen.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- A binding created against v1 before this change still resolves and still runs after it.
- The shipped workflow renders in the Pipeline editor, not Graph view.
- A broken build fails at stage 1 with zero Persona calls spent.
- An unconfigured machine runs the workflow exactly as v1 behaved.
- README updated in this change.

## Downstream handoff

Nothing is scheduled after this phase. If the follow-up named in the source plan is taken up
later, it may rely on:

- `checkCommandFor` as the single resolution point, so a default-branch file becomes a second
  source behind one helper rather than a second matcher.
- The built-in version list, so a v3 is an append.

It must not rename a slot, a built-in slug, or a version id.

## Cross-phase audit record

- **Inherited from Phase 1's corrected defect**: the built-in graph is a committed literal with
  frozen ids, never a module-load `compileStages` call. Phase 1's audit record has the full
  reasoning. Version 2 is bound by the same rule and this phase states it inline so an
  implementer reading only this file cannot reintroduce it.
- **Against Phase 1**: consumes the versions-list catalog exactly as Phase 1 promised. No
  change to `builtinWorkflowId` / `builtinWorkflowVersionId`, the store merge, or the refusals.
  Version 1 immutability is asserted in this phase's tests rather than assumed.
- **Against Phase 2**: consumes the `check` kind, `WORKFLOW_CHECK_SLOTS`, and the
  unconfigured-slot-passes rule. This phase changes `stageExpressible`, which Phase 2
  explicitly handed over. No other Phase 2 contract is touched.
- **Reconciliation performed while writing this phase**: the v2 pipeline puts two checks in one
  stage, which makes them Join predecessors. Phase 2's validator change (a Join predecessor may
  be a Check) is what allows it. That requirement was already in Phase 2 before this phase was
  written, so no edit back was needed; recorded here because a reader of Phase 2 alone would
  not see why that rule matters.
- **Reconsidered and rejected**: splitting this into "pipeline support" and "v2" as separate
  phases. The pipeline work has no consumer other than v2, and v2 must not ship without it or
  the flagship built-in forces every operator into Graph view. Recorded in `phased-plan.md`.
