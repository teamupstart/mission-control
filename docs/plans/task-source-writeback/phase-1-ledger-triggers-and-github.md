# Phase 1: the write-back contract, the delivery ledger, and GitHub issues

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

A configured GitHub Issues task source, with its write-back switches turned on, comments the
pull request onto the issue it swept, comments the outcome when the task completes, and
optionally closes the issue five minutes later. End to end, in the daemon, with nothing to
configure but the existing task-sources config route.

This is the phase that produces working behavior. Everything after it either adds a second
kind or lets an operator see and steer what this one already does.

## Entry criteria and dependencies

None. This phase is the foundation; both later phases depend on it and on nothing else.

## Scope

In scope:

- The whole shared contract, including the parts Jira will use in Phase 2 and the panel will
  render in Phase 3, so `src/shared/task-source.ts` has exactly one owner.
- The `task_source_writeback` table, its indexes, and its DB helpers.
- The `task_pr_linked` Registry signal and the `finishCompletion` seam.
- The enqueue chokepoint and the drain worker.
- GitHub `annotate` and `resolve`.
- `test/` coverage for all of the above.

Explicitly **not** in scope:

- Jira's `annotate` / `resolve`, and `jiraBin()`. Phase 2. This phase lands Jira with
  `canAnnotate: false, canResolve: false`, which is honest: the build genuinely cannot do it yet.
- The retry / discard routes and the `TaskSourceWritebackStatus` **query**. Phase 3 owns those,
  because the panel is their only consumer. The *type* is declared here (see the handoff).
- Any web change, any e2e spec, any operator-facing documentation. Phase 3.
- Extending what `settingsStatus()` counts. Phase 3, which owns `src/server/settings-status.ts`.

## Repository findings

Verified against the current tree before writing this:

- `TaskSourceImpl` (`src/shared/task-source.ts:220-247`) already carries an optional `push`
  gated on a required `canPush` boolean in `TaskSourceKindInfo`, and
  `test/task-source-contract.test.ts` pins the pair. Two more capability/verb pairs follow the
  identical shape, which is why no new mechanism is needed.
- `erase()` (`src/server/task-sources/index.ts:57-92`) parses the stored blob through the
  kind's schema at the boundary, once, on every path. The two new verbs get the same treatment,
  including `push`'s rule that a rejected config is a refusal with `outcomeUnknown: false` -
  which is a fact, not an optimistic default: no subprocess ran.
- `acceptPrForEpisode` (`src/server/registry.ts:4307`) already computes
  `const firstAssociation = episode?.prUrl === null` and `acceptRepoPrForEpisode`
  (`:4505`) computes its per-repository twin. Both return non-null exactly when the durable
  record gained a pull request, so the signal has a precise place to fire from.
- The existing `pr_opened` signal (`src/server/registry.ts:1446`) is **not** the right hook.
  It is the hook/driver's optimistic "the agent ran `gh pr create`" evidence, scoped to a
  session, carrying no task binding, and its one consumer (`src/server/inspector/worker.ts:1184`)
  wants exactly that. This phase needs to know which TASK, and therefore which upstream item.
- `finishCompletion` (`src/server/tasks.ts:4181-4212`) is the only writer of `status: "done"`,
  and it is deliberately synchronous because `complete` runs from `session_upsert` and
  `session_remove` listeners that read the registry on the very next line. The seam must not
  await and must not throw.
- `settleIfEpisodeFinished` (`src/server/tasks.ts:1266`) concludes a task on an idle agent, and
  `reopenIfWorkResumed` (`:1346`) reverses that conclusion. This is the fact that forces the
  resolve settle window; it is not a hypothetical.
- `PUT /api/task-sources/config` (`src/server/routes.ts:6011`) takes the **whole source list**
  through `TaskSourcesConfigPatchSchema`, which is an alias of `TaskSourcesConfigSchema`. A new
  field on the instance therefore rides that route with no route change, which is what makes
  this phase operable without any Phase 3 work.
- `recordTaskSourceSeen` (`src/server/db.ts:7479`) is the model for an idempotent ledger write:
  an upsert whose key columns are both `NOT NULL`, with the reason (SQLite treats NULLs as
  DISTINCT inside a unique index) written down at the table.
