# Phase 2: durable task and workflow ownership transfer

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md), and [Phase 1](phase-1-managed-resume-tools.md) first. The fixed goal is transparent task/workflow/evidence continuity to a proven terminal successor, with explicit recovery when continuity cannot be proven. This file proposes the implementation route; adapt to the repository and record justified deviations in the PR.

## Outcome, entry and scope

After Continue in terminal succeeds, the task is still running on the same conversation, every active pinned workflow belongs to the successor, and the resumed agent can register evidence for the same review. Hooks arriving before discovery, source eviction, slow launch and daemon restart must not change that result or launch a duplicate agent.

Direct merge prerequisites: published planning artifacts and Phase 1 merged. Require Phase 1's actual prepared-resume API, transport tests and state-home ownership behavior before coding. Do not recreate them from this document's suggested names. This phase changes only Mission Control.

In scope: one durable transfer reservation, lifecycle guards, exact successor verification, atomic task/workflow adoption, safe delivery retargeting, startup recovery, additive response/SSE presentation and browser acceptance. Non-goals: Backlog UI/eligibility, automatic resubmission, new workflow versions, evidence authorization bypass, a second eviction path, broad session merging, migration of historical orphaned incidents, or automatic repair of another active task.

## Findings and inherited contracts

`sdk/handoff.ts` has an in-memory claim and an immediate cwd waiter. `Registry.findSessionByEnv` and `TaskManager.rebindTaskAtCwd` can reconnect the retiring SDK before its eviction; the incident diagnostic proved that event order with the real managers. `Registry.adoptTerminalLaunch` already persists ordinary emulator task launch proof, but it is not an agent/native-identity verifier and does not transfer workflows. `terminal/launch-process.ts` checks process start times and ancestry; use those checks rather than PID-only or cwd-only matching.

`WorkflowManager.start` handles both `session_remove` and first-observation reconciliation. Both must recognize the same reservation. `WorkflowStore.reattachBinding` is used by explicit recovery that changes run behavior; do not call it as if it were transparent transfer. `activeBindingsForNote` supplies primary and repository siblings, while `activeBindingForNote` does not.

Phase 1 supplies one fully prepared home, exact tool transport, preserved permission/write scope and a distinction between definite non-launch and unknown outcome. Existing TaskManager disappearance settlement respects merged work and retains resources unless an explicit final-completion or accepted safe-Kill return authorizes cleanup. Registry remains sole session owner, `beginEviction` remains sole durable removal path, and WorkflowManager remains sole workflow policy owner. MCP and Foreman do not access SQLite.

## 1. Durable reservation and state machine

Start with failing lifecycle tests in a proposed `test/session-transfer.test.ts`, using the real Registry, TaskManager and WorkflowManager, injected launch/process observation, synthetic task/workflow IDs and disposable database state. Port the historical diagnostic's event order, not its live identifiers or file paths. Add the schema/store in `src/server/db.ts` and a small proposed `src/server/session-transfers/` module; this is orchestration state for this operation, not a replacement session/task ledger.

Use a single `session_runtime_transfers` table or equivalent narrow store. Store these facts:

| Group | Minimum durable facts and restrictions |
| --- | --- |
| Identity | Transfer ID and generation/revision; source Mission session ID; agent; native conversation ID and `noteKeyFor`; source work-episode ID; canonical primary checkout/repository; optional task ID and expected task ownership/status. |
| Workflow ownership | IDs and expected immutable versions of all active bindings for this source, with their existing repository scope. Capture mutable ownership expectations, not copies of graphs, submissions, or all run state. |
| Launch attempt | Selected/default backend policy resolved for this attempt; unique attempt identity; prepared home locator; launch-intent time; backend resource/home facts when known; wrapper PID plus process start time when observed; successor ID only after verification. No bearer, argv config body or raw credentials in SQLite or SSE. |
| State | Append-only state vocabulary, timestamps, bounded failure/recovery reason, launch outcome knowledge and completion time. Unknown persisted states fail closed and remain visible. |

Permit at most one unresolved transfer per source conversation and per task. Use transactional uniqueness/CAS, including a partial unique index for non-null task IDs, rather than trusting the supervisor set. Define unresolved-state predicates once. Terminal records can be compacted after a bounded retention period, but never expire a reservation still protecting an unknown live launch or required cleanup. References needed by an active reservation must survive task/session removal until that operation is explicitly resolved.

