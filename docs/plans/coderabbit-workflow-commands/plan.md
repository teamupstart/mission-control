# CodeRabbit workflow Commands

## Outcome and authority
People can configure CodeRabbit in Library > Commands, add that Command to any custom workflow, and optionally use it in No-Mistakes. The owning session receives actionable findings and can retrieve the retained details. A review that did not complete cannot masquerade as a clean review.

The operator approved this direction in file-comment replies MC-caf4.1 through MC-caf4.3 and explicitly requested full planning and scheduling with phased-plan. The root source is this document, derived from that discussion, not the separate GitHub-thread follow-up plan. This is planning and scheduling authority; implementation belongs to the scheduled phases. Merge is not authorized.

Operator update: use repository-root `.coderabbit.yaml` at `reviews.auto_review.enabled: true` as enablement authority, set maxRuns to 10, skip with a warning on exhausted allowance, and block unavailable reviews only when YAML enables them. Show clear error diagnostics and a Settings > Setup link for YAML-enabled blocks. These decisions supersede revision 2's Library-rule opt-in, 21-run default and block-on-exhaustion policy.

## Adopted requirements
- R1: CodeRabbit is an additional built-in Command entry and wire-kind `check`, not a new Library section or workflow node kind. Users can place it in arbitrary custom workflow stages.
- R2: Commands generally retain bounded output outside the small outcome/repair payload, with authenticated retrieval by the owning session and dashboard.
- R3: Commands expose bounded configurable timeouts and explicit unavailable/budget-exhaustion policy. Existing five slots retain their defaults.
- R4: CodeRabbit interprets its structured review result, separating actionable findings from incomplete or unavailable reviews. Findings are claims for the session to verify.
- R5: CodeRabbit is enabled automatically for any repository whose root `.coderabbit.yaml` explicitly sets `reviews.auto_review.enabled` to boolean true. No separate Library rule is required. Otherwise skip with a warning and launch no CodeRabbit subprocess; installation and trust alone never enable it.
- R6: Review execution is pinned to the captured committed head and a resolved comparison base. Repair rounds re-evaluate changed code within a default 10-execution run allowance; exhaustion skips with a warning and never blocks.
- R7: A new immutable No-Mistakes version offers CodeRabbit after basic Commands and before Personas. Existing versions and bindings remain unchanged.
- R8: Cancellation, retries, restart recovery, retention, authorization and multi-repository isolation use daemon-owned workflow machinery. Tests use fake CodeRabbit and agent binaries and incur no review charges.
- R9: Preserve ordinary Command behavior and the existing global-default/override CAS catalog. No independent review engine, scheduler, findings poller or GitHub-thread resolver is introduced.

## Current implementation and evidence
Inspected checkout starts at 85f9759d0. Implementation agents must re-read current sources after prerequisite merges.

| Evidence | Established fact and implication |
| --- | --- |
| src/shared/workflow.ts, WORKFLOW_CHECK_SLOTS and WorkflowCommandView | Five append-only built-in slots, one nullable global argv, repository/subdirectory overrides, revision CAS and maxRuns. Add the CodeRabbit id; do not enable arbitrary user-created slot ids in this feature. |
| src/server/workflows/commands.ts; store.ts; db.ts | Catalog manager publishes after a committed store write. Legacy configuration shares its transaction. New fields must preserve those properties. |
| src/server/workflows/checks.ts; check-runtime.ts; check-spawn.ts | Commands execute argv in a captured-commit leased tree. Nonzero exit is currently a repair verdict; unavailable and spent budget advance. Test timeout is 60 minutes; other slots use 10 minutes. |
| src/shared/workflow.ts; engine.ts checkVerdict; feedback.ts | Retained tail is 4,000 bytes and repair quote is 2,000 bytes. Upstream Personas see retained command evidence. Large findings disappear before delivery today. |
| src/server/workflows/images.ts; store.ts | Existing immutable evidence has retained storage, hashes, reference checks and pruning. Agent text evidence is submission capture input; command output arrives later and must stay attempt-owned. |
| src/mcp/server.ts; src/server/routes.ts | get_workflow_run uses attributed /mcp/workflows/read. Reuse its session/run authorization for an added bounded output reader rather than returning raw state-home paths. |
| src/web/workflows/CommandLibrary.tsx; WorkflowRuns.tsx | Library edits the single SSE catalog; run detail displays the short tail. Extend those surfaces, not navigation. |
| docs/agent-guides/architecture.md; change-contracts.md | Daemon owns SQLite; executable registry/locator owns built-in binaries; workflow ids and vocabularies are append-only; one run reviews one repository. |

