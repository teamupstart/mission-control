# Phase 1: complete managed terminal resume launches

Guidance for the future Phase 1 implementer: read [plan.md](plan.md) and [phased-plan.md](phased-plan.md) first. This guide is the proposed route, not a specification of internal APIs. The fixed goal is that a managed terminal resume receives the correct tool transport and scope before a usable source SDK is stopped. Adapt to repository changes and record deviations with reasons in the PR.

## Outcome, entry and scope

An operator continuing a conversation in a terminal keeps Mission tools and its permission posture. A missing required tool or unusable launch configuration produces an actionable refusal while the original SDK remains usable. The prepared environment has one explicit lifetime, including uncertain terminal launches.

Direct prerequisites: the planning session's artifacts must be published. There are no preceding implementation phases. Work is entirely in Mission Control; attach no other repositories.

In scope: harness resume preparation, required-tool derivation, fresh scoped environment/config, recoverable credential-home leases, default and selected terminal launch arms, exited-session resume, and focused integration/browser coverage for those changes. Non-goals: durable task/workflow transfer, new Backlog controls, automatic workflow reattachment, new MCP tools, global integration installation, new terminal vendors, and redesigning all dispatch.

Phase 1 is useful independently, but the known early-hook task/workflow race remains until Phase 2. Do not update operator docs to claim transparent lifecycle continuity yet.

## Repository contracts to preserve

- `src/server/harness/index.ts` owns `resumeArgvFor`; `ResumeSpec` in `harness/types.ts` supplies harness-specific grammar. Resume must remain separate from SDK support.
- `src/server/mission-mcp.ts` owns descriptors, names, renderer functions and `verifyMissionMcpTools`. Check the exact descriptor used by the launch, not another newly resolved object.
- `kindMissionMcpRequirement` owns task-kind requirements. `WorkflowManager.agentEvidenceBinding` and immutable version inspection demonstrate that a manually attached workflow is authoritative even when `task.workflowId` is empty. Secondary bindings must also be considered when deciding whether any Persona requires evidence.
- `src/server/ensembles/member-launch.ts` requires `submit_ensemble_result` independently of task kind. Read membership from existing ensemble ownership, not title or transcript text.
- `src/server/mission-tools.ts` reads `missionTools` capability: Claude/Codex use MCP clients; Pi uses its installed extension. Preserve this distinction.
- `src/server/harness/codex/launch.ts` includes dispatch posture as well as configuration. Reuse/extract its registration and hook rendering; never let dispatch auto-mode overwrite a resumed permission mode.
- `src/server/ask-channel.ts` composes redirect text and tool flags together. Do not add an unpaired `AskUserQuestion` ban or a second `--append-system-prompt`. Mission transport registration for a resume does not itself require replacing the conversation's question policy.
- `spawnUniquely` in `dispatcher.ts` accepts a state home. `launchAgentTerminal` in `terminal/targets.ts` currently allocates its own. Both end in `isolatedAgentArgv` and a cleanup wrapper.
- `reconcileDisposableAgentStateHomes` currently expires only `pipeline-caller-*.json` files; it cannot reclaim an abandoned resume home or its `loopback-token`. A wrapper's exit trap cannot run if the backend never starts it. Phase 1 must close that resource gap itself.

## Implementation sequence

### 1. Pin the launch regressions and contract

Extend `test/harness-resume.test.ts`, `test/sdk-answer-http.test.ts` and `test/session-launch-http.test.ts` before changing production behavior. Assert the argv/config actually handed to the fake terminal, including the final command inside the isolation wrapper. Show that the baseline lacks launch-scoped Mission registration. Exercise both `/handoff` and `/launch`, and the exited-session resume arm.

Introduce a server-only prepared-resume value, preferably in a small `src/server/harness/resume.ts` module with a harness-owned preparation slot in `HarnessDaemonSlots`. This is a proposed filename/API, not an existing module. Keep `resumeArgvFor` responsible for binary resolution and conversation/mode grammar. The value should carry:

- absolute executable and final unwrapped argv;
- the single disposable state-home handle and explicit dispose/transfer ownership behavior;
- a durable credential-home lease ID and guarded claim/revoke operations, separate from task/workflow ownership;
- required Mission tool names and verified transport result, with the exact descriptor for MCP-client harnesses;
- any hook/instrumentation facts the existing launch consumers need;
- write scope inherited from the task's primary and attached worktrees, using existing scope helpers.

