# Persona repository access for Workflow reviews

Status: Approved for phased implementation
Repository: `ai-harness`
Implementation scope: planning only in this task

Revalidated: 2026-09-04 against `origin/main` at `3459720f` (`v1.7.1`). The approved local-MCP architecture remains valid. The current integration, capture-order, evidence, and Persona-provenance amendments in this document are controlling for implementation.

Supersession: This Markdown source replaces the daemon-side broker design from planning PR #770. The approved architecture is the local repository MCP and portable exact-state artifact described below; the earlier implementation tasks were cancelled and must not be revived.

## Outcome

Allow an operator to enable read-only access to the complete submitted Git worktree on an individual Workflow Persona. During a review, either a Claude or Codex Persona runs once inside an isolated review workload and makes multiple typed repository queries through a local MCP repository server before returning its verdict. The MCP server reads a portable immutable representation of the exact submitted checkout, applies one provider-neutral security policy, and records an audit event for every operation, denial, truncation, cancellation, and failure.

Repository access is an explicit capability, not an implicit provider tool grant. It provides repository file read, search, and glob plus server-owned Git status, diff, show, log, and blame. It never provides shell execution, file writes, agent-visible network access, unrestricted provider tools, host-file access, `.git` internals, or known secret-bearing file contents. The initial implementation uses a local executor shaped like a future remote workload. A future scheduling-middleware adapter can transport the same request, snapshot artifact, events, and result without changing Workflow semantics.

## Approved decisions

The following decisions are requirements and are not open for reconsideration in this plan:

- Repository access is configured independently on each Persona and defaults to `none`.
- Claude and Codex reviewers receive the same MCP operations, limits, denials, retry behavior, and audit records.
- ai-harness owns a provider-neutral repository MCP server that runs locally inside the Persona workload. Providers receive only its typed tools and do not receive unrestricted filesystem or provider tools.
- The Persona uses one isolated session for the review and may call the local repository MCP repeatedly before returning one structured verdict.
- Repository query contents stay inside the workload. Mission Control receives lifecycle events, safe audit metadata, and the final verdict, not file bodies returned by the MCP server.
- The exact submitted state includes committed, staged, unstaged, and applicable untracked content.
- Repository-read unavailability is an infrastructure failure. The attempt blocks and retries through the existing attempt policy without prompt-only fallback.
- The access value is frozen into each published Persona snapshot. Later Persona edits affect only newly published workflow versions.
- Built-in Persona guidance, runner, and model remain immutable. An operator can maintain a local repository-access override for each built-in Persona.
- Sensitive-path protections must be at least as strong as the current Inspector protections.
- Reliability limits must be explicit and pageable. One global character ceiling must not silently hide most of a large worktree.
- Mission Control remains the durable Workflow and retry authority. A worker connection is transport only; ordered persisted events and idempotent commands provide reconnect and replay semantics.
- The implementation must be remote-ready without selecting or integrating a remote scheduling platform in this feature. A local reference executor consumes the same portable workload contract that a later remote adapter will consume.

## Current implementation findings

The design below is based on the current checkout rather than historical line numbers.

| Surface | Current contract | Required consequence |
| --- | --- | --- |
| `src/shared/workflow.ts` | `PersonaSnapshot` freezes guidance, runner, and model. `personaSnapshotOf` is the shared projection. | Add the closed repository-access mode to Persona and snapshot contracts through this projection. |
| `src/shared/protocol.ts` | Persona and snapshot schemas are strict and currently have no repository-access field. | Add protocol validation and default old persisted snapshots to `none`. |
| `src/server/db.ts` | Personas are persisted in one table; built-ins have no rows. Workflow versions are uniquely identified by workflow id and draft revision. | Add custom access persistence, a narrow built-in override table, snapshot migration support, and publication identity that includes resolved snapshots. |
| `src/server/workflows/store.ts` | Publishing snapshots the resolved Persona catalog, but an existing draft revision returns its prior version before new Persona state is evaluated. | Build and fingerprint the resolved graph before idempotency lookup so a Persona access change can publish a new version from an otherwise unchanged draft. |
| `src/server/workflows/context.ts` | Stable capture resolves the checkout for each per-repository Workflow run and persists bounded prompt context after checking the live checkout boundary. | Prepare a portable repository artifact candidate inside the same stable boundary for the run's resolved checkout. Do not durably promote or claim it until later capture guards pass. |
| `src/server/workflows/manager.ts` | Capture now validates external artifact expectations before persisting raw context, then freezes reserved submission evidence, captures daemon-owned image/text artifacts, compacts context, and applies evidence-readiness policy before activation. | Preserve this ordering. Discard a repository candidate on expectation or reserved-evidence failure; promote its digest and claim only after those guards pass and before raw context is persisted. The repository artifact is capability input, not criterion-mapped submission evidence. |
| `src/server/diff.ts` | Diff capture includes committed, staged, unstaged, and bounded untracked content for prompt context. | Reuse its source-base semantics, but do not reuse its prompt-oriented byte and untracked-file ceilings as the repository service. |
| `src/server/git/ensemble-snapshot.ts` | A temporary index can capture the whole worktree into one immutable commit. | Reuse the isolation pattern, but preserve separate HEAD, index, and worktree layers rather than collapsing staged and unstaged content. |
| `src/server/workflows/engine.ts` | A Persona makes one structured `LlmRunner.run` call, preserving images, submission evidence, the LLM call ledger, and verdict normalization. Infrastructure failures already retry and ultimately block. | Keep the access-off arm behaviorally identical. Dispatch one versioned review workload only for `read`, preserve all current context/evidence inputs and call accounting, validate its terminal verdict, and route workload or repository failures through the existing retry state machine. |
| `src/server/llm/` | Headless runners support structured fresh calls but do not accept launch-scoped MCP configuration. Workflow calls grant no tools; only Claude Inspector has direct read tools. | Do not widen the general headless runner with filesystem access. Add a Persona workload runner that launches each provider with only the repository MCP server and a structured final-result contract. |
| `src/server/harness/claude/`, `src/server/harness/codex/`, and `src/server/mission-mcp.ts` | Full Claude and Codex sessions already carry launch-scoped stdio MCP descriptors through provider-specific adapters. | Reuse the measured MCP configuration patterns behind a smaller workload-specific abstraction; do not couple Workflow execution to interactive session ownership. |
| `src/server/inspector/` | Inspector already has deny globs and content scrubbing, but only Claude can enforce its direct tool grant. | Extract the reusable content policy while leaving Inspector behavior unchanged. Apply it inside the repository MCP server for both providers. |
| `src/shared/workflow.ts`, `src/shared/protocol.ts` | Evidence currently has eight append-only kinds: `diff`, `transcript`, `standard`, `goal`, `decision`, `check`, `image`, and `artifact`, with a uniform quote/path/line shape. | Append `repository` without renaming or reordering existing kinds, and refactor the shared schemas to a discriminated union so repository handles cannot carry quotes while all eight existing kinds preserve their exact wire shape. |
| `src/web/workflows/PersonaEditor.tsx` and Persona import/sync paths | All built-in fields are read-only. Imported and plugin-managed Personas now carry provenance and can be reimported or synchronized. | Keep general built-in fields locked while exposing only the local repository-access override. New imports default to `none`; reimport and plugin synchronization preserve the operator's existing access value. |
| Workflow tests and `e2e/` | Unit, integration, runner-contract, migration, and built-browser coverage exist. E2E providers are faked. | Extend each layer and cover both providers without spending model tokens or adding `data-testid`. |

