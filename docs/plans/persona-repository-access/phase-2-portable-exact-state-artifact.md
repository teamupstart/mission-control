# Phase 2 - Portable exact-state artifact and lifecycle

## Outcome

Add a daemon-owned service that can seal, persist, verify, materialize, retain, and clean up a portable immutable representation of the exact submitted Git state. The artifact preserves captured base, HEAD, staged index, unstaged working tree, nonignored untracked content, and the exact bounded history prefix selected by `RepositoryHistoryPolicyV1` without depending on the original worktree or Git common directory.

Sensitive paths remain classified in the manifest, but their blob bodies are physically absent from the artifact. The Phase 1 repository MCP can query an artifact round trip safely after the original checkout is reset or deleted.

This phase does not enable repository access for Personas. Phase 3 activates conditional capture and execution.

Estimated gross non-test implementation: **1,350-1,750 lines**.

Revalidated: 2026-09-04 against `origin/main` at `3459720f` (`v1.7.1`). The exact-state artifact design remains valid. Current capture ordering requires a two-step candidate lifecycle: prepare inside the stable repository boundary, then promote and claim only after the manager's external-artifact and reserved-evidence guards pass.

## Entry criteria and direct dependencies

- Phase 1 has merged.
- The planning PR has merged.
- Phase 1's provider parity gate passed for both Claude and Codex.
- The approved source plan, `phased-plan.md`, and Phase 1's merged contracts are the controlling inputs for this phase.

Direct dependency: **Phase 1 only**. The planning-session dependency is carried by the Mission Control task separately.

## Scope

This phase owns:

- the versioned sparse Git object artifact format and canonical manifest;
- exact capture of source base, HEAD/unborn state, index tree, worktree tree, status classifications, and the policy-selected retained history prefix;
- content-addressed artifact storage under the Mission Control state directory;
- digest verification and isolated materialization for the Phase 1 reader/MCP;
- digest-level artifact metadata, independent per-submission claims, zero-claim cleanup intent, and store round trips;
- crash-safe candidate handling, startup reconciliation, retention integration, and operational logs;
- a stable-capture extension seam that Phase 3 can activate without changing current behavior.

This phase does not:

- add Persona or snapshot access fields;
- capture artifacts for every current submission;
- dispatch workloads or persist workload/query events;
- change Workflow retry or verdict behavior;
- add UI, browser routes, or remote artifact upload;
- store repository artifacts in SQLite;
- write to the operator's worktree or live index.

## Repository findings and inherited contracts

- `WorkflowManager.captureAndActivate` creates the submission row before evidence capture and calls `captureStableWorkflowContext` while the run and submission are `capturing`. It now validates external artifact expectations and captures reserved image/text evidence before raw-context persistence. Candidate preparation may occur during stable capture, but claim creation must wait for those later guards.
- `captureStableWorkflowContext` already retries a candidate when the checkout boundary changes. Exact-state sealing must participate in the same before/after sample rather than opening a second race window.
- The existing prompt evidence persists before context compaction and marks the submission `running` only after the final context fingerprint. Repository artifact readiness must be committed before that transition for access-enabled submissions in Phase 3.
- `workflowRepositoryFingerprint` is the existing answer to whether repository work changed, but it is derived from bounded prompt evidence. The artifact digest is the stronger exact-state identity and must not replace historical access-off fingerprints.
- `src/server/git/ensemble-snapshot.ts` uses a private index/ref without mutating the live checkout. This phase may reuse low-level Git helpers, but not its single collapsed snapshot commit.
- Git attributes and configuration can execute clean filters during `git add` and content drivers during diff/blame. Capture must not execute repository-supplied commands.
- Workflow evidence retention already uses a durable cleanup queue plus startup filesystem reconciliation. Match that ownership pattern instead of adding a second ad hoc deletion timer.
- SQLite remains the only durable authority and is written only by the daemon. Artifact bytes live under a dedicated state directory whose paths are never accepted from a provider.
- Phase 1 expects a `RepositoryViewDescriptor`, verified manifest/digest, sparse object database, and allowed materialized view. Do not change its operation or provider semantics.