The preparation seam takes a resolved launch context. It does not query SQLite from a harness adapter or make the adapter interpret workflow graphs. An owner-level composer in the existing route/handoff layer asks TaskManager/WorkflowManager/ensemble ownership for requirements and passes plain values down.

### 2. Resolve requirements from the live conversation

Union task-kind tools, current ensemble obligations, and evidence submission when any active pinned binding's immutable graph supports Persona evidence. Taskless/manual bindings are a required case. Preserve known launch-scoped Mission tools for an SDK conversation even when no task kind mandates them; do not fall back to “optional descriptor, continue without tools” for the managed handoff this repair promises.

Use the existing complete tool vocabulary as the conservative preflight set for a managed SDK resume whose previously available tool subset cannot be recovered. Do not invent a persisted launch-tool ledger just to recover a subset. Normal dispatch with an empty requirement retains its existing no-probe behavior.

For an exited managed session, derive what remains from its task/binding owners without reactivating an old task. For a discovered, unmanaged conversation, preserve current resume semantics and capabilities; this work must not convert external sessions into managed task owners. Required capabilities that cannot be established fail before launch with a precise reason.

### 3. Render an isolated transport without changing conversation policy

Reuse `missionMcpDescriptor(cwd, stateHome)` and `verifyMissionMcpTools(required, descriptor)`. Extend Claude's renderer to accept an explicit per-launch config path under this home while preserving the old default for existing callers. Write that file atomically and privately. Two resumes in different repositories must not overwrite each other's descriptor or credential location.

Compose Codex's MCP overrides and launch hooks with `resumeArgvFor` in the grammar accepted by the installed CLI. Preserve sandbox, approval/reviewer profile, and native conversation identity. Do not add model/effort overrides that replace values restored by the native conversation. Keep the hook trust flag coupled to actual hook overrides, following current managed-launch policy.

Pi must use `missionToolsAvailability` and the installed extension's verified bridge, not an unsupported MCP descriptor. Add capability-level tests for every current harness. A missing required extension refuses preparation while the SDK is still live.

Mint a fresh descriptor from the daemon context. Explicitly remove stale source `MISSION_SESSION_ID` and pane identifiers from the new transport context, while allowing the actual terminal to supply its own pane identity. Preserve native conversation identity through resume argv and existing hook/MCP resolution. Inspect extra-directory handling so attached worktrees retain exactly their existing write scope; do not widen it to the repository parent or operator home.

### 4. Carry one home through all launch consumers

Prepare before clearing the task or stopping the SDK in `sdk/handoff.ts`. Thread the prepared home through the default `spawnUniquely` path and selected-backend adapter in `routes.ts`. Extend `launchAgentTerminal` with an optional owned prepared home or equivalent narrow input; retain its existing behavior for callers that do not provide one. Do not wrap the command twice.

The ownership transitions are:

| Boundary | Owner and cleanup |
| --- | --- |
| Preparation, verification or stop fails before launch | Preparation owner revokes its unclaimed lease and disposes the unused home. Existing stop-failure task rollback remains unchanged. |
| Terminal definitely did not launch | Caller revokes an unclaimed lease and disposes; conflicting claim or uncertain backend cleanup is not a definite non-launch. |
| Backend reports success, wrapper has not claimed | Lease remains pending until the wrapper claims or the bounded start deadline permits revocation. An acknowledgement alone cannot transfer cleanup ownership. |
| Wrapper claims and starts the agent | Wrapper owns cleanup until the agent exits. Remove that home from the daemon's exit-cleanup set without deleting it. |
| Terminal launch result is unknown, including selected-backend 504 | Phase 1's durable lease retains the home, blocks a duplicate attempt and resolves an unclaimed launch through atomic revocation. A claimed or ambiguous owner is observed, never deleted by age. |
| Agent exits | Wrapper completes its lease and removes its home; repeated cleanup and restart reconciliation remain safe. |

Add the smallest explicit ownership-release helper to `agent-subprocess-env.ts`; do not remove cleanup for SDK or unlaunched homes. An orderly daemon restart while the terminal survives must not remove its config, credential or marker. Resource recovery below ships in Phase 1 and does not depend on Phase 2's task/workflow reservation.

### 4a. Make unknown-launch resources recoverable before this phase merges

The prepared home needs a small durable resource lease, owned by `agent-subprocess-env.ts` or a focused sibling module. Persist it before credential provisioning and external launch. Use a private control directory outside the credential home, partitioned by the owning daemon's stable state identity, with an unguessable attempt ID and validated canonical home locator. Record version/revision, conversation key, creation/start deadline, claim state and exact wrapper/process lifetime when known. No credential value or full argv belongs in the lease. Neither this journal nor its helper reads or writes task/workflow ownership or SQLite.

