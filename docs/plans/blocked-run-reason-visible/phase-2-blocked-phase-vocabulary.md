# Phase 2: No blocked phase goes unnamed

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

Every phase a workflow run can block in has a short, human cause, and every surface that mentions a
blocked run prints that cause instead of the phase's own identifier - including the notification that
fires at the moment it blocks. A phase added later cannot ship unnamed, because a test fails.

## Entry criteria and dependencies

- Direct phase dependencies: **none**. Depends only on the planning session's pull request, which
  publishes this file.
- May run concurrently with Phase 1.

## Scope

1. Move `BLOCKED_PHASE_CLAUSES` and `blockedPhaseClause` from `src/web/workflows/run-model.ts` into
   `src/shared/`, and rewire every consumer.
2. Have the workflow alert body use the clause instead of the raw phase.
3. Write clauses for the fourteen blocked-capable phases that render as the bare fallback.
4. A test that fails when a blocked-capable phase has no clause.

## Non-goals

- **The capture-failure sentence, the decoder arm, and the evidence item identity.** Phase 1 owns
  those. Do not touch `runRefusedSentence`, `WorkflowGateDetail`, or `src/server/workflows/images.ts`.
- **Reading phase detail.** A clause keys off the phase alone. Nothing in this phase decodes
  `gateState`.
- **Changing `runNoMoveReason` or `NO_MOVE_SENTENCES`.** Run detail's prose is Phase 1's concern.

## Repository findings

Verified against the checkout.

- `BLOCKED_PHASE_CLAUSES` and `blockedPhaseClause` occupy `run-model.ts:1063-1097`. Three modules
  import the function: `run-model.ts` itself (`runRemedy`, `:2692`), `run-actions.ts` (`:981`), and
  `src/web/lib/line-review-groups.ts` (`:171`).
- `alerts.ts:403` cannot use it today, because it lives in `src/shared/` and the map lives in
  `src/web/`. It prints `run.phase.replaceAll("_", " ")` instead. The map's own doc comment already
  names this as a hazard: *"two surfaces reading one field must not disagree about what an unmapped
  code looks like."*
- **Fourteen of the twenty-seven blocked-capable phases render as the bare fallback.** Twelve have no
  entry at all; two more (`delivery_blocked`, `delivery_refused`) have an entry whose value is
  character-for-character what `phase.replaceAll("_", " ")` already produces, so mapping them changed
  nothing. All fourteen are this phase's work.

  **The rule that makes this checkable: a clause must not equal `phase.replaceAll("_", " ")`.** An
  entry that merely restates its own identifier is the defect wearing a map key. Proposed starting
  points, each with the reason it is not the fallback:

  | Phase | Proposed clause | Why, and what it is grounded in |
  | --- | --- | --- |
  | `image_evidence_capture` | evidence image changed | Names the cause, not the pipeline stage |
  | `capture_interrupted` | daemon restarted | `engine.ts:1537` writes *"Evidence capture was interrupted by daemon restart; submit again"* - the restart is the fact the operator needs |
  | `conversation_changed` | conversation replaced | `manager.ts:717` fires when `binding.noteKey !== noteKeyFor(session)` and pauses the binding. If you prefer naming the consequence over the cause, `binding paused` is the alternative - decide, do not average |
  | `unchanged_repository` | same commit and tree | `runRefusedSentence` already words it *"same commit, same working tree"*; reuse that vocabulary rather than inventing a second one |
  | `check_cleanup_unresolved` | check retry withheld | The block withholds a check retry pending a worktree lease; "cleanup unresolved" names the internal state instead |
  | `session_action_blocked` | action could not run | `manager.ts:5357` blocks the attempt with a code and detail; the operator needs to know the action did not happen |
  | `external_artifact_mismatch` | artifact moved | |
  | `delivery_prepare_error` | packet not prepared | |
  | `delivery_recovery_error` | recovery failed | |
  | `delivery_blocked` | **already mapped, still the fallback** - reword | |
  | `delivery_refused` | **already mapped, still the fallback** - reword | |
  | `pr_handoff_prepare_error` | handoff not prepared | |
  | `preflight_refinement_exhausted` | out of refinements | |
  | `inspector_pr_switch_refused` | different PR refused | |

  These are proposals, not a specification. Read each phase's writer before adopting its wording: a
  clause that names the wrong thing is worse than the code it replaces, because the code at least
  cannot mislead. The grain is set by the map's own comment - three or four words for a 240px column
  of 10px mono.

- **The guard must be one-directional.** The map legitimately holds `unchanged_evidence` and
  `reattached_resubmit_required`, which are `waiting_for_session` phases rather than blocked ones,
  because the triage column also renders parked runs. Assert that every blocked-capable phase has an
  entry; do **not** assert that every entry is a blocked-capable phase.
- `preflight_refinement_exhausted` is not hypothetical: a second run in the operator's live state
  database is parked there right now, printing its own identifier.

## Implementation steps

### 1. Move the map into `src/shared/`

