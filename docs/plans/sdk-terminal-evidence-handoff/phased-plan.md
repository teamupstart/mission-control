# Reliable SDK-to-terminal handoff: phased implementation

Status: implementation design ready for review; phase tasks scheduled; planning PR awaiting merge. No implementation has been performed. Prepared September 28, 2026 against checkout `7db363f462737dfb428ce40252dbcc9de667166c`.

Future implementers start with the [accepted source plan](plan.md). The [rendered index](phased-plan.html) provides a review page. The two phase files are the implementation guides; this index owns their order and shared contracts.

## Outcome and accepted decisions

Continue in terminal must preserve the same conversation's Mission tools, running task, pinned workflow versions, active runs, and evidence. Preparation must fail before stopping a usable SDK session. A slow or uncertain terminal launch must not cause a second launch, a guessed task owner, or lost work.

The operator selected the recommendation and requested phased planning in chat on September 28. No approach choice remains open. The implementation stays in Mission Control, the current repository; no additional repositories are required. The prior investigation is historical evidence, not a deployed fix. The Backlog feature in the investigated task remains outside implementation scope.

Recommended sequence:

1. [Managed resume tools](phase-1-managed-resume-tools.html): prepare the complete transport and its lifetime before stopping the SDK.
2. [Durable ownership transfer](phase-2-durable-runtime-transfer.html): move the task and all workflow bindings together, with crash recovery and browser proof.

## Repository findings and reconciled decisions

These are source observations at the investigation baseline above. Publication preflight fast-forwarded this branch to `1676a398` and reviewed the five intervening commits. The Backlog controls landed in PR #1144; PR #1148 added final-completion and safe-Kill worktree return. Neither changed the SDK handoff or workflow transfer gap. Every phase must re-read the named owners after pulling its prerequisites and adapt if they have changed.

| Verified finding | Decision for this plan |
| --- | --- |
| `src/server/sdk/handoff.ts` calls `resumeArgvFor`, clears the task pointer, stops the SDK, launches, then waits by cwd. Its exclusion is an in-memory supervisor set. | Keep the existing entry points and stop/drain contract. Add complete launch preparation first, then one durable transfer coordinator. Do not build a second dispatch pipeline. |
| `routes.ts` has both `/api/sessions/:id/handoff` and the selected-backend `/launch` handoff. Its exited-session resume arm also uses bare resume argv. | All three consume the prepared resume contract. Active handoff and managed exited-session continuation share transfer protection where an active task or workflow still exists; settled task outcomes are never reopened. |
| `mission-mcp.ts` owns descriptors, tool names and real built-bundle verification. Codex launch preparation mixes optional dispatch posture with hooks/MCP; Pi has an installed extension rather than an MCP client. | Extend harness capabilities with resume preparation, reuse their renderers, and retain the original permission posture. Do not call a dispatch helper with auto mode enabled or force Pi through an MCP-client path. |
| `claudeMissionMcpArgs` currently writes one shared config path. `launchAgentTerminal` creates another state home internally. `agent-subprocess-env.ts` also removes parent-tracked homes at daemon exit; its startup sweep only expires Pipeline caller files. | Prepared resumes use one private home and a durable resource lease. Wrapper claim transfers cleanup ownership; uncertain unclaimed launches use atomic revocation and restart reconciliation in Phase 1. Do not delete a live terminal's credentials on daemon shutdown or defer orphaned credential cleanup to Phase 2. Preserve existing dispatch behavior unless sharing the mechanism requires a bounded compatibility edit. |
| `Registry.findSessionByEnv` can select the lingering SDK by native ID; `rebindTaskAtCwd` then binds an unowned running task. | Reserved transfers exclude the source from successor-hook attribution and exclude reserved tasks from generic cwd rebinding. Preserve overlays and ordinary non-transfer rediscovery. |
| `adoptTerminalLaunch` checks emulator ownership, but `verifiesEmulatorLaunch` returns true for non-emulator homes. `SpawnedHome.launchProcess` and `launchStateHome` are transient. | Do not treat that helper as a complete handoff proof. Require a distinct live terminal, unchanged conversation/scope, and exact launch/resource proof for both backend axes; persist the minimum recovery facts. |
| Workflow `session_remove` and first-discovery reconciliation orphan missing owners. Ordinary `reattach` requires a new resubmission. | Add a guarded transparent transfer operation to WorkflowManager/WorkflowStore. Both removal and startup read the same transfer reservation. Keep manual reattach semantics unchanged. |
| Active binding uniqueness is `(note_key, repo_root)`; `activeBindingForNote` returns only the primary binding. | Capture and move every active sibling binding, preserving secondary repository paths and versions. Do not replace a sibling's checkout with the primary session cwd. |
| Evidence and work queues use conversation identity; deliveries, task pointers and several projections also name session IDs. | Keep evidence generations, immutable submissions, intent provenance and delivery history intact. Revalidate only mutable delivery targets. A transport change never becomes an automatic retry of uncertain delivery. |
| SDK restore precedes terminal discovery; task startup reconciliation can start from construction. | Load reservation guards before either restore or destructive task reconciliation. Complete observation-dependent recovery after first discovery, before orphan/settlement callbacks make irreversible decisions. |
| Existing Ghostty E2E boundary fakes process/terminal I/O while preserving production discovery and Registry. | Extend that fixture for actual MCP child traffic and early hooks. Do not fabricate successful Session, Task or workflow state in the browser spec. |