### Discrepancies resolved by this plan

1. The existing check lease is a clean detached checkout at one commit. It cannot represent the submitted dirty worktree and is not the repository-read authority for this feature.
2. The current prompt diff is useful context but intentionally truncates large changes. It cannot be treated as repository-wide access.
3. A provider conversation thread is not available from the current shared headless runner contract, but both full session adapters already support launch-scoped MCP. This plan introduces one isolated Persona workload session rather than building a repeated fresh-call transcript loop.
4. Publication idempotency currently keys only on workflow draft revision. Snapshot-aware publication identity is required to make a later Persona access edit effective without forcing an unrelated draft edit.
5. Built-in workflow versions are app-owned immutable artifacts. A local built-in Persona override applies to future operator-published versions that resolve that Persona, not retroactively to shipped built-in workflow versions.
6. Current Mission Control browser updates use a reconnecting SSE projection, not a durable remote workload protocol. The workload event contract therefore needs its own ids, sequence numbers, replay cursor, and idempotency rather than treating a WebSocket as state.
7. A submission is now captured once per resolved repository run. The artifact must bind to `workflowCheckoutPath` for that run, not a session-wide primary repository or a stale `session.cwd` assumption.
8. External artifact expectations are validated after stable context capture but before durable context persistence. Artifact preparation may participate in stable capture, but durable promotion and the submission claim must wait until the expectation and reserved-evidence guards pass.
9. Reserved image/text evidence and evidence-readiness policy are independent submission contracts. A repository snapshot enables Persona queries and must not satisfy, replace, reorder, or weaken criterion-mapped evidence collection.
10. Repository evidence cannot be added by extending the current uniform `EvidenceRef` object with optional fields. It requires a discriminated union that preserves the exact shape and append-only identity of all existing evidence kinds.

## Target request and data flow

At submission capture, the daemon seals a portable content-addressed artifact containing captured HEAD, staged index state, working-tree state including nonignored untracked files, and a classification manifest. During each enabled Persona attempt, the engine dispatches one isolated workload. Inside that workload, the provider calls a local stdio MCP repository server repeatedly and then returns one structured verdict. Repository results stay local; the workload supervisor emits ordered lifecycle and safe audit events to Mission Control.

<!-- diagram:review-flow -->

The load-bearing flow is:

1. The daemon resolves the checkout for the specific per-repository Workflow run. Inside the existing stable-capture checks, the snapshot owner prepares a private immutable candidate and computes its canonical digest without creating a durable submission claim.
2. The manager validates the current external-artifact expectation and captures the already-reserved image/text evidence. Any failure discards the candidate. Once those guards pass, the owner atomically promotes or verifies the digest-level artifact and registers the submission claim before persisting raw context or activating the run.
3. The Workflow engine creates a versioned workload request naming the attempt, frozen Persona, snapshot digest and locator, repository policy, deadline, and idempotency key.
4. The local reference executor initially, or a future remote adapter later, materializes the artifact into an isolated workload and verifies its digest.
5. The selected provider starts once with all built-in filesystem, shell, write, and network tools disabled and only the local repository MCP server registered.
6. The provider calls MCP read/search/glob/Git tools repeatedly. The MCP server validates and audits each operation and reads only the materialized immutable snapshot.
7. The workload supervisor emits ordered events and one terminal verdict through the executor contract. Mission Control persists them, rejects duplicates, and applies a verdict only while the Workflow attempt remains current.
8. Snapshot, workload, provider, or MCP infrastructure failure follows the existing retry and blocked-run path. A denied query remains a normal auditable result the Persona may recover from.

