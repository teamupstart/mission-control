# Phase 2 - The git provider, and a check gate that degrades

## Outcome

A configured, authorized Workflow check gate **runs on a machine with no `treehouse` installed**,
instead of failing three times and stalling the run forever. The gate keeps gating; it does not go
silently green.

User-visible value: a review on such a machine gets a real build result. Today it gets a run stuck in
`blocked` / `infrastructure_error` that only a manual retry or resubmit can move.

## Entry criteria and dependencies

- **Direct dependency: Phase 1.** This phase adds a second `CheckTreeProvider` implementation and
  selects between them. Without Phase 1 there is no seam, no `provider` column, and no
  `treehouseInstalled()`.

## Scope

- `GitCheckTreeProvider`, the second implementation.
- Provider **selection** on acquire, gated on `treehouseInstalled()` only.
- `CHECK_WORKTREES_DIR` in `config.ts`.
- Flip `test/workflow-check-degradation.test.ts` into a regression test, plus the new cases below.
- README: the `max_trees` drift and what checks do without treehouse.

### Non-goals

- **Not** the `isTreehouseRepo` half. A repository with no `treehouse.toml` keeps taking a pooled tree
  for its checks. This is the adopted decision, and Phase 2 is where someone is most tempted to
  "finish the job" - do not.
- **Not** the "provider call" mislabelling (`run-model.ts:667`, `run-model.ts:1564`,
  `WorkflowRuns.tsx:678-679`). Filed separately; it is a UI change and needs its own Playwright spec.
- No change to `MAX_INFRA_ATTEMPTS` or the retry ladder. This phase removes a *cause* of
  infrastructure failure; the ladder itself is correct for real transient failures.

## Repository findings

- `run` (`util/exec.ts:62-64`) never throws on a missing binary - ENOENT arrives as `code: 1` with
  Node's message in `stderr`. That is why the current failure reads `spawn treehouse ENOENT` and why
  `treehouseInstalled()` is the honest gate rather than catching an error.
- `check-runtime.ts:197-202` already converts an acquire throw into
  `{ kind: "infrastructure", reason }`. Nothing in the runtime needs to change: once acquisition
  succeeds through the git provider, the existing spawn, supervision, and settle path is unchanged.
- `check-runtime.ts:163-168` asks the platform probe **before** a tree is taken, with the comment that
  an unsupported platform "must never reach a pool at all". Provider selection belongs in the same
  spirit: decided before anything is acquired.
- `WORKTREES_DIR = join(STATE_DIR, "worktrees")` (`config.ts:24`) is dispatch's. A check tree must not
  live there.
- `teardownWorktree` (`dispatcher.ts:899`) already branches on `provider` and spells the git removal
  as `git -C <repoRoot> worktree remove --force <path>`. Reuse that spelling; do not invent a second.
- `reapPool` early-returns for a non-treehouse repo (`pool.ts:608`) - **verified** - so a pinned git
  path is inert to the reaper.
- Every current `withPoolLock` caller is a genuine pool operation (`pool.ts:613`, `:670`,
  `dispatcher.ts:778`, `:791`, `:809`, `:938`, `check-lease.ts:431`) - **verified** - so a
  pass-through lock for the git provider changes nothing for the pool.

## Implementation steps

### 1. `CHECK_WORKTREES_DIR`

```ts
/** Isolated worktrees the daemon creates for Workflow checks when the pool is unavailable. */
export const CHECK_WORKTREES_DIR = join(STATE_DIR, "check-worktrees");
```

Separate from `WORKTREES_DIR` so no dispatch-side sweep can mistake a check tree for a task tree, and
so an operator reading the state directory can tell the two apart.

### 2. `GitCheckTreeProvider`

- `kind` - `"git"`.
- `acquire` - `mkdirSync(CHECK_WORKTREES_DIR, { recursive: true })`, then
  `git -C <repoRoot> worktree add --detach <CHECK_WORKTREES_DIR>/<attemptId> <baseSha>`, then
  `verifyHeadIs(path, baseSha)`. Return the realpath.
  - `--detach` deliberately: a check never commits, so there is no branch to name and none to clean
    up. This is simpler than dispatch's arm, which cuts `harness/<slug>` branches.
  - `attemptId` is the directory name because it is unique forever, which is what makes step 3's
    ownership rule sound. Guard the acquire against a path that already exists - that means a prior
    attempt of the same id, which `acquireForAttempt` already refuses upstream; fail loudly rather
    than reusing it.
  - On a `verifyHeadIs` failure, remove the tree before throwing, mirroring the pool arm's unwind and
    `provisionWorktree`'s own git arm (`dispatcher.ts:851-865`).
- `ownership` - `git -C <repoRoot> worktree list --porcelain`. If the command fails or
  `outcomeUnknown`, return `unreadable`. If the path is absent from the list, `gone`. If present,
  `held` with the row's own `holderToken`.
  - **Write down why presence is ownership.** A pool *slot* is handed out repeatedly, so a path says
    nothing about who holds it - hence the token. A check git tree is at a path derived from an
    `attemptId` that is never reused, so a registered worktree at that path is ours by construction.
    Without this comment the next reader sees a tautology and "fixes" it.
