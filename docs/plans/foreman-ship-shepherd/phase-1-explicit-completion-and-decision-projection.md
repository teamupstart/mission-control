# Phase 1: Explicit completion boundary and durable decision projection

## Outcome and value

Make prompted completion judge a task-owned `ship` session against the same initial boundary the
agent was actually given, then durably record why the current work-cycle generation stopped.

This phase fixes the reported deadlock without adding a new recovery writer. An implementation that
has completed its requested code, documentation, focused tests, and evidence may reach its selected
Workflow even when the durable objective also asks for a pull request that Mission Control explicitly
deferred. A genuine incomplete verdict remains quiet, but its summary and blocking gaps survive for
Phase 2 instead of disappearing behind `promptedConsumedGeneration`.

## Entry criteria and direct dependencies

- `docs/plans/foreman-ship-shepherd/plan.md` and
  `docs/plans/foreman-ship-shepherd/phased-plan.md` are merged to the default branch.
- Direct dependency: this planning session only.
- Begin from a default branch containing the existing durable work-cycle generation contract,
  prompted direct-handoff latch, task-kind completion handoff, and current No-Mistakes Workflow
  claim path.

## Scope

- A browser-safe, exhaustive task-kind completion-contract registry.
- Trusted completion-boundary input in the shared Foreman verifier prompt.
- Task-owned `ship` projection in prompted completion, with no transcript inference.
- Append-only prompted disposition vocabulary and fail-closed read model.
- Additive `foreman_queues` columns and migration.
- Atomic disposition persistence for every consumed generation, including Workflow claims.
- Focused unit, migration, route, worker, and Workflow regression tests.
- Completion-contract and architecture documentation needed to explain the behavior.

## Non-goals

- No periodic stall scan or recovery injection.
- No Foreman setting or UI control.
- No change to queue-drain verification, personal prompted conversations, other task kinds, or
  Workflow graph definitions.
- No GitHub observation, retry budget, recovery model, or new attention item.
- No attempt to derive trusted policy from agent transcript text.

## Repository findings and inherited contracts

- `withTaskKindContract` in `src/server/task-contract.ts` is the single delivery seam for task-kind
  appendices. Its `SHIP_COMPLETION_HANDOFF` already defines the authoritative initial boundary.
- `verifyItem` is shared by queue and prompted completion. The trusted completion contract must be an
  optional input so queue behavior remains unchanged unless a caller deliberately supplies one.
- `processPromptedWrapup` has the task kind on `Session.task`, the current logical key and generation,
  the full resolved intent, and the evidence gathered for verification. It must build trusted policy
  structurally before the model call.
- `consumePromptedGeneration` is already compare-and-set against the exact settled lifecycle row.
  Extend that statement rather than writing a disposition afterward.
- Workflow claims consume prompted completion through a separate transaction. That transaction must
  persist `workflow_claimed`; calling the ordinary consume route before it would break atomic claim
  semantics.
- The append-only outcome set is:
  `held`, `workflow_claimed`, `asked`, `direct_handoff`, `retired`, `empty`, and
  `verification_failed`. Unknown values and partial records are unreadable, not coerced.
- The generic prompted trigger remains a bystander. This phase changes what counts as complete for a
  managed ship task; it does not send gaps back to every incomplete session.

## Implementation steps

### 1. Establish one trusted task completion contract

1. Add a focused browser-safe shared module, preferably `src/shared/task-completion.ts`, with an
   exhaustive `Record<TaskKind, TaskCompletionContract | null>`.
2. Define the `ship` initial contract as implementation, required repository documentation, focused
   verification, and evidence complete; commit, push, pull request, review, and CI remain deferred.
3. Export a pure accessor keyed by durable task kind. Do not branch on agent or Workflow id.
4. Compose `SHIP_COMPLETION_HANDOFF` from the same contract vocabulary where practical, or pin both
   surfaces in one source-scan test if human-facing prose needs a distinct rendering. There must not
   be two independently maintained meanings of ship-complete.

### 2. Give the verifier trusted policy without weakening its evidence bar

1. Extend the input accepted by `src/server/foreman/queue-verify.ts` with an optional trusted task
   completion contract.
2. Render it in a clearly delimited trusted-policy section ahead of transcript evidence. State that
   the durable objective remains the requested outcome, while deferred post-completion work is not a
   blocking gap at this initial handoff.
3. Keep diff, transcript, repository standards, focus, prior gaps, and structured verdict schema
   unchanged. The contract changes the boundary, not the evidence required to prove implementation.
4. Supply the contract only from `processPromptedWrapup` when `session.task?.kind === "ship"` and the
   task/session binding is current. Personal sessions and queue-item verification pass no contract.

### 3. Define the durable prompted disposition

1. Add shared schemas/types for `PromptedCompletionOutcome`, a bounded gap record, and
   `PromptedCompletionDecision`. The decision carries logical key, generation, outcome, bounded
   summary, bounded blocking gaps, and decision time.
2. Extend `SessionQueue` with nullable `promptedDecision`. Keep `promptedConsumedGeneration` and
   `promptedDirectHandoff` for their existing compatibility and idempotency roles.
3. Add fresh-schema and `migrate()` columns beside the existing prompted columns. Prefer one validated
   JSON payload plus indexed scalar generation/outcome only if queries require them; otherwise use a
   small all-or-nothing scalar group. Document the row invariant and reject partial state.
4. Update the one `QueueRow` mapper, queue upsert/read paths, Registry projection, queue summary
   serialization where needed, and all fixture constructors. Unknown outcome strings, invalid JSON,
   mismatched logical key, or a decision generation that does not equal the consumed generation read
   as no actionable decision and emit a bounded diagnostic.

