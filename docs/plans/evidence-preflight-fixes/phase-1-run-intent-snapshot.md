# Phase 1: Run intent snapshot and run-frozen criteria

## Outcome and value

A workflow run judges every submission against the intent that existed when the run started. The
session Goal, which Mission Control's own repair packets can overwrite through the prompt hook, is
no longer the review's source of truth. Canonical acceptance criteria are compacted once per run and
stay stable across every round and refinement, ending the criteria drift (4, 3, 6, 5, 5, 5, 5, 7, 2
on the observed run) and cutting roughly 21 context-model calls per run to 2. Repair packets can no
longer appear under "# Original human intent" in any Persona prompt.

## Entry criteria and dependencies

- No phase dependencies. Requires only the planning PR (this plan's artifacts) to be merged.
- The repository at current `main`; all cited anchors verified at commit `4e0b70e7`.

## Scope and non-goals

In scope:

- Persisting an intent snapshot on `workflow_runs` and freezing it at run creation.
- Reading frozen intent (raw goal, refined goal, human decisions) during context capture instead of
  the live Goal and live decision extraction.
- Compacting canonical criteria once per run, storing them on the run, and reusing them for every
  submission.

Non-goals:

- No change to how the session Goal itself is captured or displayed (`captureHookGoalPrompt` and
  `captureAcceptedPrompt` stay as they are; the dashboard Goal remains live).
- No change to transcript capture, attribution, or filtering; the transcript stays a live
  per-submission read.
- No evidence or coverage storage changes (Phase 3).
- No Persona prompt wording changes (Phase 2).
- No operator intent-amendment event; if the operator's ask genuinely changes mid-run, that is a new
  run.

## Repository findings

- Runs are created inside `createInitialSubmission` (`src/server/workflows/store.ts:5316`), which
  inserts `workflow_runs` in a transaction with the round-1 submission. This is the freeze point:
  the earliest moment a durable run row exists. There is a second `INSERT INTO workflow_runs` around
  `store.ts:5480`; both insert paths must freeze the same snapshot shape.
- The live intent enters capture in `readWorkflowContextRaw` (`src/server/workflows/context.ts:918`):
  `registry.getGoal(session.id)` at `context.ts:923`, `primaryGoal.rawPrompt` from `goal?.prompt` at
  `context.ts:971`, and `boundedDecisions` at `context.ts:952` combining resolved reviews, Foreman
  episodes, and `humanTranscriptDecisions` of the filtered transcript.
- `intentFingerprintFields` (`context.ts:201`) returns `{rawGoal, refinedGoal, decisions}`; it is
  both the whole compaction prompt (`compactPrompt`, `context.ts:479`) and the intent fingerprint
  (`context.ts:220`).
- Criteria reuse (`reuseWorkflowContextCriteria`, `context.ts:597`) is gated in the manager at
  `manager.ts:6029` on `refinementReason === "evidence_preflight"` plus a fingerprint match, so it
  never applies across Persona repair rounds. It fired zero times on the observed run.
- Schema for `workflow_runs` is created in `src/server/db.ts:1355`; the repository convention keeps
  migrations next to the upgrade path (`addColumn` in `migrate()` plus the CREATE TABLE for fresh
  databases).
- The Persona prompt renders `context.primaryGoal.rawPrompt` and `context.humanDecisions`
  (`src/server/workflows/prompt.ts:61`, `prompt.ts:65`); no prompt change is needed here because
  fixing what capture puts into `primaryGoal` fixes what the prompt renders.

## Implementation steps

1. **Schema.** Add an intent-snapshot column to `workflow_runs` (for example `intent_json TEXT`)
   holding `{rawGoal, refinedGoal, decisions, fingerprint, frozenAt}`, and a column for run-level
   canonical criteria (for example `context_criteria_json TEXT`) holding
   `{constraints, acceptanceCriteria, canonicalCriteria, compaction}` once compaction succeeds.
   Follow the addColumn-in-migrate convention in `src/server/db.ts`; a pre-existing run without a
   snapshot keeps the current per-submission behavior (see step 6).
2. **Freeze at creation.** In both `workflow_runs` insert paths in `store.ts`, accept and persist
   the snapshot. The manager builds it right before creating the run, from the same sources capture
   uses today: the bounded goal (`registry.getGoal`), and the bounded decisions (resolved reviews,
   Foreman episodes, human transcript decisions at that moment). Reuse the existing bounding helpers
   in `context.ts` rather than duplicating clamp logic.
3. **Read frozen intent in capture.** Thread the run's snapshot into `readWorkflowContextRaw` (it
   already receives the binding; pass the run snapshot alongside or resolve it via the store) and
   populate `raw.primaryGoal` and `raw.humanDecisions` from it. Remove the live
   `registry.getGoal` read for intent purposes. The intent fingerprint becomes the frozen
   fingerprint.