Suggested state vocabulary and transitions:

| State | What is known | Allowed next action |
| --- | --- | --- |
| `prepared` | Validated configuration and ownership reservation persisted; no stop side effect started. | Persist `stopping` before calling SDK stop; or abort without side effects. |
| `stopping` | The stop/drain call may have started. | On confirmed drain, persist `launching` before external launch. On definite surviving source, roll back to source and abort. On uncertainty, require recovery. |
| `launching` | Source is stopped; external launch may have started. | Record definite failure, acknowledged launch or outcome-unknown. A restart here never repeats spawn. |
| `awaiting_successor` | A terminal may be alive; exact adoption has not committed. | Observe and verify; adopt once, or enter visible recovery on timeout/conflict. |
| `adopted` | Task/workflow ownership and terminal launch proof committed to one successor. | Idempotent reads; cleanup only operation-owned metadata, not the live wrapper home. |
| `aborted` | Stop never started, or source was positively restored with no replacement launched. | Release guards and unused prepared resources; ordinary SDK behavior resumes. |
| `failed` | Source cannot continue and replacement is positively absent. | Existing TaskManager settlement and normal workflow orphan/recovery policy, retaining checkout/resources. |
| `recovery_required` | Process/ownership outcome cannot be proven, or a conflicting mutation occurred. | Non-spawning recheck or explicit resolution after proof; keep guards. No automatic resubmit or second launch. |

Keep the current 30-second synchronous discovery wait as a response budget, not a failure or cleanup deadline. When it expires, report pending observation and persist the reservation. A bounded further observation budget (proposed default: two minutes from the recorded launch attempt) changes presentation to recovery required; it never converts unknown liveness into absence. A later exactly verified successor may still finish that same transfer after all current-state checks pass.

Migration is additive: fresh schema plus upgrade path, indexes after any columns they depend on, no enum renames or reordering. An old database has no reservations and keeps ordinary behavior. Test migration twice against a pre-feature fixture. There is no blanket backfill from matching cwd or historical orphaned bindings. Downgrade while a transfer is pending is unsupported; document that limitation instead of promising old binaries understand the guard.

## 2. Reserve before any ownership gap

Introduce a small coordinator at the existing `handOffToTerminal` boundary. It composes the Phase 1 preparation seam with owner-provided operations; Registry, TaskManager and WorkflowManager keep their policies. Do not inject every manager into every other manager or duplicate their SQL in routes.

Execution order:

1. Resolve the live source, native identity, task/episode, all active bindings and the Phase 1 launch requirements. Reject conflicting transfer/reset/cleanup ownership and changed task scope. Preparation and required-tool checks finish while the source remains usable.
2. Claim the durable reservation with expected ownership values. Prevent new workflow binding changes or task reassignment from silently expanding that claim. Recheck requirements/versions if they changed during asynchronous preparation; dispose and retry preparation before stopping, never proceed with stale evidence obligations.
3. Hold new automated deliveries for this logical conversation and drain any already-started delivery boundary. A sending/uncertain delivery must retain its existing acknowledgement semantics. Refuse starting a handoff that cannot safely acquire the hold; do not force a replay or invent a successful acknowledgement.
4. Persist `stopping`, clear the SDK task pointer and current task session pointer through their existing owners, then await the supervisor's draining `stop`. The reservation protects the unbound task and active bindings until adoption or explicit failure.
5. On definite stop failure with a surviving handle, restore SDK row plus task pointer using the same expected ownership/episode checks, release the hold, abort, and dispose unused preparation. If the source is definitely gone, settle via TaskManager when no replacement could have started. Unknown source outcome enters recovery without spawning.
6. Persist `launching` and the prepared home's recovery locator before calling the existing unique/default or selected-backend launch path. Preserve the source telemetry cause. Capture launch proof and outcome as soon as returned. A backend 504 stays outcome-unknown, not a thrown definite refusal.
7. Feed immediate waiter observations and subsequent discovery into the same idempotent adoption method. Never let the route's timeout result become a second adoption path.

The exited-session `/launch` arm uses the same reservation/adoption protocol when a still-active task or active workflow needs continuity. It skips source draining only after positive source absence; it does not resurrect failed/done tasks or automatically reattach an already orphaned binding. A fully taskless/unbound resume still uses Phase 1 preparation and normal discovery without manufacturing a task.

## 3. Guard hook attribution, generic rebinding and writes

