# Architecture and lifecycle

This guide expands the architecture rules referenced by the root `AGENTS.md`. Read the relevant section before changing ownership or lifecycle behavior.

## Process boundaries

| Surface | Entry point | Ownership |
|---|---|---|
| Daemon | `src/server/index.ts` | Loopback HTTP server on port 7317 and the only SQLite writer |
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

## Dispatch runtime

Runtime selection has one owner: `resolveDispatchRuntime`, composed with `resolveSessionRuntime`.

After provisioning, dispatch branches once:

- Terminal: home, discovery wait, readiness wait, and intent delivery.
- SDK: no terminal home, no discovery wait, no terminal readiness wait, and the initial prompt is turn one.

An invalid stored runtime falls back to terminal and reports what was dropped. If SDK was requested but no supervisor exists, fail instead of silently changing runtime.

A dispatch that declares required Mission MCP tools fails on both arms unless the launch carries the registration **and** the built bundle publishes those tools, established by one real `initialize` + `tools/list` handshake cached per build. Fail before the agent spawns: a scout that cannot call `submit_scout_artifacts`, or a member that cannot call `submit_ensemble_result`, cannot finish its task at all, and the existence check alone cannot see a stale `dist/`. A dispatch declaring no tools never spawns the probe and is unaffected.

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