## Contracts inherited from Phase 1

- `RepositoryArtifactMaterializer` and `RepositoryViewLease` runtime boundaries.
- Versioned manifest/view descriptors, policy version, digest, and artifact locator types.
- `RepositoryHistoryPolicyV1`, retained-revision/frontier descriptor fields, `revision_out_of_range`, and `history_boundary` semantics.
- Repository-relative byte-safe path policy and sensitive classification.
- The rule that denied blobs can be missing and no content command may request them.
- Closed workload failure codes for missing, mismatched, corrupt, or unavailable artifacts.

## Contracts established

### Artifact identity

Add a server-owned `WorkflowRepositoryArtifact` domain type with:

- content digest and repository identity;
- artifact format version and policy version;
- opaque local locator;
- captured source base, HEAD/unborn state, index tree, and worktree tree identifiers;
- history policy version, ordered retained revision ids, retained commit and incremental historical blob-byte counts, frontier commit ids, and omitted parent ids;
- canonical path classification manifest digest;
- object/file/byte counts, allowed and denied counts;
- state (`creating`, `ready`, `cleanup_pending`, `failed`) and timestamps;
- last verification and cleanup error metadata.

Add a `WorkflowRepositorySnapshotClaim` domain type with submission id, artifact digest, claim state (`provisional`, `active`, `release_pending`, `released`), and created/activated/released timestamps. A submission has at most one unreleased claim. Artifact bytes and locator belong to the digest-level record, never to an individual claim. Define `WorkflowRepositorySnapshot` as the validated join of one active claim and its ready artifact for callers that need the complete effective snapshot. A provisional claim protects promoted bytes during capture finalization but cannot authorize materialization.

The locator is opaque outside the artifact service. Shared workload requests carry it because a future executor must receive an artifact reference, but no provider or MCP request accepts or returns a host path.

### Artifact layout

Use a versioned content-addressed artifact directory or equivalently deterministic container under the dedicated Workflow artifact root. At minimum it contains:

- canonical `manifest.json` with stable ordering and byte-level path representation;
- original commit and tree objects needed for exact layer trees and the policy-selected retained history prefix;
- allowed blob objects for current layers and every revision in that retained prefix;
- no sensitive blob bodies;
- explicit logical refs for base, HEAD, index, and worktree layers;
- a canonical file table whose paths, sizes, modes, and hashes are covered by the outer digest.

A directory artifact is acceptable as the local representation if its canonical file table and digest make it transferable without the original checkout. A future remote publisher may package or upload it without changing the request contract.

### Lifecycle API

Implement one `WorkflowRepositoryArtifactService` with:

```ts
prepare(input, signal): Promise<WorkflowRepositoryArtifactCandidate>
promote(candidate, submissionId): Promise<WorkflowRepositoryProvisionalSnapshot>
activate(submissionId): Promise<WorkflowRepositorySnapshot>
discard(candidate): Promise<void>
materialize(request: RepositoryMaterializationRequest, signal): Promise<RepositoryViewLease>
verify(snapshot, signal): Promise<RepositoryArtifactVerification>
release(submissionId): Promise<void>
reconcile(): Promise<RepositoryArtifactReconciliation>
```

The service owns all filesystem paths and namespace checks. `RepositoryMaterializationRequest` carries submission id, workload id, Workflow attempt id, locator, and digest. Before filesystem access, the trusted workload supervisor validates those values against the active `PersonaWorkloadRequest`, and the artifact service independently verifies that the submission still has an active claim for the same ready digest/locator. A provisional, released, or mismatched claim fails closed and creates no materialization. `prepare` creates no durable artifact record or submission claim. `promote` is the only operation that may publish candidate bytes and creates only a provisional claim. `activate` is the only operation that may make that claim usable, in the same transaction that makes the submission runnable. Callers name submission identity and expected digest, never deletion paths.

## Implementation steps

### 1. Add schema and migration ownership

In `src/server/db.ts`, create additive tables and indexes for artifact metadata, durable claims, and retryable cleanup. A representative shape is:

- `workflow_repository_artifacts`, unique by content digest, with format/policy versions, locator token, layer ids, manifest metadata, state, counts, errors, and timestamps;
- `workflow_repository_snapshot_claims`, unique by `submission_id`, referencing artifact digest with provisional/active/release state and timestamps;
- `workflow_repository_artifact_cleanup`, keyed by artifact digest with requested/attempted timestamps and last error, valid only while no provisional or active claim exists.

Use foreign keys and existing deletion/retention policy deliberately. Historical submissions have no row and continue to parse. Add every new column to both fresh schema and `migrate()` where applicable, and create indexes beside the migration that introduces their columns.

In `src/server/workflows/store.ts`:

- add strict row schemas, parsers, domain types, writers, readers, state transitions, cleanup claims, and observability counts;
- carry every persisted value through column, row schema, parser, domain type, and writer;
- use transactions for ready-state ownership, claim creation/release, and zero-claim cleanup-intent transitions;
- never expose raw locator paths in browser-facing detail.

### 2. Capture exact repository identity and classifications

Capture inside the existing stable boundary:

- Git toplevel and common repository identity;
- source base using the same semantic base selection as current Workflow diff evidence;
- full captured HEAD or explicit unborn state;
- complete `git status --porcelain=v2 -z` bytes and untracked enumeration, with no prompt-oriented 500-line or 100-file ceiling;
- index entries and modes, including staged additions/deletions and staged-then-modified paths;
- working-tree modes/content for tracked and nonignored untracked files;
- ignored paths excluded by Git semantics;
- symlink target text without following it;
- submodule gitlink identity without entering it;
- binary and sensitive classifications.

Path identity is bytes. Preserve raw bytes in the manifest and database BLOB fields where a path is persisted. Human display may escape non-UTF-8 paths, but validation never round-trips them through a lossy JavaScript string.

### 3. Build index and worktree trees without repository code execution

Use isolated candidate object storage and private index files. Do not run ordinary `git add -A` under repository-controlled filters.

The implementation should:

1. enumerate index entries and working-tree candidates with closed Git commands;
2. read regular files or symlink targets directly under the validated toplevel without following links;
3. compute Git blob ids and write allowed blobs into candidate object storage;
4. compute but do not store denied blob bodies;
5. construct index/worktree trees from explicit modes, ids, and paths;
6. preserve deleted and gitlink entries in manifest/layer identity;
7. keep the original live index and worktree byte-identical.

If the implementation uses any Git command capable of consulting attributes, filters, hooks, credential helpers, alternates, or network, explicitly neutralize and test those paths. Every subprocess has a timeout and cancellation.

### 4. Package the exact bounded sparse history set

Implement Phase 1's shared `RepositoryHistoryPolicyV1` without a local override:

1. Use captured `HEAD` as the sole root. An unborn repository produces an empty retained set.
2. Traverse all parents breadth-first, queueing parents in commit-record order. This produces one deterministic prefix and does not trust author or committer dates.
3. Before accepting each next commit, compute the incremental unique allowed blob bytes not already required by the exact base, HEAD, index, or worktree layers. Retain the commit only if the result stays at or below both 2,048 commits including HEAD and 512 MiB of incremental historical allowed blobs. Stop the entire traversal before the first overflow instead of skipping a large commit or continuing down a different branch.
4. Mark every retained commit with an omitted parent as a frontier. Record the ordered retained ids, retained counts/bytes, frontier ids, omitted parent ids, and policy version in the canonical digested manifest.
5. Include every retained commit and tree object and every nonsensitive blob body referenced by its tree. Omit sensitive blob bodies even when retained trees reference their ids. Include candidate-created objects and the separate source-base anchor objects needed for exact layer diffs.
6. Treat a source-base commit outside the retained set as diff-only. Its object presence does not grant history-query membership.

The retained set is the only valid revision domain for `git_show`, `git_log`, and `git_blame`. Materialize frontier metadata as a shallow boundary or equivalent closed reader structure. `git_log` stops at the frontier and `git_blame` marks boundary attribution and truncation. `git_show` metadata is available at every retained frontier. Its patch mode implements Phase 1's three exhaustive cases: a true root compares with the empty tree; a non-root compares only with its recorded first parent when that parent is retained, including a merge frontier whose other parent is omitted; and a non-root whose recorded first parent is omitted returns `history_boundary` with no patch. Requests for any other revision return `revision_out_of_range` even when its object happens to be present as the source-base anchor. Never fetch or consult the original repository to extend the range.