The local binary was verified as CodeRabbit 0.9.1 using --version and review --help. Official references: https://docs.coderabbit.ai/cli/reference and https://docs.coderabbit.ai/cli/agent-mode. The latter was read successfully during the investigation; a later browser refresh was unavailable. The published contract and local help agree on --agent, --gate and committed/base selectors. No live review or daemon-authentication test has been performed. A real authenticated smoke run is optional operator validation, never a prerequisite that makes automated tests spend credits.

Repository plans and the managed catalog were checked. docs/plans/code-rabbit-auto-resolver concerns GitHub PR threads and remains out of scope. The local catalog contained complete-ready-sessions, not this feature. No historical revision was substituted.

## Command behavior shared by all slots
Retain the current 4,000-byte outcome tail and 2,000-byte repair quote. Add immutable, attempt-owned stdout/stderr artifacts under the daemon state directory with digest, byte counts, truncation status, attempt/submission/run/repository identity and availability. Do not inline large bodies into SQLite outcome JSON, snapshots, SSE or repair packets.

Proposed bounded defaults: 2 MiB combined raw stdout/stderr per attempt, 64 MiB total retained command bodies per run, and 64 KiB maximum per read response. The raw archive retains the initial bounded bytes while the existing tail ring independently retains the end; distinguish both truncation counts. Limits are named constants and tested. Raw truncation does not change a generic exit-code verdict. Integrity/storage failure is exposed as evidence unavailable, never as a fabricated intact artifact.

The supervisor must keep draining both pipes after retention fills. Artifact writes must not block stdout consumption or allocate unbounded buffers. Publish finalized bodies atomically, then durable metadata, and recover interrupted capture as partial/unavailable. Never retain data in a leased tree that can be reused.

Provide one paginated UTF-8-safe read service over opaque run/attempt/artifact identities. The dashboard offers View retained output and clear missing/pruned/partial/truncated states. A new attributed MCP reader, proposed `read_workflow_command_output`, exposes the same service with bounded cursors. Repair packets include the exact reader arguments and digest/availability summary, so the session can fetch earlier output. Cross-session access follows the existing explicit control grant, and every read verifies run ownership and repository membership. Path traversal and client-supplied filesystem paths are refused.

Artifacts belong to the run's existing evidence-retention lifecycle. Preserve metadata/tombstones after pruning; never delete active-run bodies. Integrate reference-aware cleanup, interrupted temporary-file cleanup and run deletion. Do not broaden archive contents or retention durations implicitly.

Extend each catalog slot with `timeoutMs` (nullable: use the slot default), `onUnavailable` and `onBudgetExhausted` (skip or block). These are machine execution policy, not graph argv. Enforce 1 minute through 2 hours for configured timeouts. Old rows project legacy defaults; new complete-state CAS writes must explicitly supply the fields, rather than reset saved policy when omitted. The legacy workflows/config adapter preserves fields it cannot express. Settings backup/restore, snapshot/SSE comparison and UI draft/discard behavior move together.

Missing consent never launches anything. An unconfigured generic slot or an operator-disabled node remains an explicit skip. CodeRabbit resolves YAML enablement and built-in typed defaults before generic unconfigured-slot handling; absence of a catalog override is not an unconfigured CodeRabbit Command. For a configured slot with block policy, denied execution consent, missing executable/runtime/platform or spent execution budget blocks with a specific remedy. Do not spend repair rounds or inject a fix-the-code packet for these cases. Existing five slots continue to skip under the same conditions unless the operator changes their policy.

Separate retryable infrastructure failure from operator-action-required block. Preserve bounded infrastructure retries for actual process/lease problems. A configuration or authentication block needs an explicit supported retry after correction; it must not spin. Keep process-group teardown proof and lease reclamation ahead of all verdict publication.

## CodeRabbit Command
Append `coderabbit` to the Command registry. Reuse Library > Commands, graph/pipeline authoring, imports/exports and the same check node. A registry-selected result interpreter serves CodeRabbit; generic slots retain the exit-code interpreter. There is no user-scripted parser or new provider framework in this scope.

