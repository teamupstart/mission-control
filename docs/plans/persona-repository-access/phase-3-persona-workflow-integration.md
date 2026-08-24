# Phase 3 - Persona and Workflow integration

## Outcome

Expose read-only repository access as an explicit Persona capability and connect the Phase 1 workload/MCP foundation to the Phase 2 exact-state artifact through the complete Workflow lifecycle.

Operators can configure custom Personas and local built-in overrides, publish immutable access snapshots, submit an exact dirty checkout, and watch either Claude or Codex perform multiple repository queries in one attempt before returning a verdict. Missing artifacts, workload failures, MCP failures, provider failures, and event faults retry and then block without prompt-only fallback. Run detail shows safe audit metadata but never repository response bodies.

Estimated gross non-test implementation: **1,500-1,900 lines**.

## Entry criteria and direct dependencies

- Phase 2 has merged, which transitively includes Phase 1.
- The planning PR has merged.
- Phase 1 provider parity remains green for both providers.
- Phase 2 artifact round trips and cleanup reconciliation remain green.
- The approved source plan, `phased-plan.md`, and both earlier merged handoffs are the controlling inputs for this phase.

Direct dependency: **Phase 2 only**. Phase 1 is transitive.

## Scope

This phase owns the complete user-visible and durable integration:

- persisted custom Persona access and built-in local override model;
- frozen Persona snapshot value and publication identity/backward compatibility;
- Persona routes, manager/store resolution, editor control, and disclosure;
- conditional stable capture of one submission claim on a digest-owned artifact;
- durable workload ownership, ordered event ingestion, query audit metadata, and cancellation generation;
- Workflow engine dispatch, provider parity, retry/exhaustion/recovery, and final verdict validation;
- repository evidence references tied to successful same-attempt operations;
- run detail, bounded query-audit route, version history, observability, docs, and built-browser E2E.

This phase does not:

- change the eight operations, path policy, MCP body transport, artifact format, or cleanup ownership established earlier;
- add direct provider tools, shell, writes, host access, or agent-visible network;
- select or integrate a remote scheduler, artifact store, cloud identity, or WebSocket gateway;
- mutate an existing published version or in-progress run;
- retrofit repository access onto shipped built-in workflow versions;
- add cross-repository access inside one Workflow run.

## Repository findings and inherited contracts

- `Persona`, `PersonaSnapshot`, `personaSnapshotOf`, and `personaSnapshotIsOutdated` are shared owners. A field added only at a route or store would silently miss built-in publication.
- `PersonaSnapshotSchema` parses historical graph JSON and must default a missing access field to `none` while returning a non-optional domain value.
- Built-in Personas are not rows. A narrow override table is required; general built-in update/archive refusals stay unchanged.
- `PersonaEditor.save` currently returns immediately for built-ins. The access control needs an independent draft/CAS/save path instead of making general built-in fields writable.
- `publishWorkflow` currently checks `(workflow_id, source_draft_revision)` before projecting Personas. It must project the resolved graph and hash it before deciding idempotency.
- Built-in workflow graphs compile without database access. They always freeze `none`. A local built-in override applies only when an operator-owned workflow is published from the resolved catalog.
- `captureAndActivate` already owns the transition from `capturing` to `running`. A read-enabled submission cannot cross that boundary until its artifact row is ready.
- `WorkflowEngine.runAttempt` is the current one-shot Persona call and `handleInfrastructureFailure` is the retry ladder. Replace only the read-enabled arm; the `none` arm must remain byte-identical.
- Running attempts and LLM calls are already interrupted/recovered on daemon restart. Workload reconciliation must occur before scheduling a replacement.
- Workflow events and LLM calls are paged. Repository audit rows need a dedicated bounded page and compact summary.
- `WorkflowRunDetail` is browser-safe and detail-only. Compact `WorkflowRunSummary` travels over SSE for every run and must not carry per-query rows.
- Phase 2 exposes conditional capture and artifact lifecycle but intentionally has no production caller.

## Contracts inherited from earlier phases

From Phase 1:

- final access, operation, workload, event, audit, failure, cursor, budget, and cancellation schemas;
- `RepositoryHistoryPolicyV1`, retained-revision validation, history-boundary result metadata, and the auditable `revision_out_of_range` denial;
- repository policy and standalone MCP bundle;
- workload-specific Claude/Codex adapters and `LocalPersonaWorkloadExecutor`;
- repository bodies remain local to provider/MCP;
- both providers expose the same capability.

From Phase 2:

- `WorkflowRepositoryArtifactService` and artifact/claim store API;
- active submission claim joined to a ready digest-owned artifact, immutable digest/locator, exact layer identities, immutable retained-revision/frontier metadata, and typed failure codes;
- optional stable-capture sealing seam;
- digest ownership, per-submission claims, retention, and startup reconciliation.

## Contracts established

### Persona resolution and publication

- `Persona.repositoryAccess` is always the resolved `none` or `read` value.
- `Persona.repositoryAccessRevision` is the CAS revision for the record that stores this capability. For a custom Persona it tracks the Persona row revision; for a built-in it tracks the sidecar override revision, with `0` meaning no override row yet.
- `PersonaSnapshot.repositoryAccess` is frozen and non-optional after parsing.
- `personaSnapshotOf` remains the only projection used by custom and built-in graph publishers.
- Snapshot freshness compares repository access even when a built-in's guidance revision is unchanged.
- Workflow publication identity includes a deterministic hash of canonical resolved graph JSON.

### Workload durability

- One read-enabled `WorkflowNodeAttempt` owns at most one current workload record.
- Workload commands are idempotent by workload/request key and cancellation generation.
- Events are accepted in sequence and persisted once. Equal duplicates are ignored; conflicting duplicates or gaps are infrastructure failures.
- A terminal verdict is applied only while the run, submission, attempt, workload, and cancellation generation are current.
- Query audit metadata is append-only and uniquely ordered per workload/attempt. Bodies never enter SQLite.

## Implementation steps

### 1. Add Persona access contracts and migration

In `src/shared/workflow.ts`:

- add resolved `repositoryAccess` and CAS `repositoryAccessRevision` to `Persona`/`PersonaView`;
- add frozen `repositoryAccess` to `PersonaSnapshot`;
- update `personaSnapshotOf` and snapshot freshness;
- keep access modes imported from Phase 1's shared module.

In `src/shared/protocol.ts`:

- allow `repositoryAccess` on create with default `none`;
- add a dedicated repository-access mutation schema carrying `expectedAccessRevision` and the closed mode;
- default missing `PersonaSnapshot.repositoryAccess` to `none`;
- extend run-detail/query-audit and evidence-reference schemas additively.

In `src/server/db.ts`:

1. add `personas.repository_access TEXT NOT NULL DEFAULT 'none'`;
2. create `persona_builtin_overrides` keyed by built-in Persona id, storing only repository access, monotonic revision, and timestamps;
3. add `workflow_versions.source_snapshot_fingerprint`, backfill it from canonical parsed graph JSON, drop the old draft uniqueness index, and create uniqueness on `(workflow_id, source_draft_revision, source_snapshot_fingerprint)`;
4. create workload, ordered workload-event, and repository-query audit tables/indexes;
5. add any snapshot-to-workload ownership columns proven necessary by the final Phase 1/2 contracts.

Indexes over added columns live beside migrations. Migration parity tests compare fresh and upgraded table/column/index sets mechanically.

Keep built-in override rows for explicit `none` if necessary to preserve monotonic CAS. Do not trade concurrency correctness for row removal.

### 2. Resolve custom and built-in access in one store path

In `WorkflowStore` and `PersonaManager`:

- custom Persona creation defaults to `none` and can accept explicit `read`;
- custom access mutation uses its current Persona revision and increments the Persona revision;
- built-in access mutation validates the generated built-in id and CAS-upserts only the sidecar row;
- general built-in update, archive, reimport, runner, model, and guidance guards remain unchanged;
- catalog reads overlay the built-in sidecar exactly once and return the access revision separately;
- registry/SSE `persona_upsert` carries the resolved `PersonaView` through its existing event;
- imported/plugin Personas default to `none` unless an explicit future import contract says otherwise.

Add a dedicated route, for example `PATCH /api/personas/:id/repository-access`, using the shared schema for custom and built-in Personas. Return current state on CAS conflict using the existing Persona conflict conventions.

### 3. Make publication snapshot-aware and backward-compatible

Refactor `publishWorkflow` transaction order:

1. resolve Personas including built-in overrides;
2. project the complete publishable graph with `personaSnapshotOf`;
3. serialize canonical normalized JSON and compute `source_snapshot_fingerprint`;
4. reuse a version only when workflow id, source draft revision, and fingerprint match;
5. otherwise allocate and insert a new immutable version.

Backfill old rows from parsed/normalized graph JSON without rewriting `graph_json`. Missing access parses as `none`. Identical republish remains idempotent; changing only repository access creates a new version.

