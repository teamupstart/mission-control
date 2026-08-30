# Architecture and lifecycle

This guide expands the architecture rules referenced by the root `AGENTS.md`. Read the relevant section before changing ownership or lifecycle behavior.

## Process boundaries

| Surface | Entry point | Ownership |
|---|---|---|
| Daemon | `src/server/index.ts` | State-home owner, loopback HTTP server, and the only SQLite writer |
| Web dashboard | `src/web/main.tsx` | React UI over HTTP plus one Server-Sent Events connection |
| Shared contracts | `src/shared/` | Wire types, schemas, and browser-safe shared logic |
| Electron shell | `src/main/index.ts`, `src/preload/index.ts` | Starts and embeds the daemon |
| MCP server | `src/mcp/server.ts` | Stdio child that reaches the daemon over HTTP |
| Foreman | `src/server/foreman/worker.ts` | Separate auto-responder process, HTTP only, never SQLite |
| Session intent | `src/server/goal/` | Daemon-owned objective and focus reconciliation; only the daemon persists it |
| GitHub Inspector | `src/server/inspector/worker.ts` | Daemon-owned PR review state |
| SDK supervisor | `src/server/sdk/supervisor.ts` | Daemon-owned embedded sessions |
| Terminal registry | `src/server/terminal/registry.ts` | Multiplexer and emulator mechanisms |
| Hook bridges | `hooks/` | Small Node processes that post hook events to the daemon |

The live browser channel is SSE only. Do not add browser polling.

Before opening SQLite or running migrations, the daemon takes an OS lock on
`$MISSION_HOME/daemon.lock`. The lock is scoped to the resolved state directory, not the API
port. A second daemon pointed at the same home exits with the current owner's PID and port,
while daemons using independent homes may run concurrently. The kernel releases ownership on
process exit, including crashes; orderly shutdown closes SQLite before releasing it. The lock
file and its metadata remain at the same path across restarts and upgrades and are not a state
or database migration.

## Session ownership

The Registry owns the session map. Terminal discovery and `SdkSupervisor` are its only producers.

Startup order matters:

1. Restore resumable SDK sessions.
2. Register or evict every restored session.
3. Start terminal discovery.
4. Reconcile task, workflow, and review bindings after the first completed observation.

Discovery's unseen-session loop applies only to `runtime === "terminal"`. A missing terminal process says nothing about an SDK session.

## A session going away

Both terminal and SDK sessions leave through `Registry.beginEviction`:

1. Emit `exited`.
2. Wait through the linger window.
3. Emit durable `session_remove`.
4. Let task, workflow, review, draft, and other subscribers reconcile.

Do not add another teardown route. Do not use `state === "exited"` for durable cleanup because a temporarily missed process can be rediscovered before removal.

Each durable `session_remove` subscriber needs a startup twin that reconciles after sessions have been observed. SDK restore completes before that first observation.

An SDK shutdown suspends its session. `taskLiveness` reads persisted rows during startup, before in-memory handles exist. `turn_in_progress` records interrupted work and is cleared only when the turn finishes or a successful context reset establishes an idle replacement.

## Tasks and worktrees

`Task.sessionId` points to the session currently executing the task. It is not task history. Work-episode bindings preserve provenance.

Only one non-terminal task may be bound to a session. Enforce this anywhere the pointer is assigned.

When an agent disappears, settle the task but retain its worktree, branch, and home for explicit operator cleanup. Startup reconciliation may reclaim invisible stale rows; live disappearance must not.

A handoff from SDK to terminal clears the task binding before stopping the driver, waits for the driver pump, starts through the normal unique-spawn path, then rebinds after discovery.

Worktree snapshots use a temporary Git index. Never capture through the real index. Reset helpers use `clean -fd`, never `-fdx`, so ignored warm dependencies survive.

The daemon constructs one `WorktreeManager` and injects it into task dispatch, Workflow checks,
manual lease routes, and maintenance. New task and check acquisitions use native slots by default.
Only a disabled policy or a positive native refusal may degrade to a disposable Git worktree; an
unknown native outcome fails closed. Cleanup follows the provider and exact lease identity stored
on the owning row, never current configuration. Native release remains conditional and
occupancy-gated, and clearing a task's worktree facts is atomic with recording the successful
release. Historical rows that name Treehouse retain their provider-specific cleanup path.

A terminal task that still holds a worktree also carries a durable activity clock. The daemon
observes the aggregate Git-visible state of its primary and every attached checkout - HEAD, the
whole index, tracked worktree changes, and non-ignored untracked files - and records the
fingerprint plus a 30-day deadline in `task_worktree_retention`. The clock has one boundary per
task: the newest change in any of its trees protects the whole set. `tasks.updated_at` is not an
activity signal and must never be used as one. The observation service reclaims nothing; it is
structurally incapable of it, and automatic reclamation at the deadline is a separate change that
will consume this ledger through `TaskManager.reclaim()`. An unreadable tree records a bounded
reason and moves no deadline, and a set of resources nothing has successfully observed yet has no
row at all - a first observation is what starts a window, never a pre-existing timestamp.

