# Preserve workflow evidence across SDK-to-terminal handoff

Status: Recommended direction accepted for detailed planning on September 28, 2026; implementation remains future work. The operator requested the phased-plan skill using this recommendation. See the [phased implementation index](phased-plan.md) and [rendered review page](phased-plan.html).

## Recorded operator decision and scope

The operator selected the managed transfer recommendation in chat: “i'd like you to use the phased-plan skill to plan out a fix for this in depth using your recommendation”. There is no separate submitted decision form. This resolves the approach and authorizes decomposition; it does not authorize production implementation in this planning turn.

The repair covers managed terminal launch preparation and task/workflow continuity. The investigated task's Backlog controls are a separate feature: the incident baseline lacked an idle return action and an own-row Reschedule action for a retained failed task. That separate Backlog feature has since merged in PR #1144. Preserving the task association prevents the handoff-induced “no task” refusal in that feature, but this plan does not recreate its UI or change Backlog eligibility.

Publication authorization updated September 28: the operator explicitly requested “create pR with the plan”. That later instruction authorizes the scoped planning commit, push and PR despite the earlier completion handoff. The existing workflow binding remains in place; this request does not authorize merge. Phase tasks are created only after their referenced artifacts exist in a verified pushed commit, and remain gated on publication by merge.

## Result we need

Continuing the same conversation in a terminal must preserve its ability to call Mission Control tools, its running task, and its pinned workflow. A successful transition must not mark the task failed, leave its workflow on the retired SDK session, change the workflow version, or strand registered evidence.

