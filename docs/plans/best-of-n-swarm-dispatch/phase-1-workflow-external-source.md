# Phase 1: Workflow External-Source Boundary

## Outcome

Workflow Preview can accept one server-owned external result through the same immutable-version,
binding, stable-capture, Persona, recovery, SSE, and Reset machinery used by manual Preview. The
external path proves it captured the expected commit with no uncommitted changes and shares a
daemon-level review scheduler that later Ensemble evaluators can use.

This phase changes no Workflow graph node, port, or one-Session context contract.

## Entry criteria and dependencies

- Direct dependency: the active planning session and its merged plan artifacts.
- Baseline: Workflow Phases 1–3 at main `57ea5bc`; their focused tests are green.
- May execute and merge independently of Phase 2.

## Scope

Included:

- append-only Workflow trigger-source registry with `ensemble`;
- explicit trigger source in Workflow store inserts;
- generic external binding claim persistence and transaction;
- internal `ensureExternalBinding` / `submitExternal` manager APIs;
- exact-HEAD plus clean-working-tree capture expectation and idempotent capture resume;
- one injected daemon review scheduler for Workflow compaction and Persona attempts;
- reusable prompt-fencing and byte-cap helpers;
- external source metadata in Workflow Run detail;
- Reset cleanup for external claims;
- regression, recovery, and source-detail tests.

Non-goals:

- Ensemble tables, manager, routes, or UI;
- an Ensemble Workflow graph node or multi-session context;
- Live delivery, Foreman submission, Inspector execution, or Shipping changes;
- a visible Ensembles tab or a link to a route that does not exist yet;
- a public HTTP endpoint for arbitrary external Workflow starts.

## Repository findings and inherited contracts

- `WorkflowTriggerSource` is currently the hand-written union `"manual" | "foreman"`.
- `WorkflowRunInsert` and `WorkflowSubmissionInsert` do not carry trigger source.
  `createInitialSubmission` and `insertSubmissionInTransaction` write `manual` literals.
- Manual keys are `manual:<binding-id>:<request-id>` and are already unique/idempotent.
- `workflow_bindings` enforces one active row per `note_key`.
- `captureStableWorkflowContext` retries once across Session/noteKey, repository fingerprint,
  transcript anchor, and HEAD. Its result includes `evidence.headSha` and
  `evidence.workingTreeDirty`.
- `WorkflowEngine` creates a private concurrency-three limiter. Context compaction calls
  `runJobStructured` outside it.
- `resetForNoteKey` explicitly deletes the full Workflow family in dependency order.
- `WorkflowRunDetail` has no source relation. Run summaries should stay compact.

## Implementation steps

1. In `src/shared/workflow.ts`, add append-only `WORKFLOW_TRIGGER_SOURCES` and derive
   `WorkflowTriggerSource`. Append `ensemble`; leave `WORKFLOW_TRIGGER_MODES` unchanged.
2. Add bounded types for:
   - `WorkflowExternalSourceKind` / external source metadata;
   - `WorkflowBindingClaim`;
   - `WorkflowCaptureExpectation` with `expectedHeadSha` and `requireCleanWorktree`;
   - optional `externalSource` on `WorkflowRunDetail`, not on every run summary.
3. Extend the matching Zod schemas in `src/shared/protocol.ts`. Keep external bind/submit inputs
   internal server types unless a concrete authenticated route is needed later.
4. Add new `workflow_binding_claims` table in `openDb()` with non-null `source_kind`, `source_key`,
   `source_id`, `binding_id`, and `created_at`. Make `source_key` the primary key and `binding_id`
   unique. It is a new table and needs no `addColumn` migration.
5. Extend `WorkflowStore`:
   - parameterize run and submission inserts with `triggerSource`;
   - have every existing manual call site explicitly pass `manual`;
   - parse only values from the closed trigger-source schema;
   - add one transaction that resolves an existing claim or creates claim + binding atomically;
   - join optional source metadata into Run detail;
   - delete claims for bindings selected by `resetForNoteKey` before binding deletion.
6. Add `src/server/workflows/external-binding.ts` for the narrow external input/result types and
   source-key helpers. Keep it Workflow-owned and free of Ensemble-store imports.
7. Add `WorkflowManager.ensureExternalBinding`:
   - resolve immutable version and current live Session/noteKey server-side;
   - apply normal supported-mode and active-note conflict checks;
   - invoke a narrow injected binding-eligibility guard;
   - call the store transaction and return existing/create identity explicitly.
