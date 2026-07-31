# Phase 2: Lease foundation

Source plan: `docs/plans/builtin-workflows/phase-2-check-node.md` (lines 254-301, 390-394, and
checklist items 1, 4, 5 at 415-424)
Index: `docs/plans/check-execution-runtime/phased-plan.md`

## Outcome and value

A check can hold a pooled worktree without anything else in the system destroying it, and a
daemon crash cannot lose track of a tree that is still held.

Nothing user-visible ships here. What ships is the ownership model every later phase depends
on: one adapter for the treehouse CLI, one durable record of a live lease, one reason the pool
reaper cannot touch it, and one reclamation path for the leases that leak anyway.

This phase exists separately because the alternative is discovering the reaper defect in
production. Walk `cheapVerdict` (`pool.ts:479-512`) against an idle check lease held as
`mission-control` and every rung passes - the tree is returned with `treehouse return --force`,
which terminates processes and hard-resets it, under a running check.

## Entry criteria and dependencies

- Direct prerequisite: the planning session's PR merges.
- **No dependency on Phase 1.** Shares no file with it. Concurrency group A; the two may
  merge in either order.

## Scope

In scope:

- One shared treehouse adapter owning acquire, status and return, replacing the two private
  copies and reconciling their disagreement.
- A per-repository pool lock so this process cannot interleave a status read with its own
  return.
- `workflow_check_leases`, the durable owner of a live lease.
- `PoolPins.checkLeasePaths` as a third pin source.
- The check holder-token scheme, and the reasoning that makes the shared reaper structurally
  blind to check leases.
- `CheckProcessRegistry` (Contract P) - the interface and its implementation. **Not** its
  consumer.
- Lease manager: acquire-and-pin, identity-verified return, startup reconciliation, and its
  own reclamation of leaked leases.

Explicit non-goals:

- **No process spawning.** Phase 3. This phase persists process identity and never creates
  any. `CheckProcessRegistry.record` is called by nobody until Phase 3.
- **No `CheckExecutor` implementation.** Phase 4.
- **No change to what the pool reaper does.** It gains a third pin source to read and nothing
  else. Its refusal of check leases falls out of the holder token, not new logic.
- **No holder argument on `treehouse return`.** Not ours to add; the CLI does not have one.
  See Contract L and the residual it names.
- **No plain-worktree fallback.** `phase-2-check-node.md:66-68` and `:264-266`: a configured
  check requires a *pooled* worktree, because the pool is what carries the ignored warm
  dependencies that `clean -fd` preserves. A dry pool is infrastructure, not a reason to
  `git worktree add`. Note the asymmetry with `provisionWorktree`, which **does** fall back
  (`dispatcher.ts:761-787`) - a dispatched session can afford a cold tree and a three-minute
  check cannot afford to become a twelve-minute one. The shared adapter must therefore not
  bake the fallback in; it stays the dispatcher's decision.

## Repository findings this phase depends on

- **`PoolPins` has two fields** (`pool.ts:175-178`), populated by `poolPins(registry)`
  (`:189-197`) from live sessions and Task rows.
- **`cheapVerdict` gates on the holder** (`pool.ts:501`):
  `if (!LEASE_HOLDERS.includes(tree.holder ?? "")) return …`. `LEASE_HOLDERS` is
  `["mission-control", "fleet-control", "ai-harness"]`
  (`src/shared/harness-runtime.mjs:84`), append-only, *"Append here on any future rename;
  never remove."*
- **Acquire and return are private and disagree.** `leaseFromPool`
  (`dispatcher.ts:821-834`) runs `treehouse get --lease --lease-holder <holder>` with a
  180s timeout. `returnLease` (`dispatcher.ts:794-796`) runs `treehouse return <path>`;
  the reaper runs `treehouse return --force <path>` (`pool.ts:107-108`). Neither is
  exported. `scripts/new-session.mjs:57` uses the same acquire argv a third time.
- **`--force` is not cosmetic.** `treehouse return --help`: *"Clean, reset, and return
  without prompting."* Without it the command can prompt, which is why the reaper - a
  poller - uses it. The extraction must keep the distinction deliberate rather than
  unifying on whichever it reads first.
- **`pinLeasedWorktree`** (`dispatcher.ts:645-659`) validates ownership by comparing
  `mainRepoRoot(leasePath)` against `mainRepoRoot(repoRoot)` and delegates to
  `resetWorktreeToCommit` (`git/ensemble-snapshot.ts:736-741`), which is
  `reset --hard` + `clean -fd` (never `-fdx`) + `verifyHeadIs`. `requireSha` enforces a full
  40-hex id.
