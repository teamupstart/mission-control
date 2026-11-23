# Phase 1: Retained Command output and execution policies

## Outcome
Every workflow Command has retrievable bounded output beyond its short tail, and operators can configure its timeout and whether unavailable execution or exhausted allowance skips or blocks. Existing commands behave as before until an operator changes policy.

Repository: mission-control only. Direct prerequisites: the planning PR has merged. No implementation-phase prerequisite. Read plan.md and phased-plan.md first. This file is a proposed implementation route, not an immutable file-level specification; adapt to the merged repository and document deviations.

## Scope and non-goals
Own R2 and R3 and the generic portions of R8/R9. Include storage, runtime capture, authenticated reads, repair references, Library controls, run detail and tests in this phase. No CodeRabbit id, parser, provider configuration, Setup integration or No-Mistakes version yet. Do not introduce a generalized plugin system.

## Findings to preserve
- `WorkflowCommandView` in src/shared/workflow.ts and `UpdateWorkflowCommandSchema` in src/shared/protocol.ts describe one complete slot CAS; src/server/workflows/commands.ts publishes only after commit.
- src/server/db.ts holds fresh workflow_commands tables and addColumn migration paths. WorkflowStore seeds defaults, validates rows and preserves legacy overrides.
- CheckExecutionRequest/Result in checks.ts form the runtime seam; check-runtime.ts owns lease acquisition/settlement; check-spawn.ts owns the single supervised process path and the shared stdout/stderr tail.
- engine.ts translates failures into bounded synthetic verdicts; feedback.ts constructs session repair packets. Keep the 4,000-byte outcome tail and 2,000-byte quote.
- images.ts contains retained evidence storage/reference/pruning patterns, but submission-captured text evidence must not be mutated after capture to attach later command output.
- CommandLibrary.tsx uses the SSE catalog, not a parallel fetch. WorkflowRuns.tsx displays outcomes. src/mcp/server.ts forwards attributed workflow reads through /mcp/workflows/read.
- New MCP tools need schemas in both protocol.ts and mcp/server.ts, allowlisting in src/server/mission-mcp.ts, built bundle refresh and smoke verification.

## Implementation sequence

### 1. Freeze shared contracts and behavior fixtures
Read the actual store row schemas, command routes, test fixtures and evidence cleanup owner. Add focused contract cases before changing behavior:
- old catalog rows project timeoutMs null, onUnavailable skip, onBudgetExhausted skip;
- complete CAS rejects omitted new policy fields instead of resetting saved values;
- legacy workflows/config writes preserve fields that route cannot express;
- old attempt outcomes remain readable without artifact metadata;
- generic nonzero exit remains a failure and zero remains pass, independently of raw output truncation.

Proposed additive catalog fields are `timeoutMs: number | null`, `onUnavailable: "skip" | "block"`, and `onBudgetExhausted: "skip" | "block"`. Keep slot defaults in one shared descriptor/registry, with legacy defaults 60 minutes for test and 10 for other existing slots. Accept explicit timeouts from 60,000 through 7,200,000 ms. Derived labels must use those same values.

Use additive artifact metadata on attempt/outcome detail; do not expand existing output string bounds. Proposed record:
- opaque id; runId, submissionId, attemptId; repository identity obtained through the run;
- kind stdout or stderr; retainedBytes, observedBytes, droppedBytes, sha256;
- capture state complete/partial, availability retained/pruned/unavailable and optional reason;
- internal storage locator never exposed through public payloads.

Phase 2 adds a findings kind. Define the extension seam, but do not ship an unused CodeRabbit parser. Keep process success, capture completeness and storage availability separate.

### 2. Persist policy and artifact ownership
Add fresh-create and upgrade support together. If artifact metadata requires a new table, use an attempt-owned workflow_command_artifacts table with an attempt foreign key, unique attempt/kind identity and indexes created after required migrations. Do not rewrite historical output JSON or fabricate artifacts for old attempts.

