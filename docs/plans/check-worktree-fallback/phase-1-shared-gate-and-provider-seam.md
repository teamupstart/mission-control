# Phase 1 - The shared pool gate and the check tree provider seam

## Outcome

Two structural changes with **zero behaviour change**, so the risky refactor of the most
safety-critical file in this subsystem is reviewable on its own:

1. The question "is the treehouse pool usable here?" is answered in **one module** by two named
   predicates, instead of existing on the dispatch path and nowhere else.
2. `CheckLeaseManager`'s four treehouse-specific operations move behind a `CheckTreeProvider`
   interface, with the pool as its only implementation, and the row records which provider took the
   tree.

Engineering value: the drift that caused the defect becomes structurally hard to repeat, and Phase 2
becomes a small additive diff instead of a rewrite of `check-lease.ts`.

## Entry criteria and dependencies

- **Direct dependencies:** none. This is the foundation phase.
- The approved source plan (`docs/plans/check-worktree-fallback/plan.md`) and the recorded decision
  that the check path gates on the **binary half only**.

## Scope

- `hasBin` moves out of `dispatcher.ts` into `src/server/util/exec.ts`.
- `src/server/pool.ts` gains `treehouseInstalled()` and `poolAvailableFor(repoRoot)`.
- `dispatcher.ts` consumes `poolAvailableFor`.
- `workflow_check_leases` gains a `provider` column via migration.
- `CheckTreeProvider` is introduced with one implementation, wrapping today's exact calls.

### Non-goals

- **No git provider.** Phase 2 owns it. After this phase every check still takes a pooled tree and a
  machine without treehouse still fails the gate. That is deliberate: this phase must be provable as
  a no-op.
- No README change (Phase 2 documents the behaviour it introduces).
- Nothing in `run-model.ts`, `WorkflowRuns.tsx`, or the opt-in question.

## Repository findings

- `dispatcher.ts:773` is the **only** `hasBin(TREEHOUSE_BIN)` call in the codebase. `hasBin` is
  module-private at `dispatcher.ts:1091-1093` and wraps `resolveBinPath`, which spawns `which`.
- `dispatcher.ts:1102` exports `agentBinPresent`, which also uses `hasBin`. Moving `hasBin` must keep
  that export working.