- **The dispatcher already unwinds a live lease before throwing**
  (`dispatcher.ts:720-741`): on any pin or verify failure it returns the lease and composes
  the failure message with the return's own outcome. Check setup inherits this rule.
- **New tables go in the `openDb()` template, not `migrate()`** (`db.ts:1504-1508`), with
  their indexes beside them. An index over a column added by `addColumn` goes in `migrate()`
  after the ALTER (`db.ts:1299-1308`, `idx_tasks_schedule`, the worked example).
- **`PRAGMA foreign_keys = ON`** (`db.ts:97`). Per `AGENTS.md`, the ensemble family is the
  only one that declares any, and a clause added elsewhere becomes live the moment it is
  written.
- **Every `TEXT PRIMARY KEY` must say `NOT NULL` explicitly** - on a non-STRICT rowid table
  SQLite does not imply it. `workflow_binding_claims` (`db.ts:566-590`) is the model to
  copy, comment and all.
- **The reaper is started at `src/server/index.ts:203`** and stopped in `shutdown()` at
  `:286`, after `workflows.stop()` at `:282`. Cadence from `reapIntervalMs()`
  (`pool.ts:149-156`), `MISSION_POOL_REAP_MS`, default 300s, `<= 0` disables scheduling.
- **`reapPool` re-reads status per candidate** (`pool.ts:604-628`) and already documents the
  residual it lives with: *"The uncovered sliver is a re-lease whose agent has yet to start a
  process."*

## Implementation steps, in execution order

### 1. The shared treehouse adapter

New module - suggested `src/server/pool-lease.ts`, or an exported section of `pool.ts` if that
reads better to the implementer. It owns every `treehouse` invocation this process makes:
`get`, `status`, `return`.

- Move `leaseFromPool` and `returnLease` out of `dispatcher.ts` and the two `PoolDeps` lambdas
  out of `pool.ts`, so there is one place where the argv is written.
- **Keep `--force` a parameter, not a default.** The dispatcher's ordinary teardown returns a
  tree it knows is idle; the reaper and the check reclaimer are returning trees they believe
  are abandoned. Encode that as an explicit argument with a comment, because collapsing them
  is a silent behaviour change to dispatch teardown.
- Take the holder as an argument. Default `LEASE_HOLDER` for the dispatcher; check callers
  pass their own token.
- Keep the injectable-seam shape `PoolDeps` already has, so tests drive the real adapter
  against a fake subprocess.
- `dispatcher.ts` and `pool.ts` both consume it. `scripts/new-session.mjs` is a script outside
  the bundle and stays as it is; note it in a comment so the next reader knows the third copy
  is deliberate.

### 2. The per-repository pool lock

An async mutex keyed by canonical `repoRoot`, in the same module.

Every acquire, status and return goes through it. Critically, it must support **holding across
a sequence**, not just wrapping one call:

```ts
export function withPoolLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T>;
```

`reapPool`'s per-candidate re-read plus return (`pool.ts:604-628`) must run inside one
acquisition, or the re-read proves nothing. That is a real restructuring of `reapPool`, not a
decorator, and it is the point of the lock.

Document the residual in the module comment, in the same register `pool.ts:603-628` already
uses: **this lock binds one process.** A `make session` or a hand-run `treehouse get` in
another terminal is outside it. Contract L layer 1 is what makes that survivable.

### 3. `workflow_check_leases`

In the `openDb()` template beside the other `workflow_*` tables (`db.ts:379-590`), with its
index immediately beneath, following `workflow_binding_claims` as the model.

```sql
CREATE TABLE IF NOT EXISTS workflow_check_leases (
  attempt_id             TEXT    NOT NULL PRIMARY KEY,
  submission_id          TEXT    NOT NULL,
  node_id                TEXT    NOT NULL,
  repo_root              TEXT    NOT NULL,
  lease_path             TEXT    NOT NULL,
  holder_token           TEXT    NOT NULL,
  cleanup_state          TEXT    NOT NULL,
  supervisor_pid         INTEGER NOT NULL,
  supervisor_start_ticks TEXT    NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_check_leases_path
  ON workflow_check_leases(lease_path);
CREATE INDEX IF NOT EXISTS idx_workflow_check_leases_node
  ON workflow_check_leases(submission_id, node_id);
```

Decisions to record in the table's comment:

- **No foreign key to `workflow_node_attempts`, deliberately.** Foreign keys are ON, so a
  `REFERENCES` clause would be enforced, and both enforcement modes are wrong here. `CASCADE`
  would delete the lease row when retention removes the attempt, losing the only record of a
  tree still held. `RESTRICT` would make retention fail on a leaked lease. The source plan's
  requirement is that this table **outlives** both attempt rows
  (`phase-2-check-node.md:271-279`). It also matches the house rule that only the ensemble
  family declares foreign keys.