4. **Compact once per run.** In the manager's capture path (`manager.ts:6026` region): if the run
   already has stored criteria, use them for every submission (still running
   `reconcileWorkflowCriterionMappings` against the submission's staged coverage). If not, compact
   from the frozen intent and store the result on the run atomically. Delete or bypass the
   preflight-only reuse gate at `manager.ts:6029`; `reuseWorkflowContextCriteria` may be reshaped
   into the run-level reuse helper rather than kept alongside it.
5. **Fallback semantics.** Keep `fallbackWorkflowContext` behavior: a failed compaction stores
   nothing on the run and the next submission retries, exactly as a failed compaction retries today.
6. **Compatibility.** A run created before the migration has no snapshot: capture falls back to the
   current live-read behavior for that run only, so in-flight runs keep working across a daemon
   upgrade. New runs always freeze.

## Data and compatibility details

- Both columns are nullable TEXT holding JSON validated by Zod schemas beside the existing
  `WorkflowContextSnapshotSchema` shapes in `src/shared/workflow.ts` or the store's row schemas,
  matching where sibling shapes live.
- No persisted append-only IDs are renamed or reordered. No changes to eviction, registry ownership,
  or session lifecycles.
- The snapshot deliberately excludes repository state, evidence, and Persona feedback, exactly as
  `intentFingerprintFields` documents today (`context.ts:218`).

## Tests and verification

- `test/` unit coverage (node:test, following existing workflow store/manager test patterns):
  - A run created while the Goal holds the human's request freezes that request; overwriting the
    Goal with a packet-shaped prompt afterward does not change any later submission's
    `primaryGoal.rawPrompt`, `humanDecisions`, or intent fingerprint.
  - Criteria are compacted exactly once across a multi-round run, including across
    `evidence_preflight` refinement segments and Persona repair rounds; the criteria set is
    identical on every submission.
  - A pre-migration run (no snapshot) still captures via the live path.
  - Compaction failure on submission 1 retries on submission 2 and then persists run criteria.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`. Run the workflow-focused files directly
  with `node --test --import ./test/setup-state.mjs --import tsx <file>` during development.

## Merge and exit criteria

- All listed tests pass; typecheck and lint green; no unrelated edits in the worktree.
- The frozen-intent contract holds: no code path between run creation and Persona prompt rendering
  reads the live Goal for review intent on a snapshot-bearing run.
- One reviewable PR; its merge releases Phase 3.

## Downstream handoff

Later phases may rely on:

- Every new run carries a frozen intent snapshot and, after first successful compaction, run-level
  canonical criteria that never change for the run's lifetime.
- `raw.primaryGoal` and `raw.humanDecisions` on a snapshot-bearing run are packet-proof.
- Criteria stability means coverage reconciliation targets are stable across rounds (Phase 3 builds
  inherited-coverage mapping on this).

Later phases must not change: the snapshot's freeze timing, its exclusion of repository state and
evidence, or the once-per-run compaction contract.

## Cross-phase audit record

- 2026-09-08: Initial version. Phase 2 confirmed independent (prompt wording and guardrails touch
  neither the snapshot nor the criteria store). Phase 3 declared dependent on this phase's stable
  criteria contract and shared capture-path code region in `manager.ts`.
