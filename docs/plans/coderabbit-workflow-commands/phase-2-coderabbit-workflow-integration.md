# Phase 2: Reusable CodeRabbit Command and optional No-Mistakes review

## Outcome
Operators configure CodeRabbit in Library > Commands, insert it into any custom workflow, and opt into its new No-Mistakes stage per repository. The session can retrieve every retained actionable finding, while incomplete reviews visibly block rather than request a code fix or pass.

Repository: mission-control only. Direct prerequisites: the planning PR and Phase 1 PR have merged. Read plan.md, phased-plan.md and Phase 1's downstream handoff before editing. The implementation route below is adaptable where current repository evidence supports a better approach; record deviations in the PR.

## Scope
Own R1, R4-R7 and the reviewer-specific parts of R8/R9. Ship the catalog entry, repository configuration, executable Setup, comparison identity, streaming interpreter, repair behavior and No-Mistakes version in this phase. No separate reviewer workflow engine, arbitrary slot creation, PR-thread polling, remote review, automatic paid credits or uncommitted-content overlay.

## Entry checks
- Verify Phase 1's merged commit supplies bounded attempt artifacts, read_workflow_command_output, slot timeouts, skip/block policy and action-required blocking.
- Run focused Phase 1 contract tests before changing their consumer seam. Do not implement parallel substitutes if the prerequisite is absent.
- Inspect latest shipped built-in versions and helper transformations. No-Mistakes currently derives versions through appendGpt6Version and appendDocumentationGuidanceVersion; append a new version without accidentally changing hashes or guidance of earlier versions.
- Re-read current CodeRabbit review help and the official CLI agent-mode contract. Installed version at planning was 0.9.1, which introduced severity exit gating. Do not use removed --plain/--prompt-only flags.
- Resolve current auth/version behavior in fake contract fixtures first. A real review is not required to run automated tests.

## Implementation sequence

### 1. Extend the existing catalog and authoring surfaces
Append coderabbit to WORKFLOW_CHECK_SLOTS. Add the exhaustive display purpose/default descriptor and update schema projections, seeding, imports/exports and all registry-driven command palettes. The persisted node kind remains check. Do not rename any prior node/slot ids.

CodeRabbit stays in the existing CommandLibrary rail. Reuse its CAS/discard/SSE mechanics and repository picker. Its per-repository rule has typed baseRef and severity settings; add a discriminated optional review configuration to the existing rule schema/store authority, rather than a second config blob. Keep existing slots' command argv shape backward-readable.

A repository-root rule is explicit opt-in. Ship no global default and no configured repository entries. In this first version reject a CodeRabbit global default and subdirectory-only rule with a clear explanation; the gate reviews the whole repository comparison. Removing the rule disables future execution. Configuration writes require valid canonical repository roots and existing trust remains independently required.

Show a resolved argv preview derived from the rule. The CodeRabbit recipe owns required flags. Do not parse arbitrary shell strings or allow conflicting --remote, --uncommitted, --include-untracked, --show-prompts, --usage or paid-credit flags through this typed recipe. This is a specialized built-in Command recipe, not a separate workflow node.

Use defaults from the root plan: severity major; 45-minute timeout; maxRuns 21; configured unavailable/budget exhaustion block. Default baseRef to an observed repository default only when reliable, otherwise require explicit input. Show that major includes critical and that the run budget can cause a visible block. Preserve explicit values across reload, backup/restore and legacy config updates.

Slot execution/result descriptors are the single place that selects exit-code versus CodeRabbit interpretation. Keep browser-safe descriptors in shared code and server interpreter functions in the workflow modules. No giant switch copied across routes/runtime/UI.

### 2. Integrate executable resolution and noninteractive setup
Append coderabbit to EXECUTABLE_IDS and add its spec to src/server/executables/catalog.ts. Use the established prefixed binary override, supported install candidates including the local-bin location, and shared locator provenance. Detection and execution use the same resolved absolute executable and child environment.

Add Setup diagnostics reporting presence, version compatibility and selected path/source without signing in or starting a review. Require >=0.9.1; an older or missing binary is a correctable block after opt-in. Use bounded version/auth-status probes. Authentication needs the daemon's actual effective HOME; never infer it from the interactive shell.

Preserve check-env credential stripping. Do not allow --api-key in the visible stored command or log credentials. Recommend stored CLI authentication and expose an actionable authentication-needed state; installation/login is an operator setup action outside the workflow. Disable auto-update for managed review launches through the documented CLI environment policy, while preserving relevant proxy/locale settings. Do not add a new subprocess supervision mechanism.

The adapter's version/auth probes and review launch must respect the executable-contracts test registry and all scoped environment exclusions. Do not use which, command -v, a private PATH scanner or a new login-shell probe in production.