Store API owns reserve/finalize/read/prune and enforces identity. Use one transaction for finalized metadata and attempt references. A durable reservation or equivalent recovery marker must distinguish a crash while writing from an intentionally empty successful capture. A CAS or unique key makes replay idempotent.

Reuse existing retained-file safety and cleanup primitives where applicable. Do not put command output into agent-staged evidence tables, overwrite a frozen submission, or add a second mutable source of truth. The daemon alone writes metadata.

Policy updates, legacy writes, seed defaults, config backup/restore and SSE snapshots need compatibility tests. No migration should reset maxRuns or operator overrides.

### 3. Capture while preserving supervisor behavior
Extend the existing supervisor request with a bounded capture sink owned by the runtime. Preserve exactly one subprocess launch path and the existing no-shell/closed-stdin/environment rules. Expose stdout and stderr chunks separately to the sink while continuing the combined tail ring.

Retain at most 2 MiB raw output per attempt across both streams, and at most 64 MiB command-body storage per run. Reserve capacity atomically so concurrent nodes cannot exceed the run cap. Document whether unused reservations return at finalize and test it. Continue draining after caps; never terminate a healthy test just because its log is large. Retention is initial bounded bytes, not a promise of full output; the independent tail still shows the ending.

A serialized bounded writer must handle backpressure without accumulating unbounded pending writes. On storage error, stop retaining, continue draining, and report evidence unavailable. Generic process verdict semantics stay intact. No silent storage failure, success-shaped truncated artifact, or secret/body logging.

Use private state-home temp files, restrictive permissions, no-follow containment and atomic publish. Compute digests over retained bytes, not decoded replacement characters. UTF-8/ANSI sanitation belongs to display/read projection; raw byte counts remain exact. Finalization precedes publishing outcome metadata. Cleanup proof still outranks a child's successful exit.

Cancellation, timeout, startup recovery and crash keep partial retained output when safely recoverable and label it. Uncertain process-group emptiness keeps the lease held. Never run cleanup on arbitrary client paths.

### 4. Lifecycle and retention
Attach command bodies to the current workflow evidence retention owner. Keep active runs retained and readable across daemon restart. Pruning terminal runs marks metadata first and uses the existing safe deletion/retry machinery; reference checks include command bodies wherever a shared helper is reused. Keep tombstones and return a clear gone/unavailable result.

Ensure reset/cancel does not destroy evidence needed to explain the run, and final run deletion does not leak bodies or reservations. Clean interrupted temp files only when ownership is known, after recovery distinguishes live attempts. Bound disk usage including concurrent writes and normalized artifacts introduced in Phase 2. Reserve a typed extension for those future artifacts without exposing an unsupported kind today.

### 5. Authenticated readers and delivery
Implement one service with proposed entry point readCommandArtifact(runId, attemptId, artifactId, cursor, limit). Maximum read is 64 KiB; cursors bind artifact identity/digest and byte position, preserve UTF-8 boundaries and make no progress claims on corrupt data. Reject invalid cursor, wrong run/attempt, missing ownership, mismatched digest, traversal and pruned bodies. Empty output is valid.

Expose it through a dashboard route under the workflow run and attributed MCP tool `read_workflow_command_output`. Reuse existing workflow read authorization for own runs and explicitly granted cross-session control; access must survive neither session-id spoofing nor an unrelated repository binding. Do not require a session to know state-home filesystem paths. Full-body reads must not enter SSE or ordinary get_workflow_run payloads.

Add bounded artifact descriptors to run detail and get_workflow_run. Repair packets include reader arguments, availability, truncation and digest alongside the existing short quote. Downstream Persona evidence gets compact artifact metadata without pretending tool-less Personas fetched the complete body. Existing Persona tail budget remains unchanged.

Keep all source/schema registration, tool allowlist, route guards and build-smoke tests together. A caller-supplied artifact id is a selector, never an authorization grant.