Build the artifact object set explicitly. Verify that every nonsensitive blob required by every retained revision is packaged, and that no packed or loose artifact object matches an omitted sensitive blob id. If the selected set cannot be completed because an allowed object is missing, unreadable, or cannot be stored, fail sealing as typed infrastructure unavailability. Never silently shrink the range after selection or produce a ready artifact whose in-range query can fail for a missing allowed blob.

Do not use a normal `git bundle` or a traversal mode that implicitly closes over every reachable blob. The artifact is intentionally sparse and bounded. Phase 1's path-scoped, retained-set-aware operations are the only reader.

### 5. Prepare inside stable capture and promote after capture guards

Extend `captureStableWorkflowContext` with an optional injected candidate-preparation callback that defaults to absent and therefore changes no current caller. The callback receives the exact checkout resolved for the per-repository Workflow run and returns an unclaimed candidate.

For an activated caller in Phase 3:

1. sample the existing boundary;
2. allocate a random candidate id under a bounded private pending namespace and atomically write a daemon-owned marker containing candidate id, expected root kind, creation time, and capture nonce before artifact bytes;
3. build objects, classifications, manifest, and digest;
4. resample HEAD, index/status, repository identity, and existing transcript/session boundary;
5. discard the candidate and retry if any boundary changed;
6. return the unclaimed candidate with the stable prompt context;
7. let `captureAndActivate` validate external artifact expectations and capture the already-reserved submission image/text evidence;
8. discard the candidate on any guard or evidence failure;
9. after those guards pass, atomically promote or verify the candidate in the digest namespace, upsert the digest-level artifact record, and insert the submission's provisional claim in one database transaction;
10. persist raw context and compact/check evidence readiness, then atomically activate the claim in the same transaction that allows the submission to become `running`;
11. if any post-promotion step fails or is cancelled before that transaction commits, idempotently release the provisional claim and enqueue zero-claim cleanup before propagating the existing capture failure.

If another capture concurrently wins promotion for the same digest, verify those bytes and attach a second independent provisional claim instead of replacing them. Promotion consumes the pending marker only after the digest bytes and database ownership transition are established; discard removes only the exact marked candidate. If database persistence fails after promotion, leave enough candidate metadata for startup reconciliation to prove and remove a zero-claim orphan. If filesystem promotion fails after a row exists, mark it failed/cleanup-pending only when no ready shared record already satisfies the digest. Startup reconciliation releases every provisional claim whose owning submission did not atomically reach `running`, including a crash after promotion and before application-level cleanup, and then applies the ordinary zero-claim deletion path. Never guess ownership or claim count from a directory name alone.

Phase 2 tests invoke prepare, promote, activate, release, and discard directly, including the guarantee that preparation alone produces no durable row or claim and a provisional claim cannot materialize. Production Workflow callers remain unchanged until Phase 3 supplies the callback conditionally.

### 6. Materialize and verify without the original checkout

Implement the Phase 1 materializer:

- resolve an opaque locator only inside the dedicated artifact root;
- canonicalize and containment-check every artifact path;
- accept only an active-request-bound `RepositoryMaterializationRequest` and reject submission, workload, attempt, locator, or digest mismatch before opening artifact paths;
- verify outer digest, canonical manifest, format/policy/history-policy versions, retained-set counts/frontier metadata, and every listed component before use;
- construct a private Git object directory and allowed worktree/index view in a fresh attempt-scoped directory;
- disable object fetching, alternates outside the artifact, hooks, config includes, credential helpers, and network;
- expose only the `RepositoryViewDescriptor` to the MCP launch;
- remove the attempt-scoped materialization after the lease closes or startup reconciliation proves it orphaned.

Materialization must succeed after the source worktree and its Git common directory are unavailable. Digest mismatch, missing allowed object, manifest mismatch, unsupported newer version, or unsafe path returns typed `unavailable` infrastructure failure.

