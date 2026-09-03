# Phase 2 - Complete Provider Lifecycle and Ownership

## Outcome and value

ai-conductor emits the machine evidence Mission Control needs to distinguish a live, retained, retired, missing, blocked, or failed Engineer attempt. It proves known prerequisites before authoring, retains successful authoring worktrees through specification review, and prevents accidental unreserved successors on Mission Control-owned correlations.

The contract is additive and remains usable by the current Mission Control build, which stores unknown v1 event kinds and continues to read the raw terminal `error` field.

## Entry criteria and dependencies

- The planning artifacts in the attached Mission Control checkout are merged to its default branch.
- No implementation phase is a prerequisite. This phase may run concurrently with Phase 1.
- Primary repository: ai-conductor.
- Additional repository: Mission Control, context-only. Read the plan files there; make no Mission Control changes.

## Scope

- Extend the existing Engineer lifecycle event spine and snapshots with readiness and worktree retirement.
- Add bounded structured fields to terminal failure while preserving the raw error.
- Add feature capabilities for readiness, retirement, retained review worktrees, and owned attempts.
- Enforce readiness as a machine transition gate before authoring.
- Retain authoring worktrees until PR merge, PR close, task cancel, or a bounded timeout.
- Record retirement before cleanup and make cleanup idempotent.
- Carry optional integration ownership across correlation lineage and reject accidental owner loss or change.
- Add explicit ownership transfer for an intentional provider-side successor.
- Update canonical provider documentation and tests.

## Non-goals

- Do not change Mission Control source, database state, routes, or UI.
- Do not create a parallel telemetry channel, sidecar status source, or browser-facing endpoint.
- Do not teach ai-conductor to write Mission Control SQLite.
- Do not infer task completion or adoption decisions.
- Do not make a read-only remote probe claim that branch push authorization is proven.
- Do not auto-merge a specification pull request.
- Do not alter immutable terminal attempts or reopen a predecessor.

## Repository findings and inherited contracts

- `src/conductor/src/engine/engineer/run-store.ts` owns attempt-key idempotency, correlation indexes, direct predecessors, transitions, replay, and snapshot reduction.
- `src/conductor/src/types/events.ts` defines the single Engineer event union used by the repository event spine.
- `engineer capabilities` currently reports only `engineerLifecycleEventsV1` in `src/conductor/src/engine/engineer-cli.ts`.
- A run moves directly from `created` to `authoring` on `run_started`; there is no readiness evidence or gate.
- `persistEngineerHandoffBeforeCleanup` records handoff before immediate worktree removal. This is the correct atomicity seam to replace with retained cleanup scheduling.
- Handoff failure already keeps the worktree. Preserve that behavior.
- The run snapshot already retains exact worktree path, branch, plan slug, handoff, correlation, attempt key, and previous run.
- All new observation belongs on `ConductorEventEmitter` through `ConductorEvent`, never in an ad hoc log or sidecar.
- Third-party calls in tests use faithful fakes. Real network calls remain opt-in smoke only.

## Implementation steps

### 1. Define additive event and capability contracts

In `src/conductor/src/types/events.ts` and the Engineer run-store types, add bounded structures:

```ts
type EngineerReadinessStatus = "ready" | "blocked" | "inconclusive";

type EngineerFailureClass =
  | "authentication"
  | "authorization"
  | "remote"
  | "workspace"
  | "tooling"
  | "provider"
  | "unknown";
```

Add:

- `engineer_readiness_checked` with status, stable code, summary, checked capability names, retryability, remedy, and bounded diagnostic.
- `engineer_worktree_retired` with path, branch, plan slug, reason, and retained commit SHA when known.
- optional structured class, code, summary, retryable, remedy, and bounded diagnostic on `engineer_run_failed`, preserving required raw `error`.

Use stable reason enums for retirement such as `spec_merged`, `spec_closed`, `task_cancelled`, `retention_expired`, and `operator_cleanup`. Do not accept arbitrary user text where a bounded code suffices.

Expand `engineer capabilities` with independent booleans or named capabilities for readiness, retirement, retained review worktrees, and owned attempts. Keep `engineerLifecycleEventsV1` true and retain schema version 1 because the additions are compatible with the current consumer's unknown-kind parser.

### 2. Extend snapshots and transitions without weakening history

In `src/conductor/src/engine/engineer/run-store.ts`:

- Add readiness and retirement projections to `EngineerRunSnapshot`.
- Add optional integration owner identity to run metadata and snapshot. Treat it as an opaque bounded string.
- Preserve the owner across every same-correlation successor by default.
- Reject a successor when its owner is absent or differs from an owned predecessor.
- Keep attempt numbering, direct predecessor identity, terminal-state requirements, and attempt-key collision checks unchanged.
- Reduce new events deterministically and reject duplicate or contradictory retirement transitions.
- Require a successful or explicitly permitted inconclusive readiness event before `run_started` and every authoring step transition. A blocked result cannot enter authoring.
- Keep terminal runs immutable.

The provider should not add a generic `checking` run state unless it improves the transition model. A `created` run with readiness projection is sufficient if every authoring transition validates it.

### 3. Add deterministic readiness machinery

Add an Engineer CLI command and reusable service that checks, with injected process adapters:

- repository path and Git repository identity;
- required `git`, `gh`, and provider tool availability, including configured authoring/diagram prerequisites;
- configured remote existence and parseability;
- non-mutating remote reachability and authentication from the current process posture;
- `gh` authentication when a GitHub handoff is expected;
- whether push authorization remains unproven until handoff.

Expose two explicit uses of the same injected checker:

- a non-mutating repository/environment probe that accepts no run ID, writes no journal event, and can block retry before an attempt is reserved;
- a run-scoped readiness command that accepts the exact new run ID, writes one readiness event through the run store, and returns bounded JSON.

Both return the same bounded classification. The run-scoped command is safe for Mission Control to call after initial run creation and for the host launcher to call again inside its actual sandbox and environment. It never appends readiness to a terminal predecessor.

Mechanically gate authoring:

- the canonical Engineer launch path runs readiness before `run_started`;
- `run_started` refuses if no current ready or permitted-inconclusive result exists;
- results are invalidated when the relevant repository, remote, tool resolution, or host posture changes;
- the handoff path repeats the authorization-sensitive remote check immediately before push and converts a failure to the same typed evidence.

Do not rely on prose that asks a model to remember the check. The command and transition rules enforce it.

### 4. Retain successful worktrees through review

Replace immediate successful-handoff removal at `persistEngineerHandoffBeforeCleanup` and the `engineer handoff` call site:

- persist the handoff first, as today;
- mark the worktree retained with its branch, commit, PR URL or local-commit outcome, and retention deadline in the run snapshot or lifecycle-owned metadata;
- leave the worktree registered and usable through review;
- report retention in CLI output and documentation.

Add a lifecycle-owned cleanup reconciler invoked from the existing daemon/Engineer maintenance loop. It scans durable Engineer snapshots and retires only an explicit path whose run identity matches:

- GitHub reports the recorded PR merged;
- GitHub reports the recorded PR closed without merge;
- the run or owning task is explicitly cancelled;
- the bounded retention deadline expires;
- an explicit operator cleanup command validates and retires it.

For `local_commit`, retain until cancel, explicit cleanup, or timeout because there is no PR terminal signal.

Before removal:

1. resolve and validate the exact repository, worktree, branch, marker, run ID, and retained commit;
2. append `engineer_worktree_retired` durably;
3. remove that exact worktree through the existing guarded helper;
4. on removal failure, retain actionable error evidence and permit idempotent retry without appending a contradictory second retirement.

Do not bulk-delete, glob, or infer cleanup from directory age alone.

### 5. Fence owned correlation successors

Extend `engineer run-create` with optional integration ownership:

- The first Mission Control-created run records an opaque owner such as the commission identity.
- A successor of an owned correlation must present the same owner and a fresh attempt key.
- A missing or different owner receives a stable lifecycle error before any run directory, attempt index, or event is written.
- An unowned correlation keeps current behavior.

Add one explicit ownership-release or transfer command:

- requires exact correlation, repository, active terminal run, current owner, and expected revision;
- records an auditable lifecycle transition or ownership record on the existing spine;
- issues or records a single-use transfer state for the next direct successor;
- cannot alter an existing run's attempt identity or journal.

This is operational fencing against accidental split authority, not a security boundary against the same local user. Keep the contract simple and idempotent.

### 6. Classify failures at the command boundary

Centralize classification where ai-conductor owns command intent and exit evidence:

- map known Git transport, GitHub authentication, remote authorization, missing tool, invalid workspace, and provider contract failures to stable codes;
- keep unknown as the safe default;
- bound and redact diagnostics before persistence or emission;
- preserve the original raw error for current consumers, also bounded and redacted;
- do not classify by unbounded browser-side stderr matching.

Use the same classifier for readiness and handoff failures so the operator receives consistent remedies.

### 7. Update documentation and generated outputs through their sources