### 6. Generic blocking and timeout controls
Thread frozen effective policy from command resolution into the execution request and attempt metadata. Resolve once per attempt; a catalog edit cannot change an in-flight timeout or retrospectively alter a result. Retry uses the durable policy for that execution; a new submission may resolve new policy.

Keep unconfigured and operator-disabled behavior as explicit skips. Configured slots with onUnavailable block must block for missing executable/runtime/platform or denied workflow/trust permission without launching a process. With onBudgetExhausted block, spent allowance parks with a clear remedy. Existing skip defaults remain byte-compatible in meaning.

Use an action-required classification distinct from retryable infrastructure, carried through CheckResult and engine handling. Reuse existing blocked run/attempt states and supported retry controls; add only the minimal reason schema if needed. Do not spend a repair round or send a code-fix packet. Correcting policy or availability and explicitly retrying must resume through the existing engine owner. Keep infrastructure retry bounds, reservation accounting and lease-proof gates.

Add timeout and skip/block fields to the existing CommandLibrary editor, parsed values, dirty/discard guards, CAS conflict handling and SSE updates. Do not make a new modal or navigation page. Run detail explains why the command skipped or blocked and shows actual versus configured timeout.

### 7. UI and documentation
Add View retained output in the Command outcome detail with bounded paging, separate stream selection, retained/observed counts and copy behavior. Do not print raw HTML from logs. Historical attempts show that extended output was not captured, not an error or empty success. Show loading/error/retry state and preserve selection on SSE refresh. Large output scrolls inside its container.

Update docs/workflows.md, worktrees-and-checks.md, library-and-line.md and configuration.md as appropriate. Remove contradictory claims that only the tail exists while keeping the distinction between short inline output and retained bounded artifacts. Document that saving policy does not authorize execution and that generic raw truncation does not alter an exit-code verdict.

## Verification
Use AGENTS.md's canonical isolated single-file invocation for focused node:test files. Start with existing command-store/DB/HTTP/SSE, check-spawn/runtime/env/supervisor, check-run-budget-engine and workflow-feedback tests; add artifact lifecycle and MCP route tests.

Required cases:
- huge output, split multibyte/invalid bytes, mixed streams, empty output and long single writes;
- caps under concurrent attempts, writer failure, partial capture, crash-before/after publish and idempotent finalize;
- read authorization across sessions/repositories, bad cursor/digest, path tricks, pruning/deletion and restart;
- old rows/outcomes/config round trips, legacy writes, CAS conflict and backup restore;
- default skip policies unchanged, opt-in block, exhausted budget, corrected retry, cancellation and descendant cleanup.

Playwright: extend e2e/specs/library-commands.spec.ts for save/reload/CAS/timeout/policy controls. Add a retained-output scenario using the built daemon and a fake command with an early marker beyond the short tail; prove the tail omits it but the reader displays it after paging. Exercise blocked-to-retry and historical output states through the real UI. Use role/label selectors and modal inset checks if introducing a modal.

Run npm run typecheck, npm run lint, npm test, npm run build, npm run smoke and npm run test:e2e, with scoped outside-sandbox execution for macOS Electron/browser verification where required. Keep screenshots/transcripts gitignored and attach evidence to the PR. No real model or paid service calls.

## Exit, merge and downstream handoff
All behaviors above work without Phase 2. Existing workflows still run with legacy defaults; artifacts remain readable after worktree return and daemon restart; run detail and the attributed tool use the same authorized bounded reader.

Open one PR for mission-control. Phase 2 begins only after this PR merges. Its implementation may append the findings artifact kind and CodeRabbit slot, provide interpreter hooks and slot defaults, but must not bypass artifact authorization/limits, alter existing slots' policies or introduce another spawn/lease path.

## Cross-phase audit
2026-10-30: Compared with root plan. Generic attempt ownership, output capture limits and failure classifications are defined here before the CodeRabbit consumer. The extra findings artifact consumes the same run quota. No root requirement owned solely by Phase 2 is made a prerequisite for Phase 1 exit.