8. Add `WorkflowManager.submitExternal`:
   - derive/persist `triggerSource: "ensemble"` and the opaque stable trigger key;
   - create or return one initial run/submission;
   - run stable capture with the supplied expectation;
   - reject before raw evidence persistence or compaction unless HEAD matches and the tree is clean;
   - mark mismatch as a visible, typed, retryable phase;
   - after the caller restores the artifact, resume capture on the same initial submission rather
     than creating a second binding, run, round, or model ledger family.
9. Add a daemon-owned review scheduler under `src/server/llm/review-scheduler.ts`. Inject its
   scheduling function into `WorkflowManager`/`WorkflowEngine` from `src/server/index.ts`.
   Route both context compaction attempts and Persona attempts through it. Keep the default test
   constructor ergonomic and keep Foreman/unrelated background jobs on their existing limits.
10. Extract only reusable intent-priority, untrusted-data fencing, and bounded-section helpers into
    `src/shared/review.ts` / `src/server/review/prompt.ts`. Continue to build Workflow-specific
    Persona prompts and parse `PersonaVerdict` in Workflow modules.
11. Render source metadata as non-navigating provenance in `WorkflowRuns.tsx` if present. Phase 7
    turns it into an Ensemble deep link when that route exists.

## Data, API, migration, and compatibility

- Existing `workflow_runs` and `workflow_submissions` rows remain valid. No column changes are
  required because their source columns already exist.
- Manual create/resubmit behavior, keys, response codes, and stored source values must remain
  byte-for-byte equivalent.
- Claim identity is independent of noteKey; retry after a daemon restart returns the same binding.
- A conflicting active binding is returned as typed conflict and is never replaced or adopted.
- Matching HEAD alone is insufficient. A dirty working tree would add evidence outside the selected
  artifact and must block.
- The external source id is display identity. UI and store code never parse the opaque source key.
- There is no new mutating route in this phase. Later Ensemble code calls the manager internally.

## Tests and verification

Add focused tests for:

- trigger-source tuple/schema accepts `ensemble`; trigger mode rejects it;
- existing graph schemas still reject any Ensemble node;
- existing manual HTTP tests retain keys, sources, idempotency, retries, and statuses;
- concurrent external claim calls create one claim and binding;
- existing active-note binding conflicts;
- expected HEAD mismatch and dirty worktree both block before compaction;
- restored exact clean artifact resumes the same initial submission;
- crash/retry before and after claim, binding, run insert, capture, and activation;
- scheduler caps combined Workflow compaction and Persona work;
- Reset deletes claim + Workflow family but no external source history;
- Run detail parses and renders optional provenance without changing summary size.

Commands:

```text
node --test --import tsx test/workflow-db.test.ts test/workflow-store.test.ts
node --test --import tsx test/workflow-bindings-http.test.ts test/workflow-context.test.ts
node --test --import tsx test/workflow-engine.test.ts test/workflow-recovery.test.ts
node --test --import tsx test/workflow-reset.test.ts test/workflow-run-render.test.ts
npm run typecheck
```

## Merge and exit criteria

- All existing manual Preview tests pass unchanged.
- One exact clean external result creates and activates one durable Workflow run.
- Repeated/concurrent calls return the same claim, binding, run, and first submission.
- No graph/context type becomes multi-session.
- Scheduler tests prove one daemon ceiling across Workflow review work.
- Reset leaves no claim pointing at a deleted binding.

## Downstream handoff

Phase 3 may rely on `WORKFLOW_TRIGGER_SOURCES`, the review scheduler, and shared prompt-fence
helpers. Phase 6 may call the external manager boundary and store only returned ids. No downstream
phase may:

- import Ensemble persistence into Workflow modules;
- add Ensemble graph nodes;
- skip exact-clean capture;
- replace active bindings silently;
- make the scheduler module-global across processes.

## Cross-phase audit record

- 2026-07-23: Kept Workflow route/tab changes out of this phase because an empty Ensembles route
  would be a dead surface. Source metadata lands here; navigation lands with Phase 7.
- 2026-07-23: Made `source_id` explicit so later UI never parses idempotency keys.
- 2026-07-23: Added clean-worktree enforcement after inspecting the implemented context capture.
