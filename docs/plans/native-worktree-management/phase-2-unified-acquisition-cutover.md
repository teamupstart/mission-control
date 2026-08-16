# Phase 2: unified acquisition cutover

## Outcome

Every new Mission Control task, workflow check, and approved manual development session acquires an
isolated checkout through the Phase 1 `WorktreeManager`. Native pooling is enabled by default and can
be disabled or capped per repository. The disposable Git provider remains the explicit degradation
path, while Treehouse becomes legacy cleanup-only and receives no new lease.

User-visible value: a clean installation gets warm reusable worktrees without Treehouse, and
`make session` preserves its familiar workflow while joining the same durable inventory as the app.

## Entry criteria and direct dependencies

- **Direct dependency: Phase 1.** The `mission` provider, native manager, policy resolver, state
  machine, occupancy service, reconciliation, and maintenance hook must be merged.
- Re-read the source plan, phased index, Phase 1 file and audit record, current dispatcher/check lease
  tests, `docs/ensembles.md`, and `e2e/README.md`.
- Phase 1 exit criteria must still hold before changing a consumer.

## Scope

- Persist native lease identity on task repositories and workflow check leases.
- Route task and multi-repository provisioning/teardown through the manager.
- Route workflow check acquire/release/recovery through the manager without changing check semantics.
- Turn `scripts/new-session.mjs` into a loopback daemon client with acquire and return actions.
- Make native pooling default-on and disposable Git the provider for an explicit per-repo disable or
  a failed native acquisition.
- Move check-domain leak recovery onto the native maintenance hook.
- Update tests and user-visible worktree path expectations.

### Explicit non-goals

- Do not delete or reinterpret the Treehouse provider. Existing rows still need it in Phase 3.
- Do not update Treehouse status parsing, remove installation, delete `treehouse.toml`, or rename the
  old timer yet.
- Do not add Settings > Worktrees or public destructive operations. Phase 4 owns the UI.
- Do not infer task cleanup from a stopped/exited session or add a second eviction/kill path.
- Do not change Workflow check scheduling, supervisor identity, retries, verdicts, or the unsupported-
  platform behavior.

## Repository findings and inherited contracts

- `Dispatcher.provisionAll` is the all-or-nothing owner for primary plus attached repositories. It
  records a worktree only after all acquisitions succeed and unwinds partial acquisitions through
  provider-aware teardown.
- `ProvisionedWorktree` currently carries path, branch, provider, and base SHA. Native teardown needs
  the opaque lease ID as a fifth field.
- Task primary and secondary worktree facts are persisted separately in `tasks` and `task_repos`,
  mapped through `Task`/`TaskRepoEntry`. Clearing is centralized by `releasedTaskResources`; adding a
  lease field anywhere else would recreate the partial-cleanup bug that helper exists to prevent.
- `CheckLeaseManager` already has a provider registry and durable `workflow_check_leases` state
  machine. Its provider column is authoritative on release. Add a native implementation rather than
  replacing the manager.
- Check lease recovery must retain its just-acquired pin, durable rows, supervisor identity,
  `busy`/backoff sets, and four-way ownership result. A generic slot row does not replace attempt
  semantics.
- `scripts/new-session.mjs` can import `BASE_URL` from `src/shared/harness-runtime.mjs`, just as the
  MCP/Foreman clients do. It must not import server TypeScript or open SQLite.
- Native pooled task worktrees are detached, like Treehouse's pool. The dispatcher must report the
  branch it actually observes, which may be null, and cannot invent the disposable Git
  `harness/<slug>` branch.
- Existing browser specs inspect `$MISSION_HOME/worktrees` or displayed paths as a proxy for
  isolation. Native reuse changes those observations even when the user action is unchanged, so the
  affected specs must assert the durable task/inventory contract instead of assuming disposable
  directory deletion.

## Implementation steps

### 1. Persist domain lease identity

Add nullable `worktree_lease_id` columns to `tasks` and `task_repos`, and nullable `lease_id` to
`workflow_check_leases`, beside their current provider/base migrations.

Thread the task fields through `Task` and `TaskRepoEntry`, database row mappers, upserts, dispatcher
patches, multi-repository manifests, and `releasedTaskResources`. They are internal ownership facts;
the UI does not render them.

Rules:

- `mission` rows always persist the manager's random lease ID.
- disposable `git` and historical `treehouse` rows keep null unless a future legacy acquire captured
  a stable ID before cutover;
- a worktree path, provider, base SHA, branch, and lease ID are cleared or retained as one resource
  unit;
- partial multi-repo cleanup clears exactly the entries named by `WorktreeTeardownError.reclaimed`.

Add upgrade tests proving old rows read null and preserve their provider meaning.

### 2. Replace dispatch's acquisition decision

Inject the singleton `WorktreeManager` into `Dispatcher` and the exported provisioning/teardown seams
used by tests. Do not make it a module global.