## Persisted Persona and built-in override model

Use one closed shared enum with two values:

- `none`: the current behavior and the default for all existing and new Personas.
- `read`: enables the complete read-only repository MCP server.

For operator-created Personas, add `repository_access TEXT NOT NULL DEFAULT 'none'` to `personas`. Continue to use the Persona revision for optimistic concurrency and snapshot freshness.

For built-ins, add a narrow `persona_builtin_overrides` table keyed by built-in Persona id with only `repository_access`, its own monotonic revision, and timestamps. The table is local operator configuration and must not duplicate guidance, runner, model, or built-in definitions. Resolved Persona reads overlay this value onto the app-owned built-in record. An absent row resolves to `none`.

Expose a dedicated repository-access mutation schema and route for both custom and built-in Personas. For custom Personas, the store updates the `personas` row under the existing revision contract. For built-ins, the same store operation validates the built-in id and updates only the override row. Existing general built-in edit routes continue to reject guidance, runner, and model changes.

`PersonaSnapshot` gains `repositoryAccess`. `personaSnapshotOf` remains the only publication projection. `PersonaSnapshotSchema` defaults a missing persisted value to `none`, so old workflow graphs and attempt snapshots continue to parse. Snapshot freshness compares repository access for both custom and built-in Personas.

## Publication and compatibility contract

Publishing must identify the exact resolved graph rather than only the draft revision:

1. Resolve the current Persona catalog, including local built-in overrides.
2. Build the full publishable graph using `personaSnapshotOf`.
3. Produce a deterministic hash of its canonical JSON.
4. Reuse an existing version only when workflow id, source draft revision, and graph hash all match.
5. Otherwise insert a new immutable version even if only a resolved Persona snapshot changed.

Add a `source_snapshot_fingerprint` column to `workflow_versions`, backfill every existing row from its stored canonical `graph_json`, and replace the current two-column uniqueness with a three-column unique index. The migration must be additive and idempotent. Old graphs continue to resolve missing `repositoryAccess` as `none`, and their backfilled hash is stable after normalization.

Existing Personas, workflow snapshots, workflow versions, attempts, runs, and built-in workflows retain prompt-only behavior. Shipped built-in workflow versions are not mutated by local overrides. The Version History surface marks a version out of date when the current resolved Persona access differs. To use an override with a shipped built-in workflow, the operator duplicates or otherwise publishes an operator-owned workflow version; the UI must state this boundary.

## Portable exact-state repository artifact

Create a Workflow repository-snapshot owner in `src/server/workflows/` backed by immutable Git objects, a canonical manifest, a portable artifact, and daemon-owned database metadata. A future executor must not need the original worktree path or Git common directory. Artifact bytes are owned by a durable digest-level record; each submission holds its own durable claim on that record. The claimed artifact is the only repository input a Persona workload may receive.

### Captured layers and manifest

The snapshot artifact stores:

- source base commit used by Workflow diff semantics;
- captured `HEAD`, with an explicit unborn-repository representation;
- an immutable tree and named artifact ref for the submitted index state;
- an immutable tree and named artifact ref for the submitted working-tree state, including nonignored untracked files;
- the history objects required by `RepositoryHistoryPolicyV1`, rooted at captured `HEAD`, plus an explicit ordered retained-revision set and boundary metadata;
- a canonical manifest that classifies each path as committed, staged, unstaged, untracked, deleted, symlink, submodule, binary, or sensitive-denied where applicable;
- repository identity, artifact format version, policy version, content digest, capture fingerprint, byte counts, artifact state, per-submission claim state, cleanup state, and timestamps.

<!-- diagram:snapshot-layers -->

Use a private temporary index, modeled on the ensemble snapshot implementation, so capture never mutates the operator's real index. Candidate preparation happens inside `captureStableWorkflowContext`: sample the boundary, build candidate objects and manifest, resample status and identity, and return an unclaimed candidate only when both samples agree. `captureAndActivate` owns the later commit point. It discards the candidate if external-artifact validation or reserved evidence capture fails, otherwise atomically promotes or reuses the digest-level artifact record and inserts the submission claim before raw context persistence. Clean abandoned candidates and temporary indexes on every mismatch or failed guard.

Package the required objects and canonical manifest into a content-addressed artifact whose digest covers every byte and semantic ref. The digest-level record owns the daemon-controlled locator and bytes; a per-submission claim references that digest. Concurrent captures of identical state converge on one verified record while retaining independent claims. The workload request exposes an opaque artifact locator plus digest, never a live checkout path. A later remote publisher can replace the locator with a scoped artifact reference without changing Workflow or Persona contracts.

Sensitive paths remain represented in the manifest as denied entries, but their blob contents are omitted from the portable workload artifact. This prevents a compromised provider process from bypassing the MCP policy by inspecting artifact files directly. The MCP server independently enforces the same policy, so omission and query denial are defense-in-depth layers rather than competing sources of truth.