In `registry.ts`, scope hook/MCP identity matching to the reservation. A terminal hook for a reserved native conversation must not fall through to the retiring SDK session, even if that card still lingers. Keep the raw terminal overlay available so normal discovery can associate it later. The source's own late SDK events still follow the supervisor path and cannot cancel transfer guards.

Do not globally suppress exited-session hooks: test ordinary terminal rediscovery, pane reuse, context clear and unrelated native conversations. Once the successor is proven, existing identity resolution must choose it, not the retired source. Until then, an early tool call fails with a bounded retryable “handoff awaiting discovery” reason or uses already-proven ownership; it must never submit evidence under a guessed source.

Compatibility with merged PR #1148 is required: runtime transfer is neither final completion nor accepted Kill. It must not create a `task_worktree_returns` obligation or lend cleanup authority to an unbound interval. Existing genuine final-completion and safe-Kill return behavior remains intact; queued cleanup must recheck the transfer reservation before a destructive boundary. Include `test/workflow-handoff-worktree-retention.test.ts` and `test/task-worktree-return.test.ts` as compatibility checks.

In `tasks.ts`, reserved tasks are excluded from `rebindTaskAtCwd`, startup reclamation and agent-disappearance settlement until the coordinator resolves them. Keep non-transfer cwd recovery unchanged. A cleanup, cancellation, reschedule, new work episode or reassignment during the transfer must invalidate the adoption CAS; it cannot be overwritten by a late waiter. Destructive task operations must first resolve or safely terminate the exact pending launch, using existing task cleanup policy, before removing its checkout.

Use a shared transfer hold read by the actual mutation boundaries: SDK sends, `PendingTurnManager` acceptance/drain, Workflow delivery claiming and terminal injection policy in `actions.ts`. Cover queued work, Foreman injection and session-action deliveries through those existing boundaries, not with a second worker protocol. A queued human message may remain queued for the same note key; it is not delivered during the gap. Preserve uncertain pending turns and request-answer state. Do not call reset as a shortcut.

## 4. Verify one successor and commit ownership together

A candidate must satisfy every check below after external process inspection and again at commit:

- distinct Mission session ID, `runtime: terminal`, live state, same harness and native conversation;
- unchanged canonical primary checkout/repository and source task attempt; the reserved source episode has not rotated. The successor may have its own distinct discovered work-episode ID for the same native conversation; do not require it to equal the source ID;
- terminal backend/resource identity from this exact launch attempt, with PID/start-time ancestry where used;
- no other active task on the candidate, no conflicting active workflow in any affected `(note_key, repo_root)` slot, and no changed/archived captured binding;
- valid reservation revision and launch attempt that has not been failed, cancelled, adopted elsewhere or superseded.

For multiplexers, compare the returned pane/resource identity against observed terminal handles. A reusable home name alone is insufficient. For emulators, reuse exact inventory identity or `belongsToLaunch` with both process start times and the prepared wrapper marker. Persist the proof that is currently only transient in `SpawnedHome` in the transfer store, not by adding private filesystem paths to public Task state. If a backend cannot provide proof, leave pending/recovery visible; do not weaken it to cwd matching.

Ask owner-specific store operations to participate in one short daemon database transaction/CAS: mark the reservation adopted, bind the task to the successor and its work episode, retain the terminal home/proof, and update all captured active Workflow binding session identities. This requires factoring synchronous mutation portions from existing owners where needed; do not nest independent `BEGIN` transactions or emit SSE from rollback-capable code. Verification that awaits process inventory finishes before the transaction. Recheck revision, task/episode ownership and binding set inside it.

Use the existing `bindTaskWorkEpisode` transaction-aware archival path in `db.ts`: it preserves outgoing PR-bearing bindings in `historical_task_work_episode_bindings`. Retain task-owned pull-request and dependency provenance under the existing ownership rules, including attached repositories; do not replace these with a generic session merge or a new history ledger. Test that a later merge of the source episode still settles the same task correctly.

After commit, refresh Registry/task/workflow projections from durable rows before publishing their existing updates, then release delivery holds. Observers must not see a task upsert and create a fresh workflow binding before its pinned binding transfer commits. If publication is interrupted, restart rebuilds from the committed rows. Keep `Registry.beginEviction` for removing the source, regardless of whether it is removed before or after adoption.

## 5. Preserve workflow, evidence and delivery semantics