- Update `skills/engineer/SKILL.md` to describe machine-gated readiness and retained review worktrees.
- Update canonical CLI and daemon documentation for new commands, capabilities, retention, cleanup, and ownership transfer.
- Update generated tables or references only through their generators.
- Do not edit `CHANGELOG.md` or `VERSION`.

## Data, API, migration, and compatibility

- Run metadata and snapshots: additive optional owner, readiness, retention, and retirement fields with legacy defaults.
- Event journal: additive v1 kinds and optional terminal-failure fields. Existing revisions remain unchanged.
- Correlation index: preserve current shape unless owner lookup demonstrably requires an additive field; snapshots remain the source for run owner.
- Capability response: additive independent feature flags so Mission Control can gate each guarantee.
- Existing Mission Control safely stores unknown v1 kinds and reads raw `error`; no coupled consumer merge is required.
- Replaying an old journal produces a legacy snapshot with no readiness or explicit retirement. It must not fabricate either.
- Existing unowned correlations remain creatable. Ownership fencing starts only when the first run carries an owner.

## Tests and verification

The implementation agent must follow ai-conductor's current repository instructions and HARNESS-directed workflow. At minimum, add or extend:

- `src/conductor/test/engineer-lifecycle-cli.test.ts`: capabilities, readiness command, bounded JSON, owner flags, and compatibility.
- `src/conductor/test/engine/engineer/engineer-lifecycle-store.test.ts`: event reduction, transition gate, legacy replay, owner inheritance, mismatch refusal, transfer, retirement idempotency, and immutable terminal history.
- `src/conductor/test/engineer/engineer-cli*` suites: parse and reject unknown or incomplete flags.
- `src/conductor/test/engine/engineer/handoff-step.test.ts` and lifecycle tests: readiness before push, typed failures, handoff persisted before retention, and no immediate cleanup.
- worktree acceptance tests: retained after PR open, removed on merge/close/cancel/timeout, exact identity validation, local-commit retention, and removal failure recovery.
- integration emission tests: new events travel through `ConductorEventEmitter`, persistence, replay, and snapshot without a parallel channel.
- faithful fake Git, GitHub, tool, clock, and process adapters. Default tests make no real network or model calls.

Run the focused tests selected by the repository workflow, then the mandatory full validation before commit:

```sh
test/test_harness_integrity.sh
```

Also run any build, typecheck, packaging, or generated-output verification required by the current HARNESS and changed package.

## Merge and exit criteria

- Mandatory provider validation passes.
- Current journals replay byte-for-byte into compatible legacy snapshots.
- New event kinds and fields are bounded, persisted through the existing event spine, and replay identically to live reduction.
- The non-mutating readiness probe creates no run, attempt, event, or provider index; the run-scoped command records evidence only on a non-terminal exact run.
- No authoring transition can occur after a blocked readiness result or without required readiness evidence.
- Successful handoff retains the exact worktree and records its deadline.
- Merge, close, cancel, timeout, and explicit cleanup each retire only the exact validated worktree and emit retirement evidence before removal.
- Unreserved successors of owned correlations fail without partial durable state.
- Explicit transfer is exact, auditable, one-use, and cannot reopen or rewrite an attempt.
- Handoff failure keeps the worktree as before.
- Canonical documentation matches the implementation.

## Downstream handoff

Phase 3 may rely on feature capabilities, new event schemas, readiness and retirement snapshots, typed failure codes, and owner presence. It must treat absent features as legacy state.

Phase 4 may rely on owned correlations refusing accidental unreserved successors. It may use the explicit transfer mechanism only for future intentional control transfer; historical adoption remains a Mission Control reconciliation of an already-existing direct successor.

## Cross-phase audit record

- Initial audit: Phase 2 is provider-only and additive, so it can merge independently of Phase 1.
- Compatibility proof: current Mission Control retains unknown v1 kinds and strips unknown fields on known kinds while preserving raw `error`.
- Contract refinement: use independent capability flags rather than changing the existing lifecycle capability string, so consumers can gate readiness, retirement, retention, and ownership separately.
- Contract refinement: retirement evidence is written before cleanup; `missing` remains a consumer-observed state and is not emitted by the provider.
- Retention decision is settled: immediate successful-handoff cleanup must be removed, not preserved as an optional default.
- Final audit: Phase 3 activates owner identity on new Mission Control creates, while Phase 4 reuses the same owner on retries. Historical adoption does not fabricate provider ownership.
- CodeRabbit audit: pre-reservation readiness and run-scoped readiness are separate commands over one checker, preserving terminal-run immutability.