Each submission owns a durable claim, not the shared artifact bytes, and every retry for that submission reuses its claimed digest. Retention or submission deletion atomically marks that claim released and enqueues digest cleanup only when no active submission claim remains. The retryable daemon-owned reconciler rechecks the zero-claim invariant in the deletion transaction before removing bytes and the digest record. Startup reconciliation repairs database/filesystem non-atomicity, restores or retires claims conservatively, and deletes only zero-claim artifacts in the dedicated Workflow namespace whose digest ownership is proven.

If the artifact, digest, manifest, or materialized snapshot is unavailable or mismatched, repository-enabled Persona attempts are infrastructure failures. Attempts never reconstruct from the current live checkout and never receive the bounded prompt as a substitute for the missing repository view.

## Local repository MCP server

Implement a small stdio MCP server that runs inside each Persona workload. It is not an agent, remote query service, or Mission Control transport. It advertises only the approved repository tools, reads only the materialized snapshot named by an attempt-scoped launch descriptor, and reports safe audit metadata to its local workload supervisor.

Define browser-safe tool input, output, cursor, policy, and audit metadata schemas in `src/shared/review.ts` or a focused shared Workflow review module. Reuse those schemas in the MCP server, workload event protocol, daemon ingestion, tests, and UI projections. The supported operation set is closed and exhaustive:

| Operation | Required semantics |
| --- | --- |
| `read` | Return a bounded line or byte window from a repository-relative regular file, with a continuation cursor. |
| `search` | Search literal text with explicit case behavior and optional validated path/glob scope, with match context and a cursor. Regular expressions are excluded initially to keep cost and denial behavior predictable. |
| `glob` | Enumerate matching manifest paths with a cursor and type metadata. |
| `git_status` | Return the captured path classifications, not the current checkout status. |
| `git_diff` | Diff explicit captured layers: base to HEAD, HEAD to index, index to worktree, or base to worktree, optionally scoped to approved paths. |
| `git_show` | Read metadata for captured HEAD or a retained revision. Patch mode compares a true root with the empty tree, compares a non-root commit only when its recorded first parent is retained, and otherwise returns `history_boundary` with no patch. Reject every other revision as `revision_out_of_range`. |
| `git_log` | Traverse only the manifest's ordered retained-revision set, anchored at captured HEAD, with bounded count, cursor, optional approved path, and an explicit history-boundary marker. |
| `git_blame` | Attribute a bounded line range for an approved regular file using only retained revisions, marking boundary attribution and truncation instead of consulting missing or host objects. |

Every MCP response includes a stable operation id, status, structured result metadata, byte and item counts, `truncated`, an explicit `nextCursor` when more data is available, and a typed error or denial code. Each successful content-bearing result item also carries an opaque `evidenceHandleId`. The MCP emits matching safe handle metadata containing the snapshot/workload/operation identity, item ordinal, canonical approved path and exact line or diff range, policy version, and truncation state, but no excerpt or response body. Pagination cursors are opaque, integrity-checked tokens bound to snapshot digest, operation shape, and prior position so a provider cannot turn one cursor into a different request.

The MCP process receives no Mission Control credential and no arbitrary network capability. Repository results stay between the provider and local MCP process. The MCP sends only bounded audit metadata to the workload supervisor over local IPC. The supervisor owns any authenticated connection or callback to Mission Control.

## Persona workload request and event protocol

Add a provider-neutral `PersonaWorkloadExecutor` boundary above provider launches. The initial `LocalPersonaWorkloadExecutor` runs on the Mission Control host but consumes the same portable request and produces the same events a future scheduling-middleware adapter will use.

The versioned workload request includes:

- workload id, Workflow attempt id, idempotency key, and protocol version;
- frozen Persona snapshot, runner, model, prompt inputs, and immutable image references;
- repository snapshot artifact locator, digest, and format version;
- repository policy version, allowed operation ids, and layered budgets;
- deadline and cancellation generation;
- an attempt-scoped event sink descriptor that the local adapter may satisfy in-process and a remote adapter may satisfy through authenticated middleware.

The ordered workload event union includes accepted, sandbox ready, repository verified, Persona started, repository query and evidence-handle metadata, progress, question or approval requests where later workflows allow them, terminal verdict, failure, and cancellation. Every event carries workload id, attempt id, monotonic sequence, event id, timestamp, and safe payload. Ingestion is idempotent by workload and sequence, detects gaps, and can resume from a persisted cursor.

A WebSocket, HTTP stream, polling API, or other future connection is only a transport for this event protocol. Mission Control persists an event before projecting it to the dashboard or original session. The workload never writes the Mission Control database and never connects directly to a session terminal. Human questions and answers, if enabled later, use durable addressed events and idempotent commands mediated by Mission Control.

## Multiple queries in one Persona session

The workload starts the selected provider once with the normal Persona prompt, images, structured final-verdict schema, and exactly one registered MCP server. All built-in filesystem, shell, write, and network tools remain disabled. The provider calls the local MCP repeatedly during that one session and returns one final verdict.

Provider-specific adapters may render MCP configuration differently, but both must consume one shared launch descriptor and expose the same tool inventory. The general `LlmRunner` remains unchanged for tool-less call sites. The implementation must prove through contract tests that both Claude and Codex can complete multiple MCP calls and schema-validated final output without any direct repository grant. If either provider cannot meet this contract, the phase stops for design review; it must not fall back to a provider-specific tool or the previous prompt-only path.