- `startTaskSourceSweeper` (`src/server/task-sources/sweeper.ts:192`) and `startPrPoller`
  (`src/server/pr.ts:378`) are the two shapes to copy: a self-rescheduling `setTimeout`, never
  `setInterval`, `unref`'d via `src/server/util/timers.ts`, try/caught, returning a stopper that
  `shutdown()` calls.
- `githubIssueCreateOutcome` (`src/server/github/issue-create.ts:58`) already establishes the
  ordering a `gh` result reader must follow, and the rule that process output does not cross the
  boundary verbatim on a success path because `gh` error text can carry local filesystem paths.

## Implementation steps

### 1. `src/shared/task-source.ts`

Rewrite the file header's contract comment so the outward direction is described honestly:
sweeps stay read-only; a kind may declare `push`, `annotate` and `resolve`; none of them writes
to our database; each has its own chokepoint beside `ingest.ts`.

Add, browser-safe, no `node:` imports:

- `WRITEBACK_SIGNALS = ["pr-opened", "task-completed"] as const` and
  `WRITEBACK_ACTIONS = ["annotate", "resolve"] as const`, both documented **APPEND-ONLY** with
  the reason `TASK_SOURCE_KINDS` gives: they are persisted in the ledger, so a rename orphans
  every undelivered row.
- `WritebackNotice`, exactly the fields the plan names. Document why it is a snapshot rather
  than the `Task`, in the same terms `PushDraft` uses, and add the second reason that is
  specific to this feature: the task may be deleted between observation and delivery.
- `WritebackResult { error, outcomeUnknown, detail }`, with `outcomeUnknown` documented as the
  same flag `PushResult` carries and why it matters more here.
- `type WritebackContext = SweepContext`, an alias for the same reason `PushContext` is one.
- `canAnnotate` / `canResolve` on `TaskSourceKindInfo`, both required.
- `annotate?` / `resolve?` on `TaskSourceImpl`, each documented as present exactly when its
  flag says so, and as never firing from the sweep loop.