- `handBack` - `git -C <repoRoot> worktree remove --force <path>`, same spelling as
  `teardownWorktree`.
- `withLock` - call `fn()` directly. Comment that there is no cross-process pool to serialise
  against, `git` takes its own index lock, and the manager's `busy` set already provides in-process
  single-flight.

### 3. Select the provider on acquire

In `acquireForAttempt`, before anything is acquired:

```ts
const provider = (await treehouseInstalled()) ? this.pool : this.git;
```

Gate on `treehouseInstalled()` **only**, and put the reason in a comment at the call site: a check
must keep working on a repository that never opted in, so it must not consult `isTreehouseRepo`; the
opt-in question is filed separately and is not decided here.

Persist `provider.kind` on the row (Phase 1 already threads it). `releaseForAttempt` already selects
from `row.provider` - no change needed, which is the point of Phase 1's shape.

### 4. Documentation

- `README.md:2922` - the repository's pool sets `max_trees` **32** (`treehouse.toml:23`), not 16.
- `README.md:2920-2925` - state that when `treehouse` is not installed a check falls back to a
  throwaway `git worktree` pinned to the captured commit, so the gate still runs; and that a check
  does **not** consult `treehouse.toml`, unlike a dispatch.

## Tests and verification

Flip the existing suite. `test/workflow-check-degradation.test.ts` currently asserts
`kind: "infrastructure"` for a passing command with no treehouse on PATH; it must now assert the
command's real verdict. Keep its PATH-stripping helper, its "the strip actually worked" assertions,
and its per-case lease-leak `afterEach` - those are what make it honest. Update the file's header
comment: it stops documenting a defect and starts documenting a guarantee.

Add:

- **Pinning.** A git-provider tree's HEAD is the captured commit, verified through the real
  `verifyPinnedBase`/`verifyHeadIs` - the same standard the pool arm is held to.
- **No leak.** After the check, the worktree is gone from `git worktree list` and the row is
  terminal. The suite's existing `afterEach` covers the row; assert the directory too.
- **The provider column is authoritative.** A row written with `provider = 'treehouse'` is released
  through the treehouse provider even when the current machine would now choose git. Drive this with
  the injected fake pool so it needs no binary.
- **Fail-closed on a vanished binary.** A `treehouse` row whose binary is gone resolves `retry`, keeps
  the row live, and keeps the pin. This is the deliberate outcome recorded in the source plan, so it
  needs a test or a later reader will "fix" it into a destructive return.
- **The adopted split, deliberately.** With the binary present and no `treehouse.toml`, dispatch takes
  a git worktree and a check still takes a pooled tree. The case must say in its name and a comment
  that this is the adopted decision, not an accident - it is the guard against the deferred opt-in
  question being answered by a future refactor.

```sh
node --test --test-concurrency=2 --import tsx \
  test/workflow-check-degradation.test.ts test/workflow-check-lease.test.ts \
  test/workflow-check-runtime.test.ts test/pool.test.ts test/pool-check-pins.test.ts \
  test/dispatch-git-preflight.test.ts
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
```

`npm run build && npm run smoke` because this phase adds a runtime surface (a new state
subdirectory). No `npm run test:e2e` and no `e2e/` spec: this change has no UI surface.

## Merge and exit criteria

- With no `treehouse` on PATH, a configured check runs its command and reports its real verdict, in a
  worktree pinned to the captured commit, and hands that worktree back.
- With `treehouse` present, every existing pool behaviour is unchanged - proven by the untouched
  `workflow-check-lease` and `workflow-check-runtime` suites.
- A repository with no `treehouse.toml` still takes a pooled tree for its checks.
- README matches the implementation, `max_trees` included.

## Downstream handoff

Nothing depends on this phase. Two follow-ups are filed separately and must not be folded in:

- the "provider call" mislabelling, which needs its own Playwright spec;
- the silent opt-in question, whose eventual answer may make the check path adopt
  `poolAvailableFor` wholesale. If that lands, the "adopted split" test above is the one that must be
  deliberately rewritten - it is the tripwire, and rewriting it should require saying so out loud.

## Cross-phase audit record

- **Reconciled against Phase 1.** Phase 1 owns the seam, the column, the two predicates, and the
  `releaseForAttempt` selection point; this phase adds only an implementation and the acquire-time
  selection. No Phase 1 contract needed amending - the selection point was written to read
  `row.provider` from the start precisely so this phase would be additive.
- **Migration ownership:** Phase 1, not here. This phase writes a new value into an existing column
  and adds no schema change.
- **Documentation ownership:** here, not Phase 1, because this is the phase that introduces the
  behaviour the README would describe. Phase 1 is a no-op and has nothing to document.
- **Pinning:** unchanged and unconditional in both phases, per Phase 1's handoff.