Confidence: high for these directly inspected source contracts and the previously reproduced race. The historical cause of tool loss remains the report's 95% inference, not a claim about an unobserved MCP child error. The durable state machine and new seams below are design decisions, to be verified by the implementing phase, not existing APIs.

## Sizing and phase-count rationale

Estimate **1,450 to 2,350 gross non-test production lines** added or materially changed, excluding documentation and tests. Phase 1 is approximately 650 to 1,050 lines across harness preparation, scoped configuration, durable resource leases and their wrapper/startup/diagnostic integration, plus three route consumers. Phase 2 is approximately 800 to 1,300 lines across storage, coordination, Registry/task/workflow integration, recovery projection and browser behavior. The Phase 1 estimate includes the resource lifetime gap identified in review. Tests may be comparable in size; they are not included in the estimate.

Assumptions behind the range: reuse existing terminal adapters, process ancestry checks, WorkflowStore transactions, evidence intake, and recovery UI primitives. No new agent protocol, MCP tool, external service, terminal backend, or generalized job framework is required. If implementation needs one, revise the estimate and phase contract rather than hiding it in a helper.

Two phases are justified by one independently useful merge boundary: complete managed resume launches can be verified without changing durable task/workflow ownership. Combining both would mix configuration and credential lifetime with a multi-owner, crash-sensitive state machine. Splitting Phase 2 further would be less safe: task adoption, workflow adoption, hook suppression and restart reconciliation must agree in the same merge. A separate test, UI, migration or cleanup phase would leave the behavior incomplete, so those belong to their owning phase.

## Phase table and dependency graph

| Phase | Outcome | Direct merge prerequisites | Guide | Task status |
| --- | --- | --- | --- | --- |
| 1 | Every managed terminal resume carries the right Mission tool transport and launch environment, verified before SDK stop. | Planning artifacts published by this session. | [Phase 1](phase-1-managed-resume-tools.md), [rendered](phase-1-managed-resume-tools.html) | `339ddb4d-e54d-4756-9fb7-c130d81e1507`; Backlog, gated on this session. |
| 2 | One durable operation transfers task and all pinned workflows to a proven successor, survives restart, and shows actionable uncertainty. | Phase 1 and planning artifacts published by this session. | [Phase 2](phase-2-durable-runtime-transfer.md), [rendered](phase-2-durable-runtime-transfer.html) | `c9935d46-24e6-403d-8fbe-8a3a02d44679`; Backlog, gated on this session and Phase 1. |

```handoff-flow
Planning artifacts merged
Phase 1: managed resume tools
Phase 2: durable ownership transfer
H1-H6 acceptance satisfied
```

There are no concurrent implementation groups. Merge order is planning publication, Phase 1, then Phase 2. Each future task also directly depends on this planning session; the Phase 2 task additionally depends on the returned Phase 1 task ID. Never substitute a guessed session ID or flatten those requirements into text alone.

## Cross-phase contracts