The local reference executor gives current Workflows this behavior without waiting for a remote scheduler. A later remote executor changes only artifact publication, workload dispatch, event transport, and cancellation transport. It does not change Persona snapshots, MCP tools, repository security policy, evidence references, or Workflow retry semantics.

## Security boundary

The repository MCP server reads the materialized artifact through its canonical manifest and validated object ids. It never resolves a provider-supplied path against the sandbox host filesystem, the original checkout, or a Mission Control host path.

### Path validation

- Accept only normalized repository-relative POSIX paths.
- Reject empty ambiguous paths where an operation requires a file, absolute paths, drive prefixes, NUL bytes, backslashes, overlong segments, `.` and `..` traversal, and normalization changes that alter identity.
- Match pathspecs literally after validation. Never interpolate provider input into a shell string.
- Treat path matching and sensitive segments case-insensitively where the checkout filesystem could do so.
- Never expose `.git` or any nested Git administrative path.
- Never follow symlinks. A symlink result may expose only its repository-stored target text and metadata after policy checks; it may not resolve that target.
- Never traverse submodules. Return only the gitlink identity and approved metadata.
- Restrict history operations to captured HEAD and the exact retained-revision set committed into the verified manifest. Never accept an arbitrary ref, revision expression, option-like argument, merely reachable object id, source-base anchor outside that set, or revision beyond the retained boundary.

### Sensitive-path policy

Move the current Inspector deny rules and secret scrubbing primitives into a shared repository content policy that both Inspector and the artifact builder/MCP server consume. Preserve current denials for `.env*`, credentials, private-key and certificate formats, `.npmrc`, `.netrc`, Git config and internals, host SSH/AWS/Claude/Mission Control state, and known secret-bearing names. Extend the policy across artifact packaging, file reads, search, glob, status, diff, show, log, and blame so filenames, history, or patch bodies cannot bypass a content denial.

Return structured denial metadata and safe aggregate counts, never file contents or secret-bearing snippets. Apply the existing content scrubber as defense in depth to allowed text before it enters a provider prompt or audit summary. Audit records must not store response bodies.

### Bounds and cancellation

Use layered budgets rather than a single prompt character limit:

- per-operation byte, line, match, file, history-count, and elapsed-time ceilings;
- explicit pagination for every collection or large file response;
- a generous attempt budget across operation count, cumulative served bytes, and wall-clock duration;
- bounded MCP requests and responses so one tool call cannot monopolize the workload;
- binary detection and a small metadata-only response unless the operation explicitly supports a safe bounded binary preview, which is out of scope initially.

Initial constants should be centralized and testable. The implementation phase should validate practical defaults against large repository fixtures, targeting approximately 128 operations, 32 MiB cumulatively served, a 1 MiB maximum MCP response, and 15 minutes per Persona attempt. These are reliability defaults, not a promise that all cumulative data remains in the provider context. Every truncation must say what was omitted and how to continue.

History retention uses the shared, versioned `RepositoryHistoryPolicyV1`, separate from per-query pagination:

1. Captured `HEAD` is the sole traversal root; an unborn repository has an empty retained set.
2. Walk the all-parent ancestry breadth-first. Queue parents in the order stored by each commit, producing a deterministic prefix without relying on commit timestamps.
3. Retain at most 2,048 commits including `HEAD` and at most 512 MiB of unique allowed historical blob bodies not already required by the exact base, HEAD, index, or worktree layers. Before accepting each next commit, calculate its incremental allowed blobs; if either ceiling would be exceeded, stop the traversal rather than skipping that commit and creating holes.
4. Include every commit and tree object plus every nonsensitive blob needed by the retained prefix. Omit sensitive blob bodies. Record the ordered retained ids, retained counts/bytes, frontier commits, omitted parent ids, and policy version in the digested manifest.
5. Treat captured source base outside the retained set as a diff-layer anchor only. Its presence in the artifact does not make it valid for `git_show`, `git_log`, or `git_blame`.

The oldest retained frontier is a shallow history boundary. `git_log` stops there, and `git_blame` returns boundary attribution with `historyTruncated: true`. `git_show` metadata remains available for every retained frontier commit. Patch mode has exactly three cases: a true root compares with the empty tree; a non-root whose recorded first parent is retained compares against that parent, even if another parent is omitted; and a non-root whose recorded first parent is omitted returns typed `history_boundary` with no patch. It never treats a non-root boundary commit as a root. Any requested revision outside the retained set returns the auditable `revision_out_of_range` denial. If capture cannot package every required allowed object for the selected set, sealing fails as infrastructure unavailable; it never silently shrinks the range or leaves an in-range query with a missing allowed blob.

Propagate cancellation from the Workflow attempt through `PersonaWorkloadExecutor`, provider process, MCP process, Git child processes, blob reads, search iterators, and event persistence. Commands carry a cancellation generation and idempotency key so reconnect or duplication cannot revive older work. Cancellation terminates local processes, records cancelled events, and makes any later terminal verdict audit-only.

## Audit and observability

Add an append-only `workflow_repository_query_events` ledger keyed by attempt id and MCP operation sequence, plus bounded evidence-handle metadata keyed by opaque handle id. Each query record includes workload id, workload event sequence, snapshot digest, normalized operation kind, safe path or query hash metadata, start/end time, duration, outcome, denial/error code, item and byte counts, truncation, cursor presence, and cancellation state. Each handle record binds one actually returned item to its successful operation, canonical approved path/range, item ordinal, policy version, and truncation state. Do not store repository response bodies, excerpts, quote fields, sensitive query text, or provider secrets.

