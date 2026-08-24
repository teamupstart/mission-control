# Phase 1 - Repository MCP and workload execution foundation

## Outcome

Land the provider-neutral execution and security foundation for repository-aware Persona reviews without enabling the feature for any Persona yet.

After this phase, a test or internal harness can dispatch one versioned local Persona workload against an injected materialized repository view. Claude and Codex each start one isolated provider session, call the same local stdio MCP server repeatedly, and return one schema-validated verdict. The MCP exposes only the eight approved read operations, enforces one shared policy, emits safe audit metadata locally, and never receives Mission Control credentials.

Estimated gross non-test implementation: **1,950-2,550 lines**.

## Entry criteria and direct dependencies

- The planning PR containing `plan.md`, `phased-plan.md`, and this file has merged.
- No implementation phase dependency.
- The approved source plan and `phased-plan.md` are the controlling planning context for this phase.
- Verify the current Claude and Codex SDK APIs and launch configuration in the checked-out revision. Do not rely on the planning checkout's line numbers.

## Scope

This phase owns:

- browser-safe repository access, operation, result, policy, cursor, workload, event, cancellation, and safe audit schemas;
- shared path and content policy used below both providers;
- a separate repository MCP bundle and all eight typed operations;
- one-session workload-specific Claude and Codex adapters;
- the `PersonaWorkloadExecutor` interface, local supervisor, and local reference executor;
- ordered local event production, cancellation propagation, and an attempt-scoped safe audit journal;
- build, smoke, unit, security, and runner-contract proof of provider parity.

This phase does not:

- add a Persona setting or edit `PersonaSnapshot`;
- change workflow publication, submission capture, retries, or run detail;
- add database tables or write SQLite;
- produce the portable artifact from a live checkout;
- activate the executor from `WorkflowEngine`;
- add remote scheduling, WebSocket transport, cloud identity, artifact upload, shell, writes, or agent-visible network access;
- widen the general `LlmRunner` interface or Inspector's provider grant.

## Repository findings and inherited contracts

- `src/shared/review.ts` is browser-safe prompt framing. Keep repository contracts in a focused sibling, `src/shared/repository-access.ts`, rather than turning review prompt helpers into a protocol registry.
- `src/mcp/server.ts` is Mission MCP. It imports task tools, HTTP access, session identity, and credentials. Repository MCP must not be a mode of that process.
- `package.json` builds `dist/mcp/server.mjs`, and `scripts/smoke-bundles.mjs` performs a real initialize/list-tools handshake. Add a second explicit bundle and smoke it the same way.
- `LlmRunOptions` intentionally defaults to no tools. Do not add an MCP option to it. Workload-specific provider adapters are a distinct execution boundary.
- `runClaudeSdkOneShot` is structured-output capable but defaults its tool-less jobs to one turn. Repository workloads need a dedicated multi-tool-call turn budget.
- `runCodexSdkOneShot` explicitly rejects tool grants and images. The workload adapter must use a provider path that supports launch-scoped MCP and preserves Workflow image inputs, or prove an equally bounded dedicated SDK path. It must not weaken image behavior or fake parity.
- Full session adapters already configure Claude `mcpServers` and Codex `mcp_servers.*`. Reuse their descriptor composition patterns, not their Registry/session ownership.
- Inspector denies and scrubs useful secret families, but the deny list includes host-absolute patterns because the provider tool grant reads a live checkout. The new policy starts from those families and operates on repository-relative bytes plus an explicit `.git` ban.
- Git content commands can invoke configured external diff, text conversion, or clean filters. Every repository operation and fixture must prove those are disabled.
- The Phase 2 artifact intentionally has missing sensitive blobs. Phase 1 readers must pre-authorize paths before invoking Git and must never run an unrestricted content operation and redact it afterwards.

## Contracts established

### Shared closed contracts

Create `src/shared/repository-access.ts` with append-only or closed constants and strict Zod schemas for:

- `PERSONA_REPOSITORY_ACCESS_MODES = ["none", "read"]` and default `none`;
- `REPOSITORY_OPERATION_IDS = ["read", "search", "glob", "git_status", "git_diff", "git_show", "git_log", "git_blame"]`;
- operation-specific request payloads with no free-form argv, revision expression, or host path;
- result envelopes containing operation id, status, byte/item counts, truncation, continuation cursor, history-boundary metadata, and typed denial/failure codes including `revision_out_of_range` and `history_boundary`;
- a closed `RepositoryHistoryPolicyV1` contract: captured HEAD root, deterministic all-parent breadth-first traversal, 2,048 retained commits, 512 MiB of incremental unique allowed historical blob bodies, stop-before-overflow prefix semantics, and no timestamp cutoff;
- a versioned `RepositoryViewDescriptor` naming only an isolated manifest/object view and its verified digest, ordered retained-revision ids, frontier/omitted-parent metadata, retained counts/bytes, and history policy version;
- layered budgets for per-call bytes/items/time and per-attempt calls/bytes/time;
- opaque cursor metadata bound to snapshot digest, operation shape, policy version, and position;
- a versioned `PersonaWorkloadRequest` with idempotency key, frozen Persona payload, provider/model, prompt/images, artifact locator/digest, policy, budgets, deadline, and cancellation generation;
- ordered `PersonaWorkloadEvent` variants with workload id, sequence, timestamp, and payload;
- `PersonaWorkloadResult` containing one validated Persona verdict or one typed infrastructure failure;
- opaque `RepositoryEvidenceHandleId` and safe handle metadata bound to snapshot/workload/operation identity, returned item ordinal, canonical approved path and exact line/diff range, policy version, and truncation state;
- safe `RepositoryQueryAuditMetadata` with hashes/counts and bounded evidence-handle metadata only, never result bodies, excerpts, quote fields, or sensitive query text.

Use exhaustive records and switches over every operation and event. Unknown future values must fail closed rather than map to a nearby capability.

### Runtime boundaries

Establish these production interfaces under `src/server/workflows/persona-workload/` or the closest current Workflow ownership directory:

```ts
interface PersonaWorkloadExecutor {
  dispatch(request: PersonaWorkloadRequest, signal: AbortSignal): AsyncIterable<PersonaWorkloadEvent>;
  reconcile(workloadId: string, afterSequence: number): Promise<PersonaWorkloadReconciliation>;
  cancel(workloadId: string, generation: number): Promise<void>;
}

interface RepositoryArtifactMaterializer {
  materialize(locator: string, digest: string, signal: AbortSignal): Promise<RepositoryViewLease>;
}
```

The local executor accepts the materializer as a dependency. This phase uses a fixture implementation; Phase 2 supplies the real artifact owner. The supervisor owns provider/MCP process lifetime and emits ordered events. It does not own Workflow state or SQLite.

## Implementation steps

### 1. Prove both providers before broad implementation

Build focused executable contract prototypes using the installed provider paths:

1. Start one isolated Claude workload with one launch-scoped stdio MCP descriptor, all built-in filesystem/shell/write/network tools disabled, multiple MCP calls, required image inputs, and one structured final result.
2. Repeat the same sequence for Codex through its workload-specific SDK/app-server path.
3. Record the exact provider configuration in runner-contract tests: working directory, sandbox/approval posture, disabled built-ins, MCP registration, model, images, schema, deadline, and cancellation.
4. Prove the provider sees only the repository MCP tool names and cannot call Mission MCP or provider-native repository tools.

This is a blocking feasibility gate. If either provider cannot meet the contract, stop the phase and return the design to operator review. Do not add a provider-specific fallback, repeated fresh-call broker, prompt-only fallback, or direct filesystem grant.

### 2. Extract one repository security policy

Create shared pure modules for:

- byte-preserving repository-relative POSIX path validation;
- literal path and glob normalization;
- case-aware sensitive segment matching;
- denied path families seeded from Inspector and expanded to `.git` internals, credentials, private keys/certificates, `.env*`, `.npmrc`, `.netrc`, host-state names, and known secret-bearing files;
- content scrubbing, reusing `scrubSecrets` behavior without changing Inspector output;
- operation safety declarations that state required input validation and output handling for every operation.

Preserve Inspector behavior by making its current constants consume or re-export the shared policy with equality tests. Do not silently broaden or narrow Inspector access in this phase.

Path rules:

- accept only repository-relative POSIX paths in canonical form;
- reject absolute paths, drive prefixes, backslashes, NUL, empty file targets, `.`/`..`, normalization identity changes, overlong segments, and option-like revision input;
- keep Git path bytes authoritative. Non-UTF-8 paths may be listed with a stable escaped marker but are not addressable through a lossy string;
- never follow symlinks or traverse submodules;
- treat symlink target bytes as bounded repository content only after path policy passes;
- validate every path or glob argument even for metadata operations.

### 3. Implement the repository reader over an injected sparse view

Create one reader factory from a verified `RepositoryViewDescriptor`. The reader owns validation, policy, budgets, cursors, cancellation, Git invocation, scrubbing, and local audit emission.

For every successfully returned content item, mint one unpredictable opaque evidence handle and include only its id in the MCP result. Emit the matching safe handle metadata to the supervisor-owned audit journal in the same operation lifecycle. Do not mint a handle for denied, failed, cancelled, or omitted items. A truncated result binds handles only to the ranges actually returned. The provider cannot create an id that matches an authenticated workload event and persisted handle record.

