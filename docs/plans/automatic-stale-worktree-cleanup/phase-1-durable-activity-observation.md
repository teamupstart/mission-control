# Phase 1: Durable activity observation

## Outcome

Mission Control continuously records a restart-safe, task-level worktree activity boundary for
every terminal task that still owns at least one worktree. The observer detects local commits,
index changes, tracked worktree changes, and non-ignored untracked files across all attached
repositories, then persists a 30-day due time.

This phase is deliberately non-destructive. It starts the conservative rollout clock and makes
the evidence testable, but it never calls reclaim, returns a provider lease, stops a terminal home,
or removes a Git worktree.

## Entry criteria and dependencies

- Direct dependency: the planning pull request containing `plan.md`, `phased-plan.md`, and this
  phase file is merged.
- No implementation-phase dependency.
- Read `docs/agent-guides/architecture.md`, `docs/agent-guides/change-contracts.md`,
  `docs/worktrees-and-checks.md`, and the source plan before editing.

## Scope

- Add one shared predicate for whether a task holds any primary or attached worktree.
- Make terminal candidate loading and in-memory pruning respect attached-only partial-cleanup
  shapes.
- Add a migration-safe task-worktree retention ledger and focused store operations.
- Add a deterministic aggregate Git-state probe with bounded, streaming file reads.
- Add a daemon-owned, non-overlapping observer with a fixed internal cadence and test seams.
- Wire start and stop ordering into the daemon without depending on native-pool maintenance.
- Add focused unit, integration, migration, restart, and concurrency coverage.

## Non-goals

- Do not automatically or manually invoke `TaskManager.reclaim()` from the new service.
- Do not change restart reconciliation's current teardown behavior yet. Phase 2 replaces that
  branch at the same time it can honor the full retention state machine.
- Do not add dashboard copy, a countdown, a retry message, a route, a public duration setting, or
  a retention off switch.
- Do not preserve patches, push commits, create rescue branches, or inspect remote push state.
- Do not clean worktrees not durably owned by a task.

## Repository findings and inherited contracts

- `src/shared/task-repos.ts` already owns primary-plus-secondary enumeration through
  `taskRepoRefs()`. Extend that source instead of creating another repository list.
- `src/server/db.ts` maps all selected task rows through `rowsToTasks()`, which attaches
  `task_repos` in one batch. `loadResourceHoldingTerminalTasks()` currently filters only the
  primary `tasks.worktree_path` and `home_name`; use an `EXISTS` clause for attached worktrees.
- `Registry.pruneTerminalTasks()` currently treats a terminal task with no primary path as
  evictable. It must use the shared all-repository predicate so the observer and later cleanup do
  not lose ownership from memory.
- `run()` buffers stdout and defaults to an 8 MB maximum. A fingerprint implementation must not
  feed arbitrary file contents or an unbounded path list through that buffer. Stream file content
  and use NUL-delimited Git output with an explicit safe bound or a streaming child-process helper.
- The daemon is the only SQLite writer. The observer lives in the daemon and persists through the
  existing DB module or a store built over that module's connection pattern.
- `startPoller()` completes a first discovery pass even when its recurring interval is disabled.
  Start observation only after that discovery gate so SDK restore and session/task reconciliation
  have established current ownership.

## Implementation steps

### 1. Establish one resource predicate

Add `taskHasWorktrees()` to `src/shared/task-repos.ts`, or use an equally central exhaustive name.
It must return true when the primary path or any `extraRepos[].worktreePath` is non-null. Keep home
ownership separate because the approved policy requires at least one worktree.

Apply it to:

- `loadResourceHoldingTerminalTasks()` in `src/server/db.ts`, using SQL that includes an attached
  row with a non-null `worktree_path`; and
- `Registry.pruneTerminalTasks()` in `src/server/registry.ts`, so attached-only owners remain in the
  in-memory registry and SSE snapshot.

Add regression fixtures for a task whose primary tree was released but whose attached tree remains.
Do not broaden startup teardown, removal, or the dashboard in this phase.

### 2. Add the durable ledger