- **Every column `NOT NULL`, including the primary key**, for the
  `workflow_binding_claims` reason.
- **`supervisor_pid = 0` and `supervisor_start_ticks = ''` are sentinels meaning "the gate was
  never released".** That state is load-bearing, not filler: a row carrying the sentinel is
  proof branch code never started, which is exactly the crash-between-spawn-and-persist case
  Phase 3's recovery has to distinguish from a live group. Say so in the comment or the next
  reader will "clean up" the sentinels into nullable columns and destroy the distinction.
- **`cleanup_state`** is the lease's own lifecycle: `held` → `returning` → `returned`, plus
  the terminal `lost`. A failed return moves to `returning` and **stays there** - it must not
  delete the row, release its pin, or permit a second lease
  (`phase-2-check-node.md:274-279`). `lost` is the holder-mismatch terminal described in step
  6: audit row kept, no return issued, pin dropped.
- **`submission_id` and `node_id` are carried, not joined for.** Phase 4 must ask "does this
  node still have an unresolved lease?" before it is allowed to retry, and the answer has to
  survive retention deleting the attempt row - the same reason this table has no foreign key.
  A join through `workflow_node_attempts` would answer correctly right up until the moment it
  matters.

`WorkflowStore` reads the shared handle (`store.ts:996`), so the accessors live there or in a
small sibling; either is fine, but only one module writes this table.

### 4. `PoolPins.checkLeasePaths`

- Add the field to `PoolPins` (`pool.ts:175-178`). It is `readonly string[]`, like its
  siblings.
- Populate in `poolPins(registry)` (`:189-197`) from the durable table **union** the lease
  manager's in-memory just-acquired set. The union is the point: a path is pinned from the
  moment acquire returns, synchronously, before the persist yields.
- Add the rung to `cheapVerdict` beside the existing two path checks (`pool.ts:508-509`), with
  a message in the same voice: *"a check is running in it"*.
- Extend `canonicalPins` (`pool.ts:388`, module-private) so the new paths get the same
  canonicalisation the other two get.

This is defence in depth, and the comment must say so, or a future reader will conclude the
holder token is redundant and delete one of them. Both exist because the holder token is a
string a future rename could break, and the pin is a path this process knows it holds.

### 5. Holder tokens

`mission-control-check-<attemptId>`, built by one exported function so the parse and the
format cannot drift.

Record in the same place: **this token is deliberately not in `LEASE_HOLDERS`.** That array is
the shared reaper's "is this ours to touch" gate, and a check lease must answer *no*. Adding
it there would re-open the defect this phase exists to close.

The consequence is the obligation in step 7: because the shared reaper cannot collect a leaked
check lease, this phase must collect its own.

### 6. The lease manager

One module owning the lifecycle. Public surface, roughly:

- `acquireForAttempt(attemptId, repoRoot, headSha)` - under the pool lock: `treehouse get`
  with the check token; add the path to the in-memory pin set synchronously; persist the row
  as `held`; `pinLeasedWorktree(repoRoot, path, headSha)`; return the path.
  - `headSha` must be a full 40-character id. `verifyPinnedBase` (`dispatcher.ts:620-630`) is
    the existing check; use it rather than a second regex.
  - **Unwind on any failure**, exactly as `provisionWorktree` does (`dispatcher.ts:720-741`):
    return the lease, compose the failure with the return's own outcome, and clear the row and
    the pin only once the return is confirmed. A pin or verify failure is infrastructure and
    never a verdict.
- `releaseForAttempt(attemptId)` - identity-verified, idempotent:
  - Read the row. Missing → the prior return already succeeded; complete cleanup without
    calling treehouse.
  - Under the pool lock: `treehouse status`, find the tree at that path, compare **both** the
    canonical path **and** the exact `holder_token`.
  - Match → `return --force`, mark `returned`, drop the pin.
  - Path available, or absent from status → the prior return already succeeded; complete
    cleanup.
  - **Path held by any different token → issue no return, and move to the terminal
    `lost` state: keep the row for audit, DROP the pin.** Refusing the return is the
    invariant that stops recovery-after-crash from returning a tree now leased to someone
    else and destroying their work. Keeping the *pin* would be a different bug: the pin
    exists to protect **our** lease, and a mismatch is positive proof this tree is not ours.
    Held forever it would outlive the external holder's lease and permanently bar the normal
    reaper from reclaiming that path - one pool slot lost for the life of the daemon.
    Dropping it is safe in every sub-case, and the reasoning is worth keeping because it is
    the non-obvious part: an external re-lease is genuinely not ours; another check's lease
    is pinned by *its own* row; and our own still-running check cannot reach this branch,
    because a live process makes `tree.busy` true and its holder token is not in
    `LEASE_HOLDERS` - so a live check keeps two independent reaper refusals even with no pin.
  - Return failure → `cleanup_state = "returning"`, row retained, pin retained, bounded
    backoff retry. Never `handleInfrastructureFailure` until the resource is actually clean.
