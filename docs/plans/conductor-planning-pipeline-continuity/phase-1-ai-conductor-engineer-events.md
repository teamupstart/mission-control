# Phase 1: Generic Engineer Lifecycle Events in the AI Conductor Fork

## Outcome

AI Conductor emits and durably replays product-neutral Engineer run and DECIDE step lifecycle events through its existing event spine. Registered visualizers can observe the flow before the implementation daemon begins, and handoff exposes exact plan identity without embedding Mission Control behavior in core.

This phase lands only in `mancej/ai-conductor`. Mission Control is attached as context for the consumer contract and must not be changed.

## Entry criteria and dependencies

- Source plan: `docs/plans/conductor-planning-pipeline-continuity/plan.md` in the attached Mission Control checkout.
- Phased index: `docs/plans/conductor-planning-pipeline-continuity/phased-plan.md`.
- Direct phase dependencies: none.
- Scheduling dependency: the Mission Control planning session and its plan PR must merge before implementation starts.
- Start from the current `origin/main` of `/Users/jordan.mance/workspace/upstart/ai-conductor`, whose `origin` is the user's fork.

## Repository scope

### Primary: `/Users/jordan.mance/workspace/upstart/ai-conductor`

Implement, test, document, commit, push, and open a PR against `mancej/ai-conductor`.

### Attached context-only: Mission Control

Read the source plan and current plugin/ingest contracts. Do not edit Mission Control in this phase. A Mission Control diff makes the phase incomplete rather than multi-repository.

## Scope

- Stable generic Engineer run identity, optional opaque correlation identity, and idempotent attempt lineage.
- Product-neutral Engineer run and DECIDE step lifecycle events on `ConductorEventEmitter`.
- Monotonic revisions, durable event journal, compact inspection, and replay after a revision.
- Visualizer discovery/start/stop around supported Engineer emission paths.
- Deterministic lifecycle emission at worktree, land, handoff, failure, cancellation, and settlement boundaries.
- Structured start/failure integration for supported Claude and Codex Engineer host flows.
- Artifact-backed completion and land-time reconciliation.
- Machine-readable capability advertisement for the complete contract.
- Focused tests plus repository-required documentation.

## Non-goals

- No Mission Control task id, commission lifecycle, HTTP route, token, UI copy, or database concept in AI Conductor.
- No changes to Mission Control or its plugin.
- No automatic spec merge.
- No change to BUILD/SHIP step order, provider routing, gates, or current event semantics.
- No `conduct-state.json` authoring-mode expansion.
- No assumption that a Skill/PostToolUse return means accepted completion.
- No upstream implementation PR to `jstoup111/ai-conductor`.

## Verified repository findings

- `src/conductor/src/index.ts:593-597` dispatches Engineer before ordinary plugin setup.
- `src/conductor/src/types/plugin.ts:39-56` makes visualizers observers of an emitter and gives them no authority to instrument the host.
- `src/conductor/src/ui/events.ts` already isolates subscribers and awaits only handlers that return promises.
- `src/conductor/src/engine/event-sinks.ts` is exhaustive over the event union and decides persistence.
- `src/conductor/src/engine/event-persister.ts` provides the existing append-only JSONL and interval pattern.
- `src/conductor/src/engine/visualizer-lifecycle.ts` already owns safe start/stop and failure isolation.
- `src/conductor/src/engine/engineer-cli.ts:880-1156` owns worktree, land, handoff, cleanup, and daemon nudge boundaries.
- `src/conductor/src/engine/engineer/authored-ledger.ts` demonstrates Engineer-state durability outside an individual worktree, but is not an event journal.
- `docs/reference/settings-and-hooks.md` documents Claude-specific host hooks and confirms there is no current cross-provider Engineer lifecycle hook.

## Implementation steps

### 1. Define the event contract first

Add a distinct Engineer event family to `src/conductor/src/types/events.ts`. Prefer explicit discriminants such as `engineer_run_started`, `engineer_step_started`, and `engineer_spec_handoff` over overloading implementation-run events with optional context.

Use a shared base shape with:

- `schemaVersion: 1`;
- `engineerRunId`;
- optional opaque `correlationId`;
- opaque `attemptKey`, supplied by an integration for correlated runs or engine-minted for direct runs;
- Engineer attempt ordinal and optional predecessor run id;
- canonical repository root;
- monotonic `revision` scoped to the Engineer run;
- ISO timestamp;
- event-specific data.

Step events add canonical step, step-attempt number, and optional provider/model. The family covers run creation/start, routing, worktree creation, step start/complete/fail/retry/skip, land reconciliation, spec handoff, cancellation, failure, and settlement.

Add every new kind to `EVENT_SINKS` with `persist: true`. Rendering may remain false unless the existing terminal renderer has a clear, tested representation. Keep the union and sink declaration exhaustive.

### 2. Add a durable Engineer run store

Create a focused module under `src/conductor/src/engine/engineer/` that owns:

- creation and idempotent lookup by repository, opaque correlation id, and attempt key;
- ordered attempt allocation and predecessor linkage within a correlation;
- append under the existing lease/atomic-write conventions;
- monotonic revision allocation;
- a compact reducer/snapshot;
- replay after a caller-supplied revision;
- schema-version refusal and corruption diagnostics;
- cancellation and terminal-state protection.

Keep the journal under the durable Engineer state directory so authoring-worktree removal cannot erase it. Reuse `ConductorEventEmitter` and `EventPersister` where their contracts fit; do not create a second event bus or a sidecar telemetry format.

### 3. Expose deterministic machine-readable commands

Extend `src/conductor/src/engine/engineer-cli.ts` using the existing detection/dispatch pattern. The exact subcommand names may adapt to current CLI conventions, but the callable surface must support:

- create/reserve an Engineer run before host launch;
- inspect current snapshot and capability as JSON;
- replay events after a revision;
- record a structured host/step transition;
- cancel or fail a run through validated transitions.

All success paths print one parseable JSON value. Validate outputs rather than relying on exit code. Repeating one repository/correlation/attempt-key tuple returns the same run. A new attempt key creates a successor only when the previous correlated run is terminal. Reject unknown flags, cross-repository ids, incompatible correlation reuse, a second live attempt, attempt-key reuse with different inputs, revision regression, illegal terminal reopen, and invalid canonical step names.

### 4. Thread identity through mechanical Engineer commands

Associate the Engineer run with the authoring worktree through an engine-written marker or equivalent durable mapping. Update worktree creation, land, and handoff so they recover identity mechanically rather than asking a consumer to infer it from names.

Emit:

- worktree-created only after the worktree exists;
- land-reconciled only after artifacts pass existing land validation;
- handoff-ready only after exact plan slug, branch, and PR URL/local-commit outcome are known;
- terminal/failure events before cleanup removes the worktree needed for evidence.

Preserve the current keep-on-failure and ensure-running behavior.

### 5. Add supported host emission without false completion

Factor lifecycle setup so registered visualizers start around Engineer emissions from the CLI launcher and deterministic commands. Reuse `visualizer-lifecycle.ts` and plugin discovery rather than hand-starting one named visualizer.

For Claude, use structured hook/tool information where the host exposes it. For Codex or any host without equivalent hooks, route the canonical Engineer workflow through the deterministic lifecycle command. Keep the contract provider-neutral so later DECIDE steps can move between providers.

A structured skill/tool start may emit `engineer_step_started`. A tool return alone must not emit `engineer_step_completed`. Completion requires one of:

- an accepted structured result from the owning workflow;
- deterministic validation of the required artifact;
- land-time reconciliation from the full validated artifact set.

Emit failures when the host or deterministic command can establish them. Repeated attempts within one step increment the step-attempt number and revision rather than overwriting history. Retrying after an Engineer run reaches terminal state creates a new Engineer run with the next run-attempt ordinal and a fresh run-local revision sequence.

### 6. Reconcile at land and handoff

Before land succeeds, compare the durable event snapshot with the accepted track, tier, and DECIDE artifacts. Append missing `completed` or `skipped` events that are mechanically proven. Refuse contradictions such as completion without required evidence, illegal ordering, or two final plan identities.