Built-in workflow versions remain generated with `none` and are never rewritten from local override state. Version History displays the frozen mode and marks a node outdated when the resolved access differs. The UI explains that using a built-in override requires publishing an operator-owned workflow version.

### 4. Add the Persona Editor control and disclosure

Add a clearly labelled control with:

- `No repository access`
- `Read-only repository access`

Keep its draft/save/conflict state separate from general Persona fields so built-ins can edit only this capability while guidance, provider, model, name, archive, and reimport remain locked. For new custom Personas, include the selected value in create; for existing Personas, use the dedicated CAS route.

Visible disclosure states:

- access covers non-sensitive committed, staged, unstaged, and nonignored untracked content from the submitted state;
- the Persona receives no shell, writes, agent-visible network, host files, `.git` internals, or unrestricted provider tools;
- known secret-bearing paths are denied and their blob bodies are omitted; allowed text is scrubbed as defense in depth;
- Git history is retained as a deterministic bounded prefix of at most 2,048 commits and 512 MiB of additional allowed historical blobs; the reviewer sees an explicit boundary or out-of-range response instead of silently consulting older history;
- the value freezes only when a workflow version is published;
- built-in access is a local override and does not alter shipped built-in workflow versions.

Use accessible labels and existing property-chip/editor patterns. Do not add `data-testid`.

### 5. Activate exact artifact capture conditionally

Before capture, inspect the immutable workflow version. If no executable Persona snapshot has `repositoryAccess: "read"`, call the existing capture path exactly as before and do not create an artifact row.

If any Persona requires `read`:

- pass Phase 2's sealer into the stable capture boundary with the already-created submission id;
- require the artifact row to be `ready` before marking the submission `running`;
- include the exact artifact digest in the access-enabled submission/workload identity while preserving existing evidence and repository fingerprints for access-off runs;
- reuse one durable submission claim and its digest across all read-enabled Personas and retries;
- never seal again from a moved live checkout after the submission is active.

Capture/seal failures occur before a Persona attempt exists. Retry the stable capture/seal operation within its bounded capture policy, then block visibly as `repository_capture_unavailable` if no exact artifact can be established. The operator may resubmit when the checkout is stable. Do not manufacture a Persona attempt or prompt-only review without a snapshot.

After a ready artifact exists, materialization, digest, MCP, workload, event, provider, or audit failures are Persona infrastructure failures and use the normal attempt retry ladder.

### 6. Add durable workload and query-audit ownership

Persist enough state for local and future remote executors:

- workload id, node attempt id, request/idempotency key, executor identity, snapshot digest, protocol version, state, deadline, cancellation generation, accepted/terminal timestamps, highest contiguous sequence, last error, and transport diagnostics;
- ordered workload events with payload equality hash and ingestion timestamp;
- query audit rows with operation id/kind, safe path display or query hash, timing, outcome/denial/error including history-boundary and out-of-range results, item/byte counts, truncation, cursor presence, and cancellation state.

The daemon is the only database writer. The MCP writes a safe local journal; the workload supervisor emits safe events; the engine/store validates and persists them.

Add bounded store and HTTP paging for query audits, for example `GET /api/workflow-runs/:id/repository-queries?after=&limit=`. Run detail carries only repository-access enabled state and aggregate counts/latest failure; it does not inline an unbounded ledger or response body. Run export includes safe audit metadata only.

### 7. Dispatch one repository-aware workload per attempt

In `WorkflowEngine.runAttempt`, retain the existing access-off arm without modifying prompt bytes, image options, `runStructured`, call ledger behavior, or verdict parser.

For a `read` snapshot:

1. claim the node attempt and validate persisted context/images as today;
2. require a ready Phase 2 snapshot and build the versioned workload request from the frozen Persona, exact prompt inputs, images, digest/locator, final policy/budgets, deadline, idempotency key, and cancellation generation;
3. create one `workflow_llm_calls` record for the provider workload and one durable workload row;
4. dispatch through `PersonaWorkloadExecutor` and ingest ordered events;
5. treat query denials, invalid queries, unsupported operations, exhausted pages, and ordinary truncation as data the Persona can recover from inside the same session;
6. abort immediately on artifact/MCP/provider/event/audit `unavailable`, timeout, budget exhaustion, or malformed terminal output;
7. validate the terminal Persona verdict and repository evidence references;
8. apply receipts/verdict only if all current-ownership checks still pass;
9. otherwise persist the late terminal event as audit-only and leave run state unchanged.

There is no model-facing broker loop in the engine. Multiple queries happen inside the one provider session through local MCP.

### 8. Validate repository evidence references

