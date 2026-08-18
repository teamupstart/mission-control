# Conductor SDK launch runtime

## Outcome

Let an operator choose whether a Mission Control **pipeline** task opens Conductor's Engineer
host in a terminal home or in Mission Control's embedded Claude Agent SDK runtime. Terminal stays
available as a first-class compatibility path. The SDK path invokes the installed Conductor skill
directly as `/engineer <idea>`; it does not run `conduct-ts engineer` inside another Claude
session.

This removes the terminal multiplexer from the interactive Engineer launch when SDK is selected.
It does not replace Conductor's own background build daemon supervisor. That daemon is owned by
ai-conductor and currently uses tmux independently of Mission Control.

## Why the current launch uses a terminal

Pipeline dispatch is currently a deliberate exception to normal task dispatch:

- `TASK_KIND_BEHAVIOR` marks pipeline launch as `pipeline-terminal` in
  `src/shared/task.ts`.
- `Dispatcher.dispatch` branches to `dispatchPipeline` before normal harness runtime selection in
  `src/server/dispatcher.ts`.
- `dispatchPipeline` asks the provider for `conduct-ts engineer --idea`, opens that command with
  `spawnUniquely`, records only `homeName`, and leaves `sessionId` null.
- `conductorEngineerArgv` removes inherited `CLAUDECODE` because ai-conductor's CLI refuses to
  launch a nested Claude session.
- The terminal home is also a durable join. A later provider-owned agent discovered in the
  Conductor worktree can be matched back to the task through the home and worktree in
  `TaskManager.bindPipelineTask`.

tmux is therefore not required by Conductor's planning logic. It is the mechanism the current
Mission Control adapter uses to supply live stdin, persistence, operator attachment, and task to
run correlation for an interactive CLI.

## Approved technical direction

### Two explicit launch runtimes

Extend the persisted pipelines config with one provider-launch preference:

```ts
type PipelineLaunchRuntime = "terminal" | "claude-sdk";
```

The setting is global to the Conductor integration, beside the existing master enablement and
Foreman triage controls. It selects only the Engineer host. Conductor continues to choose the
agents, models, and effort used by its downstream pipeline.

The dashboard presents both values in Settings:

| Runtime | Host behavior | Important boundary |
| --- | --- | --- |
| Terminal | Open `conduct-ts engineer --idea` in a terminal home | Requires an installed terminal backend and preserves attachable stdin |
| Claude Agent SDK | Start one managed Claude SDK session with `/engineer <idea>` as turn one | Requires the installed Conductor Engineer skill; does not remove tmux from Conductor's daemon |

The selected runtime is explicit. If its preflight or launch fails, dispatch fails with a useful
message instead of silently opening the other runtime. This keeps permission, recovery, and
operator-expectation changes visible.

### Direct SDK invocation

The SDK adapter calls the existing `SdkSupervisor.start` with:

- agent `claude`;
- the task repository as `cwd`, `gitRoot`, and `repoRoot`;
- `/engineer <task intent>` as the opening prompt;
- the task id for durable liveness and restart recovery;
- normal Claude settings sources, which already include user, project, and local skills;
- no Mission Control worktree and no attached repositories.

The host session is written to `Task.sessionId`, so Focus, cancellation, restart reconciliation,
and SDK liveness use existing ownership. The pipeline task still completes from the provider run,
not from the host session becoming idle.

### Deterministic provider-run identity

Before either runtime launches, the Conductor adapter derives the expected run key from the
single enabled repository and Conductor's canonical idea slug rule: lowercase, replace
non-alphanumeric runs with hyphens, trim edge hyphens, then truncate to 50 characters. The adapter
owns this provider-specific function beside `conductorEngineerArgv`; it does not put Conductor
rules in shared task code.

The dispatcher refuses a duplicate key that is already projected, persists the expected
`Task.pipelineRun`, then launches the selected host. This replaces the terminal home as the only
way a newly dispatched task learns its provider key. The existing session/worktree correlation
remains as a compatibility backstop for tasks launched by older builds with `pipelineRun: null`.

This contract is possible without an ai-conductor change because Engineer writes the plan and
worktree with the same canonical slug, and the build daemon projects that plan stem as the run
slug. Focused contract tests pin the copied slug rule and the duplicate refusal.

### Lifecycle rules

- The provider projection remains the only completion authority. A projected `processed` run
  settles the task and adopts its pull request exactly as today.
- An SDK host disappearing before its expected provider run exists is a failed task.
- Once the expected run exists, losing the SDK host does not fail the task. The provider now owns
  the durable work and may continue through its daemon and child agents.
- Cancellation stops the selected host through existing task cleanup. It does not claim to stop
  Conductor's independently supervised daemon, matching terminal behavior today.
- SDK rows and task binding recover through `SdkSupervisor.taskLiveness` and
  `liveSessionForTask`. No second SDK-session persistence or eviction path is introduced.
- Pipeline tasks stay out of Foreman's backlog autopilot and remain single-repository with no
  after-work Workflow.

## Product behavior

Settings gains a **Launch runtime** card in the Conductor panel. It names Claude Agent SDK
explicitly and explains that the choice controls Engineer only. Saving uses the existing
`PipelinesConfig` route and optimistic hook, with the new field forwarded by the route rather than
dropped during reconstruction.

Dispatch remains a pipeline-specific form:

- Terminal selection keeps Agent, Model, Effort, attached repositories, After work, and Agent SDK
  task-runtime controls unavailable, with terminal-specific explanation.