Add durable workload dispatch and event state sufficient to make local and future remote execution share one lifecycle: request idempotency key, accepted executor identity, highest contiguous event sequence, terminal outcome, cancellation generation, and transport diagnostics. A duplicate event is ignored after equality validation; a conflicting duplicate or sequence gap is an infrastructure fault rather than guessed ordering.

Extend existing Workflow run detail data and UI with a repository-query audit summary. Operators can inspect what operation ran, whether it was allowed, denied, truncated, failed, or cancelled, and how much data it returned. The view must not reproduce file bodies. Add structured server logs and status counts for capture latency/failure, query latency/outcome, retries caused by repository access, active snapshot count, and cleanup backlog.

Append a metadata-only `repository` kind to the existing stable evidence-kind vocabulary. Refactor `EvidenceRef`, `WorkflowEvidenceRefSchema`, `EvidenceInputSchema`, verdict normalization, audit helpers, and renderers to one discriminated union. The existing eight kinds retain their current identifiers and quote/path/line wire shapes. The new repository branch contains only an operation id and `evidenceHandleId`, with no quote, excerpt, or provider-supplied path/range field. The engine resolves the handle against persisted safe metadata and accepts it only when it was minted for a successfully returned item from the same snapshot, workload, and node attempt; the UI may display the stored approved path/range metadata. A truncated item remains bound to only the exact returned range. A fabricated, duplicate-conflicting, denied, failed, cancelled, or unrelated handle is invalid. Repository artifacts do not count toward criterion-mapped submission evidence readiness. Existing prompt-only evidence remains valid for Personas with `none` access and for old runs. Ordinary reviewer prose remains part of the existing bounded/scrubbed final verdict, but it is not treated as a verified repository excerpt.

## Failure and retry behavior

Classify failures consistently:

- Sensitive-path denial, invalid query, exhausted page, unsupported operation, `revision_out_of_range`, or `history_boundary` is an auditable MCP response. The Persona may issue a corrected query within the same attempt.
- Missing or mismatched artifact, failed materialization, unreadable repository view, MCP process failure, workload launch failure, event-sequence gap, audit-write failure, provider failure, malformed final output, lost executor without resumable ownership, or exceeded attempt budget is an infrastructure failure.
- Cancellation is terminal for the active work and records cancellation without scheduling a retry that contradicts the requested stop.

Infrastructure failures use the current attempt lifecycle, including `retry_wait`, the existing maximum infrastructure-attempt count, restart recovery, and final blocked `infrastructure_error` state. Each retry dispatches a new workload against the same artifact digest claimed by the submission and the same frozen Persona snapshot. Restart recovery first reconciles a persisted workload with its executor and event cursor; it never starts a duplicate workload speculatively. There is no path from a repository-enabled snapshot to prompt-only execution.

## Persona Editor and workflow UX

The Persona Editor adds a clearly labeled repository-access control with `No repository access` and `Read-only repository access`. For built-ins, this control remains editable while guidance, runner, and model remain locked. Saving shows whether the value is stored on the Persona or as a local built-in override and uses the appropriate revision for conflict handling.

The editor disclosure must state:

- the Persona can query all non-sensitive files from the submitted repository state, including committed, staged, unstaged, and nonignored untracked content;
- the Persona receives no shell, write, agent-visible network, host-file, `.git` internals, or direct provider-tool access;
- known secret-bearing paths are denied and allowed text is scrubbed as defense in depth;
- the setting is frozen only when a workflow version is published;
- a built-in override does not mutate already shipped built-in workflow versions, so an operator-owned version must be published to use it.

Version History displays the frozen access mode and uses it in out-of-date detection. Run detail displays whether repository access was enabled and links to the audit summary. Any visible control, copy, publication behavior, and audit state receives browser-level Playwright coverage against the built application.

## Migration and backward compatibility

Migrations are additive, idempotent, and located beside the existing upgrade path:

1. Add `personas.repository_access` with `none` default.
2. Create `persona_builtin_overrides` with foreign identity validation against the in-memory built-in catalog at write time.
3. Add and backfill `workflow_versions.source_snapshot_fingerprint`, then replace the old uniqueness index.
4. Create digest-level repository artifact, per-submission artifact claim, zero-claim cleanup, workload dispatch/event cursor, and query audit tables and indexes.
5. Extend JSON schemas with read-time defaults so historical graph and attempt JSON does not require destructive rewriting.

Migration tests open representative pre-feature databases, including custom Personas, built-in workflow history, published custom workflows, runs, attempts, and LLM call audit rows. They prove that all old records parse as `none`, repeated migration is safe, old versions keep identity, identical republish is idempotent, and a changed resolved Persona snapshot creates a new immutable workflow version.

## Test strategy

### Unit and security tests

- Schema defaults, exhaustive MCP tool and workload-event unions, cursor integrity, artifact digest validation, budget accounting, event idempotency, metadata-only evidence-handle validation, and access freshness.
- Path normalization, traversal, option injection, Unicode and case behavior, symlink and submodule handling, retained-revision validation, history frontier behavior, binary handling, and every sensitive-path family.
- Layered Git fixtures that distinguish committed, staged, unstaged, deleted, renamed, untracked, ignored, symlink, submodule, and unborn-repository states.
- Per-operation pagination and truncation without silent omissions.
- Deterministic history selection at both ceilings, all-parent merge traversal, out-of-range revision denial, the three exhaustive `git_show` patch cases at the frontier, boundary log/blame semantics, and failure rather than silent range shrinkage when an in-range allowed object cannot be packaged.
- Evidence handles are minted only for actually returned allowed items; forged, cross-attempt, mismatched-range, denied, failed, cancelled, and conflicting duplicate handles fail without persisting or reconstructing a quote.