Add an internal WorkflowManager/WorkflowStore transfer operation distinct from manual `reattach`. Capture all active bindings with `activeBindingsForNote`, retain binding IDs and version IDs, and update only the mutable session-owner fields. For secondary bindings preserve their repository-specific `sessionCwd`, `sessionRepoRoot` and `repoRoot`; only their transport session changes. Paused/orphaned/archived bindings do not become active as a side effect.

Keep active run IDs, statuses except for a temporary transport hold where necessary, round/segment, attempts, receipts, criteria and version pins. A newer published workflow does not participate. An already-running capture or evaluator may finish its immutable work; a new capture that needs a live session waits on the same transport hold and revalidates its source after adoption. Do not rewrite a captured session identity, cancel an otherwise valid evaluation, or increment round/segment merely because the transport changes. Do not create a replacement binding through `bindDispatchedTaskWorkflow`; that path must recognize reservation/adoption and remain idempotent.

Stable `noteKeyFor` is a precondition, so staged evidence items, generation, coverage claims and issued repository-slot mapping remain reachable without copying. Frozen evidence, canonical criterion IDs, submissions and transcript/intent provenance remain immutable. Do not clear evidence on source `session_remove`. Registration continues to require the same live active Persona binding and scoped checkout rules through `stageAgentEvidence`.

Inventory mutable records that still point at the source session. Apply this delivery policy explicitly:

| Delivery state | Transfer behavior |
| --- | --- |
| Queued human turn / prepared workflow packet never sent | Preserve logical identity and payload. Retarget only mutable destination fields after adoption; re-run ordinary consent, pane and binding gates before first send. Preview remains preview. |
| Sending when hold is acquired | Wait for the existing sender outcome or mark uncertain through its current owner if acknowledgement is lost. No parallel replacement send. |
| Uncertain | Preserve uncertainty and explicit retry-confirmation requirement, including across restart. Never turn it into a fresh prepared packet automatically. |
| Delivered or cancelled historical packet | Keep the original session attribution and receipt; do not rewrite history or trigger delivery because the runtime changed. |
| Refused packet | Preserve refusal/retry policy; transparent transfer is not a new authorization to send. |

For both ordinary removal and first-observation reconciliation, an active reservation suppresses orphaning only for its exact captured source/bindings. Definitive transfer failure releases that exception and invokes the existing orphan/recovery semantics once. An unrelated disappearance must still orphan normally.

## 6. Recover across restart without replaying side effects

Load unresolved reservations and establish guards before TaskManager construction can reclaim unbound resources and before `SdkSupervisor.prepareRestore`/`restore` can recreate a source driver. The daemon remains the sole writer. Keep HTTP responsiveness and existing serial SDK restore ordering; a transfer guard does not turn a restoring projection into an actionable Session.

After terminal discovery completes, resolve against observed source and launch proof before task/workflow missing-session reconciliation. Subscribe later discoveries to the same adoption method. Do not rely solely on callback registration order; each irreversible consumer checks the reservation itself.

Crash-point expectations:

| Last durable boundary | Recovery rule |
| --- | --- |
| `prepared`, stop not begun | Abort unused preparation and restore/retain original source ownership only if expected task/episode/bindings still match; ordinary SDK restore may proceed. |
| `stopping` with unknown stop result | Do not auto-restore and do not spawn. Inspect exact process/SDK state; surface recovery if ambiguous. A positively live original source can be restored by the existing owner without launching another driver. |
| `launching` before a launch result was stored | Treat spawn as possibly performed. Read persisted wrapper/resource proof and discover; never repeat spawn merely because no result was written. |
| `awaiting_successor` or `recovery_required` | Re-evaluate exact candidates and current ownership. Adopt once if all guards pass. Missing/inaccessible inventory is unknown, not dead. |
| Adoption transaction committed, SSE not sent | Rehydrate task, bindings and transfer projection; publish consistent state without changing evidence or delivering a packet twice. |
| Proven source and launch absent | Settle using TaskManager and WorkflowManager; keep checkout for ordinary explicit cleanup. Dispose only this transfer's unused private home after proving no process can still use it. |

Use the existing launcher/wrapper proof and process inventory. Do not put a secret recovery token in shell argv, fabricate task ownership from a marker alone, or use age as proof of death. SDK driver restore must explicitly exclude unresolved attempts that crossed `stopping`; otherwise a restart can launch the SDK beside its terminal successor.

## 7. Expose pending and recovery states in the existing dashboard

