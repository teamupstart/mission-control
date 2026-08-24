# Phase 2 - Portable exact-state artifact and lifecycle

## Outcome

Add a daemon-owned service that can seal, persist, verify, materialize, retain, and clean up a portable immutable representation of the exact submitted Git state. The artifact preserves captured base, HEAD, staged index, unstaged working tree, nonignored untracked content, and allowed history without depending on the original worktree or Git common directory.

Sensitive paths remain classified in the manifest, but their blob bodies are physically absent from the artifact. The Phase 1 repository MCP can query an artifact round trip safely after the original checkout is reset or deleted.

This phase does not enable repository access for Personas. Phase 3 activates conditional capture and execution.

Estimated gross non-test implementation: **1,350-1,750 lines**.

## Entry criteria and direct dependencies

- Phase 1 has merged.
- The planning PR has merged.
- Phase 1's provider parity gate passed for both Claude and Codex.
- The approved source plan, `phased-plan.md`, and Phase 1's merged contracts are the controlling inputs for this phase.

Direct dependency: **Phase 1 only**. The planning-session dependency is carried by the Mission Control task separately.

## Scope

This phase owns:

- the versioned sparse Git object artifact format and canonical manifest;
- exact capture of source base, HEAD/unborn state, index tree, worktree tree, status classifications, and allowed history;
- content-addressed artifact storage under the Mission Control state directory;
- digest verification and isolated materialization for the Phase 1 reader/MCP;
- submission-owned snapshot metadata, cleanup intent, and store round trips;
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

- `WorkflowManager.captureAndActivate` creates the submission row before evidence capture and calls `captureStableWorkflowContext` while the run and submission are `capturing`. This provides a real submission id for ownership.
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
- Repository-relative byte-safe path policy and sensitive classification.
- The rule that denied blobs can be missing and no content command may request them.
- Closed workload failure codes for missing, mismatched, corrupt, or unavailable artifacts.

## Contracts established

### Artifact identity

Add a server-owned `WorkflowRepositorySnapshot` domain type with:

- submission id and repository identity;
- artifact format version and policy version;
- content digest and opaque local locator;
- captured source base, HEAD/unborn state, index tree, and worktree tree identifiers;
- canonical path classification manifest digest;
- object/file/byte counts, allowed and denied counts;
- state (`creating`, `ready`, `cleanup_pending`, `failed`) and timestamps;
- last verification and cleanup error metadata.

The locator is opaque outside the artifact service. Shared workload requests carry it because a future executor must receive an artifact reference, but no provider or MCP request accepts or returns a host path.

### Artifact layout

Use a versioned content-addressed artifact directory or equivalently deterministic container under the dedicated Workflow artifact root. At minimum it contains:

- canonical `manifest.json` with stable ordering and byte-level path representation;
- original commit and tree objects needed for captured HEAD ancestry and exact layer trees;
- allowed blob objects for current layers and bounded history operations;
- no sensitive blob bodies;
- explicit logical refs for base, HEAD, index, and worktree layers;
- a canonical file table whose paths, sizes, modes, and hashes are covered by the outer digest.

A directory artifact is acceptable as the local representation if its canonical file table and digest make it transferable without the original checkout. A future remote publisher may package or upload it without changing the request contract.

### Lifecycle API

Implement one `WorkflowRepositoryArtifactService` with:

```ts
seal(input, signal): Promise<WorkflowRepositorySnapshot>
materialize(locator, digest, signal): Promise<RepositoryViewLease>
verify(snapshot, signal): Promise<RepositoryArtifactVerification>
release(submissionId): Promise<void>
reconcile(): Promise<RepositoryArtifactReconciliation>
```

The service owns all filesystem paths and namespace checks. Callers name submission identity and expected digest, never deletion paths.

## Implementation steps

### 1. Add schema and migration ownership

In `src/server/db.ts`, create additive tables and indexes for snapshot metadata and retryable cleanup. A representative shape is:

- `workflow_repository_snapshots`, unique by `submission_id`, with format/policy versions, digest, locator token, layer ids, manifest metadata, state, counts, errors, and timestamps;
- `workflow_repository_snapshot_cleanup`, keyed by submission/snapshot ownership with requested/attempted timestamps and last error.

Use foreign keys and existing deletion/retention policy deliberately. Historical submissions have no row and continue to parse. Add every new column to both fresh schema and `migrate()` where applicable, and create indexes beside the migration that introduces their columns.

In `src/server/workflows/store.ts`:

- add strict row schemas, parsers, domain types, writers, readers, state transitions, cleanup claims, and observability counts;
- carry every persisted value through column, row schema, parser, domain type, and writer;
- use transactions for ready-state ownership and cleanup-intent transitions;
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

### 4. Package a sparse history object set

Preserve original commit and tree object identities for captured HEAD and reachable ancestors needed by bounded `git_show`, `git_log`, and `git_blame`.

Build the artifact object set explicitly:

- include commit and tree objects required to traverse captured ancestry;
- include allowed blobs for approved paths/history;
- omit sensitive blob bodies even when a tree references their object ids;
- include candidate-created objects for exact index/worktree layers;
- verify no packed or loose artifact object matches a denied blob id whose content was omitted;
- record omitted object ids only as safe manifest metadata.

Do not use a normal `git bundle` or a traversal mode that implicitly closes over every reachable blob. The artifact is intentionally sparse. Phase 1's path-scoped operations are the only reader.

### 5. Seal atomically inside stable capture

Extend `captureStableWorkflowContext` with an optional injected sealing callback or candidate transaction that defaults to absent and therefore changes no current caller.

For an activated caller in Phase 3:

1. sample the existing boundary;
2. create a candidate under a private pending namespace;
3. build objects, classifications, manifest, and digest;
4. resample HEAD, index/status, repository identity, and existing transcript/session boundary;
5. discard the candidate and retry if any boundary changed;
6. atomically promote the candidate into the digest namespace and persist ready ownership;
7. only then allow the submission to become `running`.

If database persistence fails after promotion, leave enough candidate metadata for startup reconciliation to prove and remove the orphan. If filesystem promotion fails after a row exists, mark it failed/cleanup-pending. Never guess ownership from a directory name alone.

Phase 2 tests invoke this seam directly. Production Workflow callers remain unchanged until Phase 3 supplies the callback conditionally.

### 6. Materialize and verify without the original checkout

Implement the Phase 1 materializer:

- resolve an opaque locator only inside the dedicated artifact root;
- canonicalize and containment-check every artifact path;
- verify outer digest, canonical manifest, format/policy versions, and every listed component before use;
- construct a private Git object directory and allowed worktree/index view in a fresh attempt-scoped directory;
- disable object fetching, alternates outside the artifact, hooks, config includes, credential helpers, and network;
- expose only the `RepositoryViewDescriptor` to the MCP launch;
- remove the attempt-scoped materialization after the lease closes or startup reconciliation proves it orphaned.

Materialization must succeed after the source worktree and its Git common directory are unavailable. Digest mismatch, missing allowed object, manifest mismatch, unsupported newer version, or unsafe path returns typed `unavailable` infrastructure failure.

### 7. Add retention and startup reconciliation

Integrate with `src/server/workflows/retention.ts` and `WorkflowManager` startup/periodic ownership:

- snapshots are owned by submissions and shared by all retries of that submission;
- run-family retention or explicit deletion records cleanup intent before file deletion;
- failed deletion remains durable and retryable;
- startup removes abandoned pending candidates and orphaned materializations only when their dedicated namespace and ownership marker are proven;
- startup repairs ready-row/missing-artifact and artifact/no-row mismatches conservatively;
- never recurse-delete a user-supplied path, worktree, repository root, or Git common directory.

Expose structured logs and status counts for active snapshots, bytes, seal/verify/materialize latency, failures by code, cleanup backlog, and orphan observations. Do not log file bodies, sensitive paths, or raw manifests.

## Data, API, migration, and compatibility

- Additive SQLite tables only; no historical JSON rewrite.
- Old submissions without snapshot rows remain valid and prompt-only.
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
- repository config/attributes defining clean, process, diff, textconv, smudge, hook, include, credential, and promisor behavior;
- a live index with uncommon extensions or split-index behavior if supported by current Git;
- source worktree mutation during each capture step;
- database failure, rename/promotion failure, disk-full simulation, cancellation, digest corruption, missing object, daemon restart, retention, and cleanup retry.

Required proofs:

- the original worktree and index hashes are unchanged after success and failure;
- reconstructed HEAD/index/worktree layer diffs and status match the captured fixture exactly;
- an artifact still works after source checkout/common-dir deletion;
- denied blob bodies and known secret markers do not appear anywhere under the artifact root;
- Phase 1 MCP operations succeed for allowed content and deny sensitive content against the real artifact;
- cleanup removes only owned artifacts and survives partial failure/restart;
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
- Capture neither mutates the live index/worktree nor executes repository-configured programs.
- Candidate promotion, database ownership, cleanup intent, and restart reconciliation are crash-safe and tested.
- Historical submissions and all existing active Workflow behavior are unchanged.
- Operational logs/counts are bounded and contain no repository bodies.
- The phase pull request records any deviation and reasoning.

## Downstream handoff

Phase 3 may rely on:

- `WorkflowRepositoryArtifactService` as the only capture/materialize/verify/release/reconcile owner;
- the snapshot store API and ready-state invariant;
- a ready snapshot's immutable digest and locator surviving original checkout release;
- one submission-owned artifact reused by every retry;
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
- Sparse object packaging matches Phase 1's pre-allowlisted Git operations and missing-denied-blob tests.
- The optional capture callback defaults off, preserving Phase 1 and historical Workflow behavior until Phase 3 owns activation.
- Snapshot rows are keyed by submission, matching retry reuse and Phase 3 attempt/workload ownership.
- Locator opacity lets a future remote executor replace local-file resolution without changing Workflow or Persona semantics.
- Cleanup lives in existing Workflow retention/startup ownership, so Phase 3 does not need a compensating delete path.