### Persistence, migration, and integration tests

- Custom access updates and CAS conflicts; built-in override creation, update, removal, and immutable-field rejection.
- New imports default to `none`, while reimport and plugin synchronization preserve an existing operator-selected access value and provenance.
- Snapshot capture, portable reconstruction, and rollback under checkout mutation, Git failure, database failure, digest mismatch, restart reconciliation, retention, and cleanup retries.
- Per-repository run capture resolves the same checkout as `workflowCheckoutPath`; an external-artifact mismatch or reserved-evidence failure leaves no active repository claim or durable raw context.
- Two submissions claiming the same digest, release of either claim while the other remains active, final-claim cleanup, concurrent claim/release, and crash recovery without premature byte deletion or leaked claims.
- Publication hash backfill, identical republish, same-draft Persona access republish, historical parsing, and built-in version immutability.
- Local reference workloads that make several MCP calls in one provider session, read several pages, recover from denial, cite returned evidence, and complete once.
- Artifact, executor, MCP, and provider unavailability; cancellation; duplicate and gapped events; restart recovery; retry exhaustion; and proof that prompt-only fallback never occurs.
- Audit ordering, redaction, cardinality, and read APIs without response-body persistence.
- Criterion-mapped evidence readiness remains unchanged when repository access is enabled, and repository capability artifacts cannot satisfy reserved evidence.

### Runner-contract parity

- The same fake repository MCP server drives Claude and Codex through the same sequence of tool calls and final verdict in one session.
- Both providers receive the same workload launch descriptor, preserve required images and structured final output, and receive no direct filesystem, shell, write, or network tools.
- Provider adapters expose only the expected MCP server, propagate timeout/cancellation, and reject malformed final output identically.
- The local executor and a fake remote executor produce an identical ordered event contract, including reconnect replay and duplicate delivery.

### Browser E2E

Add a focused spec under `e2e/specs/` using the existing fake Claude and Codex agents. It must cover:

- enabling custom Persona access and a built-in local override with accurate disclosure;
- publishing and observing the frozen access mode and out-of-date behavior;
- an exact dirty checkout that requires committed, staged, unstaged, and untracked queries to complete;
- multiple repository queries in one Persona attempt for both providers;
- a sensitive-path denial and a pageable/truncated result visible in the audit summary;
- artifact, workload, or MCP unavailability leading to retry/blocked UI rather than a prompt-only verdict;
- reload persistence and historical old-run rendering.

Use roles, labels, and visible copy only. Do not add `data-testid`, do not contact real providers, and run against the built dashboard and daemon.

## Documentation and operational readiness

Update the existing Workflow and security documentation in the same implementation phases that introduce behavior:

- `docs/workflows.md`: Persona configuration, publication freezing, built-in override behavior, retry semantics, and operator workflow.
- `docs/workflow-system.md`: portable workload request, local MCP query flow, digest artifact and submission-claim ownership, event ingestion, audit flow, and state transitions.
- `docs/security.md`: artifact and workload trust boundaries, denied paths, symlink/submodule rules, scrubber reuse, and explicit non-capabilities.
- `docs/troubleshooting.md`: artifact, workload, MCP, and event-stream failure signals, cleanup backlog, retry exhaustion, and safe diagnosis.
- `docs/database-and-migrations.md` and `docs/agent-guides/architecture.md`: new durable owners and publication fingerprint where their current contracts require updates.

Operational validation includes large-change fixtures, capture/materialization/query latency logs, event lag and gap diagnostics, cleanup reconciliation after forced daemon or workload termination, and confirmation that audit records reveal failure reasons without leaking repository bodies.

## Ownership boundaries

| Owner | Owns | Must not own |
| --- | --- | --- |
| Shared Workflow contracts | Closed access modes, snapshot fields, workload/MCP/event schemas, evidence references | Node or Git execution |
| Workflow store and DB | Persona settings, built-in overrides, publication fingerprint, artifact/workload/audit ledgers | Provider-specific request shaping |
| Repository snapshot service | Exact layer capture, portable artifact, digest, manifest, cleanup reconciliation | Workflow retry policy or UI state |
| Repository MCP server | Validation, path policy, Git/read operations, bounds, cursors, local query audit emission | Shell access, checkout writes, network, provider tools, Mission Control credentials |
| Persona workload supervisor | Artifact verification/materialization, provider and MCP lifecycle, ordered events, cancellation | Workflow state transitions or database writes |
| Persona workload executor | Versioned dispatch, executor reconciliation, event delivery, future remote transport seam | Repository query semantics or Persona policy |
| Workflow engine | Dispatch authority, event ingestion, retry classification, terminal verdict validation | Direct filesystem resolution, provider-specific access, or remote transport details |
| Provider workload adapters | One-session Claude and Codex launches with one MCP descriptor and final schema | Capability policy or separate MCP semantics |
| Persona Editor and run detail | Configuration disclosure, snapshot visibility, audit summaries | Security enforcement |