### 3. Capture the exact reviewed comparison
Extend attempt execution context additively with CodeRabbit-specific comparison metadata. Use the run/binding's repository, never the session's primary repository by assumption. Resolve captured abbreviated heads with the existing resolveCapturedCommit helper; record a full oid.

Resolve the configured baseRef to a commit and compute merge-base with that head using bounded safe Git argv helpers in the correct repository. Reject unknown/ambiguous refs and unsupported comparisons before review. Persist configured ref, resolved base tip, merge-base oid, full head, interpreter version and command rule revision before allowing the review child to start.

Freeze identity across retry of the same submission. New repair submissions capture their own comparison identity. Repository refs moving later cannot rewrite past evidence. Do not update remote refs automatically. Record the comparison prominently enough to diagnose stale local refs.

Capture dirty state from the submission's actual checkout/content identity, not the lease. If uncommitted changes would make the reviewed snapshot differ from the submission, block and explain that a commit and new submission are needed. Do not secretly commit the user's work, review the prior HEAD as if current, or apply an overlay in this phase.

Invoke the recipe through check-runtime/check-spawn in the lease at the pinned head:
review --agent --gate <severity> --committed --base-commit <merge-base-oid>
Freeze the effective timeout and policy already introduced in Phase 1. If expected comparison is empty, retain explicit no-change provenance; disagreement with a nonempty diff blocks.

### 4. Parse and retain structured findings
Add a focused server interpreter module, proposed coderabbit-result.ts, with pure parsing/state-transition tests. Receive stdout chunks before generic tail/raw retention clipping. Never parse merged stderr as NDJSON. Decode incrementally across chunk boundaries; cap records at 256 KiB, findings at 1,000 and normalized findings bytes at 4 MiB. These are additive to the raw 2 MiB attempt cap and share Phase 1's 64 MiB run quota.

Validate finding severity and required fields; retain title/comment/codegenInstructions/suggestions/path/line range as untrusted text. Validate paths for display, but never execute suggested commands or use paths as artifact filesystem locators. Tolerate optional fields and unknown additive event types. Malformed JSON or invalid critical known events makes the result incomplete, not an empty clean review.

Give retained findings stable per-attempt ids. Persist normalized findings through Phase 1's artifact service with a new findings kind and machine-readable content; do not copy them into a second mutable findings ledger. Reserve storage before success, publish the complete artifact atomically, and include a compact counts/identity manifest in the attempt outcome. Persistence failure blocks CodeRabbit because lost review findings cannot support a successful review.

Use the official terminal-event contract:
- no pass before a terminal complete event and process exit;
- exit 0 with successful passed gate and complete coverage passes;
- exit 2 with complete blocked gate produces a review-finding failure;
- exit 1, missing completion, failed outcome, positive unreviewedFileCount, contradictory gate/exit, gate-incomplete reused review, malformed semantic stream or semantic capacity overflow blocks;
- completed_with_warnings without unreviewed files can pass only if other completeness/gate checks agree;
- review_skipped is only a successful explicit skip when consistent with an empty pinned comparison.

Heartbeat events update observable progress if supported, but never extend a fixed hard timeout without a separate explicit policy. Keep the 45-minute default bounded; record expectedDuration as diagnostic. An error/action_required/auth/usage/rate-limit event cannot be cleared by a later superficial summary. Do not automatically use credits or retry before a known vendor wait expires.

Continue consuming/draining safely after parsing fails, preserve bounded diagnostics, and let existing teardown/recovery finish. A full raw log is not required when the complete independent findings artifact and terminal result are retained. Conversely, a raw tail with a success sentence is never enough.

### 5. Integrate outcomes, repair and retry
Return a typed interpreter result through the existing Command outcome path. Distinguish completed pass, completed review-finding fail and action-required incomplete block. Keep generic slots' exit behavior unchanged. The confidence of an observed exit must not be presented as certainty that a CodeRabbit claim is true.

Failure summaries include comparison identity, threshold, counts and a bounded selection of finding titles/locations, plus exact output-reader arguments for the full retained findings. Preserve every retained finding including advisory severities. Run detail and get_workflow_run expose compact metadata, not multi-megabyte output. Downstream Personas receive the summary/provenance through upstream command evidence, within existing model budgets; do not imply they fetched an artifact they cannot access.

Repair instructions tell the session to inspect all retained actionable findings and verify them before modifying code. Valid findings are fixed on the task branch. A false-positive explanation does not silently alter the gate: the session surfaces it for an explicit operator decision and the existing node-disable/recovery controls record the bypass. No automatic clearing of CodeRabbit history, hidden severity change or extra review-thread mutation.