| Contract | Owner | Consumer and invariant |
| --- | --- | --- |
| Prepared managed resume | Phase 1 | Phase 2 calls a harness-owned preparation seam yielding absolute executable/argv, exact verified transport descriptor or extension result, disposable state-home handle, and cleanup ownership. It does not compose agent flags itself. |
| Credential-home lease and recovery | Phase 1 | Persist before provisioning/launch; atomic wrapper claim versus revocation fences delayed commands. Phase 1 reclaims never-started attempts across restart and retains claimed/ambiguous owners. Phase 2 references the same lease ID and consumes its outcome; it does not implement another collector. |
| Requirement derivation | Phase 1 | Derive task-kind, ensemble membership and active pinned Persona requirements from durable/current owners, including a taskless manually bound workflow. Do not use only `Task.workflowId`. Preserve repository write scopes. |
| Launch outcome knowledge | Phase 1 | Definite non-launch, successful launch and outcome-unknown remain distinct. The resource lease persists before launch side effects; Phase 2 adds the task/workflow reservation around it. Neither layer retries an unknown spawn automatically. |
| Transfer identity and durable reservation | Phase 2 | One source session/native identity/episode, optional task, full active binding set and exact launch attempt. Task, Registry, Workflow and startup code all consult this single record. |
| Adoption commit | Phase 2 | Task pointer, all binding session pointers and adopted reservation commit consistently before SSE observers can act. No awaiting external work inside a SQLite transaction. |
| Evidence continuity | Phase 2 | Stable `noteKeyFor`, staged generation and coverage survive. Frozen `(round, segment)` submissions, canonical criteria, repository scope, work provenance and sent/uncertain delivery history are never rewritten to make a transition appear successful. |
| Failure presentation | Phase 2 | The response and persistent dashboard state distinguish preparation refusal, pending discovery and recovery required. Restart must not erase an unresolved handoff or trigger another process. |

Request flow after both phases:

```handoff-flow
Dashboard requests continuation
Harness prepares verified transport
Daemon reserves and drains SDK
Discovery proves exact successor
Task and Workflow owners adopt
```

During the gap, automated injections pause. After adoption, ordinary authorization, consent and evidence readiness still apply. The terminal's actual evidence tool calls reach the existing authenticated daemon intake; this plan adds no evidence bypass.

## Requirement ownership and final acceptance

Each source-plan implementation requirement has one owner. Tests in a prerequisite can support a later final acceptance criterion without moving ownership.

| Requirement | Implementing owner | Final proof |
| --- | --- | --- |
| Complete scoped resume launch; tools, hooks, permissions, both backend paths and exited resume | Phase 1 | Harness/HTTP tests plus a fake-agent MCP round trip and missing-tool refusal before stop. |
| Fresh home; no stale SDK/pane identity; recoverable cleanup ownership | Phase 1 | Credential isolation, terminal survival across shutdown, never-launched 504 before/after restart, atomic claim/revoke races, duplicate-attempt suppression and fail-closed path/process checks. |
| Durable reservation, early-hook guard, exact successor, timeout and restart behavior | Phase 2 | Lifecycle and crash-point tests with positive and negative ownership proofs. |
| Pinned bindings/runs/evidence continuity, delivery hold and conflict handling | Phase 2 | Multi-repo and taskless workflow tests including old pinned versions and existing frozen evidence. |
| Dashboard continuity and recoverable failure | Phase 2 | Browser action through production routes/discovery/SSE to task, workflow and evidence tray. |

The source plan's H1-H6 are end-state criteria owned by Phase 2's exit audit: H1 actual evidence submission uses Phase 1's transport; H2 proves event-order safety; H3 proves binding/run/evidence identity; H4 combines Phase 1 preparation refusals with Phase 2 stop/spawn/restart outcomes; H5 proves identity/conflict refusals; H6 proves rendered behavior. Neither the planning checks nor a passing Phase 1 establish all six.

## Verification strategy

Each phase lists concrete existing test files and proposed additions. Run focused tests first, then typecheck/lint and build/smoke for changed runtime surfaces. Browser behavior is covered in the introducing phase with a real Playwright spec using fake agents. The repository's ordinary CI remains the broad gate; no production agent, operator DB, live target worktree or external model call is a fixture.