Keep old success fields (`homeName`, nullable `sessionId`) for compatibility, and add a structured transfer ID/status/reason to the two handoff responses. Successful spawn is not the same as completed adoption. Add schema validation for any new write route and update `web/lib/api.ts` types in the same change.

Proposed API additions are `GET /api/session-transfers` (bounded unresolved summaries and pagination), `GET /api/session-transfers/:id` (one sanitized record), `POST /api/session-transfers/:id/recheck` (observe this attempt without spawning), and `POST /api/session-transfers/:id/resolve` (expected revision plus an explicit end request). Reuse existing authenticated route/CSRF policy. The resolve mutation rechecks ownership and liveness server-side, returns 409 for stale or unsafe resolution, 404 for an unknown transfer, and never accepts an arbitrary replacement session ID from the browser. Successful resolution follows the same owner methods as automatic definite failure or source rollback. These are proposed contracts, not existing endpoints.

Wire contracts and schemas belong in `src/shared/types.ts` / `src/shared/protocol.ts` or a focused browser-safe shared transfer module. `routes.ts` delegates to the coordinator; `registry.ts` owns snapshot and event publication; `src/web/useEventStream.ts` applies the exhaustive events; `App.tsx` owns selection, and `ReportPanel.tsx` renders the recovery summary. Avoid placing policy in the browser or terminal adapters.

Provide a small durable transfer summary projection so an unresolved handoff remains visible after the source card is evicted and after a browser reload. Suggested surface: a pending/recovery subsection in the existing Sitrep/ReportPanel, usable for taskless bindings as well as task-backed sessions. Reuse existing row/action styles and explain the concrete state: “Terminal opened; waiting for discovery”, “Could not verify the terminal”, or “Source still running; nothing transferred”. Do not expose internal config paths or database states as user instructions.

If a new top-level SSE collection is used, name it explicitly (`sessionTransfers` is the proposed name), cap snapshot summaries at 100 unresolved records with an overflow count and a paginated read for the remainder, and add exhaustive snapshot/event/comparator/Line membership handling per change contracts. Retain no unbounded per-phase transcript or terminal history in that collection. This projection is a read of the transfer table, not another source of ownership.

Offer a **Check again** action that only re-observes the same attempt. An **End transfer** or equivalent resolution is enabled only when the daemon can positively rule out a live replacement, or has safely stopped that exact replacement through existing policy, and requires the repository's ordinary destructive confirmation when applicable. It never removes the worktree implicitly. If proof is unavailable, state what remains unknown and keep recovery pending; do not offer a force-adopt or force-spawn control. Ordinary terminal focus, manual reattach for a genuinely different conversation and task cleanup remain their existing actions.

On adoption, select the successor when the current view still owns the request, preserve task/workflow labels and refresh via SSE, and remove the pending row. If the operator navigated elsewhere, do not steal focus. If the source disappears before HTTP returns, the transfer summary still leads to the successor. Apply any session-visible prop through shared layout contracts so Board and Console agree.

## 8. Verification, browser proof and documentation

Extend the proposed Phase 1 browser spec and existing `e2e/fixtures/terminal-boundary-build.ts` seam. Both CLI and SDK agents remain fake. A terminal fake reads its supplied transport configuration, starts the real built MCP bundle, initializes and lists tools, then calls `submit_workflow_evidence` with a focused command output, an ignored synthetic screenshot, and mapped coverage against the isolated task. Assert registration success in the daemon and the rendered workflow evidence tray. A direct HTTP submission alone is not proof of the resumed agent's tool connection.

Seed one active workflow pinned to an older published version, staged evidence plus a frozen submission, and a newer published version that must not be selected. Include a taskless manually bound conversation and a primary plus secondary binding. Deliver the resume hook before discovery and after source removal in separate cases. Inspect captured state transitions or an event log so a transient `failed`/orphaned state cannot be hidden by a retrying final-state assertion.