Ordinary repair resubmission reviews the new captured commit. Keep Phase 1 slot-level accounting shared by duplicate CodeRabbit nodes. Default 21 executions supports the current maximum rounds, but repeated nodes can spend it sooner; spent allowance blocks with a concrete remedy. An incomplete retry uses frozen comparison identity and existing bounded attempt machinery. Auth/config/usage blocks do not consume repair rounds or create automatic retry storms. Preserve max repair-round handling, operator grants and full-restart behavior.

### 6. Add optional No-Mistakes stage without coupling custom workflows
Append the next immutable built-in No-Mistakes version through the existing version-generation owners. Add stable new CodeRabbit node/join ids once. Insert one evaluation stage after the existing typecheck/test/lint join and before Intent/Coverage Personas. Preserve subsequent Persona execution settings, evidence readiness, PR action and Inspector policy.

The same Command must work in a freshly created custom workflow and in a custom stage group. Do not branch execution on a workflow slug or require a No-Mistakes binding. An unconfigured repository produces an explicit skipped node and never launches the binary. A configured but unavailable command blocks. Operator-disabled nodes remain distinguishable from earned approval.

Pin regression tests for all previous built-in version graphs/hashes and prove that existing bindings stay on their version. A user explicitly upgrades a binding to receive the new stage; no background rebinding. Do not add CodeRabbit to unrelated built-ins.

### 7. Finish UI, docs and evidence
CodeRabbit fields live within CommandLibrary. Run details show threshold, reviewed head/base, severity counts, complete/incomplete/skipped status and retained findings access using Phase 1 readers. Existing blocked recovery actions surface the relevant remedy. Use the shared code/text display and scrolling components; no raw HTML rendering or new navigation section.

Update docs/workflows.md, library-and-line.md, configuration.md, worktrees-and-checks.md and Setup documentation for installation/auth prerequisites, committed-only scope, opt-in, output access, usage limits, rerun cost and false-positive handling. Keep CLI local reviews separate from existing GitHub CodeRabbit thread follow-up. Do not hand-edit generated outputs or CHANGELOG.md.

## Verification
Parser tests use vendor-shaped fake fixtures with provenance and the installed help/official documented field contract. Cover every table row above, partial stdout chunks, UTF-8 boundaries, stderr noise, oversized records, advisory-only findings, unknown additive fields, duplicate/contradictory completion and semantic-output retention failure.

Runtime/integration tests cover:
- no rule means no version/auth/review subprocess;
- configured absent/old/unauthenticated tool blocks without code-fix packet;
- timeout, rate-limit delay, credit request, cancelled group and restart do not pass;
- exact head/base with dirty worktree refusal, moved base ref during retry, empty diff, ambiguous base and two repositories;
- findings before an early raw-output truncation remain retrievable through MCP;
- repair at a new head, exhausted shared budget, duplicate nodes and explicit operator disable;
- compatibility with Phase 1 generic slots, old rows, CAS/legacy writes and old graph versions.

Playwright must cover Library configuration/save/reload, Setup path/version state, adding CodeRabbit to an arbitrary custom workflow, grouped-stage behavior, optional No-Mistakes skip, failed-findings repair presentation and reader access, incomplete-review block/retry and old-binding stability. Add e2e/fixtures/fake-coderabbit.mjs with an explicit binary override through the executable registry, isolated HOME and deterministic NDJSON scripts. Fake agents and GitHub calls remain enabled. No paid or network CodeRabbit review is used.

Use AGENTS.md's isolated node:test loader for focused files. Run typecheck, lint, npm test, build, smoke and test:e2e. Extend executable-contracts and MCP tool registration/smoke checks. Validate UI geometry and modal insets if a modal is introduced. Evidence is gitignored and attached to the PR.

## Exit and merge criteria
One mission-control PR delivers the complete optional feature. All R1/R4-R7 and reviewer-specific R8/R9 acceptance cases pass; Phase 1 regressions remain green. An operator can opt into CodeRabbit, place it in a custom workflow, inspect/retrieve findings, repair, and obtain a fresh result. Disabled/unconfigured and incomplete states are accurately distinguished.

No-Mistakes upgrades are explicit. No GitHub/release/CI policy is changed and no automatic model spend occurs in tests. Real-account smoke validation, if not performed, is reported precisely rather than claimed.

## Downstream handoff
No later phase is needed. Preserve artifact identity/retention and append-only command/built-in version contracts for future integrations. A future provider can reuse the generic command surfaces but must define its own completion semantics.

## Cross-phase audit
2026-10-30: Re-read root and Phase 1 contracts. Findings use the same retained-output quota, authorization and paging service; interpreter input is the pre-truncation stdout stream, not the 4 KB tail. Typed provider settings remain in the catalog CAS and generic old slots retain argv. Block states use Phase 1 engine ownership. Comparison metadata is reviewer-specific and introduced here without changing generic capture semantics. No temporary external service, future cleanup phase or extra workflow engine is required.