- `src/shared/` is a controlled path: wire contracts and browser-safe shared logic only, no `node:`
  imports. The map and its accessor are pure string data and one lookup, so they qualify. Place them
  where the blocked vocabulary already lives - `workflow-lifecycle.ts` owns the phase list - or a
  small sibling module if that file is already carrying enough.
- Move the doc comments with the code. They record why the fallback exists and why the grain is what
  it is; a move that drops them turns a considered map into a lookup table.
- Re-export from `run-model.ts` only if that keeps the diff honest; prefer updating the three
  importers to the new path.

### 2. Rewire the alert

- `alerts.ts:403` replaces `run.phase.replaceAll("_", " ")` with the clause. The title stays as it
  is; only the body changes.
- Check the neighbouring arms while you are there: the `resumed` arm at the bottom of the same
  function prints the raw phase the same way, and it is the same defect on the way out of a block.

### 3. Write the fourteen clauses

One at a time, each verified against the code that writes the phase. Carry a one-line comment for any
whose wording is not self-evident, as the existing entries do.

### 4. The exhaustiveness guard

- A test iterating `WORKFLOW_RUN_PHASES`, filtering to those whose `WORKFLOW_RUN_PHASE_STATUSES`
  entry includes `blocked`, and asserting for each that a `BLOCKED_PHASE_CLAUSES` key exists **and
  that its value is not `phase.replaceAll("_", " ")`**.
- The second half is the half that matters, and it is not belt-and-braces. A key-existence check
  alone would pass on `capture_interrupted: "capture interrupted"` - an entry that adds a map key and
  changes nothing a reader sees. Two entries in the map today (`delivery_blocked`,
  `delivery_refused`) are exactly that, which is how the weaker guard is known to be insufficient
  rather than merely suspected.
- The guard therefore fails on the current map until all fourteen are reworded. That is intended: it
  is the work of this phase, not a surprise to route around by weakening the assertion.
- The failure message should say what to do - add an entry, or write one that beats the fallback -
  rather than only that a key is missing. The next person to hit this will be adding an unrelated
  phase.

## Data and compatibility

No persisted data, no migration, no wire-format change. The clause is derived at render time from a
column that is already sent.

## Tests and verification

- The new exhaustiveness test.
- `test/line-review-groups.test.ts` - a blocked run groups under its clause rather than its phase
  code.
- `test/workflow-alerts.test.ts` - the alert body carries the clause.
- Whatever currently covers `blockedPhaseClause`'s fallback must keep passing unchanged: an unmapped
  code still degrades to readable text rather than to `undefined`, and the two surfaces must still
  agree on what that looks like.
- **A new spec in `e2e/specs/`.** The Line strip or Review drawer showing a blocked run named by its
  cause. Select by role and label; no `data-testid`. This is a UI change, so the spec is not optional.
- `npm run typecheck`, `npm run lint`, and `npm run build && npm run test:e2e`.

## Merge and exit criteria

- All of the above green.
- No blocked-capable phase renders its own identifier in the Line strip, the Review drawer, the Runs
  rail, or a notification.
- `blockedPhaseClause` keeps its name, its `(phase: string) => string` signature, and its fallback
  behavior.

## Downstream handoff

Later work may rely on:

- `blockedPhaseClause` living in `src/shared/` and being callable from daemon and browser alike.
- The exhaustiveness test as the place a new blocked phase learns it owes a clause.

Must not change: the fallback for an unmapped code, since `alerts.ts` and the triage column both
depend on it rendering the same way.

## Cross-phase audit record

- **Written second**, after re-reading `plan.md`, `phased-plan.md` and
  `phase-1-capture-failure-visible.md`.
- Reconciled with Phase 1 on the map: Phase 1's audit record was written to explicitly *not* add an
  `image_evidence_capture` clause, so ownership is unambiguous and the two phases cannot both edit
  `BLOCKED_PHASE_CLAUSES`.
- Reconciled on the shared file: Phase 1 adds a union arm and an accessor to
  `workflow-lifecycle.ts`; this phase may add the clause map to the same file. Different regions, no
  semantic overlap, but whichever merges second rebases. Recorded in `phased-plan.md`'s concurrency
  note.
- Reconciled on `run-model.ts`: Phase 1 edits `runRefusedSentence` (~line 1616), this phase removes
  `BLOCKED_PHASE_CLAUSES` (~line 1063) and updates `runRemedy` (~line 2692). Textual proximity only.
- No dependency direction between the phases in either direction. Confirmed both merge orders leave a
  coherent product, as recorded in the index.
- **Round 1 review, 10 September 2026.** GitHub Inspector flagged that three proposed clauses
  (`capture_interrupted`, `conversation_changed`, `unchanged_repository`) were identical or trivially
  equivalent to the fallback they exist to replace, and that a key-existence guard would let an
  implementer ship them. Correct, and checking it found two *existing* map entries with the same
  defect. Resolved by adding the "must not equal the fallback" rule to the guard, grounding each
  reworded clause in its phase's writer, and widening the phase from twelve clauses to fourteen. No
  approved decision changed: the decision was "name the blocked phases and add an exhaustiveness
  test", and this makes both stricter rather than different.