The daemon remains the sole SQLite writer. Provider processes receive repository access only through local MCP. Workload supervisors and future remote workers receive no database handle or original-worktree authority.

## Acceptance criteria

The feature is complete only when all of the following are true:

- An operator can configure `none` or `read` independently on custom and built-in Personas, with only the local access override mutable on built-ins.
- Publication freezes access in the exact Persona snapshot and can publish a new version after a Persona-only access change while preserving identical-publish idempotency.
- Historical data reads as `none` without destructive rewrites or changed run outcomes.
- The submission produces a content-addressed portable artifact that reconstructs committed, staged, unstaged, and applicable untracked state without the original worktree.
- Identical artifacts may share digest-level bytes, but each submission has a durable claim; releasing one submission cannot delete bytes until the last active claim is released and cleanup rechecks that invariant atomically.
- One review attempt starts one provider session that can execute multiple typed, pageable local MCP queries and then return one validated verdict.
- Claude and Codex use the same MCP tool contract and security path with no direct filesystem, shell, write, or agent-visible network tools.
- The local reference executor consumes a versioned portable workload request and produces ordered idempotent events suitable for a later remote adapter.
- Repository query result bodies and evidence excerpts remain inside the workload; Mission Control persists only safe query/evidence-handle metadata, lifecycle events, and the ordinary bounded final verdict.
- Protected paths, traversal, symlink following, submodule traversal, history beyond the manifest-retained range, shell, writes, network, and host files are impossible through the exposed contract.
- Every query outcome, denial, truncation, cancellation, and failure is auditable without storing repository response bodies.
- Artifact, workload, provider, or MCP unavailability retries and eventually blocks with infrastructure error, never silently degrading to prompt-only review.
- Unit, integration, runner-contract, migration, and built-browser E2E suites cover the behavior and both providers.
- Documentation explains capability, limitations, security, publication freezing, operations, and failure recovery.

## Scope exclusions

- Arbitrary shell commands or Git commands supplied by a model.
- File writes, checkout mutation, commit creation on the operator branch, or agent-visible network access.
- Direct unrestricted Claude or Codex repository tools.
- Runtime changes to an already published Workflow version or an in-progress run.
- Retroactive mutation of shipped built-in workflow versions.
- Cross-repository review within one Workflow run.
- Binary preview beyond safe metadata in the initial implementation.
- Selection or integration of a remote sandbox, workload scheduling middleware, artifact store, WebSocket service, or cloud provider.
- Direct broker or worker access to an original session terminal; Mission Control mediates all durable consequences.
- Upload of repository artifacts outside the local executor until source-code handling, retention, encryption, workload identity, and remote API contracts are separately approved.

## Verify-claims ledger

### Verified current claims

- Workflow Personas currently make one tool-less headless structured call, while full Claude and Codex session adapters already accept launch-scoped stdio MCP descriptors.
- The current stable capture reads a bounded diff and status from the bound live checkout; the existing detached check worktree contains one commit and cannot preserve submitted staged, unstaged, and untracked distinctions.
- Mission Control already treats a late Persona result after run cancellation as audit-only and already owns the Workflow retry state machine.
- The browser's current reconnecting SSE projection is not a durable remote workload event protocol.
- As of `3459720f`, submission capture resolves a checkout per repository run, validates external artifact expectations before raw-context persistence, captures reserved image/text evidence, compacts context, and applies evidence-readiness policy before activation.
- As of `3459720f`, evidence kinds are an append-only eight-value vocabulary and current schemas use a shared quote/path/line shape. A metadata-only repository handle therefore requires a discriminated-union migration that preserves every existing branch.
- As of `3459720f`, imported and plugin-managed Personas carry provenance and support reimport/synchronization, so repository access must be treated as operator-owned state and preserved by those flows.

### Pending technical proof

- **Load-bearing, about 75% confidence:** both installed provider paths can complete multiple calls to one workload-scoped stdio MCP server and then produce the existing schema-validated verdict while every built-in repository, shell, write, and network tool remains disabled.
  - Impact if wrong: the one-session MCP execution mechanism is not viable for both providers.
  - Confirm by: mandatory provider contract prototypes and fake-agent coverage at the start of the foundation implementation phase.
  - Gate: do not begin Persona/Workflow integration or introduce a provider-specific fallback until both providers pass. A failure returns the design to operator review.
- **Not load-bearing for this feature, about 60% confidence:** a future middleware can accept the portable artifact reference, run the same workload contract, and carry ordered events and idempotent commands.
  - Impact if wrong: the later adapter needs a polling or gateway layer, but the local executor and Workflow feature remain valid.
  - Confirm by: the future scheduler API contract. No remote adapter is implemented here.
- **Not load-bearing for this feature, about 60% confidence:** repository artifact upload will be permitted by source-code handling and retention policy.
  - Impact if wrong: future execution must use an approved pull-through service, private deployment, or local executor.
  - Confirm by: security and data-governance review before any remote artifact publication.

Verify-claims verdict: the local remote-shaped plan may proceed with the provider MCP proof as a blocking foundation exit gate. Remote transport implementation remains out of scope and blocked on its platform and governance contracts.

## Planning handoff

The operator approved this local-MCP, remote-shaped workload design and asked for phased implementation scheduling. The accompanying phased plan uses three serial merge units: the workload/MCP foundation, the portable exact-state artifact, and the end-to-end Persona and Workflow integration. The actual remote scheduling adapter remains future work. No feature implementation belongs in this planning pull request.