Implement:

- `read`: regular file or symlink target, explicit layer (`worktree` or `index` where available), line/byte window, cursor;
- `search`: literal text only, explicit case behavior and validated path/glob scope, bounded context, cursor;
- `glob`: manifest-backed path enumeration with type/classification metadata and cursor;
- `git_status`: manifest-backed exact captured classification, never live `git status`;
- `git_diff`: only the four approved layer pairs, optional validated scope, explicit literal allowlist before content generation;
- `git_show`: captured HEAD or a revision in the descriptor's retained set, fixed metadata format plus an allowlisted first-parent patch; reject outside revisions as `revision_out_of_range`, compare a true root with the empty tree, and return `history_boundary` instead of a root-style patch when a non-root retained frontier commit lacks its first parent;
- `git_log`: descriptor-retained ancestry only, fixed metadata-only format, optional validated allowed path, no patch/stat/name flags, and explicit terminal boundary metadata;
- `git_blame`: bounded allowed regular file/range against the retained view, with boundary attribution and `historyTruncated`, and with any emitted filename/previous path revalidated.

All Git invocations use argv arrays, `--` separation, deterministic config, explicit revisions derived from the descriptor, timeouts, and cancellation. Disable external diff, text conversion, hooks, filters, pagers, optional locks, credential helpers, object fetching, and network. Treat a missing object on an allowed path as `unavailable`, not an empty file. Denied missing blobs must never be requested.

For `git_diff` and patch-producing `git_show`, first resolve the complete changed path set, deny sensitive paths, then generate content for explicit allowed literal paths only. Verify every returned header path before returning bytes. Never generate an unrestricted patch and redact it later.

### 4. Implement bounds and opaque cursors

Centralize initial defaults from the source plan: approximately 128 operations, 32 MiB cumulatively served, 1 MiB maximum response, and 15 minutes per workload. Add smaller operation-specific item/line/history/time limits.

History query pagination does not define artifact retention. Implement the exact shared `RepositoryHistoryPolicyV1` declared above and require every fixture descriptor to carry its computed retained set. History validation tests use that set, not a live reachability check. A captured source-base object outside the retained set remains valid only for the approved layer diffs and is rejected by all three history operations. Missing allowed objects inside the retained set are typed artifact unavailability, never an implicit shorter range.

Every truncated response states the limit reached and supplies an integrity-protected continuation cursor when continuation is meaningful. Cursor verification binds it to the view digest, policy version, operation kind, normalized input hash, and prior position. Reusing a cursor with a different request fails closed and is audited.

### 5. Add the standalone repository MCP bundle

Create `src/repository-mcp/server.ts` as a stdio MCP server with only the eight approved tools. Its launch environment names an attempt-scoped descriptor and safe local audit sink. It must not import:

- `src/mcp/server.ts`;
- Mission Control HTTP helpers or bearer-token readers;
- task/session Registry code;
- general shell/process execution helpers beyond the reader's closed Git invocations.

Add `build:repository-mcp` and include it in `npm run build`. Extend `scripts/smoke-bundles.mjs` to initialize the built repository MCP, verify the exact tool set, execute a harmless fixture-backed query, and confirm clean termination. Keep the existing Mission MCP smoke unchanged.

The MCP writes only safe query and evidence-handle metadata to an attempt-scoped local audit journal or equivalent supervisor-owned IPC. MCP stdout remains protocol-only. An audit write failure makes the operation unavailable and eventually fails the workload; it is never ignored. The journal never contains result bodies, excerpts, or quote text.

### 6. Implement the local workload supervisor and executor

The supervisor:

1. validates the versioned request and deadline;
2. asks the injected materializer for a verified repository view lease;
3. creates attempt-scoped provider and MCP configuration;
4. starts one provider session and the local repository MCP;
5. streams monotonically sequenced lifecycle and safe query/evidence-handle audit events;
6. validates one terminal Persona verdict and its provider result envelope;
7. releases the view lease and terminates child processes in `finally`;
8. treats late results after cancellation as terminal audit only.

Cancellation propagates from executor to provider, MCP, Git children, iterators, and audit drain. A larger cancellation generation supersedes an older command; an older replay cannot revive work. The local executor supports reconciliation and event replay from its in-memory/test event journal without claiming durable ownership, which Phase 3 adds.

Provider configuration must be generated from one provider-neutral capability description. Provider-specific adapters translate only transport details. Both advertise the same MCP server, schema, budgets, and final contract.

### 7. Keep the feature unreachable in production