Register focused exact command outputs, ignored screenshots and criterion mappings through `submit_workflow_evidence` after final relevant runs. Evidence stays gitignored. Do not include the historical report, incident IDs, raw transcript, private launch config or credentials in implementation commits. Source references and synthetic regression fixtures must make the implementation guides usable without the historical report.

Planning baseline check: 64 of 66 existing focused cases passed inside the sandbox; the two process-inventory cases could not recognize their spawned wrappers there. Re-running the affected `terminal-launch-identity.test.ts` file with scoped process access passed all 16 cases. These are baseline contract checks, not proof of the proposed fix.

Planning verification is separate: source-contract review, cross-phase audit, local link/path and dependency checks, HTML parity, offline dark/light renders, narrow-screen overflow and contrast checks. The planning turn does not claim that implementation regression tests pass against a fix that does not exist yet.

## Publication and phase task map

The operator explicitly requested the planning PR on September 28, superseding the earlier no-commit/push/PR handoff for these plan artifacts. Mission Control still reports the No-Mistakes Review v20 binding with `foreman_complete` trigger; that binding is not removed or rewritten. This direct operator request authorizes the planning PR, not merge or implementation.

The goal-level briefs and returned task IDs are recorded in [task-map.json](task-map.json). Both tasks were created after all nine plan artifacts were verified at pushed commit `eaf4d80e11cf7fd7f3cc6355b9ccf33581ac89d1`. Mission Control returned the current repository as the sole canonical repository for each task. Both tasks directly depend on this planning session. Phase 2 also directly depends on Phase 1. Both remain in Backlog until their prerequisites merge. All implementation stays in the current Mission Control repository.

Publication sequence:

1. Publish only the source/index/phase Markdown and HTML plus the task map. Exclude the historical report and all `.evidence/` content.
2. Verify every task pointer against the pushed commit before creating tasks.
3. Create Phase 1 with `dependsOnCurrentSession: true`; verify the returned canonical repository set before using its returned ID.
4. Create Phase 2 with the returned Phase 1 ID as its only `dependsOnTaskIds` entry and `dependsOnCurrentSession: true`. Stop dependent creation on failure; never recreate a successful task speculatively.
5. Publish the returned IDs in this index/task map and open the operator-requested planning PR. No merge is authorized by this request.
6. The planning PR's observed merge publishes the paths and releases Phase 1. Phase 2 remains gated on Phase 1's observed merge. Workflow success or PR creation alone does not release either prerequisite.

## Cross-phase audit record

- Initial audit, September 28: accepted managed-transfer recommendation; Backlog UI excluded; two phases selected after sizing. Phase 1 owns launch configuration, Phase 2 owns all durable ownership changes.
- After Phase 1: the prepared home must be passed through both launch paths, including outcome-unknown. Phase 2 must not mint a second home or reconstruct its descriptor. The shared Claude config path and parent exit cleanup need explicit compatibility coverage in Phase 1.
- After Phase 2: task and workflow adoption remain one commit boundary; siblings keep their repository scopes; startup guards load before restore/cleanup. No independent concurrency remains. Recovery UI and E2E are included in Phase 2 rather than a later cleanup phase.
- Final audit: H1-H6 each have an end-state owner; each detailed source requirement has one implementing phase; the only direct implementation edge is 1 to 2. Scheduling requires verified pushed artifacts. The task map contains no invented IDs.

- Verification reconciliation: source/phase documents are self-contained; unit tests use fixture MCP bundles without a build prerequisite, while browser proof uses the built production bundle. Phase 2 includes SDK startup/reset compatibility and guarded recheck/resolution APIs.

- Source-plan ordering reconciled with the two merge units. Successor episode IDs may differ while native conversation and task attempt remain stable; existing PR-bearing episode archival is preserved.

- Publication preflight: the later operator request authorizes the planning PR. The branch is current with `1676a398`; Phase 2 must preserve PR #1148 final-completion/safe-Kill cleanup policy while guarding unresolved runtime transfers. The separate Backlog work in PR #1144 is already merged.
- Inspector round 1 reconciliation: Phase 1 now owns durable credential-home recovery and its merge criteria, including a backend that returns 504 without starting anything. The wrapper claim/revoke fence makes safe reclamation possible without treating age as process-death proof. Phase 2 consumes this primitive while retaining all task/workflow ownership guards. Sizing was revised; phase count, task IDs and dependency edges remain unchanged.