### 4. Persist the disposition at the existing atomic boundaries

1. Extend `PromptedWrapupSchema`, the Foreman client method, Registry consume guard, and
   `consumePromptedGeneration` input with a required disposition for new callers.
2. Write `empty`, `retired`, `held`, `asked`, `direct_handoff`, or `verification_failed` in the same
   SQL statement that consumes the exact generation. Store only bounded blocking gaps for `held`.
3. When the verifier returns incomplete, persist its summary and blocking gaps before returning the
   existing quiet hold. Do not type or create an episode in this phase.
4. When repeated verifier infrastructure failures hit the existing cap, persist
   `verification_failed` with the bounded failure reason. Do not mislabel it `held`.
5. Extend the Workflow prompted-completion claim schema and daemon transaction so a successful claim
   writes `workflow_claimed` beside the consumed generation and run creation/resumption. A failed or
   stale claim writes neither.
6. Preserve mark-before-inject for direct shipping. `direct_handoff` and the existing episode latch
   are committed together before the instruction can be typed.
7. Preserve existing behavior for an upgraded caller only where wire compatibility requires it.
   New in-repository callers must always provide a disposition; silently synthesizing `held` is not
   allowed.

### 5. Document and expose the projection conservatively

1. Update `docs/foreman.md`, `docs/work-queues.md`, `docs/agent-guides/architecture.md`, and
   `docs/agent-guides/change-contracts.md` with the trusted ship boundary, disposition ownership, and
   atomic-write rule.
2. Keep the full decision on the daemon's queue/detail read used by Foreman. Do not put unbounded gap
   text into a compact session summary or the SSE snapshot.
3. If a compact summary needs an outcome/generation for the existing drawer, bound and compare it
   explicitly through Registry contracts. The Phase 1 UI does not need to render it.

## Data, API, migration, and compatibility details

- Existing rows have no decision and continue to open. `promptedConsumedGeneration` remains the
  replay guard, so upgrade does not re-run a spent generation merely because its historical reason
  is unknown.
- New rows must never contain a current consumed generation written by prompted completion without
  its matching current disposition. Legacy rows are the only allowed absence.
- A later generation replaces the current disposition atomically. History belongs in
  `foreman_episodes`, which Phase 2 writes when it acts; `foreman_queues` remains current projection.
- A context-key rotation selects another queue row. No disposition migrates across logical keys.
- Bound summary and gap counts in the shared schema to protect queue reads and future prompt sizes.
- Persisted outcome ids are append-only. Future outcomes are added beside existing values and older
  builds fail closed when they cannot interpret one.
- The daemon remains the only SQLite writer. Foreman uses schemas and loopback routes only.

## Tests and verification

Add or extend focused tests for:

- the exhaustive task-kind registry and one source of truth for ship handoff semantics;
- verifier prompt ordering and the distinction between trusted deferred PR work and missing
  implementation evidence;
- the exact reported regression: an objective requires a PR, the task contract defers it, and a
  complete implementation creates exactly one Workflow claim;
- a real missing implementation requirement still produces `held` with bounded gaps;
- every terminal disposition maps to the correct outcome;
- verifier infrastructure exhaustion maps to `verification_failed`, never `held`;
- fresh schema, pre-feature migration, old rows with no decision, partial/malformed decision data,
  restart restoration, context rotation, and newer-generation replacement;
- ordinary prompted consume and Workflow claim each atomically pair generation and disposition;
- stale generation, changed intent, active cycle, and queue ownership write neither consumption nor
  disposition;
- personal, chat, scout, plan, and pipeline sessions receive no ship completion contract.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/queue-db.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/prompted-wrapup-worker-e2e.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-completion-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-repair-cycle.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run smoke
```

No new Playwright test is required unless implementation changes visible UI despite this phase's
non-goal.

## Merge and exit criteria

- The reported false hold is reproduced before the change and passes afterward.
- Every new prompted consumption and Workflow claim stores one matching decision atomically.
- Legacy rows remain readable and never replay because the reason column is absent.
- Generic personal prompted sessions retain quiet bystander behavior.
- Focused tests, full unit suite, typecheck, lint, build, and smoke pass.
- Documentation names the completion boundary and disposition owner.
- One reviewable pull request merges before Phase 2 begins.

## Downstream handoff

Phase 2 may rely on:

- one shared accessor for the trusted task completion contract;
- one append-only outcome vocabulary including `verification_failed`;
- a nullable but validated `SessionQueue.promptedDecision` tied to logical key and consumed generation;
- atomic current-disposition writes on ordinary consume and Workflow claim;
- old rows reading as consumed with unknown historical disposition rather than as fresh work.

Phase 2 must not change the meaning of implementation-complete, create another decision ledger,
reinterpret transcript prose as policy, or relax the atomic generation/disposition invariant.

## Cross-phase audit record

- Initial audit: this phase owns the source plan's trusted completion boundary and persisted reason.
  Recovery timing, attempts, delivery, controls, visibility, and escalation remain wholly in Phase 2.
- Compatibility reconciliation: `verification_failed` was added because the existing capped verifier
  failure is not a model verdict and cannot safely become `held`. Phase 2 will escalate it without a
  recovery-model call.
- Ownership reconciliation: Workflow claims and ordinary consumes use separate daemon transactions,
  so both are named explicitly. No worker-side after-write can satisfy the atomic contract.
- Downstream audit: the nullable legacy case is distinguished from malformed current state, giving
  Phase 2 a fail-closed input without replaying historical generations.