Do not add Persona fields, routes, engine calls, or default executor construction. Export the foundation for Phase 2 and tests, but keep every existing Workflow path byte-identical.

## Data, API, migration, and compatibility

- No SQLite migration in this phase.
- No HTTP or browser API change.
- No persisted Workflow schema change.
- Existing Mission MCP, Inspector, `LlmRunner`, Workflow engine, prompts, fingerprints, and provider defaults must be unchanged.
- New shared schemas are additive and unused by historical JSON until Phase 3.

## Tests and verification

Add or extend focused tests such as:

- `test/repository-access-contract.test.ts`
- `test/repository-path-policy.test.ts`
- `test/repository-reader.test.ts`
- `test/repository-mcp.test.ts`
- `test/persona-workload-contract.test.ts`
- `test/llm-runner-contract.test.ts`
- provider adapter tests under the current Claude/Codex test naming pattern
- `test/inspector-scrub.test.ts` and Inspector grant equality regressions
- `test/keep-awake-native-build.test.ts` or the current bundle/build contract suite where new entrypoint enumeration belongs

Security fixtures cover traversal in every field, absolute and option-like input, Unicode/case behavior, non-UTF-8 names, denied paths returned indirectly by search/glob/diff/show/blame, symlinks outside the view, submodules, arbitrary refs, reachable-but-out-of-range revisions, source base outside the retained range, boundary show/log/blame behavior, forged patch headers and commit messages, configured diff/textconv/filter commands, binary files, sparse missing denied blobs, missing in-range allowed blobs, evidence handles for exact returned ranges, absence of handles on non-success outcomes, body-free audit events, timeouts, cancellation, response limits, cumulative limits, and cursor tampering.

Provider contract fixtures prove multiple repository calls and one verdict for Claude and Codex without real tokens. They assert image preservation and exact capability parity.

Run focused tests with the mandatory loader, then:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

## Merge and exit criteria

- Both installed provider paths pass the one-session, multiple-MCP-call, image, structured-result, cancellation, and no-direct-tool contract.
- The repository MCP publishes exactly eight tools and contains no Mission Control credential or task API path.
- Every operation shares the same path/content policy and explicit budgets.
- History operations enforce the shared retained-revision set, report its boundary, and never fetch, accept, or imply history beyond it.
- Sparse denied blobs cannot be read or leaked through another operation.
- MCP response bodies remain between provider and MCP; emitted events contain safe metadata only.
- Every content evidence handle maps to one actually returned allowed item and exact range; no response excerpt or quote crosses into workload events.
- Build and smoke prove both MCP bundles are packaged and runnable.
- No existing Workflow or Inspector behavior changes.
- The phase pull request records any deviation from this proposed route and why.

If provider parity fails, this phase does not merge and Phase 2 must not start.

## Downstream handoff

Phase 2 may rely on:

- the exact shared operation, view, policy, workload, event, audit, cursor, and cancellation schemas;
- the exact `RepositoryHistoryPolicyV1`, retained-revision validation, boundary result semantics, and out-of-range denial code;
- opaque repository evidence-handle ids and safe handle metadata, including the no-body/no-quote event contract;
- the sparse-object reader's rule that denied blob bodies may be physically absent;
- `RepositoryArtifactMaterializer` and `RepositoryViewLease` boundaries;
- the standalone MCP bundle and its descriptor;
- the local executor and supervisor accepting an injected real materializer.

Phase 2 must not change provider capability semantics or duplicate reader policy inside artifact capture. It may add artifact-format-specific descriptor fields only through the versioned shared schema and compatibility audit.

Phase 3 may rely on the same contracts and must not widen `LlmRunner`, create a daemon-side query API, or send repository bodies through workload events.

## Cross-phase compatibility audit

- The Phase 1 access enum uses final `none`/`read` spellings so Phase 3 does not migrate a temporary vocabulary.
- Query, evidence-handle, and audit schemas contain attempt/workload identity fields even though Phase 1 does not persist them; Phase 3 can write and validate them without changing MCP responses or retaining excerpts.
- The materializer is injected, so Phase 2 can add the real artifact owner without replacing the executor.
- The MCP reads a manifest and sparse object view rather than a live repository path, matching Phase 2's portability and sensitive-blob omission.
- History validity is descriptor membership, not generic reachability, so Phase 2 can package one deterministic bounded prefix and Phase 3 can disclose and audit the same boundary without changing provider semantics.
- The final verdict contract remains the existing Persona verdict union, so Phase 3 can preserve access-off parsing and add repository evidence validation without a second verdict format.
- No user-visible or durable surface exists yet, so a Phase 1 merge cannot advertise an unavailable capability.