Append a `repository` evidence kind and optional operation id/range fields without renaming or reordering existing persisted ids.

For every repository evidence reference:

- operation id belongs to the same workload and node attempt;
- the operation completed successfully and returned the cited allowed path/range;
- the cited path is canonical and not denied;
- the quote is bounded/scrubbed and consistent with the operation metadata contract;
- a denied, failed, cancelled, or unrelated operation cannot support a verdict.

Access-off verdicts retain the existing evidence union and validation behavior. Prompt construction for access-off is byte-identical. The access-enabled prompt explains the repository MCP capability, pagination, security boundaries, bounded retained-history range, boundary/out-of-range responses, and repository evidence form without telling the provider it has shell or filesystem access.

### 9. Integrate retry, cancellation, and restart recovery

Use `handleInfrastructureFailure` for post-capture failures. Every retry:

- creates a new node attempt/workload id;
- uses the same artifact digest held by the submission claim and the same frozen Persona snapshot;
- never reconstructs from the live checkout;
- never falls back to `LlmRunner.run` prompt-only review.

Cancellation increments generation, persists it, tells the executor, stops provider/MCP/Git processes, drains terminal safe audit events, and makes any later result audit-only. It does not schedule a retry.

On daemon restart:

1. load nonterminal workload ownership;
2. ask the executor to reconcile from the highest contiguous sequence;
3. replay equal missing events idempotently;
4. continue the same workload only when executor ownership is proven;
5. otherwise mark the attempt interrupted and use the existing retry budget;
6. never launch a duplicate speculatively while ownership is unknown.

An event gap or conflicting duplicate is an infrastructure fault. WebSocket, SSE, or process connection status is transport evidence only, never durable ownership.

### 10. Add run detail, observability, and documentation

Run detail displays:

- frozen access mode per Persona attempt;
- snapshot digest prefix and readiness/failure state;
- query count, bytes, allowed/denied/truncated/failed/cancelled counts;
- bounded rows showing operation, safe path/hash metadata, duration, outcome, size, truncation, and cursor presence;
- retry/block reason when repository access caused it.
- retained history count and boundary state from the verified manifest, plus safe audit rows for `history_boundary` and `revision_out_of_range` without exposing omitted commit messages or paths.

Never render repository response bodies, sensitive query text, raw locator paths, or denied content. Keep the compact run summary/SSE projection small.

Add structured logs and status metrics for capture/materialization/workload/query latency, outcomes, event lag/gaps, retries caused by repository access, active artifact bytes, and cleanup backlog.

Update in the same phase:

- `docs/workflows.md`
- `docs/workflow-system.md`
- `docs/security.md`
- `docs/troubleshooting.md`
- `docs/database-and-migrations.md`
- `docs/agent-guides/architecture.md`
- any configuration or generated-artifact documentation the final implementation changes

Document the local MCP as an in-workload repository query service, not a network callback to the scheduling session. Document the 2,048-commit/512-MiB `RepositoryHistoryPolicyV1`, deterministic frontier behavior, source-base diff-only rule, and operator-visible boundary/out-of-range outcomes. Document future remote execution as an adapter to the same artifact/request/event contract, not part of this feature.

## Data, API, migration, and compatibility

- Existing custom Personas migrate to `none`.
- Existing built-ins resolve to `none` without sidecar rows.
- Historical Persona snapshots, workflow graphs, versions, attempts, runs, LLM calls, and exports parse as `none`.
- Old `graph_json` bytes remain unchanged; backfill hashes normalized parsed graphs.
- Existing built-in workflow versions remain app-owned and `none`.
- Existing create/update clients that omit access continue to work.
- Access-off capture and execution remain byte-identical and create no artifact/workload/query rows.
- New database tables and fields are additive/idempotent; fresh and upgraded schemas converge.
- Query audit paging is bounded and optional to newer clients.
- No artifact or response body is stored in SQLite, SSE, logs, run export, or browser state.

## Tests and verification

### Unit, migration, and store

Add/extend:

- `test/persona-migration.test.ts`
- `test/personas-store.test.ts`
- `test/personas-http.test.ts`
- `test/persona-editor-render.test.ts`
- `test/workflow-publish.test.ts`
- `test/workflow-contracts.test.ts`
- `test/workflow-db.test.ts`
- a focused repository-access migration parity suite

Cover custom create/update/CAS conflict, built-in override create/update/conflict, immutable field rejection, `none` defaults, historical JSON, snapshot freshness, graph fingerprint backfill, identical republish, access-only republish, built-in version immutability, repeated migration, and row-schema/domain round trips.