Manual development sessions acquire and return native leases through the daemon's loopback API.
The client does not create an independent inventory, and shell exit does not imply return.

## Dispatch runtime

Runtime selection has one owner: `resolveDispatchRuntime`, composed with `resolveSessionRuntime`.

After provisioning, dispatch branches once:

- Terminal: home, discovery wait, readiness wait, and intent delivery.
- SDK: no terminal home, no discovery wait, no terminal readiness wait, and the initial prompt is turn one.

An invalid stored runtime falls back to terminal and reports what was dropped. If SDK was requested but no supervisor exists, fail instead of silently changing runtime.

A dispatch that declares required Mission MCP tools fails on both arms unless the launch carries the registration **and** the built bundle publishes those tools, established by one real `initialize` + `tools/list` handshake cached per build. Fail before the agent spawns: a scout that cannot call `submit_scout_artifacts`, or a member that cannot call `submit_ensemble_result`, cannot finish its task normally, and the existence check alone cannot see a stale `dist/`. A human may explicitly confirm closing a scout without its report after seeing the archive warning; automatic completion remains gated. A dispatch declaring no tools never spawns the probe and is unaffected.

## Harnesses and terminals

Harness capabilities split by purity:

- `HARNESS_CAPABILITIES` in `src/shared/harness-capabilities.ts` is browser-safe.
- `HARNESSES` in `src/server/harness/index.ts` adds filesystem and process behavior.

Reach behavior through `capabilitiesFor`, `harnessFor`, or the focused accessors. Do not branch on `session.agent`.

Terminal vendors are hidden behind `MULTIPLEXERS`, `EMULATORS`, and `bindPane`. UI and actions branch on capabilities, not vendor IDs. Use:

- `canWriteTo` for a terminal pane operation.
- `canMessage` for any reachable conversation, including SDK.
- `paneToken` for pane-scoped maps.

### Work-cycle lifecycle

The Registry is the sole owner of normalized work-cycle state. Terminal hook adapters translate
their raw event vocabulary into `work_started` and `turn_completed`; SDK driver state reaches the
same Registry transition path. Generic Registry, Foreman, Workflow, and task code must not inspect
raw hook event names to identify a completed turn.

`session_work_cycles` stores one current projection per logical conversation key: generation,
active state, completion time, and update time. It is separate from `session_events`, whose any-row
query remains proof that terminal hooks were seen, and from `session_work_episodes`, which owns task,
branch, agent identity, and pull-request provenance. The active bit is durable so work observed
before a daemon restart can still be completed by a later turn-end signal.

`Session.workCycle` is an optional wire projection. Missing state means no lifecycle activity is
known for the current logical key and consumers must fail closed. A context clear or driver rebind
selects the new key's state instead of carrying a generation across conversations. Generations are
monotonic only within one logical key and advance only when a normalized completion follows
observed work. Idle notifications and duplicate turn ends do not advance them.

Prompted automatic completion stores the last consumed generation on the Foreman queue row. The
daemon compares the submitted logical key and generation with `session_work_cycles` in the same
write that consumes it; queue items retain drain precedence. Reconciled intent is checked
separately for staleness, while evidence fingerprints remain proof and workflow idempotency rather
than lifecycle identity. Historical `prompted_goal` values are read only for an idempotent upgrade
bootstrap: a value matching the current resolved intent marks the current completed generation as
consumed only when the cycle is inactive and its completion does not postdate the legacy activity
watermark. A row from before that immutable watermark existed instead records the current settled
generation as a conservative legacy cutover ceiling: that ambiguous generation cannot be claimed,
while a later completed generation naturally becomes eligible. A null or mismatched guard, active
cycle, or completion newer than a known watermark stays eligible. New decisions never use the
legacy intent/evidence columns as a fallback trigger.

### Task completion contract

`src/shared/task-completion.ts` owns one browser-safe, exhaustive `Record<TaskKind,
TaskCompletionContract | null>` describing what "complete" means for a task kind's initial
delivered turn: what must be done, and what post-completion work is explicitly deferred to a
later owner. `ship` is the only kind that defers anything today. The delivered handoff appendix
(`src/server/task-contract.ts`) and Foreman's verify prompt render from that one record, so the
boundary an agent is told and the boundary it is judged against cannot drift apart.

Prompted completion supplies the contract to `verifyItem` as an optional trusted-policy input,
resolved from the durable task kind on the live session. It is rendered above the untrusted
evidence fence, alongside the objective and never in place of it. Queue-item verification and
personal sessions pass no contract, so their behavior is unchanged. Trusted policy is never
derived from transcript prose.

### Prompted completion disposition

`foreman_queues.prompted_decision` holds one validated JSON record - logical key, generation,
outcome, bounded summary, bounded blocking gaps, decision time - describing why the current
consumed generation stopped. Outcomes are append-only:
`held`, `workflow_claimed`, `asked`, `direct_handoff`, `retired`, `empty`, `verification_failed`,
`direct_handoff_undelivered`.

