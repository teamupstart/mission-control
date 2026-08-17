# Phase 2: Claude SDK runtime and operator controls

## 1. Outcome

Pipeline tasks default to a managed Claude Agent SDK host that invokes the installed Conductor
Engineer skill directly as `/engineer <idea>`. Operators can select Terminal instead in Conductor
Settings. Either host attaches to the deterministic provider run from Phase 1, and only that
provider run can complete the task.

Estimated non-test implementation: about 290 lines, plus tests and fixtures.

## 2. Entry criteria and dependencies

- Direct prerequisite: Phase 1, `phase-1-provider-identity.md`.
- Re-verify the Phase 1 symbols on the default branch before editing. If the provider identity or
  collision contract changed during review, update this phase document before implementing around
  it.
- The planning pull request must be merged.

## 3. Scope and non-goals

In scope:

- a persisted `terminal | claude-sdk` Conductor launch setting, defaulting to `claude-sdk`;
- explicit no-fallback launch behavior;
- direct Claude SDK host launch through the daemon's singleton `SdkSupervisor`;
- task/session binding for focus, questions, cancellation, and restart recovery;
- pipeline-specific guards around generic session completion and disappearance;
- runtime-aware Settings and dispatch copy;
- terminal compatibility and runtime switching;
- HTTP, render, unit, integration, Playwright, and docs coverage.

Non-goals:

- replacing the ai-conductor build daemon's tmux supervisor;
- Codex `$engineer` hosting;
- exposing Agent, Model, Effort, attached repos, or After work for pipeline tasks;
- using the generic task runtime picker as a second source of truth;
- automatic Terminal fallback;
- changing Conductor's downstream provider choices or pipeline state.

## 4. Repository findings

- `PipelinesConfigSchema` is read from `app_config` with defaults, so an additive field needs no
  database migration. `PUT /api/pipelines/config` explicitly reconstructs the saved object and must
  forward the field.
- `useConductor` already owns optimistic full-config writes. `ConductorPanel` has one card grid for
  engine, observation, Foreman triage, and repositories; Launch runtime belongs in that grid.
- `TASK_KIND_BEHAVIOR.pipeline.launch` is `pipeline-terminal`, and `DispatchModal` checks that value
  in kind selection, guided-step skipping, and constraint copy. The in-memory value can become
  `pipeline` once those consumers use runtime-aware wording.
- `DispatchModal` already fetches `/api/pipelines/repos` to decide whether Pipeline is available.
  Carrying the configured runtime on that response avoids a second poll and keeps availability and
  runtime from different config snapshots.
- `SdkSupervisor.start` accepts all required launch facts. For this adapter: `agent: "claude"`,
  task title as name, task repository as cwd/git root/repo root, `/engineer <intent>` as turn one,
  null model/effort/permission override, no extra directories, and the task id.
- The Claude SDK driver already loads user, project, and local settings and forwards structured
  questions. Use the normal Mission MCP descriptor when available; no new MCP tool is required.
- Normal embedded dispatch provisions a Mission Control worktree before calling the supervisor.
  Pipeline SDK dispatch must not call it because Conductor owns routing and worktree creation.
- `Task.sessionId` is the correct current-executor pointer and gives the card, Focus, cancel, and
  liveness behavior for free. It also makes generic `settleMergedTask`,
  `settleIfEpisodeFinished`, `reconcileMergedTasks`, `agentWentAway`, and startup reconciliation
  see the task. Each requires a provider-owned pipeline rule.
- `Registry.beginEviction` and `session_remove` remain the only durable SDK removal path.
- `TaskManager.settlePipelineTask` already settles a projected processed run and supplies the
  provider PR. Do not create another completion adapter.

## 5. Implementation

1. Add an exhaustive browser-safe `PIPELINE_LAUNCH_RUNTIMES` tuple and
   `PipelineLaunchRuntime` type in `src/shared/pipeline.ts`. Add
   `launchRuntime: z.enum(...).default("claude-sdk")` to `PipelinesConfigSchema` and its patch
   schema.