- Claude Agent SDK selection still keeps Agent, Model, Effort, attached repositories, and After
  work unavailable because the host is fixed by the integration and the downstream pipeline owns
  its own choices. The explanation changes to the direct `/engineer` and provider-lifecycle
  contract.
- The generic task runtime picker does not become the source of truth. The Conductor integration
  setting is the one authority for a pipeline launch.

## Persistence and compatibility

- `PipelinesConfigSchema` adds `launchRuntime` with a default, so older `app_config.pipelines`
  blobs parse without a database migration.
- `PipelinesConfigPatchSchema`, `PUT /api/pipelines/config`, `useConductor`, fixtures, and tests all
  round-trip the field. The route must include it in its explicit `setPipelinesConfig` object.
- `Task.pipelineRun` and `Task.sessionId` already persist the required identity. No task-table
  migration is needed.
- `PipelineProviderId`, event-ledger keys, task kind ids, and SDK session ids do not change.
- Rename the in-memory `TaskKindBehavior.launch` value from `pipeline-terminal` to `pipeline` when
  the UI becomes runtime-aware. It is not a persisted identifier. All behavior checks continue to
  go through the shared registry rather than checking `task.kind` in the browser.
- Terminal remains supported and covered. Existing tasks with a home and no provider link still
  bind through discovered worktree sessions.

## Repository-shaped implementation map

Likely touchpoints, to be re-verified by each implementation task:

- provider identity and terminal launch: `src/server/pipelines/conductor/index.ts`;
- shared config and behavior registry: `src/shared/pipeline.ts`, `src/shared/task.ts`;
- config persistence and route forwarding: `src/server/pipelines/config.ts`,
  `src/server/routes.ts`;
- runtime selection and SDK launch: `src/server/dispatcher.ts`, `src/server/sdk/supervisor.ts`,
  `src/server/index.ts`;
- provider-owned task lifecycle: `src/server/tasks.ts`, `src/server/registry.ts`;
- Settings and dispatch copy: `src/web/components/ConductorPanel.tsx`,
  `src/web/useConductor.ts`, `src/web/components/DispatchModal.tsx`;
- docs: `docs/dispatch-and-backlog.md`, `docs/pipelines.md`;
- contract and lifecycle tests: `test/pipeline-contracts.test.ts`,
  `test/pipeline-phase6.test.ts`, `test/dispatcher-runtime.test.ts`, focused SDK supervisor tests;
- browser coverage: `e2e/specs/settings-conductor.spec.ts`,
  `e2e/specs/conductor-loops.spec.ts`, and the fake-agent fixture.

## Verification

Backend coverage must prove:

1. Old and partial pipeline config blobs default correctly and both launch values round-trip.
2. Conductor idea slug fixtures match the provider contract, including punctuation, edge hyphens,
   empty output, Unicode, and 50-character truncation.
3. A duplicate projected provider key is refused before either host starts.
4. Terminal dispatch remains a home-backed launch and stores the expected provider key.
5. SDK dispatch starts Claude with exact `/engineer <idea>` turn one, no worktree, no extra repos,
   and the task id; it records the SDK session id and no home.
6. A daemon restart restores a live SDK pipeline task instead of reclaiming it.
7. SDK host loss fails before a projected run exists, but does not fail after that run appears.
8. A processed projection settles either launch runtime and adopts the provider PR without
   satisfying merge-only dependents.
9. Older terminal tasks with no precomputed link still bind through their home and discovered
   worktree.

Browser coverage must prove both operator flows against the built dashboard:

1. Select Claude Agent SDK in Conductor Settings, reload, and observe the persisted selection.
2. Open pipeline dispatch and see SDK-specific constraints rather than the terminal-only claim.
3. Dispatch and observe a running task bound to an SDK session with no terminal home.
4. Switch back to Terminal and observe the existing terminal constraint and home-backed launch.

Each phase runs focused tests plus `npm run typecheck`, `npm run lint`, and `npm test`. The phase
that changes runtime and UI runs `npm run build`, `npm run smoke`, and focused Playwright coverage
before the full `npm run test:e2e` gate.

## Approved rollout decisions

The operator selected these choices on 2026-08-17:

1. **Claude Agent SDK is the shipped default.** Old config blobs and fresh installations gain
   `launchRuntime: "claude-sdk"` through schema parsing. Terminal remains an explicit selection.
2. **Launch failures are visible and final for that attempt.** Mission Control does not silently
   fall back from SDK to Terminal. The task records the specific error and can be retried after
   configuration is fixed or after the operator selects Terminal.

## Out of scope

- replacing ai-conductor's tmux-supervised background daemon;
- adding an embedded Codex host for `$engineer`;
- changing Conductor's downstream agent, model, effort, routing, DECIDE, or gate behavior;
- provisioning a Mission Control worktree for pipeline tasks;
- attached repositories, after-work Workflows, or Foreman autopilot for pipeline tasks;
- parsing SDK transcript prose or shell commands to infer the provider run;
- changing provider event ingestion, projection keys, or cost attribution;
- automatically stopping a provider daemon when a Mission Control task is cancelled.

## Known risks

- The slug function is an adapter contract copied from ai-conductor. A future provider change must
  update the adapter and its fixtures together. Duplicate refusal prevents an already projected
  old run from being mistaken for a new dispatch.
- A successfully completed `/engineer` turn can still produce no build run if the operator declines
  routing, authoring fails, or the Conductor daemon cannot start. The SDK session remains the
  inspectable recovery surface; the task does not fabricate completion.
- Selecting SDK does not make a tmux-free Conductor installation. The Engineer host no longer
  needs a Mission Control terminal home, but ai-conductor's daemon still does until that project
  adopts another supervisor.