- `TaskSourceWritebackSchema { onPrOpened, onCompleted, resolve }`, all `.default(false)`, with a
  `.refine` refusing `resolve && !onCompleted` (message: "auto-resolve needs the completion
  trigger - a resolve with nothing to trigger it never fires").
- `writeback: TaskSourceWritebackSchema.default({})` on `TaskSourceInstanceBase`.
- `TaskSourceWritebackStatus` (the type only; Phase 3 computes it) and its
  `writeback: TaskSourceWritebackStatus[]` slot on `TaskSourcesView`, defaulting to an empty
  array from the route until Phase 3 fills it.
- `closeReason: z.enum(["completed", "not-planned"]).default("completed")` on
  `GithubIssuesConfigSchema`. Our spelling, not `gh`'s - see step 6 for the mapping and why it
  cannot be a passthrough.
- `resolveTransition: z.string().max(120).default("")` and
  `linkVia: z.enum(["comment", "remote-link", "both"]).default("both")` on `JiraConfigSchema`,
  with a comment saying Phase 2 implements the verbs that read them and that they are storable
  now so the shared file has one owner.
- `TASK_SOURCE_KIND_INFO`: `github-issues` gets `canAnnotate: true, canResolve: true`; `jira`
  gets both **false**, with a comment naming Phase 2 and the contract test as the reason it is
  false rather than optimistic.

### 2. `src/server/task-sources/index.ts`

- `ErasedTaskSource` gains `canAnnotate` / `canResolve` booleans and
  `annotate` / `resolve` slots typed `((config: unknown, notice, ctx) => Promise<WritebackResult>) | null`.
  Null rather than absent, for the reason already written at the `push` slot.
- `erase()` wires both with the same boundary parse. A rejected config becomes
  `{ error: reason(...), outcomeUnknown: false, detail: null }`, and the `outcomeUnknown: false`
  is a fact: the config never reached an implementation.
- New exports, so nothing outside this file tests `inst.kind`: `canAnnotateTo(inst)`,
  `canResolveTo(inst)`, `annotateWith(inst, notice, ctx)`, `resolveWith(inst, notice, ctx)`.
  Each catches a throw as a refusal with `outcomeUnknown: false` (the `pushToSource` argument:
  a throw out of here is our own code, because `run()` and `fetch` wrappers report their own
  outcome), and each returns a named error rather than a silent success for a null slot.

### 3. `src/server/db.ts`

The table exactly as the plan states it, in the schema block, with the comment explaining why a
row outlives its task and why both key halves are `NOT NULL`. Then the helpers, each with the
narrow signature the callers need:

- `enqueueWriteback(row): boolean` - `INSERT ... ON CONFLICT DO NOTHING`, returning whether a
  row was actually inserted so the caller can log a first observation without logging every
  repeat.
- `claimDueWritebacks(now, limit): WritebackRow[]` - `state = 'pending' AND next_at <= now`,
  ordered by `id`, deduplicated in SQL to at most one row per `(source_id, external_id)`.
- `settleWriteback(id, state, patch)` - one write for the outcome, `attempts`, `next_at`,
  `last_error`, `last_detail`, `updated_at`.
- `cancelWritebacksForSource(sourceId)` - used when a source is removed.
- `countWritebacks(sourceId)` - the counts Phase 3's status will read.
- `retryWritebacks(sourceId, includeUnknown)` - `failed` rows, and `unknown` rows only when the
  flag says so, back to `pending` with `attempts` reset and `next_at` now.
- `discardWritebacks(sourceId)` - drop this source's rows.

The last three are landed here and first called in Phase 3, deliberately: `db.ts` has one owner
in this feature, and all three are plain SQL over a table this phase owns. Phase 3 puts the view
and the two routes on top of them rather than reaching into a file this phase froze.

### 4. `src/server/registry.ts`

- `export interface TaskPrLinked { taskId: string; repoRoot: string; prUrl: string; observedAt: number }`.
- `onTaskPrLinked(fn)`, documented in the same voice as `onTaskPrMerged`: where it is emitted
  from, why not `pr_opened`, once per (task, repository), and "listeners must not throw; this
  runs inside the PR poller's reconciliation".
- Emit from `acceptPrForEpisode` when `firstAssociation` was true and the accepted episode binds
  a task (via the existing `taskWorkEpisodeForSession` lookup already used in `reconcilePrs`),
  and from `acceptRepoPrForEpisode` on its per-repository equivalent. Emit **after** the durable
  write succeeded, never before: a signal about a record that was not written is a comment about
  a link that does not exist.

### 5. `src/server/task-sources/writeback.ts` (new)

The mirror of `push.ts`, and the only DB writer on this path. Header comment stating that, and
stating the asymmetry with `push.ts`: a push is one operator click, this is automatic, so the
consent lives in configuration and the idempotency lives in the ledger key.

- `export interface WritebackDeps` - the I/O seams a test replaces: `annotate`, `resolve`,
  `enqueue`, `claim`, `settle`, `now`, `log`. Decisions stay in the functions.
- `export interface WritebackEnqueuer { prLinked(e: TaskPrLinked): void; completed(task: Task): void }`
  and `makeWritebackEnqueuer(registry, deps?)`. Both methods do the same local, synchronous work
  in this order: `task.source` present, source found in `getTaskSourcesConfig()`, trigger on,
  kind capable, build the notice, insert. A completion with `resolve` on inserts two rows: the
  annotate due now, the resolve due at `now + settleMs`. Every method is wrapped so nothing can
  throw into its caller.
- `noticeFor(...)` - the pure notice builders, exported for tests.
- `export async function drainWritebacks(deps)` - one tick: claim, re-validate, deliver, settle.
  The re-validation is the part with the rules:
  - source gone, or its trigger switched off since enqueue -> `cancelled`;
  - `action === "resolve"` and the task is missing or no longer `done` -> `cancelled`, with a
    log line naming the reopen. The annotate is deliberately **not** re-checked.
  - kind no longer capable (a downgrade, or a config edit) -> `cancelled`.
- `export function startWritebackWorker(registry, deps?)` - the canonical poller shape. A tick
  that moved any row to a terminal state calls `publishSettingsStatus(registry)`, so the gear's
  dot can react. What that dot COUNTS is `settingsStatus()`'s business and Phase 3 extends it;
  this phase only makes sure the recompute is triggered, which is correct before and after.
- Constants from `envVar`: `MISSION_TASK_SOURCE_WRITEBACK_TICK_MS` (default 20s, floor 5s),
  `MISSION_TASK_SOURCE_WRITEBACK_SETTLE_MS` (default 5 minutes), `MAX_ATTEMPTS = 6`,
  `BACKOFF_BASE_MS = 60_000`, `BACKOFF_MAX_MS = 30 * 60_000`, `MAX_PER_TICK = 20`.

### 6. `src/server/task-sources/github-issues.ts`

- `export function ghIssueCommentArgs(cfg, notice): string[]` and
  `export function ghIssueCloseArgs(cfg, notice): string[]`, both resolving the binary through
  the existing `ghBin()`.
- `export function writebackCommentBody(notice): string` - the rendered comment. Short, factual,
  and it says Mission Control wrote it.
- `export function writebackResultFrom(res: RunResult): WritebackResult` - a child death outranks
  an exit code; a non-zero exit with no proof of effect is a retry-safe refusal; a run that
  cannot be read is `outcomeUnknown`. `gh`'s "already closed" message reads as **success**.
- Register `annotate` and `resolve` on the `githubIssues` impl object.

### 7. `src/server/tasks.ts`

An optional `writeback?: WritebackEnqueuer` constructor dependency, and in `finishCompletion`,
immediately after `this.registry.upsertTask(updated)`:

```ts
try {
  this.writeback?.completed(updated);
} catch (err) {
  console.error("[writeback] enqueue on completion failed:", id, err);
}
```

The try/catch is not defensive decoration. `finishCompletion` runs inside `session_upsert` and
`session_remove` listeners, and a throw here would abort a completion that has already been
persisted and broadcast.

### 8. `src/server/index.ts`

Construct the enqueuer, `registry.onTaskPrLinked((e) => enqueuer.prLinked(e))`, pass it to the
`TaskManager` constructor, `const stopWriteback = startWritebackWorker(registry)` beside
`startTaskSourceSweeper`, and `stopWriteback()` in `shutdown()`.

### 9. `src/server/routes.ts`

One line only: the `taskSourcesView()` closure returns `writeback: []` so `TaskSourcesView` is
satisfied. Phase 3 replaces it with the real query.

## Data and compatibility

- The table is `CREATE TABLE IF NOT EXISTS` in the schema block with its indexes beside it. No
  `addColumn`, no backfill: an existing database gains an empty table by opening.
- `writeback` on the instance is a Zod default over the `app_config` blob, so a source written by
  an older build gains `{ onPrOpened: false, onCompleted: false, resolve: false }` on read. No
  migration, matching how every other task-source field arrived.
- `TaskSourcesView` gains a required field, so any client reading it must tolerate it. The only
  client is `useTaskSources.ts`, which Phase 3 updates; an empty array is valid until then.
- Removing a source should call `cancelWritebacksForSource`. Where the config PUT drops an
  instance, cancel its queue in the same handler.

## Tests and verification

New `test/task-source-writeback.test.ts`:

- enqueue refuses, silently and without a row, for: no `task.source`; a `sourceId` no longer in
  the config; the trigger switched off; a kind whose capability flag is false;
- the same observation enqueued twice inserts once, and `enqueueWriteback` reports that;
- a completion with `resolve` on writes two rows, the resolve's `next_at` a settle window later,
  and the annotate's `id` lower - which is what orders them without any dependency machinery;
- a task that completes, is reopened by `reopenIfWorkResumed`, and completes again enqueues a
  SECOND pair, because `dedupe_key` carries `completedAt`. Assert it against a first cycle left
  in each reachable state - `delivered`, `cancelled`, `failed`, `unknown` - since the collision
  this guards against does not care what became of the earlier row;
- `claimDueWritebacks` returns at most one row per `(source_id, external_id)`;
- backoff arithmetic across attempts 1..6, and the transition to `failed` at exhaustion;
- an `outcomeUnknown` result becomes `unknown` and is never returned by a later claim;
- a resolve whose task has been reopened, rescheduled, or deleted becomes `cancelled` without
  calling the implementation at all;
- an annotate whose task has been deleted still delivers, from the snapshot.

New `test/github-issues-writeback.test.ts`: both argv builders (including the `--repo`
passthrough), the comment body, and `writebackResultFrom` across a clean exit, a non-zero exit, a
killed child, and the already-closed message. Assert the close reason by its exact emitted argv -
that stored `not-planned` becomes the two-word `not planned` - because that is the whole bug the
mapping exists to prevent, and a test that only round-trips the schema value would pass while
every close failed.

Extend `test/task-source-contract.test.ts`: for every kind, `canAnnotate` matches the presence
of `annotate` and `canResolve` matches the presence of `resolve`, in both directions - the same
assertion `canPush` already gets, and the reason Jira ships `false` here rather than optimistic.

Commands:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/task-source-writeback.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/github-issues-writeback.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-source-contract.test.ts
npm test
npm run typecheck
npm run lint
npm run build && npm run smoke
```

`npm run test:e2e` is not required here: this phase changes no UI surface. Phase 3 owns the spec.

## Merge and exit criteria

- A GitHub Issues source with `writeback.onCompleted` set through
  `PUT /api/task-sources/config` comments on its issue when a swept task completes, and closes
  it after the settle window when `writeback.resolve` is also set.
- A daemon restart mid-queue loses nothing: the pending rows are still pending.
- With every write-back switch off, which is the default and therefore every existing
  installation, the ledger stays empty and no subprocess is spawned.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` pass.

## Downstream handoff

Later phases may rely on, and must not change:

- `WRITEBACK_SIGNALS`, `WRITEBACK_ACTIONS`, `WritebackNotice`, `WritebackResult`,
  `WritebackContext`, `TaskSourceWritebackSchema`, `TaskSourceWritebackStatus`, and the
  `canAnnotate` / `canResolve` / `annotate` / `resolve` slots. Append only.
- The ledger's columns, its unique key `(source_id, external_id, signal, action, dedupe_key)`,
  what `dedupe_key` holds per signal (the pull request url; the task id plus its `completedAt`),
  and the five `state` values.
- `canAnnotateTo` / `canResolveTo` / `annotateWith` / `resolveWith` as the only way to reach an
  implementation.
- `countWritebacks`, `retryWritebacks` and `discardWritebacks`, which Phase 3 puts behind the
  view and the two routes. `src/server/db.ts` gains nothing after this phase.
- `taskSourcesView()` returning `writeback: []`, which Phase 3 replaces.

Phase 2 owns exactly two edits inside this phase's files: flipping Jira's `canAnnotate` and
`canResolve` to `true` in `TASK_SOURCE_KIND_INFO`, in the same commit that implements the verbs.
Nothing else in `src/shared/task-source.ts` moves after this phase.

## Cross-phase audit record

- Initial write. No earlier phases to reconcile against.
- Review round 1 (PR #944). Three corrections, all landing before this phase merges because all
  three touch contracts it freezes:
  - `dedupe_key` for `task-completed` was the bare task id, which let a reopened-then-genuinely-
    completed task collide with its own first cycle and be dropped by `ON CONFLICT DO NOTHING`,
    so the resolve silently never fired for the completion that counted. It now carries
    `completedAt`. The unique key tuple is unchanged; what one of its columns holds is not.
  - `closeReason` stored `not_planned` and was passed straight to `gh issue close --reason`,
    which takes `not planned` with a space (verified against gh 2.100.0, whose help reads
    `Reason for closing: {completed|not planned|duplicate}`). Every close configured that way
    would have failed until it exhausted its retries. The stored spelling is now `not-planned`
    and step 6 maps it.
  - `retryWritebacks` / `discardWritebacks` were named in the source plan's `db.ts` step but
    excluded from this phase's scope and unassigned in Phase 3's, so no phase owned the SQL.
    They are landed here with the rest of the ledger helpers, matching the treatment
    `countWritebacks` already had.