- `unresolvedLeaseForNode(submissionId, nodeId)` - is there a row for this node in a state
  other than `returned` or `lost`? **Phase 4 gates its retry on this**, so it must answer from
  the table alone, never from a join that retention can break.
- `reconcileOnStartup()` - restore rows into the in-memory pin set and resolve each by the
  same identity rules. Rows carrying the sentinel pid are known never to have run branch code
  and can be returned once identity matches.

**Ordering, and it is not optional:** reconciliation completes **before**
`startPoolReaper(registry)` at `src/server/index.ts:203`. This is the same shape as
`SdkSupervisor.restore()` completing before `startPoller(registry)` (`AGENTS.md`, "A session
going away"): a pin registered after the first sweep is invisible to it. Wire the call above
line 203 and add a comment saying why, because the ordering is the whole protection.

### 7. Reclamation of leaked check leases

Because the shared reaper is structurally blind to them, this phase owns collection. A bounded
periodic pass over `workflow_check_leases` rows whose attempt is no longer live: apply
`releaseForAttempt`'s identity rules; a refusal keeps the row for the next pass.

This may ride the existing reaper tick rather than owning a timer - it is the same cadence and
the same lock - but it must be visibly this module's logic, not a fourth rung inside
`cheapVerdict`.

### 8. README

A subsection under the pool/worktree material: what a check lease is, why it uses a distinct
holder, why the shared reaper ignores it, who collects it instead, and the one-process residual
of the pool lock stated plainly.

## Data, API and compatibility

- **New table only.** No `addColumn`, so nothing belongs in `migrate()` and no index is
  displaced.
- **`PoolPins` gains a required field.** It is a `readonly string[]`, so every constructor
  must supply it - which is the enforcement. `poolPins()` is the only production constructor;
  tests build it by hand and will fail to compile until they say what they mean. That is
  correct and the fix is not `?? []`.
- **`treehouse` CLI contract unchanged.** No new subcommand, no new flag. If a future
  treehouse gains a holder-aware return, Contract L layer 3's residual closes and the comment
  should be updated - note that in the module.
- **Fresh install and upgrade are identical**: `CREATE TABLE IF NOT EXISTS`, empty table,
  empty pin list, no behaviour change until Phase 4 acquires the first lease.

## Tests and verification

`test/workflow-check-lease.test.ts`:

- Acquire persists the row and pins the path **before** the persist resolves - assert the
  in-memory union, not just the table.
- Return is idempotent across all four identity outcomes: match, path available, path absent,
  path held by a different token. The fourth must issue **no** return, keep the row as `lost`,
  and **drop the pin** - then assert the reaper can subsequently reclaim that path, which is
  the regression the pin-retention bug would cause.
- Return failure keeps the row in `returning`, keeps the pin, and does not permit a second
  lease for the same attempt.
- Startup reconciliation restores pins before the reaper could run, and resolves a sentinel-pid
  row.
- Pin/verify failure unwinds the lease and surfaces the return's own outcome in the error.
- `unresolvedLeaseForNode` answers true for `held` and `returning`, false for `returned` and
  `lost`, and keeps answering correctly after the attempt row is deleted.

`test/pool-check-pins.test.ts` (or extend `test/pool.test.ts` if it exists):

- `cheapVerdict` refuses a tree held by a check token, with the holder message.
- `cheapVerdict` refuses a tree in `checkLeasePaths` even when the holder reads
  `mission-control` - the defence-in-depth case, which is the one a future refactor breaks.
- `reapPool` holds the lock across its per-candidate re-read and return.

Extend `test/dispatcher-cleanup.test.ts`: dispatch teardown still returns **without**
`--force`, proving the extraction did not unify the two spellings.

**Lease-leak assertion:** the suite must end with no `workflow_check_leases` row and no
`~/.treehouse` tree held by a check token. This is the cheapest guard against the worst
failure mode and belongs here rather than in Phase 4.

Any test touching the db sets `HARNESS_HOME` to a fresh temp dir before importing anything that
resolves it (the `ui-config-store.test.ts` preamble; static-import hoisting defeats a
late-set env var - see `db-isolation.test.ts`).

Commands: `npm run typecheck`, `npm test`, `npm run build`.

## Merge and exit criteria

- CI green on Node 24 and 26.
- One module writes every `treehouse` argv; `grep -rn '"treehouse"' src/` shows the adapter and
  nothing else under `src/server/`.
- Dispatch teardown behaviour is byte-identical to today, proven by test, not by inspection.
- `workflow_check_leases` exists, is empty, and nothing writes it yet.
- Reconciliation is wired above `startPoolReaper` in `src/server/index.ts` with a comment
  saying why.
- Suite ends with no leaked lease, and no path is left pinned by a `lost` row.

## Downstream handoff

Phase 3 may rely on:

- **Contract P**, `CheckProcessRegistry` - `record(attemptId, pid, startTimeTicks)` and
  `clear(attemptId)`, backed by the two sentinel-defaulted columns. Phase 3 must not touch the
  table directly.
- The sentinel meaning: `pid = 0` / `ticks = ''` is *"the gate was never released"*.

Phase 4 may rely on:

- `acquireForAttempt` / `releaseForAttempt` and their identity rules.
- `unresolvedLeaseForNode(submissionId, nodeId)`, the retry gate.
- The pin being live from acquisition through confirmed return, so a check may run for minutes
  without the reaper noticing.
- Lease or pin failure already being classified as infrastructure, so Phase 4 forwards it to
  `handleInfrastructureFailure` rather than re-deciding.

Nobody may: add the check token to `LEASE_HOLDERS`; give the lease table a foreign key; make
`checkLeasePaths` optional; collapse the two `return` spellings; or hold a pin in the `lost`
state.

## Cross-phase audit record

- **2026-07-30, at authoring:** re-read the source plan and Phase 1. No file overlap with
  Phase 1 (`shared/workflow.ts`, `shared/protocol.ts`, `workflows/store.ts`,
  `workflows/manager.ts`) - this phase touches `server/pool.ts`, `server/dispatcher.ts`,
  `server/db.ts`, `server/index.ts` and new modules. Concurrency claim in the index holds.
- **Reconciled against the source plan's "holder-verified idempotent return"
  (`phase-2-check-node.md:291-301`):** the CLI cannot support it. Recorded in the index as
  Contract L with three layers and a named residual, per that same passage's escape clause.
  The source plan's sentence *"If it cannot close that race, pooled check execution cannot
  ship"* is answered by layer 1 making the residual survivable rather than by claiming
  closure.
- **Source-plan checklist coverage** (`phase-2-check-node.md:415-424`): item 1 (reaper reclaim)
  → steps 4 and 5; item 4 (return failure erasing state) → step 3's `cleanup_state` and step
  6's retention rule; item 5 (non-idempotent return / TOCTOU) → step 2's lock and step 6's
  four-outcome identity check plus the named residual. Items 2, 3 and 6 are Phase 3's.
- **Deviation from the source plan recorded:** it specifies `PoolPins.checkLeasePaths` as the
  protection (`:281-289`) and does not anticipate that a distinct holder token makes the shared
  reaper refuse a check lease outright. Both ship. The token is primary; the pin is defence in
  depth. The consequence the source plan therefore also missed - that leaked check leases are
  no longer collected by the shared reaper - is new obligation step 7.

- **2026-07-30, Inspector round 2 (PR #326):** two findings accepted against this phase and
  Phase 4, both valid.
  - *Release stale pins after holder mismatch.* The mismatch branch retained the pin as well
    as the row, so an external re-lease would leave that path permanently unreapable - a pool
    slot lost for the life of the daemon. Corrected: mismatch is now the terminal `lost`
    state, which keeps the audit row, issues no return, and **drops the pin**. The safety of
    dropping it is argued in step 6 rather than asserted, because a live check keeps two
    independent reaper refusals (`tree.busy`, and a holder token outside `LEASE_HOLDERS`)
    without needing a pin at all.
  - *Do not retry while group cleanup is unknown* (Phase 4's finding, but the fix lands
    here). Phase 4 needed a way to ask whether a node still owns an unresolved lease, so this
    phase now carries `submission_id` / `node_id` on the row and exposes
    `unresolvedLeaseForNode`. Carried rather than joined for, because retention deleting the
    attempt row must not make the answer wrong - the same argument that keeps this table
    free of a foreign key. Moving the columns into the earliest phase that must own them,
    rather than bolting a lookup onto Phase 4, follows the phasing rule.