Handoff must append exact final plan slug, branch, and PR URL when present and represent `awaiting_spec_merge`. It must not claim merge. The event is persisted and delivered before authoring-worktree cleanup.

### 7. Advertise capability only when complete

Add a machine-readable `engineerLifecycleEventsV1` capability or equivalent exact identifier. It must be absent until create, identity, step events, persistence/replay, visualizer lifecycle, and handoff identity all work together. Document the compatibility boundary for consumers.

### 8. Update maintained documentation

Update the canonical CLI, settings/hooks, event/step, and Engineer lifecycle documentation. State:

- the event family and identity/revision rules;
- what host hooks can and cannot prove;
- where replay lives and how it survives cleanup;
- that consumers own their own projections;
- that existing BUILD/SHIP state and events are unchanged.

Do not edit `CHANGELOG.md` or generated files by hand. Follow the repository's release metadata policy in the PR body.

## Compatibility details

- Existing visualizers that do not subscribe to the new kinds continue unchanged.
- Existing inline and daemon runs use their current emitter, persister, and visualizer lifecycle.
- Existing direct Engineer invocations without a correlation id still work and receive an engine-minted run id when lifecycle support is active.
- Existing direct Engineer invocations without an attempt key receive an engine-minted attempt key and start at run attempt 1.
- Existing worktrees and plans without an Engineer run marker remain valid.
- Unknown future event fields are additive. Schema major mismatch is explicit.
- The Engineer journal is not the implementation run journal and must never be mistaken for `.pipeline/events.jsonl` under a daemon worktree.

## Tests and verification

Add focused unit/integration coverage for:

- event union and `EVENT_SINKS` exhaustiveness;
- create idempotency by attempt key, correlation/repository collision refusal, and concurrent-live-attempt refusal;
- terminal retry creates a distinct successor with correct ordinal/predecessor while terminal reopen remains illegal;
- concurrent run-local revision allocation and independent successor cursors;
- journal recovery, replay cursors, corruption, and schema mismatch;
- visualizer start/stop and failure isolation around each supported Engineer path;
- host start versus accepted completion semantics;
- worktree marker and identity recovery;
- land reconciliation for product/technical and S/M/L skip combinations;
- handoff payload and persistence-before-cleanup;
- old uncommissioned Engineer and existing inline/daemon behavior.

Run from the AI Conductor repository root unless a command says otherwise:

```sh
test/test_harness_integrity.sh
cd src/conductor
npm run typecheck
npm run typecheck:test
npm run lint
npm test
npm run build
```

Use focused Vitest commands during development, then run the full required suite before commit and push. Tests must use fakes for LLMs, GitHub, and every third-party boundary.

## Merge and exit criteria

- All scoped tests and the full repository validation suite pass.
- Documentation matches the delivered contract.
- The fork PR contains no Mission Control code or terminology in core event semantics.
- Existing BUILD/SHIP event fixtures remain compatible.
- The PR targets `mancej/ai-conductor` through `origin`; no upstream implementation PR is opened.
- The PR is reviewable, green, and merged before Phase 2 begins.

## Downstream handoff

Phase 2 may rely on the merged capability name, exact event discriminants, identity/attempt/revision fields, correlation inspection and per-run replay output, CLI JSON shapes, and handoff payload. Record those exact names in the Phase 1 PR description.

Phase 2 must not reinterpret completion, infer identity from worktree names, or require Mission Control fields to be added back into AI Conductor. If implementation changes a proposed name or shape, document the deviation and reasoning in the PR so the consumer follows the merged contract.

## Cross-phase audit record

- 2026-08-27: This phase owns all provider emission and replay behavior. No later phase may create a parallel Engineer event source.
- 2026-08-27: `engineerRunId`, Mission Control commission id, and final plan slug remain separate identities.
- 2026-08-27: Completion semantics were placed here because only AI Conductor can validate its artifacts and skips.
- 2026-08-27: Mission Control is context-only; a change there would create an unnecessary atomic cross-repository phase.
- 2026-08-27: A terminal Engineer run is immutable. A correlated retry is a new ordered run attempt, never a reopen or revision reset on the old run.