The existing contract in [sessions.md](../../sessions.md#continue-in-terminal) already promises that the task follows the conversation. This proposal repairs that contract.

## Verified diagnosis

- The SDK supplies Mission MCP through its launch options. The current terminal handoff calls `resumeArgvFor` and spawns the returned argv without Mission MCP registration or a required-tool handshake. See `src/server/sdk/handoff.ts:125`, `src/server/harness/index.ts:122`, and `src/server/harness/claude/sdk.ts:1302`.
- Before discovery creates the terminal card, its resume hook can resolve by native conversation ID to the exiting SDK card. The hook sets that card idle, and `TaskManager.rebindTaskAtCwd` puts the task back on the retiring SDK session. Its existing eviction timer then marks the task failed. An isolated diagnostic reproduces this sequence.
- Workflow bindings retain a concrete session ID. SDK removal orphans them; ordinary task workflow binding does not transfer that pinned binding. Evidence registration requires an active Persona binding, but supports terminal sessions.
- Evidence staging is keyed by native conversation identity through `noteKeyFor`. There is no need to copy evidence into a new conversation when the native identity is unchanged.

The historical incident report at `docs/reports/sdk-terminal-evidence-handoff/report.html` retains bounded live evidence and exact timestamps in this planning checkout. It and the diagnostic evidence must not be committed. The findings here and the detailed phase guides are self-contained so implementation does not depend on that unpublished report.

## Recommended approach

Repair the managed handoff as one lifecycle operation. Reuse harness launch configuration and existing Registry, TaskManager, and WorkflowManager ownership. Do not weaken evidence authorization or rely on machine-global MCP installation.

### 1. Prepare a complete terminal launch before stopping the SDK

Use a shared managed terminal resume preparation seam, composed with the existing harness resume argv. It must carry the Mission tool transport, scoped daemon credentials, hooks where needed, terminal identity, and required-tool allow rules through the harness capability registry.

Reuse `missionMcpDescriptor`, the existing per-harness renderers, `kindMissionMcpRequirement`, and `verifyMissionMcpTools`. Requirements must include the active pinned Persona binding, even if the task has no dispatch-time workflow selection. Preserve task-kind requirements for scouts, plans, and ensemble members as applicable.

Mint a fresh disposable terminal state home. Do not retain the SDK's `MISSION_SESSION_ID`, pane identity, or soon-to-be-cleaned credential file. The terminal wrapper owns cleanup after launch. A failed preparation leaves the SDK and bindings untouched; a failed spawn releases the unused prepared home.

Apply the preparation seam to both terminal backend routes. Review the exited-session resume route for the same missing registration so it cannot remain an alternative route into this failure. Preserve each harness's existing permission-mode and conversation-resume semantics.

### 2. Reserve the transfer and verify its successor

Record a narrowly scoped transfer reservation before clearing the source task pointer. It must identify the source session, native conversation, task if any, pinned workflow bindings, and intended terminal launch. Persist the minimum facts needed to reconcile a daemon restart.

While reserved, a terminal hook must not revive the stopped SDK projection or rebind the task to it. Retain its terminal overlay for discovery. Do not globally discard all hooks for exited sessions: ordinary terminal rediscovery and context-reset semantics still need their existing behavior.

Adopt only a distinct, live terminal session with the expected agent, native conversation, checkout and exact launch proof. A cwd match alone is insufficient. For multiplexers, require the launched resource/pane identity; for emulators, reuse launch ancestry and resource proof.

Route both the immediate waiter and later discovery reconciliation through the same adoption operation. A discovery timeout leaves a pending transfer, not a failed task or a guessed owner. On restart reconcile the recorded launch without spawning it twice. Definite stop/spawn failures keep the existing TaskManager settlement and rollback behavior.

### 3. Transfer the pinned workflow and preserve evidence identity

WorkflowManager participates in the authorized transfer: it suspends deliveries across the ownership gap and transfers the existing binding to the verified successor. Preserve the pinned version, run identity, round, segment, staged evidence generation, and coverage.

An expected source `session_remove` must not orphan a transferred binding. If the source disappears before discovery, hold transfer provenance until the successor is verified. Handle both event orders idempotently.

Keep immutable submissions unchanged. Pending or uncertain deliveries retain their existing acknowledgement and retry-confirmation rules; never replay an uncertain message automatically. Do not call ordinary `reattach` blindly: that recovery operation sets `reattached_resubmit_required`, which is not transparent continuity.

A changed native conversation or conflicting target binding fails closed with an explicit recovery reason. Manual reattachment remains the recovery path for genuinely different conversations, not an automatic cwd guess.

## Request flow

Before:

```handoff-flow
SDK with Mission tools
Bare terminal resume
Hook can revive retiring SDK
Task fails; binding orphans
```

After:

```handoff-flow
Prepare tools and verify bundle
Reserve transfer; stop SDK
Verify terminal and launch identity
Transfer task and pinned workflow
```

Registry remains the only session owner and eviction path. TaskManager owns task settlement. WorkflowManager owns binding/run changes. The daemon remains the only database writer.

## Acceptance criteria and regression coverage

| ID | Required behavior | Focused proof |
| --- | --- | --- |
| H1 | A managed terminal successor exposes `submit_workflow_evidence` and can register command output, an ignored screenshot, and coverage. | Fake-agent terminal launch plus authenticated evidence route; real MCP initialize/tools-list against the built bundle, without model calls. |
| H2 | A resume hook arriving before discovery cannot revive/rebind the retiring SDK owner. The task stays running on its verified successor after source eviction. | Convert the isolated diagnostic into permanent regression tests; exercise discovery before and after eviction. |
| H3 | The same binding and immutable workflow version survive, including active runs and staged/frozen evidence. | Pin an older version, publish a newer one, hand off, then verify binding/run IDs, round/segment and evidence identity remain correct. |
| H4 | A missing required tool or preparation failure leaves the SDK usable; spawn/stop failures and timeouts have explicit outcomes. | Inject each failure, late discovery, repeat/concurrent requests, and daemon restart with a pending transfer. Verify no duplicate launch or resource leak. |
| H5 | Wrong conversation, wrong pane, same-cwd unrelated process, and conflicting target workflow cannot acquire the transfer. | Negative lifecycle tests, preserving valid terminal rediscovery and context-reset tests. |
| H6 | The dashboard's Continue in terminal action retains the task and workflow, and evidence reaches the review tray. | Playwright fake-agent spec covering the actual UI action, server transition and rendered result. Follow `e2e/README.md`; use accessible selectors. |

## Implementation order and validation

1. In Phase 1, write permanent launch/preflight regressions for the transport portions of H1 and H4. Keep the incident diagnostic as gitignored evidence only.
2. Complete Phase 1 with the prepared terminal launch seam, scoped configuration lifetime, both backend routes, exited resume and its browser proof.
3. In Phase 2, write permanent H2-H3 lifecycle regressions, then add the durable reservation, hook/adoption guards and restart reconciliation.
4. Transfer pinned workflows and preserve delivery/evidence semantics in that same Phase 2 merge; cover H4-H5 negative paths.
5. Complete H1-H6 end-to-end acceptance, update the lifecycle and session docs, then run the affected tests, typecheck, lint, build, smoke and focused browser specs. No model tokens are needed for these checks.

Treat these as one coordinated repair delivered in two merge units. Phase 1 repairs the independently testable launch contract on the existing resume routes. Phase 2 completes the durable task/workflow transfer using that contract. Phase 1 does not claim to fix the ownership race, and the final handoff acceptance criteria require both phases. Task transfer, workflow transfer, source-removal guards, and restart reconciliation stay together in Phase 2 because separating them would introduce conflicting owners or unsafe intermediate behavior.

## Alternatives considered

- **MCP configuration only:** smaller, but the reproduced task failure and workflow orphaning remain.
- **Automatically attach the latest workflow by cwd:** unsafe; can change the pinned version, lose active-run continuity, or target an unrelated session.
- **Managed transfer with launch and workflow continuity:** recommended. More lifecycle coverage, but restores the existing user-facing promise.

## Claims and limits

Verified: the missing launch registration, the early-hook race, the original binding's orphaned state, and the current empty evidence tray. The isolated control proves terminal evidence intake works with an active binding.

High confidence (95%, inferred from the matching launch omission, process flags and tool-removal record): losing launch-scoped MCP during handoff caused this session's missing tool. The underlying MCP child exit/error log was not retained in the inspected transcript; this is not a claim about a particular socket or credential error.

No unconfirmed load-bearing assumption is needed for the proposal. Actual fixes and integration/browser acceptance are future work. This task does not authorize restarting the other active agent, rewriting its state, or bypassing workflow preflight.