It is written by the same statement that consumes the generation, on both atomic boundaries: the
ordinary consume route and the Workflow completion claim transaction. A refused or rolled-back
claim writes neither.

There is exactly one amendment, and it narrows rather than writes. Direct shipping is
mark-before-inject: the handoff is durable before the instruction types, because a retried direct
injection is the double push, so a failed injection cannot be rolled back. Foreman instead corrects
the record over `POST /api/sessions/:id/queue/wrapup/prompted/undelivered`, which moves that
generation's `direct_handoff` to `direct_handoff_undelivered` and nothing else. It requires the row's
consumed generation and the stored decision's own generation to be the one named, so it cannot
create a decision, spend a generation, touch another generation's reason, or relabel an outcome that
is not a handoff. The generation stays consumed, the latch stays latched, and the Ship it? card
raised alongside is the recovery. A second call is refused, which is what makes the caller's
best-effort retry safe. It is current projection, replaced by the next generation, while
`foreman_episodes` remains the append-only history of what Foreman did.

Reads fail closed. Unparseable JSON, an outcome this build cannot interpret, a logical key that is
not the row's own, a generation that is not the row's consumed generation, or a reason the write
schema would have refused - most sharply, a non-`held` outcome carrying gaps - all read as no
actionable decision and emit one bounded diagnostic; the generation stays consumed either way, so
nothing replays a spent turn. The reader runs the write schema over the stored payload rather than
restating its rules, so length is clamped and contradiction is refused: an over-long summary is the
same decision described at greater length, while gaps an outcome may not carry are feedback no
verifier wrote, and normalizing them away would manufacture a decision that is well-formed,
actionable, and not what the row says. A legacy row with no decision is consumed with an unknown reason and
is not fresh work. A context-key rotation selects another row, and no disposition migrates across
logical keys.

### Pre-PR ship recovery projection

`foreman_queues.prompted_recovery` is a validated current projection for the bounded ship
shepherd. It stores task id, logical key, intent episode, current completed work-cycle generation,
the Phase 1 decision identity when one exists, append-only reason, attempt, deterministic marker,
claim time, next eligibility, delivery knowledge, and a bounded payload summary. The episode keys
the reason-specific attempt budget across later generations, while the generation stays in the
marker as the per-delivery idempotency identity. It is not history;
`foreman_episodes` remains the append-only audit.

The Foreman worker's fleet pass orders PR follow-through before ship recovery, then excludes every
touched pane from ordinary target processing. The worker reads policy inputs over HTTP and the
daemon alone writes recovery state. The claim route rebuilds eligibility from the current Registry,
task, queue, Workflow, PR, diff, config, trust, invite, and work-cycle projections before a database
compare-and-set. This makes the worker's earlier snapshot advisory rather than authority. Unknown
injection results stay claimed across worker and daemon restarts; only a positive non-delivery may
release the exact same attempt.

Recovery reasons are structural except `idle_ambiguous`. A newly consumed `held` decision for an
eligible managed ship task may claim and deliver its structural gaps in the same worker pass, using
the same daemon projection and delivery path as the shepherd without waiting for the first quiet
window. Human-driven sessions remain silent, and the shepherd remains the later backstop.
The prompted decision stores its intent episode and held-round count. A later generation in the
same episode feeds the prior gaps and strikes into verification, and the daemon increments the
held round at its single consume write point. Decisions and recovery projections without episode
metadata retain legacy generation-scoped behavior and never acquire cross-generation continuity.
`idle_ambiguous` invokes the existing Review model
through a fresh tool-less call and records spend under `foreman:ship-recovery`. The parsed output is
post-checked against the pre-PR authority boundary. No recovery model can add repository scope or
authorize commit, push, pull-request creation, merge, cleanup, another task, or a human answer.

## GitHub Inspector and PR provenance

The workflow's Code Quality Judge and GitHub Inspector have different owners. Code Quality Judge
is a normal tool-less Persona introduced in the frozen No-Mistakes Review v9 graph. The current
v10 graph runs it alongside Code Risk Reviewer in stage 3, followed by Test Evidence Auditor and
Documentation Steward in stage 4, all inside the local repair loop before the Pull Request action.
GitHub Inspector is the optional daemon service below; its durable remote observation and review
provenance remain the input Shipping trusts.

The GitHub Inspector stays in the daemon so it is present in packaged Electron builds and its state survives restarts.

The GitHub Inspector comment marker `mission-inspector:v1` is append-only because it already exists on GitHub. Parse a future version alongside it rather than replacing it.

The GitHub Inspector's poll is also the only place a PR's remote state is READ. Its tick writes what it saw - `observed_head_sha`, `observed_state`, `head_ref_name` - onto the adoption ledger beside `head_sha`, which records only what the last completed review was about. That split matters: "has the branch reached the pull request yet" is a question the review head cannot answer, and it is the question a `pull_request` session action must answer before downstream stages read fresh evidence. Anything else that needs a PR's remote state reads those columns; adding a second poller would double the API cost of every open PR to answer a question this one already answers.