Every managed resume wrapper must claim that exact lease before reading the launch configuration or starting the agent. Claim and revoke share one crash-safe atomic exclusion mechanism across the daemon and wrapper processes; a check followed by a separate write is insufficient. The claim records the wrapper PID and start time within that boundary. A missing, revoked, foreign or already claimed lease refuses execution without recreating credentials. The wrapper must use the same guard on both terminal axes, including a command delivered late after a backend timeout. Include the local guard helper in the existing build/package contract and use fixture equivalents in source-only tests.

Use a bounded start deadline, proposed default two minutes from the persisted external-launch intent immediately before calling the backend; SDK drain time must not consume that budget. At expiry, the daemon tries to revoke only a still-unclaimed lease atomically. If revocation wins, no wrapper can subsequently start from that attempt, so remove its credential home and mark cleanup complete even when the backend returned 504 and created nothing. If claim wins, retain the home and observe its exact owner. Time merely schedules the revocation attempt; it is not evidence that a claimed process died. Revoked or missing tickets fail closed forever, so a delayed wrapper cannot race cleanup or recreate a deleted home.

Extend startup reconciliation in `index.ts` and add a bounded periodic sweep using that same resource owner. Reconcile interrupted provisioning, revocation and deletion idempotently. Reload unresolved leases before admitting another managed resume for the same conversation; return the existing attempt's bounded status instead of allocating another home. Inaccessible or malformed records stay quarantined with an actionable diagnostic and cannot authorize a recursive delete. Restrict every cleanup to a lease-owned canonical path beneath this daemon's disposable namespace; reject symlinks and foreign-daemon entries. Keep existing unleased SDK/dispatch homes on their current policy.

For a claimed attempt, normal wrapper completion releases the home. Crash recovery may release it only with positive proof that the exact wrapper and any agent using it have stopped; a missing marker, recycled PID, unavailable inventory or wrapper absence alone is insufficient. Expose a non-spawning recheck through the existing launch error/status path, with a documented recovery action for an exact owned resource. If stopping that resource is needed, use the existing terminal policy and ordinary confirmation; never offer raw path deletion or a guessed pane kill. Uncertain owners remain retained and visible, with no duplicate launch. This resource diagnostic belongs to Phase 1; Phase 2 adds task/workflow recovery presentation.

This is one resource-lifetime primitive, not a second session ledger. Phase 2 references its lease ID and uses its claim/revoke/reconcile result. It must not add a competing home collector or treat lease revocation as authority to settle a task. The lease's pre-claim fence is the concrete cleanup path for the review's never-launched 504 case, without deleting any live agent's credentials.

Use the same preparation in the exited `/launch` resume arm. Preserve the existing status/outcome semantics, default-backend uniqueness policy and selected-backend no-fallback policy. Do not leak config bodies, bearer values, or an argv containing secrets in errors. Keep existing human resume advice sanitized and clearly distinguish a bare manual resume from a managed continuation with tools.

### 5. Prove actual transport, then document the limited result

Add `test/managed-resume-tools.test.ts` as a focused fixture-driven transport suite if existing files become unwieldy. Launch the prepared MCP child against a disposable fixture bundle and perform a real initialize/tools-list through the rendered configuration, with no model request. A stub that only asserts a boolean `missionMcp: true` is insufficient. Reuse `test/helpers/mcp-fixture.ts` and the patterns in `test/mission-mcp.test.ts`. These unit tests must pass on a fresh checkout without pre-existing `dist/`; the built production bundle and its authenticated tool round trip belong to the browser/integration case below.

Extend the terminal-boundary Playwright fixture and add `e2e/specs/sdk-terminal-handoff.spec.ts`. In this phase its cases prove preparation refusal before stop and a taskless/manual-free SDK handoff whose resumed fake actually invokes a Mission tool. The terminal fake may read its supplied config and invoke the real built MCP bundle; it must not manufacture a registry session or make a direct authenticated HTTP call in place of the tool. Phase 2 extends this same spec with task/workflow continuity.

Update `docs/harnesses-and-terminals.md`, `docs/dispatch-and-runtimes.md` and the relevant Continue in terminal explanation with preflight and failure behavior. State that lifecycle continuity is completed by Phase 2. Update the E2E fixture guide for its new fake protocol. No release/deployment configuration change is planned.

## Verification matrix and commands