In `src/server/db.ts`, add a new table following the repository's create-and-migrate rules. Use one
row per task ID. The durable contract must cover:

- `task_id` primary key;
- resource generation and aggregate fingerprint;
- `last_changed_at`, `observed_at`, and `cleanup_due_at`;
- cleanup state, claim token/time, latest attempt time, retry time, and bounded error fields needed
  by Phase 2; and
- row update time for diagnosis.

Use a narrow internal row type, not `Task`, for hashes and claim data. Add store operations that can:

- read one row and list due/candidate rows without N+1 queries;
- insert the first observation;
- replace a row when an external resource generation changes;
- record an unchanged or changed successful observation;
- record an unknown observation without moving `last_changed_at` or `cleanup_due_at`;
- prune a row after the task or its last worktree disappears; and
- delete the row inside `deleteTask()`'s cleanup sequence.

Define the Phase 2 claim columns now so activation does not need a second migration. Leave every
row in the observation state in this phase and test that no claim transition is reachable from the
observer.

### 3. Define resource generation

Create a deterministic server-side helper near the retention service. Build the generation from:

- task ID and `dispatchedAt` attempt boundary;
- the primary and attached repository positions in `taskRepoRefs()` order;
- canonical repository roots and recorded worktree paths;
- recorded provider and native lease identity; and
- terminal home name, terminal resource ID, and session ID, because reclaim can stop or clear them.

Hash the canonical serialization rather than persisting it as another source of resource truth.
Any dispatch, reschedule, path replacement, lease replacement, or terminal ownership replacement
must produce a new generation. Pure task metadata and pull request polling must not.

### 4. Implement the Git-visible activity probe

Add a focused module such as `src/server/git/worktree-activity.ts`. The exact implementation may
adapt to existing utilities, but it must produce the following semantic fingerprint for each
recorded worktree:

1. full HEAD identity, including unborn-HEAD handling if the repository permits it;
2. the complete index entry set, including modes, stages, blob IDs, and NUL-delimited paths;
3. tracked worktree status, including deletion, rename, mode, symlink, and submodule signals; and
4. every non-ignored untracked path and its current content identity.

Use Git plumbing or porcelain with `-z`; never split filenames on newline. For regular changed or
untracked files, stream bytes into the digest rather than loading the file into memory. Hash symlink
targets as link data. Include explicit markers for deleted paths and supported special states. If a
path changes during the read, Git exits ambiguously, a required object cannot be read, the worktree
is not the exact recorded checkout, or a file kind cannot be represented safely, return `unknown`
with a bounded internal reason.

Combine per-worktree fingerprints in persisted repository-position order. Do not store file paths,
file contents, or Git command output in the ledger. Ignored files must not participate. A state that
changes and fully returns to the prior fingerprint between observations does not reset the clock,
because no changed Git-visible work remains.

Bound simultaneous repository probes and individual file reads. A very large visible file may take
time to stream, but must not be silently truncated into a stable fingerprint. On an explicit probe
timeout or safe-size refusal, report `unknown` and leave the clock unchanged.

### 5. Run an observation-only lifecycle

Add a service such as `TaskWorktreeRetentionObserver` that receives the registry, store, clock,
scheduler, probe, and concurrency limit through narrow dependencies.

- Start one immediate pass after the first completed session discovery, then schedule the next pass
  from the completion of the current pass. Never overlap passes.
- Use a fixed internal cadence materially shorter than 30 days, such as six hours. Do not read
  `MISSION_WORKTREE_SWEEP_MS` and do not expose a public disable value.
- Enumerate only `done`, `failed`, or `cancelled` tasks for which `taskHasWorktrees()` is true.
- Re-read the task before writing an observation so a stale pass cannot attach a fingerprint to a
  replaced generation.
- On the first successful observation of a generation, set `last_changed_at` to the current clock
  and `cleanup_due_at` to exactly 30 days later. Do not infer older activity from task timestamps or
  filesystem mtimes.