- `src/server/util/exec.ts:17` already has `onPath`, whose doc comment explicitly frames it as the
  other half of the same question ("the cheap answer is a handful of `existsSync` calls rather than a
  `fork` + `execve`"). **Do not merge the two** - `check-spawn.ts:29-35` documents why `onPath` must
  not be used to precheck a command, and that reasoning depends on them staying distinct.
- `isTreehouseRepo` (`pool.ts:166`) is used at `dispatcher.ts:773`, `pool.ts:282`, and `pool.ts:608`
  (`reapPool`'s early return). Leave the latter two alone.
- `workflow_check_leases` is defined at `db.ts:701-713` with two partial indexes at `db.ts:729-732`.
  `addColumn` (`db.ts:1929`) is the migration helper and returns whether it added.
- `CheckLeaseRow` is `check-lease.ts:85-97`; `CheckLeaseStore.insertHeld` (`check-lease.ts:179-206`)
  names its columns explicitly; `get`/`listLive` use `SELECT *` through a `toRow` mapper.
- The treehouse-specific calls inside the manager are exactly four:
  `acquireLease` + `this.pin` (`check-lease.ts:432`, and the pin just below),
  `this.cli.status` (`:530`), `this.cli.return` (`:568`), and `withPoolLock` (`:431`, `:515`).

## Implementation steps

### 1. Move `hasBin` to `util/exec.ts`

Move `resolveBinPath` and `hasBin` from `dispatcher.ts` into `src/server/util/exec.ts`, beside
`onPath`. Export both. Add a short comment tying the three together: `onPath` walks the filesystem,
`hasBin` spawns `which`, and they are not interchangeable.

Re-import in `dispatcher.ts` so `agentBinPresent` and any other caller keep working. Verify with
`npm run typecheck` that no other module was relying on the private version.

### 2. Two named predicates in `pool.ts`

```ts
/**
 * Whether the pool binary is resolvable at all.
 *
 * The half that was MISSING on the check path, and the only half a check asks - a check must keep
 * working on a repository that never opted in, so it must not consult `isTreehouseRepo`. See the
 * opt-in question in the source plan, which is deliberately not decided here.
 */
export async function treehouseInstalled(): Promise<boolean>;

/** The full dispatch gate: the binary is there AND this repository opted in. */
export async function poolAvailableFor(repoRoot: string): Promise<boolean>;
```

`poolAvailableFor` is `(await treehouseInstalled()) && isTreehouseRepo(repoRoot)`. Both live here so a
later reader finds them together; the comment on `treehouseInstalled` is what stops someone
"tidying" the check call site into the conjunction and shipping the deferred decision by accident.

### 3. Rewire the dispatch gate

`dispatcher.ts:773` becomes:

```ts
if (await poolAvailableFor(repoRoot)) {
```

No other change to that function. Its fallback arm, its reap-and-retry, and its warning text stay
exactly as they are.

### 4. Migration

In `db.ts`, beside the other `workflow_check_leases` work:

```ts
addColumn(d, "workflow_check_leases", "provider", "TEXT NOT NULL DEFAULT 'treehouse'");
```

The default is **historically accurate, not a guess**: every row that can exist before this
migration was written by the treehouse-only path. Record that reasoning in a comment - the table's
own comment at `db.ts:691-693` warns against nullable columns whose NULL cannot be distinguished
from "a build that did not set it", and a NOT NULL default with a true value is the way to stay
clear of that.

Do not touch the two partial indexes.

### 5. The provider interface

In `check-lease.ts`:

```ts
export interface CheckTreeProvider {
  readonly kind: WorktreeProvider;               // the EXISTING union, src/shared/types.ts:1386
  acquire(input: { repoRoot: string; attemptId: string; baseSha: string }):
    Promise<{ path: string; holderToken: string }>;
  ownership(row: CheckLeaseRow): Promise<
    | { state: "unreadable"; reason: string }
    | { state: "gone" }
    | { state: "held"; holder: string }
  >;
  handBack(row: CheckLeaseRow): Promise<RunResult>;
  withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
}
```

Then `TreehouseCheckTreeProvider`, built from the injected `TreehouseCli` plus `pin`/`verifyBase`, so
the existing `CheckLeaseDeps` seam keeps working and every current test keeps injecting a fake pool
the same way.

Map today's code onto it exactly:

- `acquire` - `acquireLease(repoRoot, checkHolderToken(attemptId), cli)`, then `pin`, and the existing
  unwind on pin failure. Returns the realpath and the holder token.
- `ownership` - `cli.status(repoRoot)`; non-zero → `unreadable`; parse with `parsePoolStatus`; absent
  or `available` or null holder → `gone`; otherwise `held` with the parsed holder.
- `handBack` - `cli.return({ cwd, path, force: true })`.
- `withLock` - `withPoolLock`.

### 6. Rewire the manager onto the seam

`resolveLocked` keeps its exact shape. It must still distinguish:

1. "we could not look" → `retryLater`, authorisation unchanged;
2. "already returned / not ours to act on" → `settle("returned")`;
3. "held by a token that is not ours" → `settle("lost")` and drop the pin;
4. "ours" → `handBack`, and `failedReturn` on non-zero.

That mapping is load-bearing and documented at length in the existing comments. **Carry the comments
across with the code** - they explain why `returning` must not be written when the pool was merely
unreadable, and a reviewer cannot re-derive that.

`CheckLeaseRow` gains `provider: WorktreeProvider`. `insertHeld` takes and writes it. `toRow` reads
it. `acquireForAttempt` passes `provider.kind`. `releaseForAttempt` selects the provider **from the
row**, never from a fresh probe - in this phase there is only one, but the selection point must
already read the column so Phase 2 is additive.

Keep pinning unconditional (`justAcquired`, `PoolPins.checkLeasePaths`). Nothing about it becomes
provider-specific, now or in Phase 2.

## Tests and verification

The strongest signal available here is that **the existing suites pass untouched** - that is what
"no behaviour change" means. Do not edit them to fit a refactor; if one fails, the refactor is wrong.

```sh
node --test --test-concurrency=2 --import tsx \
  test/workflow-check-lease.test.ts test/workflow-check-runtime.test.ts \
  test/workflow-check-supervisor.test.ts test/workflow-check-env.test.ts \
  test/pool.test.ts test/pool-check-pins.test.ts \
  test/dispatch-git-preflight.test.ts test/dispatch-pinned-base.test.ts \
  test/workflow-check-degradation.test.ts
npm run typecheck
npm run lint
npm test
```

`test/workflow-check-degradation.test.ts` must still pass **unchanged** in this phase, still
asserting `kind: "infrastructure"`. It is the proof this phase changed no behaviour. Phase 2 flips it.

Add:

- A migration case: open a database seeded with a pre-migration `workflow_check_leases` row, assert it
  opens and the row reads back `provider === "treehouse"`. Follow the existing db-migration test
  patterns rather than inventing a new harness.
- A case asserting `poolAvailableFor` is false when the binary is absent and false when
  `treehouse.toml` is absent, and that `treehouseInstalled` ignores the repo entirely. This is where
  the adopted split is pinned as a property.

## Merge and exit criteria

- Every listed suite green, `npm run typecheck` and `npm run lint` clean.
- `provider` column present, always `'treehouse'`, and read back through `CheckLeaseRow`.
- `dispatcher.ts` no longer spells the gate itself.
- A machine without treehouse still fails a check exactly as before - unchanged, and proven by the
  untouched degradation suite.

## Downstream handoff

Phase 2 may rely on:

- `treehouseInstalled()` and `poolAvailableFor()` in `pool.ts`, and `hasBin` in `util/exec.ts`.
- `CheckTreeProvider` as the only way the manager reaches a tree.
- `CheckLeaseRow.provider` being populated and authoritative on release.
- The provider selection point inside `releaseForAttempt` already reading the row.

Phase 2 **must not** change: the four-way mapping in `resolveLocked`, the unconditional pinning, the
`LIVE_STATES` scoping of the partial indexes, or `reapPool`'s early return.

## Cross-phase audit record

- **Initial (this phase, first written):** no earlier phases to reconcile.
- Provider selection in `releaseForAttempt` deliberately reads `row.provider` even though only one
  provider exists, so Phase 2 adds an implementation rather than moving a decision. Recorded so a
  reviewer does not "simplify" it back to a constant.