| Case | Required observation |
| --- | --- |
| Claude and Codex, default and selected backend | Resume grammar/mode unchanged; correct scoped config/hooks and required tools carried once. |
| Pi extension available/unavailable | Correct extension capability path or pre-stop refusal; no fake MCP registration. |
| Manually bound Persona, taskless binding, late workflow attachment | Evidence tool is required from live pinned binding, independently of `Task.workflowId`. |
| Scout, plan, ensemble member, attached repositories | Existing tool obligations and repository write scopes preserved. |
| Missing bundle/tool, invalid config path, preparation exception | Zero SDK stops and zero task/workflow mutations. SDK remains usable. |
| Stop error, definite spawn refusal, unknown spawn | Correct lease/home ownership and existing task failure/rollback semantics; unknown is not retried. |
| Selected backend returns 504 and never starts a wrapper, including daemon restart | Persisted unclaimed lease is revoked at its deadline; home and token are removed; repeated requests allocate no additional unresolved home. |
| Late wrapper races deadline or restart cleanup | Exactly one of claim/revoke wins. Revoked or missing lease starts zero agents; successful claim retains credentials until proven completion. |
| Crash during provisioning, claim, revocation or home deletion | Startup finishes safe cleanup or retains a proven/uncertain owner; no age-only deletion, duplicate launch or lost cleanup record. |
| Claimed wrapper survives restart, PID is recycled, inventory fails, or wrapper dies with a surviving child | Preserve live/ambiguous credentials; show recovery status; exact process proof governs eventual cleanup. |
| Corrupt lease, path traversal/symlink, foreign daemon, or legacy unleased home | Fail closed without deleting another owner's files or changing legacy cleanup policy. |
| Two simultaneous resumes | Independent config files and credentials; no stale SDK or unrelated pane identity. |
| Daemon shutdown with live terminal | Wrapper's files survive; final wrapper exit cleans them. SDK-only homes retain cleanup. |

Run the existing files plus the new focused suite with the repository's required test preload:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/harness-resume.test.ts test/sdk-answer-http.test.ts test/session-launch-http.test.ts test/mission-mcp.test.ts test/mission-tools-availability.test.ts test/agent-subprocess-env.test.ts test/managed-resume-tools.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
MC_E2E_EVIDENCE=1 npm run test:e2e -- e2e/specs/sdk-terminal-handoff.spec.ts e2e/specs/terminal-session-name.spec.ts --workers=1
```

The new suite/spec must be created before these commands are claimed as passing. Keep the build before smoke/E2E; use scoped outside-sandbox approval when required by the repository. Do not change production security settings to make a fixture work.

## Exit, merge and downstream handoff

Phase 1 can merge when all managed resume entry points consume the same prepared contract; focused transport, environment, refusal and browser checks pass; the never-launched 504 is reclaimed before and after daemon restart; claim/revoke race tests prove a late wrapper cannot use revoked credentials; docs accurately describe the partial repair; and there are no changes to durable task/workflow identity semantics. Add Playwright coverage for any visible resource diagnostic/recheck introduced here. Register final command output and rendered preflight evidence before completion. Commit/push/PR steps follow the implementation task's then-current handoff owner.

Phase 2 may rely on one prepared home, its recoverable resource lease, verified tool transport, preserved scope, and explicit definite/unknown launch outcomes. It must reuse the preparation and lease seams and extend existing launch proof, not duplicate agent argv, credentials or home cleanup. Phase 1 must leave no production feature flag or dead preparatory API for Phase 2 to enable.

## Cross-phase audit record

- September 28, initial: route inventory includes both active handoff paths and exited resume. No task/workflow schema work belongs here.
- Reconciled with index: fresh scoped config and daemon-to-wrapper cleanup transfer are inseparable from a correct transport launch. The same home must survive through Phase 2's persistent proof record.
- Final set audit: H1/H4 transport subproofs support Phase 2's end-state acceptance. The same browser spec is intentionally extended sequentially; phases cannot run concurrently. Durable adoption, orphan suppression and restart claims remain Phase 2 responsibilities.

- Final verification audit: unit protocol tests use disposable fixture bundles and run without `dist/`; the built production MCP round trip is in the browser suite after the explicit build.
- Inspector round 1 reconciliation: uncertain credential-home recovery, atomic wrapper claim/revoke, restart sweep and resource diagnostics move into Phase 1. Phase 2 retains task/workflow ownership recovery. The two-phase boundary now delivers independently complete resource lifetime safety; no unknown home waits for a later phase to gain a cleanup owner.