2. Forward the field through `PUT /api/pipelines/config`, config tests, fixtures, and API types.
   Extend `/api/pipelines/repos` with the current launch runtime so Dispatch receives repo
   availability and launch semantics from one config read. Existing consumers may ignore the
   additive field.
3. Make the provider launch result from Phase 1 carry the selected runtime. Read it once with the
   consented provider and identity so a concurrent Settings edit affects the next dispatch, not
   half of this one.
4. Split `Dispatcher.dispatchPipeline` after identity prebinding:

   - `terminal`: keep the Phase 1 spawn, home, status, and session-null path;
   - `claude-sdk`: require the injected singleton supervisor, resolve the normal Mission MCP
     descriptor, and call `SdkSupervisor.start` directly with the fixed launch facts above;
   - on SDK success, patch `status: "running"`, `sessionId`, and no home, then bind the task to the
     session's work episode using the same before/after driver-binding discipline as ordinary SDK
     dispatch;
   - on cancel during start, stop the newly created SDK session through the supervisor;
   - on any preflight or start error, use the existing dispatch failure path and never call the
     terminal spawner.

5. Add a focused `/engineer` prompt composer. Preserve the intent bytes after the command prefix;
   do not invoke `conduct-ts engineer`, prepend hidden correlation prose, or parse transcript tool
   calls.
6. Add one predicate for provider-owned pipeline completion and use it in every generic task
   reconciler reached through `Task.sessionId`:

   - skip generic idle or merged-session completion for `kind === "pipeline"`;
   - skip generic merge reconciliation and close-after-merge for a pipeline host;
   - when the SDK session is removed, look up the task's exact `pipelineRun`: if no projection
     exists, fail with a host-ended/no-run error; if the run exists, clear the stale `sessionId`
     and leave the task running for provider completion;
   - during startup, prefer SDK row liveness while the host is restorable. If the host is gone but
     the exact provider run exists, do not reclaim or fail the task. A processed run still settles
     through the projection listener.

7. Update comments and tests that currently assert pipeline tasks never have `sessionId`. The
   invariant becomes: terminal pipeline hosts have `homeName` and no session id; SDK pipeline
   hosts have `sessionId` and no home; both have `pipelineRun`.
8. Rename `TaskKindBehavior.launch` from `pipeline-terminal` to `pipeline`. Update every shared and
   browser consumer exhaustively. Keep harness/after-work skipping registry-driven.
9. Add a **Launch runtime** card to `ConductorPanel` with two accessible radio or select choices:
   **Claude Agent SDK** and **Terminal**. Explain that it controls Engineer's host and that the
   build daemon still has its own tmux supervision. Saving uses the existing optimistic config
   hook.
10. Make `DispatchModal` retain the pipeline-specific disabled controls but render runtime-aware
    explanation. SDK copy names direct `/engineer`, managed recovery, and provider-owned downstream
    choices. Terminal copy names live stdin and the CLI nesting guard. Neither offers the generic
    runtime picker.
11. Update `docs/dispatch-and-backlog.md`, `docs/pipelines.md`, and any README overview that still
    says Pipeline always opens a terminal. Document the SDK default, Terminal selection, no silent
    fallback, direct skill invocation, task/session shapes, provider completion, and remaining
    daemon tmux boundary.

## 6. Data and compatibility

- Old pipeline config gains `launchRuntime: "claude-sdk"` by approved product decision. There is
  no database migration and no second config authority.
- Terminal is a stored explicit value and remains fully supported.
- Existing terminal tasks may have a home and null run link; Phase 1 compatibility binding remains.
- New terminal tasks have a home, no session id, and a prebound provider link.
- New SDK tasks have a session id, no home, no Mission Control worktree, and a prebound provider
  link.
- `Task.sessionId` keeps its existing meaning: current executing session. Generic completion is
  gated by task kind, not by inventing another session pointer.
- SDK rows use the existing task-id index and restore flow. Do not add a pipeline SDK table.
- The provider run key and pipeline projection wire shape do not change.

## 7. Tests and verification

