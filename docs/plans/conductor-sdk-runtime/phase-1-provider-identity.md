# Phase 1: deterministic provider identity

## 1. Outcome

Every newly dispatched pipeline task knows its exact provider run before the current terminal host
starts. The task still launches `conduct-ts engineer --idea` in a terminal home, but completion no
longer depends on discovering a child agent before the durable row can name the run.

This phase is the compatibility foundation for the SDK runtime. It ships no new setting and makes
no dashboard control or launch-default change.

Estimated non-test implementation: about 140 lines.

## 2. Entry criteria and dependencies

- No implementation-phase prerequisite.
- The planning pull request containing this file must be merged so the task can resolve it on the
  default branch.

## 3. Scope and non-goals

In scope:

- provider-owned task identity and Conductor's canonical idea slug helper;
- fail-closed validation for an empty slug or unreadable provider run set;
- refusal when a live Mission Control task or provider worktree already owns the exact run key;
- persisting `Task.pipelineRun` before the existing terminal home launches;
- keeping the current home-backed argv, cwd, status, cleanup, and session discovery;
- retaining one-time resource/worktree binding for older tasks with no precomputed link;
- focused provider, dispatcher, lifecycle, restart, and documentation coverage.

Non-goals:

- pipeline runtime config;
- any SDK session launch;
- Settings or dispatch UI changes;
- changing provider completion or dependency-satisfaction semantics;
- changing ai-conductor state or its slug algorithm.

## 4. Repository findings

- `pipelineTaskLaunch` in `src/server/pipelines/index.ts` resolves one active provider for the task
  repository, then returns only provider argv and cwd.
- `PipelineProvider.taskArgv` in `src/server/pipelines/types.ts` is provider-specific and can be
  extended without putting Conductor rules in the dispatcher.
- `PipelineProvider.knownRunSlugs` already reads the provider's current worktree key space and
  distinguishes unreadable (`null`) from empty. Reuse it for a collision preflight.
- `conductorEngineerArgv` in `src/server/pipelines/conductor/index.ts` is the current provider task
  launch seam. Keep its `/usr/bin/env -u CLAUDECODE` argv byte-identical.
- ai-conductor commit `eda111c903d1` defines the idea slug as lowercase ASCII alphanumerics,
  hyphenated separators, trimmed edges, and a 50-character cap. Engineer uses it for the plan
  filename that becomes the daemon's run slug.
- `Dispatcher.dispatchPipeline` patches `homeName` and then `running`, leaving `sessionId: null`.
  It can persist the returned run link immediately before `spawnUniquely` without changing the
  terminal mechanism.
- `TaskManager.bindPipelineTask` currently learns the link from a child session's projected
  worktree. Its refusal to replace a different existing link is already the right safety rule.
- `TaskManager.settlePipelineTask` and boot-restored projection tests already support a task whose
  link exists before any child session.

## 5. Implementation

1. Add a provider task-identity method to `PipelineProvider`, returning a `PipelineRunLink` or a
   bounded refusal. Implement it in the Conductor adapter beside `conductorEngineerArgv`.
2. Export and test the adapter's canonical slug helper. Refuse an idea whose canonical slug is
   empty rather than launching a host that cannot create a stable branch or plan key.
3. Extend `pipelineTaskLaunch` to compose identity, current provider slugs, argv, and cwd in one
   consented provider read. If the provider's key space cannot be read, fail closed. If it already
   contains the expected slug, refuse the duplicate before opening a terminal.
4. Return the complete `PipelineRunLink` with the launch result. Keep the provider id and resolved
   repository from the same config snapshot used for argv composition.
5. In `Dispatcher.dispatchPipeline`, check the Registry for another `running` or `dispatching`
   pipeline task already holding that link. Refuse a second live owner even in the interval before
   the provider has created its worktree.
6. Patch the current task's `pipelineRun` before calling `spawnUniquely`. Leave terminal argv,
   terminal label, `homeName`, `sessionId: null`, and status order unchanged.
7. Keep `bindPipelineTask` as a migration fallback. It may fill a null link, must accept a
   discovered session matching the prebound link, and must never rewrite a different prebound
   key.
8. Update the pipeline launch sections of `docs/dispatch-and-backlog.md` and `docs/pipelines.md`:
   new tasks prebind deterministic identity; old terminal tasks may still bind through their home
   and child worktree; the provider projection remains completion authority.

## 6. Data and compatibility

- No schema migration. `Task.pipelineRun` already round-trips through SQLite.
- Task kind, provider ids, pipeline run keys, and event keys do not change.
- Reschedule continues clearing `pipelineRun`; the next dispatch recomputes it from current intent
  and provider config.
- A failure after prebinding may retain the expected link on the failed task until Retry or Clean
  up. It is evidence, not a claim that the provider run exists.
- Old rows with `pipelineRun: null` remain readable and bind through the existing strong terminal
  resource join.

## 7. Tests and verification

Add or extend focused tests to prove:

- canonical slug fixtures: punctuation, repeated separators, trimmed edges, mixed case, Unicode,
  50-character truncation, and empty output;
- every `PipelineProvider` implements task identity;
- unreadable provider runs and existing exact slugs refuse before terminal spawn;
- a second active task with the same link refuses before spawn;
- a different repository or different slug may launch concurrently;
- terminal argv and cwd stay byte-identical;
- dispatcher stores the link before spawn and still records a home with no session id;
- a processed projection settles a prebound task without child-session discovery;
- an older null-link task still binds from home plus projected worktree;
- a discovered mismatched child cannot reassign a prebound task;
- restart with a persisted link and processed run still settles.

Run:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-contracts.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/pipeline-phase6.test.ts
npm run typecheck
npm run lint
npm test
```

## 8. Merge and exit criteria

- All section 7 gates pass.
- A normal pipeline task still launches the same terminal command and retains the same cleanup
  resources.
- Its durable row names the expected provider run before any child agent is discovered.
- Duplicate ownership is refused with a specific task error and no host process.
- Documentation describes both prebound new tasks and legacy terminal fallback accurately.

## 9. Downstream handoff

Phase 2 may rely on:

- the provider task-identity method and its exact `PipelineRunLink` result;
- the Conductor slug helper and collision preflight;
- the invariant that a new task has `pipelineRun` before any host starts;
- Registry refusal of a second active task for the same link;
- `bindPipelineTask` remaining available only as legacy/resource fallback;
- processed provider projection remaining the task's completion authority.

Phase 2 must not move slug logic into the browser, infer a run from SDK transcript text, or make
SDK idleness replace provider completion.

## 10. Cross-phase audit record

- 2026-08-17: verified `knownRunSlugs` already has the fail-closed null/empty distinction required
  for collision preflight.
- 2026-08-17: added the Registry active-owner check because the provider worktree does not exist
  during Engineer authoring. Filesystem collision alone leaves a window for two identical Mission
  Control dispatches to prebind the same future run.
- 2026-08-17: preserved terminal child-session binding for old rows. Removing it in the identity
  phase would strand tasks persisted before the new field is populated at launch.