### Enablement and execution policy
Read the submission's captured repository-root `.coderabbit.yaml`. Enable CodeRabbit only when the parsed `reviews.auto_review.enabled` value is boolean true. This is Mission Control's explicit local enablement rule, not an assumption that CodeRabbit's CLI enforces its cloud auto-review setting. [CodeRabbit's configuration reference](https://docs.coderabbit.ai/reference/configuration) documents the field; Mission Control deliberately requires an explicit local true instead of applying vendor defaults or inherited organization settings.

```yaml
# yaml-language-server: $schema=https://coderabbit.ai/integrations/schema.v2.json
inheritance: true
reviews:
  auto_review:
    enabled: true
```

The example enables the Command. `inheritance: true` does not itself enable it or cause Mission Control to fetch remote parent settings. Missing file, missing key, false or a non-boolean value does not enable it. Invalid, unreadable, oversized or ambiguous YAML yields a skipped warning plus a visible configuration error, not an inferred enabled state or a workflow block. Use bounded safe YAML parsing, reject duplicate critical keys and unsupported tags, and keep resolution inside the run's repository. Record source path, digest, parsed enablement and diagnostic reason with the submission; retry reuses that snapshot and a new submission refreshes it.

| Condition, evaluated in order | Result |
| --- | --- |
| Operator-disabled node or YAML does not explicitly enable review | Skip with a visible warning; no version/auth/review subprocess. |
| Shared CodeRabbit execution allowance exhausted | Skip with a visible warning even when YAML enables review; no availability probe or review launch, no block and no fabricated pass. |
| YAML enabled, allowance available, but CLI/auth/trust/runtime/configuration prevents review | Block with a visible error, exact reason and a direct Settings > Setup link. Preserve trust controls; YAML is not execution consent. |
| YAML enabled and prerequisites available | Run review; apply the structured-result contract below. |

Every skip records its reason in run detail and session command evidence. Observed unavailability is an error diagnostic even when a nonblocking policy applies; do not probe a disabled Command merely to discover an error. YAML-enabled incomplete reviews block with error diagnostics and a Settings > Setup link as well as any more specific remedy. Completed findings still fail normally for repair. Execution-budget exhaustion is the explicit nonblocking exception.

Library > Commands remains the catalog authority for optional repository-root tuning of typed `baseRef` and `severity`, timeout and execution allowance. Creating or deleting an override cannot enable or disable CodeRabbit; YAML owns that choice. Ship built-in effective defaults so YAML-enabled repositories work without any saved override. Reject subdirectory-only rules and arbitrary global argv for this whole-repository typed recipe. No separate Settings enable flag, copied YAML state or second mutable configuration store is introduced.

Default baseRef to the repository's observed default branch when known; otherwise require an explicit value and show a configuration remedy for an enabled review. Default severity to major, including critical. Show the resulting argv preview with the resolved-base placeholder. Binary overrides use the shared executable locator/Setup integration; no absolute user path is committed as a product default. Existing five slots keep editable argv.

Fresh CodeRabbit defaults are timeout 45 minutes and maxRuns 10. The allowance remains shared across CodeRabbit nodes within one run. Resolve unavailable policy to block only for YAML-enabled review; all other cases skip. CodeRabbit budget exhaustion always skips with a warning. These derived policies must not be contradicted by editable generic policy selectors or legacy writes; preserve existing slots' configurable skip/block behavior. An operator can explicitly disable a node with existing workflow controls. Every skipped outcome remains distinct from completed clean review.

At the first CodeRabbit attempt for a submission, resolve the configured base ref in the run's repository to a full commit id and compute its merge base with the captured head using existing safe Git/commit helpers. Persist the configured ref, resolved base tip, merge-base id, full captured head, optional catalog rule revision, YAML enablement digest, interpreter version and effective options before execution. Retries use that frozen identity; a new repair submission captures a fresh identity. Do not fetch or change refs implicitly. Missing/ambiguous refs block with a setup remedy.

Execute the resolved binary under the existing supervisor with:
`review --agent --gate <severity> --committed --base-commit <merge-base-oid>`
in the lease pinned to the reviewed head. Require CLI >=0.9.1. Check version/auth status with bounded noninteractive probes through the same executable/environment contracts. Never start login, install/update the CLI, enable paid-credit continuation, or pass credentials in visible argv. Stored local authentication is supported; automatic credential provisioning is not.

Only committed content is reviewed. When a submission also includes uncommitted changes, block this YAML-enabled review with a clear commit-and-resubmit remedy instead of endorsing the dirty snapshot using an older HEAD. Reuse captured dirty/content identity rather than guessing from the clean leased tree.

## Structured results, completeness and repair
Parse stdout NDJSON before tail truncation; stderr remains diagnostic. Ignore heartbeats for findings, tolerate unknown additive event types/fields, and validate known critical fields. Bound each record (proposed 256 KiB), the normalized findings artifact (4 MiB and 1,000 findings), and memory use. Retain findings in arrival order with stable per-attempt ids, severity, path, line range, title, comment and instructions. Escape output as text. A record/semantic overflow, malformed result or missing terminal completion blocks as incomplete, even when the process exits zero.

| Observed result | Workflow consequence |
| --- | --- |
| Exit 0, complete successful gate, no blocking findings | Pass; preserve all advisory findings for run detail and downstream evidence. |
| Exit 2, complete successful review, valid blocked gate | Fail with verified-review context, severity counts and bounded finding summaries plus output-reader references. |
| Exit 1, incomplete coverage, reused result marked incomplete, unknown contradictory status, truncated semantic findings, or missing completion | Block as incomplete; preserve available findings and explain the remedy. |
| Authentication, unsupported version, rate/usage limit or action_required during YAML-enabled review | Block with visible error and Settings > Setup link, without code-repair verdict or automatic paid continuation. Respect a vendor-provided retry time; no polling/retry storm. |
| Timeout, cancellation, crash or uncertain teardown | Use existing lifecycle/cleanup semantics; never publish a clean result. |
| No changes | Record an explicit successful skip only when the pinned comparison confirms no changes in scope; otherwise block the discrepancy. |

Exit and structured gate must agree. Never infer completion just because findings arrived. Raw stdout truncation alone need not block if the independent bounded structured result is complete and durably retained; loss of the structured result does block.

The session must verify each actionable finding and repair valid issues. For a false positive, it records its reasoning and requests an explicit operator decision using the existing workflow node-disable/recovery controls. It cannot silently turn a failed Command into a pass, clear CodeRabbit stored findings as a bypass, or mark a dismissal as a verified fix. Preserve that distinction in repair instructions. No new automated dismissal database or GitHub comment writes are required.

Re-evaluate after a repair on its new submission/head. The existing per-slot run allowance remains shared across duplicate nodes; when spent, CodeRabbit skips with a visible warning, without blocking or claiming a completed review. Full restart and operator-granted retry budgets keep existing semantics. Retrying an unchanged incomplete attempt must reuse pinned comparison identity and cannot reuse a previous successful review as evidence for changed code.

## No-Mistakes and workflow compatibility
Append a new built-in version after the latest shipped version at implementation time; do not hardcode a version number inferred from old plans. Preserve all prior node ids, versions, Persona settings, PR action and Inspector completion semantics. Add a distinct evaluation stage between typecheck/test/lint and the first Persona stage, using the same reusable CodeRabbit Command. The stage uses the YAML enablement and skip/block policy above for every repository, without requiring a saved Library override. Existing binding upgrades remain explicit.

Custom workflows can insert CodeRabbit wherever Command nodes are accepted, including grouped evaluation stages. It has no dependency on No-Mistakes identity. Avoid changing General Review or other built-ins implicitly.

Before: supervisor output -> short tail -> outcome/verdict -> repair delivery or Persona evidence.
After: captured repository YAML -> enablement and budget decision -> warning skip, Setup-linked error block, or supervised review; supervisor output -> bounded immutable command artifacts and short tail; CodeRabbit stdout additionally -> structured interpreter -> outcome. Run detail and attributed MCP retrieve artifacts on demand. Existing engine sends compact repair summaries to the owning session. No-Mistakes adds the optional CodeRabbit stage after basic checks.

## Non-goals
Arbitrary user-defined catalog slot creation; cloud/remote CodeRabbit review; uncommitted review overlays; automatic sign-in, installation, update or paid credits; GitHub thread follow-up changes; auto-applying suggestions; new top-level navigation; merge-policy changes; changes to CI/release/deployment configuration.

## Delivery and verification
Two phases, detailed in phased-plan.md and their individual files. Phase 1 ships usable general Command improvements. Phase 2 ships the complete CodeRabbit experience and No-Mistakes opt-in together.

Each phase includes migrations, old-record compatibility, HTTP/MCP authorization, cancellation/restart cases, focused node:test coverage and Playwright coverage of every changed UI behavior. Follow the isolated test loader in AGENTS.md. Run typecheck, lint, build, smoke and appropriate E2E/full-suite gates. Real CodeRabbit/model/GitHub operations remain faked in automated tests.

No code is implemented by this planning task. Only returned managed-plan Markdown paths are committed; HTML stays in the managed preview store and the scout report stays untracked. Schedule each phase only after the plan is pushed, with a planning-session merge prerequisite and direct prior-phase merge edges.

## Cross-phase audit
2026-10-30: R1-R9 reconciled with the operator's latest YAML-enable, 10-execution and nonblocking-exhaustion decisions and current code. Phase 1 owns generic output/policy contracts; Phase 2 consumes them and owns reviewer-specific configuration, parsing, comparison identity and workflow integration. No dependency points backward and no phase relies on an unmerged consumer to make its UI usable.