### 7. Add retention and startup reconciliation

Integrate with `src/server/workflows/retention.ts` and `WorkflowManager` startup/periodic ownership:

- artifact bytes are owned by a digest-level record; each submission has an independent durable claim and all retries of that submission reuse it;
- run-family retention, explicit deletion, or failed activation atomically moves that submission's claim through release state and enqueues digest cleanup only when the transaction observes no other provisional or active claim;
- cleanup claims the zero-reference artifact, rechecks the absence of provisional or active submission claims in the deletion transaction, and abandons deletion if a concurrent capture acquired a claim;
- failed deletion remains durable and retryable;
- startup scans only immediate children of the bounded daemon-owned pending namespace. After a restart no unpromoted candidate can have a durable consumer, so it removes every well-formed candidate whose atomic marker, containment, root kind, and candidate id agree; malformed or unowned entries are quarantined/reported rather than recursively deleted. Periodic reconciliation uses the in-memory active-candidate registry and never removes a candidate still owned by a live capture;
- startup repairs ready-row/missing-artifact, artifact/no-row, claim/no-artifact, stranded provisional claims, and zero-claim cleanup mismatches conservatively without deleting bytes referenced by any provisional or active claim;
- never recurse-delete a user-supplied path, worktree, repository root, or Git common directory.

Expose structured logs and status counts for active snapshots, bytes, seal/verify/materialize latency, failures by code, cleanup backlog, and orphan observations. Do not log file bodies, sensitive paths, or raw manifests.

## Data, API, migration, and compatibility

- Additive SQLite tables only; no historical JSON rewrite.
- Old submissions without claim rows remain valid and prompt-only.
- Re-running migration is safe.
- Fresh and pre-feature database schemas have identical final table/column/index sets.
- Current Workflow submissions are not automatically captured because no production caller supplies the optional seal callback yet.
- Existing evidence and repository fingerprints remain byte-identical.
- No new browser route in this phase. Store/status methods are internal and used by tests and later integration.
- Artifacts are local only. No remote upload, public URL, or provider-visible path exists.

## Tests and verification

Add focused suites such as:

- `test/workflow-repository-artifact.test.ts`
- `test/workflow-repository-artifact-migration.test.ts`
- `test/workflow-repository-artifact-retention.test.ts`
- `test/workflow-repository-materialization.test.ts`
- extensions to `test/workflow-context.test.ts`, `test/workflow-retention.test.ts`, and migration parity coverage

Fixtures must distinguish:

- committed, staged, unstaged, staged-then-modified, renamed, deleted, untracked, ignored, binary, executable, symlink, submodule, empty, and unborn states;
- non-UTF-8 and case-colliding paths where the platform permits;
- denied tracked, staged, modified, and untracked files;
- history in which allowed and denied files change together;
- merge-heavy history that reaches both commit and incremental-blob ceilings, a large historical blob at the frontier, a source base outside the retained range, and an unborn repository with no retained revisions;
- repository config/attributes defining clean, process, diff, textconv, smudge, hook, include, credential, and promisor behavior;
- a live index with uncommon extensions or split-index behavior if supported by current Git;
- source worktree mutation during each capture step;
- database failure, rename/promotion failure, disk-full simulation, cancellation, digest corruption, missing object, daemon restart in every prepare/promote/activate/release/discard window, retention, and cleanup retry.

Required proofs:

- the original worktree and index hashes are unchanged after success and failure;
- reconstructed HEAD/index/worktree layer diffs and status match the captured fixture exactly;
- an artifact still works after source checkout/common-dir deletion;
- stale or cross-attempt materialization requests and mismatched submission, workload, locator, or digest values fail before a lease or filesystem view is created;
- denied blob bodies and known secret markers do not appear anywhere under the artifact root;
- Phase 1 MCP operations succeed for allowed content and deny sensitive content against the real artifact;
- retained revision selection is deterministic across repeated capture, stops before the first commit or byte overflow without holes, includes every allowed blob needed in range, and records identical boundary metadata in the descriptor and manifest;
- `git_show`, `git_log`, and `git_blame` work inside the retained set; fixtures distinguish a true root patch, a non-root patch with retained first parent, and `history_boundary` with no patch when the first parent is omitted; reachable, source-base-only, and arbitrary revisions outside the set are rejected as `revision_out_of_range`;
- failure to package any selected in-range allowed object prevents ready state rather than silently reducing the retained range;
- two submissions can claim the same digest; releasing either claim preserves bytes and materialization for the other, while releasing the final claim permits retryable cleanup;
- concurrent claim/release and cleanup races recheck the active-claim invariant and never prematurely delete shared bytes;
- cleanup removes only proven zero-claim artifacts and survives partial failure/restart;
- a crash after prepare returns but before promote/discard leaves no durable row or claim, and the next startup removes only that atomically marked pending candidate while preserving malformed, unowned, and live periodic candidates;
- a raw-context, compaction, evidence-readiness, cancellation, or activation failure after promotion releases the provisional claim, while a crash in that interval is reconciled from provisional claim plus submission state without retaining an unusable artifact;
- default-unused capture seam leaves all existing Workflow fingerprints and behavior unchanged.

Run focused tests with the suite preamble, then:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

## Merge and exit criteria

- Exact HEAD, index, worktree, and nonignored untracked state round-trips through a portable artifact.
- Original checkout removal does not affect materialization or MCP reads.
- Denied blob bodies are absent from the artifact, including history packs.
- The artifact contains exactly the deterministic `RepositoryHistoryPolicyV1` retained prefix and all required allowed objects; boundary and out-of-range behavior passes the Phase 1 MCP contract after source removal.
- Capture neither mutates the live index/worktree nor executes repository-configured programs.
- Candidate marker publication, prepare/promote/activate/release/discard crash windows, digest ownership, provisional/active per-submission claims, zero-claim cleanup intent, and startup reconciliation are crash-safe and tested.
- Releasing one of several provisional or active claims cannot delete shared bytes; releasing the final claim permits deletion only after the cleanup transaction rechecks zero unreleased claims.
- Historical submissions and all existing active Workflow behavior are unchanged.
- Operational logs/counts are bounded and contain no repository bodies.
- The phase pull request records any deviation and reasoning.

## Downstream handoff

Phase 3 may rely on:

- `WorkflowRepositoryArtifactService` as the only capture/materialize/verify/release/reconcile owner;
- the artifact/claim store API and active-claim plus ready-artifact invariant;
- a ready snapshot's immutable digest and locator surviving original checkout release;
- the immutable retained-revision set, history policy version, and frontier metadata used by every retry and exposed only through Phase 1's bounded history results;
- one durable submission claim whose digest is reused by every retry, even when another submission claims the same artifact bytes;
- typed unavailability on missing/corrupt/mismatched artifacts;
- the optional stable-capture seal seam;
- retention and startup reconciliation already handling snapshot files.

Phase 3 must:

- activate sealing only when the published graph contains at least one `read` Persona that can execute;
- require ready state before an access-enabled attempt starts;
- include the artifact digest in access-enabled workload identity without changing access-off fingerprints;
- never reconstruct from the live checkout or bounded prompt evidence.

Phase 3 must not rewrite artifact files, query sparse objects directly, or add a second cleanup path.

## Cross-phase compatibility audit

- The artifact manifest implements Phase 1's final `RepositoryViewDescriptor` and policy version rather than inventing a second schema.
- History packaging implements Phase 1's final `RepositoryHistoryPolicyV1` exactly, so valid revisions and frontier behavior cannot drift between capture, MCP validation, retries, or UI disclosure.
- Sparse object packaging matches Phase 1's pre-allowlisted Git operations and missing-denied-blob tests.
- The optional capture callback defaults off, preserving Phase 1 and historical Workflow behavior until Phase 3 owns activation.
- Claim rows are keyed by submission for retry reuse and Phase 3 attempt/workload ownership, while artifact rows are keyed by digest for safe deduplication.
- Locator opacity lets a future remote executor replace local-file resolution without changing Workflow or Persona semantics.
- Cleanup lives in existing Workflow retention/startup ownership, so Phase 3 does not need a compensating delete path.