- On a changed fingerprint, reset the same fields to the observation time and 30 days later.
- On unchanged state, advance only `observed_at`. On `unknown`, preserve the activity boundary and
  record only bounded diagnostic state.
- Prune rows for missing, non-terminal, or resource-free tasks. A later re-dispatch creates a new
  generation and full grace period.
- Expose `stop()` and await any in-flight pass before `worktrees.stop()` in daemon shutdown.

The observer must have no reference to `TaskManager.reclaim()`, `teardownWorktree()`, or provider
release methods. Make this invariant visible in its dependency interface and tests.

## Data and compatibility details

- The table addition must open both a fresh database and a pre-feature database without destructive
  backfill.
- Existing task rows get no ledger row until the first successful observation. That is the rollout
  safety mechanism, not missing data to synthesize from `updated_at`.
- A failed probe cannot make a task appear inactive. Preserve the last valid deadline, but Phase 2
  must require a fresh successful revalidation before acting on it.
- Ledger rows remain internal server data in this phase. Do not widen `Task`, `ServerEvent`, or
  browser state yet.
- Keep stored error text bounded and free of file content. Paths already present on the task need
  not be duplicated into the error.

## Tests and verification

Add focused tests, with names adapted to repository conventions:

- `test/task-worktree-activity.test.ts` for HEAD, complete index state, staged changes, tracked
  unstaged changes, executable/symlink/deletion cases, ignored versus non-ignored untracked files,
  odd filenames, large streamed files, multi-repository ordering, and unknown results;
- `test/task-worktree-retention-db.test.ts` for fresh schema, upgrade opening, row transitions,
  bounded errors, orphan/task deletion, and compare-and-swap columns remaining inert;
- `test/task-worktree-retention-observer.test.ts` for first observation, changed, unchanged, unknown,
  restart, generation replacement, terminal-only eligibility, row pruning, no overlapping pass,
  bounded probe concurrency, and the zero-reclaim invariant; and
- existing task/registry tests for attached-only durable loading and terminal pruning.

Run focused files with the mandatory preload, then the relevant full gates:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/task-worktree-activity.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-worktree-retention-db.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-worktree-retention-observer.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No Playwright spec is required in Phase 1 because it adds no visible dashboard behavior. Phase 2's
activation changes visible task behavior and owns the required E2E coverage.

## Merge and exit criteria

- A terminal task's aggregate fingerprint and due time survive daemon and database reopen.
- Every Git-visible state named in the approved policy changes the fingerprint; ignored churn does
  not.
- First observation grants a full 30 days, and unknown reads cannot age or reclaim anything.
- Attached-only terminal tasks stay durably loaded and in memory.
- The daemon starts and stops the observer in the correct discovery/worktree order.
- Tests prove the observer has no destructive dependency and never transitions a cleanup claim.
- Relevant focused tests, typecheck, lint, full unit suite, build, and smoke pass.
- The pull request explains any repository-driven deviation from this proposed route.

## Downstream handoff

Phase 2 may rely on the ledger schema, resource generation, activity result type, aggregate probe,
observer lifecycle, and all-repository predicate. It may add claims and cleanup consumers, but it
must not add another timer, activity clock, repository enumerator, Git parser, or cleanup path.

Phase 2 must preserve first-observation grace, unknown-read safety, bounded concurrency, internal
fingerprint privacy, and the Phase 1 zero-truncation semantics.

## Cross-phase audit record

- Initial audit: the phase was checked against the approved source plan and existing task, DB,
  registry, Git utility, discovery, and shutdown contracts.
- Boundary audit: cleanup activation, restart behavior, UI copy, documentation, and Playwright proof
  remain wholly assigned to Phase 2.
- Multi-repository audit: candidate load and pruning land here because Phase 2 cannot consume a
  ledger for attached-only survivors if Registry has already forgotten them.
- Final reconciliation on 2026-08-20: Phase 2 consumes the reserved claim/retry fields, preserves
  terminal-home identity through restart settlement, and uses the same aggregate probe before its
  own mutations and again at the destructive boundary. No Phase 1 schema, clock, or ownership
  contract requires a workaround.