For each repository:

1. retain the existing Git repository preflight and full-SHA validation;
2. resolve the exact base SHA before acquisition (`baseSha` when supplied, otherwise current `HEAD`);
3. resolve Phase 1 policy for the canonical common directory;
4. when enabled, call `manager.acquire` with owner `task:<task-id>:<position>`;
5. on success, return provider `mission`, lease ID, observed branch, path, and verified base SHA;
6. when disabled, use the existing disposable Git worktree provider;
7. when native acquisition fails because capacity is exhausted or all slots are unavailable,
   quarantine the broken slot where applicable, log the observed reason, and fall back to disposable
   Git without weakening isolation.

Do not fall back on an ambiguous outcome after the manager may have granted a lease. The acquire
result must distinguish `notAcquired` from `outcomeUnknown`; the latter remains a failed dispatch and
startup reconciliation resolves it.

Keep `provisionAll` all-or-nothing. Its `taken` list includes the full native lease so unwind calls
the same manager conditional release. Mixed `mission` and `git` repositories remain supported in
both orderings.

### 3. Make teardown provider-authoritative

Extend `teardownOneWorktree`:

- `mission`: close the task's existing terminal home first, then call manager release with the
  persisted lease ID and owner key. Accept `released` or matching `alreadyReleased`; refuse stale,
  occupied, quarantined, or unknown results and keep the task resource fields.
- `treehouse`: retain the current legacy adapter path byte-for-byte until Phase 3.
- `git`: retain `git worktree remove --force` and the guarded `harness/` branch deletion.

The manager must not kill processes. Terminal close remains through `killHome`, and an adapter lookup
that cannot prove it asked a backend remains a warning/refusal according to the existing teardown
contract. After terminal close, manager occupancy is the last gate.

Update every cancel, complete, delete, reset, startup, mid-dispatch abort, and partial-unwind caller
to pass task ID/position plus lease identity. Preserve the rule that Mark done keeps work and a
session reaching `exited` keeps the task checkout.

### 4. Add the native Workflow check provider

Add `MissionCheckTreeProvider` to the existing `CheckTreeProvider` registry:

- acquire from the manager at the captured base SHA with owner `check:<attempt-id>`;
- persist provider and lease ID on the held row before the supervisor gate can release;
- ownership asks the manager for the exact active or last-released lease, not path presence alone;
- hand-back uses conditional/idempotent manager release after `groupRecovery` proves the process
  group empty;
- pool serialization is supplied by the manager, so the provider's old `withLock` layer is a direct
  call for native paths.

Selection at acquire reads the Phase 1 policy:

- enabled: native provider;
- disabled: existing detached Git check provider;
- native `notAcquired`: Git provider, with a bounded infrastructure note;
- native `outcomeUnknown`: fail closed and let reconciliation resolve, with no second acquire.

The Treehouse check provider stays registered only for old rows whose persisted provider is
`treehouse`. It cannot be selected for new attempts.

Install `checkLeases.reclaimLeaked(checkRuntime.groupRecovery)` into the native manager's maintenance
hook. Keep startup check reconciliation after native slot reconciliation, so the allocator knows its
slots before attempt rows decide whether a lease can return.

### 5. Turn `make session` into a daemon client

Add loopback routes through the singleton manager, appending the manager dependency to `buildApp`
using the existing optional-parameter compatibility pattern:

- acquire a manual lease for a validated repository path and optional human label;
- return one exact manual lease by lease ID or by an explicit path lookup followed by current-lease
  preview/revalidation;
- report a clear conflict for non-manual, occupied, dirty, stale, or unknown ownership.

`scripts/new-session.mjs` imports `BASE_URL`, calls the acquire route, runs
`scripts/worktree-setup.mjs` exactly as today for this repository, exports `MISSION_WORKTREE` plus a
new `MISSION_WORKTREE_LEASE_ID`, and spawns the requested command in the returned path. Exiting the
shell deliberately leaves the lease durable.

Add `--return <path>` and `--return-lease <id>` companion actions so a source checkout without the
Phase 4 UI can release its own manual lease through the daemon. Printed instructions name both the
command and the future Settings > Worktrees surface. Remove `TREEHOUSE_LEASE_HOLDER` from newly
launched environments; retain no alias that suggests Treehouse still owns a native slot.

When the daemon is unavailable, print one direct instruction to start it (`make up`, `make dev`, or
the application) and exit without allocating anything. There is no standalone fallback.

### 6. Update e2e isolation and visible behavior

Native default-on means the real e2e daemon will create pools only inside its disposable
`MISSION_HOME`. Keep `MISSION_POOL_REAP_MS=0` in the fixture until Phase 3 retires the external
reaper, and set `MISSION_WORKTREE_SWEEP_MS` to a deterministic test value where needed.

Audit specs that inspect `daemon.home/worktrees`, require paths containing `worktrees/`, or expect a
cleanup to remove a directory. Update them to distinguish:

- task ownership cleared and the slot returned to `available`;
- native slot directory intentionally retained for reuse;
- disposable Git directory removed when the repository override disables pooling.

Add a focused Playwright spec because the displayed path and cleanup result are user-visible. With
fake agents and a real built daemon it must dispatch, show a native pool path on the card, clean up
the task, and prove a second dispatch reuses the available slot without sharing it concurrently.
Exercise an attached second repository so provider/lease identity is correct per position.

### 7. Update behavior documentation without retiring legacy setup

Update `docs/worktrees-and-checks.md` and the linked setup/architecture text to state:

- task, check, and `make session` acquisitions are native by default;
- slots are lazy, reusable, exact-commit checkouts under `MISSION_HOME`;
- per-repository disable selects disposable Git;
- manual leases remain held until an explicit client/UI return;
- legacy Treehouse cleanup still exists temporarily for historical rows.

Do not remove Treehouse installation instructions or `treehouse.toml` in this phase. Phase 3 needs a
clearly reviewable diff proving the compatibility bridge remains after those defaults disappear.

## Data, API, and compatibility details

- Provider is read from the persisted row on every cleanup. A machine/config change after acquisition
  never changes release behavior.
- Native lease ID is required when provider is `mission`; a null ID is a corrupt/legacy native row and
  fails closed into reconciliation.
- Git fallback remains cold and disposable. It has no slot row and null lease ID.
- Treehouse rows remain on the old adapter. No migration writes `mission` onto them.
- The manual routes accept only loopback-protected API traffic and canonical repository paths. They
  never accept an arbitrary destination path.
- An unavailable daemon makes `make session` fail, because allowing the script to allocate directly
  would create a second writer and allocator.
- Ensemble members receive the change only through the ordinary dispatcher. No ensemble-specific
  provider path is added.

## Tests and verification

Add or update focused coverage for:

- old task/check rows migrating with null lease IDs;
- native task acquire, persisted ID, exact SHA, provider-authoritative release, and idempotent retry;
- per-repository disabled policy selecting Git for tasks and checks;
- native `notAcquired` falling back once, while `outcomeUnknown` never double-acquires;
- multi-repository all-or-nothing success and partial unwind across `mission`/`git` combinations;
- every task cleanup path retaining unreclaimed resource fields and clearing reclaimed lease IDs;
- Mark done and session exit retaining the native lease;
- check acquire/release/restart/reclaim with native lease identity and unchanged process-group rules;
- old `treehouse` check rows still selecting the legacy provider after new selection changed;
- `make session` acquire, warmup, environment, durable exit, explicit return, and daemon-down refusal;
- native pool capacity and disable changes affecting the next acquisition, not an active lease;
- browser dispatch, reuse, cleanup, and multi-repo behavior with fake agents.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/dispatcher-cleanup.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatcher-runtime.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatch-pinned-base.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/multi-repo-dispatch.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-lease.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-runtime.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-degradation.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/new-session.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/native-worktree-dispatch.spec.ts e2e/specs/multi-repo-dispatch.spec.ts
```

Run the full built `npm run test:e2e` before merge because the default worktree path/lifetime affects
many existing user flows even when their controls did not change.

## Merge and exit criteria

- New task, check, and manual acquisitions create no Treehouse lease.
- With no Treehouse installed, default configuration yields reusable native slots; a disabled repo
  yields a disposable Git worktree.
- Concurrent dispatch/check/manual work never shares a slot, and cleanup cannot release a newer lease.
- All task retention, check supervisor, exact-commit, multi-repo rollback, and provider-authoritative
  tests pass.
- `make session` works through the daemon and has an explicit release command.
- The full unit/build/smoke/e2e gates are green.

## Downstream handoff

Phase 3 may rely on:

- no new caller selecting Treehouse;
- every native task/check row carrying a lease ID and every Git/legacy row remaining distinguishable;
- native maintenance owning the check-reclaim cadence;
- the old Treehouse modules serving only persisted rows and external-pool discovery;
- `make session` no longer requiring the binary or holder labels.

Phase 3 must not delete the `treehouse` provider value, convert its rows to Git/native, remove the
compatibility adapter while rows exist, or change native manager contracts.

## Cross-phase audit record

- **Reconciled with Phase 1:** consumer rows add the durable lease identity Phase 1's conditional and
  idempotent release requires. No new lock or allocator is introduced.
- **Crash boundary:** native release may complete before a task/check row clears. Phase 1's
  last-released identity lets the retry prove success, while a stale domain reference prevents slot
  reuse in the interim.
- **Maintenance ownership:** check reclamation moves to Phase 1's injected native sweep before the old
  Treehouse reaper can be removed in Phase 3.
- **UI consequence:** because worktree paths and retained-slot cleanup are already visible on current
  task cards, this phase owns a Playwright regression rather than deferring all browser coverage to
  the Settings phase.