| Acceptance | Required focused cases |
| --- | --- |
| H1 | Actual resumed-tool call registers command, image and coverage to the same bound conversation and correct repository slots; unbound/foreign-scope calls still refuse. |
| H2 | Hook before discovery; discovery before/after removal; source lingers past adoption; late ordinary sweep; immediate waiter timeout followed by adoption. No wrong task pointer or transient failed state. |
| H3 | Primary and sibling binding IDs/versions/runs/rounds/segments unchanged; staged generation/coverage and frozen bytes unchanged; manual/taskless bindings; live/preview and prepared/sending/uncertain delivery policy; capture/evaluator completion during the ownership gap. |
| H4 | Phase 1 refusals plus stop survives/stop gone, definite spawn failure/504, concurrent/repeat request, every crash point, delayed markers, browser reload and daemon restart. At most one external launch. |
| H5 | Wrong agent/native ID/cwd/repo/pane, recycled PID, same-cwd unrelated session, other active task, changed/archived/sibling workflow, reset/cancel/cleanup/new-episode race. Valid non-transfer rediscovery remains valid. |
| H6 | Click both handoff entry points as applicable; Board/Console task and workflow remain associated; view follows successor without stealing focus; tray shows proof; pending and recovery reasons survive source removal/reload. |

Proposed new files are `test/session-transfer.test.ts`, `test/session-transfer-db.test.ts`, and `test/workflow-session-transfer.test.ts`; adapt their names to repo organization, keeping tests at actual boundaries. Existing compatibility files must continue to pass. Commands once new files exist:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/session-transfer.test.ts test/session-transfer-db.test.ts test/workflow-session-transfer.test.ts test/sdk-answer-http.test.ts test/session-launch-http.test.ts test/terminal-launch-identity.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-agent-evidence-binding.test.ts test/workflow-recovery.test.ts test/workflow-per-repo-runs.test.ts test/pending-turn-manager.test.ts test/session-contracts.test.ts test/sdk-startup-order.test.ts test/sdk-supervisor.test.ts test/reset-sdk.test.ts test/workflow-reset.test.ts test/workflow-handoff-worktree-retention.test.ts test/task-worktree-return.test.ts
npm run typecheck
npm run lint
npm run build
npm run smoke
MC_E2E_EVIDENCE=1 npm run test:e2e -- e2e/specs/sdk-terminal-handoff.spec.ts e2e/specs/terminal-session-name.spec.ts e2e/specs/workflow-evidence-pane.spec.ts --workers=1
```

Process-identity tests inspect their own spawned processes; on the planning host the two real-process cases needed scoped outside-sandbox execution. Do not weaken those assertions. New browser modals, if introduced for recovery confirmation, must call `expectContentClearsBorder`. Use accessible selectors and capture ignored successful-path evidence. Run broader relevant CI as the repository requires; in a later repair round run only appropriate focused checks before its authorized push.

Update `docs/sessions.md`, `docs/session-lifecycle.md`, `docs/agent-guides/architecture.md`, `docs/workflow-system.md`, and relevant recovery/change contracts. Replace the old claim that cwd rebinding completes handoff with the durable proof/ownership model. Document the pending and recovery states, the unchanged manual reattach policy, the same-conversation limitation, and the no-downgrade-while-pending restriction. No release, signing or deployment changes are in scope.

## Exit, merge and downstream handoff

Merge only when H1-H6 are demonstrated, migration and crash-point checks pass, the source and both resume routes cannot bypass the coordinator, pending transfers remain observable after restart, and no evidence/credential artifact is committed. Supply criterion-mapped native workflow evidence after the final relevant run. The actual implementation task's completion/PR owner governs commit and publication; this guide does not override a handoff instruction.

There is no later phase to fix lifecycle safety, fill in browser coverage or clean up schema shortcuts. Final completion means the accepted source outcome is operable on both backend axes, including error paths. The existing Backlog feature may rely on `session.task` remaining associated after successful handoff; this phase does not add that feature or change what returning a task to Backlog does.

## Cross-phase audit record

- September 28, first pass: Phase 1's preparation and home are inputs, never recreated. All irreversible ownership guards and their startup twins ship together here.
- Reconciled with earlier files: terminal proof moves into a private transfer record; public Task launch proof remains its existing shape. All active sibling bindings move without losing repository scope. Settled/exited historical tasks are not silently resurrected.
- Delivery audit: prepared destinations may change after proof; delivered/uncertain history and immutable submissions cannot. No active run is replaced with the latest workflow, and manual reattach remains explicit recovery.
- Episode audit: source ownership must not rotate during reservation, but the discovered successor gets its own episode. Existing PR-bearing archival and dependency provenance remain authoritative.
- Final set audit: direct prerequisite is Phase 1; no parallel execution; H1-H6 final ownership is here. The required UI, migration, cleanup and restart work has no dependency on an unplanned third phase.