Unit and integration coverage must prove:

- missing and partial old pipeline blobs default to `claude-sdk`;
- both runtime values round-trip through config GET/PUT, including explicit route forwarding;
- `/api/pipelines/repos` reports the same configured runtime used by dispatch;
- SDK launch uses Claude, exact `/engineer <idea>` turn one, repo cwd, task id, no model/effort
  override, no extra dirs, no Mission Control worktree, no terminal spawn, and no home;
- terminal selection keeps exact existing argv/home behavior and never starts the supervisor;
- missing supervisor or SDK start rejection fails the task and never falls back;
- cancellation during SDK start stops the just-created host;
- SDK task/session binding recovers across daemon restart;
- an idle SDK host and any host-session PR merge do not complete a pipeline task;
- SDK host removal before a provider projection fails the task with a specific message;
- SDK host removal after the exact run appears clears `sessionId` and leaves the task running;
- a different run key does not preserve a lost host;
- a processed projection settles the SDK task and uses the provider PR;
- startup with a dead host plus active provider run preserves the task, while a restored processed
  run completes it;
- terminal legacy binding from Phase 1 remains green;
- render tests cover the Settings selection and both dispatch explanations.

Playwright coverage in the built application must:

1. Open Conductor Settings, observe Claude Agent SDK as the default, select Terminal, reload, and
   prove persistence.
2. Select Claude Agent SDK again and open pipeline dispatch in an enabled repository.
3. Prove Agent, Model, Effort, attached repositories, and After work remain unavailable, while the
   explanation names SDK and direct `/engineer` rather than claiming a real terminal.
4. Dispatch through the fake Claude SDK and assert the running task has a session id, expected
   provider link, and no home.
5. Switch to Terminal, dispatch a distinct idea, and assert the task has a home, expected provider
   link, and no session id.
6. Capture successful Settings and dispatch states into the gitignored evidence directory for the
   pull request.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-contracts.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-phase6.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/settings-conductor.spec.ts e2e/specs/conductor-loops.spec.ts
npm run test:e2e
```

## 8. Merge and exit criteria

- All section 7 gates pass in CI.
- A new installation and an upgraded config both show Claude Agent SDK selected by default.
- SDK dispatch produces a focusable, cancellable, restart-safe host with no terminal home.
- Terminal selection still produces the current attachable home.
- No SDK launch failure opens a terminal.
- Only provider projection completes either pipeline task, and old terminal tasks remain readable.
- User-facing docs state the remaining ai-conductor daemon tmux requirement plainly.

## 9. Downstream handoff

After this phase, future work may rely on:

- `PipelinesConfig.launchRuntime` as the only pipeline host choice;
- Claude SDK as the shipped default and Terminal as the explicit compatibility value;
- one deterministic provider link stored before host launch;
- SDK pipeline tasks using `Task.sessionId` and terminal pipeline tasks using `homeName`;
- provider projection as the only pipeline completion authority;
- direct `/engineer` invocation, never nested `conduct-ts engineer`;
- no automatic fallback;
- ai-conductor's own daemon supervision remaining outside Mission Control.

Any later Codex host or daemon-supervisor project needs a new plan. It must not widen this enum or
reinterpret `claude-sdk` in place without compatibility review.

## 10. Cross-phase audit record

- 2026-08-17: audited all current `pipeline-terminal` browser checks. Runtime-aware copy and the
  in-memory behavior rename stay in this phase so no merged UI makes a false terminal claim.
- 2026-08-17: added generic completion exclusions after tracing `Task.sessionId` through idle,
  merge, exit, and restart listeners. Without them a host session could complete or fail a task the
  provider still owns.
- 2026-08-17: kept the SDK host bound to `Task.sessionId` instead of adding a parallel pointer. The
  existing pointer is semantically correct and unlocks Focus, cancel, card decoration, and durable
  SDK liveness; task-kind guards preserve the different completion owner.
- 2026-08-17: default changed from the initial compatibility recommendation to `claude-sdk` by the
  operator's explicit plan decision. Fail-visible behavior remained selected.