### Engine, executor, and integration

Add/extend:

- `test/workflow-context.test.ts`
- `test/workflow-engine.test.ts`
- `test/workflow-recovery.test.ts`
- `test/workflow-llm-calls.test.ts`
- `test/workflow-retention.test.ts`
- `test/workflow-verdict.test.ts`
- Phase 1 provider and MCP contract suites
- a focused `test/workflow-repository-access-engine.test.ts`

Cover:

- exact dirty capture only when at least one frozen Persona needs access;
- multiple read/search/glob/Git queries in one attempt;
- denial recovery and pagination within the same provider session;
- retained-history boundary and out-of-range recovery within the same provider session, with the same result and audit semantics for Claude and Codex;
- same-attempt evidence validation;
- Claude/Codex parity and image preservation;
- missing/corrupt artifact, failed materialization, MCP crash, provider crash, malformed verdict, audit failure, event duplicate/gap, timeout, cumulative budget, cancellation, late result, daemon restart, executor loss, retry exhaustion, and manual resubmit;
- proof that every read-enabled failure avoids prompt-only execution;
- proof that access-off prompt, options, fingerprints, call count, and verdict path match the pre-feature fixture byte for byte.

### Browser E2E

Add `e2e/specs/workflow-persona-repository-access.spec.ts` against the built daemon and fake agents. Extend fake Claude and Codex workload behavior so no model tokens are spent.

Cover:

1. configure a custom Persona and read the full security/publication disclosure;
2. edit only repository access on a built-in while its other fields remain locked;
3. publish and see frozen mode plus access-only out-of-date state;
4. submit a fixture containing committed, staged, unstaged, and nonignored untracked content;
5. observe multiple repository queries and one verdict for Claude;
6. repeat capability parity for Codex;
7. observe denial and truncation/pagination in the audit summary without response bodies;
8. observe retained-history boundary and out-of-range outcomes without omitted commit metadata;
9. remove/corrupt the artifact or fail MCP and see retry then blocked state, never a verdict;
10. reload and see persisted audit/retry state;
11. render a historical old run as no repository access.

Use roles, labels, placeholders, and visible text only. Do not add `data-testid`.

Run focused tests with the required preamble, then:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Perform desktop and narrow-width visual QA of the Persona control, Version History, audit summary, denial, truncation, retry, and blocked states. Attach evidence to the implementation PR without committing it.

## Merge and exit criteria

- Operators can configure custom and built-in Persona access with correct CAS and immutable built-in fields.
- Publication freezes access and creates a new version for access-only changes while identical publish remains idempotent.
- Historical data parses as `none` and existing behavior remains unchanged.
- Read-enabled submission capture produces one ready exact artifact before attempts start.
- One attempt means one provider session with multiple MCP queries and one validated verdict.
- Claude and Codex have equivalent operations, limits, denials, cancellation, and audit metadata.
- Repository response bodies remain inside the workload.
- Unavailability retries and eventually blocks without prompt-only fallback.
- Cancellation and restart recovery cannot duplicate or revive stale workloads.
- Persona Editor, Version History, run detail, migration, unit, integration, runner-contract, and built-browser E2E coverage pass.
- Documentation and operational diagnostics match the shipped behavior.
- The phase pull request records deviations and reasoning.

## Downstream handoff

This is the final implementation phase. Future remote execution work may rely on:

- the versioned portable artifact and opaque locator/digest;
- `PersonaWorkloadExecutor` dispatch/reconcile/cancel semantics;
- ordered idempotent workload events and cancellation generations;
- repository bodies staying local to worker/MCP;
- daemon-owned Workflow state and audit ingestion;
- local executor behavior as the reference conformance suite.

A future adapter may replace local artifact resolution and event transport. It must not change Persona snapshot semantics, repository operations/policy, retry behavior, evidence validation, or provider parity.

## Cross-phase compatibility audit

- Persona access uses Phase 1's final enum and Phase 2's ready artifact invariant.
- Conditional capture activates Phase 2 without changing access-off fingerprints or capturing every submission.
- The engine dispatches Phase 1's workload instead of adding a repeated model-call broker.
- Query audits persist Phase 1 safe metadata only; response bodies never cross into daemon state.
- Retries reuse the digest held by Phase 2's durable submission claim and create new Phase 1 workload identities.
- Built-in overrides affect future operator publication only, preserving generated built-in versions.
- Run detail pages query audits separately, preserving existing event/LLM paging and compact SSE summaries.
- Final browser coverage exercises contracts from all phases with both providers and no real model calls.
