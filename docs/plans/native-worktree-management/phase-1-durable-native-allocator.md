# Phase 1: durable native allocator

## Outcome

Mission Control gains a tested, daemon-owned pooled-worktree allocator with durable lease identity,
Git-common-directory pool identity, conservative occupancy checks, and startup reconciliation. It is
present but not selected by task dispatch, workflow checks, or `make session` yet, so the merge is a
reviewable foundation with no acquisition behavior change.

Engineering value: the highest-risk state machine and filesystem safety can be reviewed and fault-
tested before three production owners move onto it.

## Entry criteria and direct dependencies

- **Direct dependencies:** none.
- Read the approved source plan, `phased-plan.md`, the architecture and change-contract guides,
  `docs/worktrees-and-checks.md`, and the current pool/check lease tests before editing.
- The adopted requirements are default-on native policy, a staged Treehouse drain, Settings >
  Worktrees, and a daemon-client `make session`. This phase establishes their shared backend contract
  without activating it.

## Scope

- Append the native `mission` provider ID.
- Add operational pool/slot persistence and schema migrations.
- Add schema-validated worktree policy in `app_config` with default-on, per-repository controls.
- Implement the native allocator, pool serialization, Git materialization/reset, conditional release,
  quarantine, occupancy, maintenance planning, and startup reconciliation.
- Construct and reconcile one manager in daemon startup, while leaving current Treehouse/Git callers
  untouched.
- Add focused contract and fault-injection tests.

### Explicit non-goals

- No dispatcher, workflow check, or manual-session cutover. Phase 2 owns all three.
- No Treehouse adapter rewrite, install removal, `treehouse.toml` removal, or legacy drain. Phase 3
  owns them.
- No Settings category, browser state, public destructive route, or UI. Phase 4 owns them.
- No change to task retention, session eviction, workflow check supervision, or ensemble dispatch.
- No repo-controlled executable hook and no copied Treehouse Go source.

## Repository findings and inherited contracts

- `WorktreeProvider` is append-only in `src/shared/types.ts`. Existing persisted `treehouse` and `git`
  values select teardown behavior and cannot be renamed or reinterpreted.
- `src/server/util/git.ts` already resolves a linked checkout to its physical main repository and Git
  common directory. Extend/export that source rather than shelling out or hashing remote URL.
- `resetWorktreeToCommit` in `src/server/git/ensemble-snapshot.ts` is the one owner of hard reset plus
  `git clean -fd`, followed by exact-HEAD verification. The native provider must reuse it.
- `listProcesses()` in `src/server/discovery/processes.ts` returns every process with stable start
  data and command. `readProcCwds()` batches cwd lookup. The allocator needs a projection over them,
  not a new `ps`/`lsof` implementation.
- `app_config` is the established store for daemon settings whose schema applies defaults. Follow
  `src/server/harnesses.ts` and `src/shared/protocol.ts`; do not duplicate enablement, capacity, or
  setup policy on operational pool rows.
- The daemon must remain the only SQLite writer. Native callers will all enter through its manager,
  which eliminates the external file-lock problem for new worktrees.
- Current task/check pins are defense in depth and cannot be deleted merely because slot ownership is
  durable. Phase 2 will adapt them into the manager's owner-reference source.

## Implementation steps

### 1. Append wire and configuration contracts

In `src/shared/types.ts`, append `"mission"` to `WorktreeProvider`. Preserve tuple/union ordering and
all old values.

In `src/shared/protocol.ts`, define a bounded `WorktreesConfigSchema` and patch schema. The stored
shape should have:

- a default-enabled value of `true`;
- a default maximum of 16 slots, matching Treehouse's upstream default but creating slots only on
  demand;
- per-repository overrides keyed by canonical Git common directory, with `enabled`, `maxSlots`, and
  an optional operator-authored setup argv;
- conservative bounds on maximum slots, argv count, and argv/string length.

Setup is an argv array, not a shell string. It runs with the worktree as cwd only when an operator
stored it. No repository file can opt into execution.

Add `src/server/worktrees/config.ts` over `app_config.worktrees`. Apply defaults on read and merge
repository patches without replacing unrelated entries. This is the only policy source.

### 2. Add operational tables and migrations

Add migrations beside their upgrade path in `src/server/db.ts`:

`worktree_pools` records only operational identity:

- stable ID;
- physical Git common directory, unique;
- last known main checkout root;
- native pool path, unique;
- created/updated timestamps;
- last reconciliation timestamp and bounded error.

`worktree_slots` records:

- stable ID, pool ID, ordinal, and unique physical path;
- lifecycle state and monotonic version;
- requested/current HEAD SHA;
- active lease ID, owner kind/key, and leased timestamp;
- last released lease ID and owner key for idempotent release recovery;
- last-used timestamp, quarantine reason, last error, and created/updated timestamps;
- unique `(pool_id, ordinal)` and appropriate live-state/lease indexes.

Use append-only state strings: `provisioning`, `available`, `leased`, `returning`, `pruning`, and
`quarantined`. A later migration may append but never rename them.

Do not add policy fields to either table. Do not add foreign keys to task/check tables in this phase:
their legacy providers must remain valid when no native slot exists.

### 3. Establish repository and path identity

Add a worktree-specific repository identity helper by extending `src/server/util/git.ts` rather than
copying its filesystem walk. It returns:

- canonical main checkout root;
- canonical Git common directory;
- a display repository name;
- a stable pool path under `WORKTREE_POOLS_DIR`, derived from repository name plus a truncated SHA-256
  of the physical common-directory path.

Add `WORKTREE_POOLS_DIR = join(STATE_DIR, "worktree-pools")` in `src/server/config.ts`.

Write a provider-neutral `.mission-control-worktree-pool` marker at each native pool root before its
first slot is exposed. The marker contains only a schema version and pool ID. It lets checkout-local
tools such as the hook installer recognize that an absolute path is transient without opening
SQLite or assuming a particular `MISSION_HOME`. Phase 3 will teach that installer to recognize both
this marker and Treehouse's historical `treehouse-state.json` marker.

Separate local clones of one remote must produce different pool IDs and directories. A main checkout
and any of its linked worktrees must produce the same result. Refuse bare repositories and paths
whose ownership cannot be proven.

### 4. Build the occupancy service from existing process discovery

Create `src/server/worktrees/occupancy.ts` as a bounded query:

1. call `listProcesses()` once;
2. pass all positive PIDs to `readProcCwds()` once;
3. canonicalize cwd and worktree paths;
4. report every process whose cwd equals or is below the target path, including PID, parent PID,
   start identity inputs, command summary, and whether the Registry/check runtime already owns it.

Path containment must be segment-aware, not string-prefix based. A vanished PID is ignored only when
`lsof` omitted it; a failed or timed-out process/cwd read yields `unknown`, never an empty answer.

This service observes. It does not signal. Known terminal/check shutdown remains with the terminal
backend and `terminateCheckGroup`; unknown occupancy always blocks reset, reuse, prune, and destroy.

### 5. Implement the allocator state machine

Create a `src/server/worktrees/` module family with a single `WorktreeManager` and injected seams for
Git execution, time/random IDs, occupancy, policy, owner references, and event publication.

Acquisition accepts a canonical repository, exact 40-character commit, owner kind/key, and optional
setup policy. It must:

1. serialize within the pool using an asynchronous queue owned by the manager;
2. choose only an eligible `available` slot with no domain reference, no occupancy, no dirt, and a
   valid Git registration, or reserve a new ordinal below the resolved maximum;
3. persist `provisioning`, random lease ID, owner, requested SHA, and incremented version before the
   first filesystem mutation;
4. create a new detached Git worktree when needed, otherwise reset the chosen slot through
   `resetWorktreeToCommit`;
5. run the stored operator setup argv only for a newly created slot, with bounded output/timeout;
6. verify physical path, owner repository, and exact HEAD;
7. transition to `leased` and return an opaque lease object containing slot ID, path, provider,
   lease ID, owner, exact base SHA, and slot version.

Any failure after reservation either proves and removes a never-exposed partial worktree or marks the
slot `quarantined` with the exact reason. A setup failure quarantines the slot; it is not handed to a
caller as merely cold.

The acquire result distinguishes a refusal before any reservation (`notAcquired`) from a timeout or
failure whose lease outcome cannot be proven (`outcomeUnknown`). Later consumers may fall back to Git
only for `notAcquired`; `outcomeUnknown` waits for reconciliation and must not double-acquire.

Release accepts the full opaque lease plus an owner-reference check. It must:

1. compare slot, active lease ID, owner, and observed version under the pool queue;
2. return an idempotent `alreadyReleased` result only when last-released lease ID and owner match;
3. refuse while a task/check owner reference or any process occupancy remains;
4. persist `returning` before reset;
5. reset to a resolved/fetched remote default commit with `resetWorktreeToCommit` and verify;
6. move the active lease to the last-released fields, clear active owner fields, and mark `available`.

The last-released fields close the crash window between slot release and Phase 2 clearing a domain
row: a retry can prove the same release already completed, while a new acquire refuses a slot still
referenced by a task/check row.

### 6. Add reconciliation and maintenance planning

At daemon startup, before any future native consumer may acquire:

- read Git's porcelain worktree list once per pool;
- compare pool/slot rows, physical paths, Git registrations, active and last-released lease identity,
  domain owner references, exact HEAD, and occupancy;
- complete only transitions whose result is positively provable;
- quarantine missing, mismatched, dirty, occupied, stale-owner, unknown-process, and interrupted states;
- never infer task cleanup from session state;
- never touch a Treehouse or disposable Git path.

Add manager-level status and maintenance planning methods. They return structured native pool/slot
facts and preview safe prune/right-size candidates, but no public destructive route is added yet.
Safe candidates are available, unreferenced, clean, merged into a freshly fetched remote default,
process-free, and registered to the expected common directory. Phase 4 will expose execute actions
with fresh revalidation.

Add an unref'd native maintenance cadence with a new `MISSION_WORKTREE_SWEEP_MS` setting and an
injected `reclaimDomainLeases` hook. It is inert with no native pools. Do not retire or alias
`MISSION_POOL_REAP_MS` yet; Phase 3 owns compatibility after new consumers have cut over.

### 7. Wire one manager into daemon lifecycle

Construct one `WorktreeManager` in `src/server/index.ts`, reconcile it before Workflow check recovery,
and start its maintenance loop after all domain owners are available. Stop it during orderly shutdown
before closing the database.

Do not construct a manager in routes or callers. If test route builders later receive it, append an
optional parameter following the repository's positional compatibility pattern.

The currently selected dispatch/check/manual paths remain unchanged in this phase. The new manager's
only production effects are schema migration, startup reconciliation of its own native rows, and an
inert sweep when no native pool exists.

## Data, compatibility, and failure behavior

- Existing databases migrate by adding empty tables and a new valid provider option. No old row is
  rewritten.
- `app_config.worktrees` absent means default-on/max-16 policy for future consumers, not immediate
  pool creation.
- SQLite is allocator authority, but Git and occupancy are mandatory evidence before reuse. A row
  cannot make an unsafe filesystem fact safe.
- Pool queues are per canonical common directory. SQLite transactions remain short and never wrap a
  Git/process subprocess.
- Unknown outcomes from timed-out Git/process commands quarantine rather than roll forward.
- No phase may use `git clean -fdx`, auto-kill an unknown process, or delete a worktree outside the
  exact native pool path.

## Tests and verification

Add focused tests for:

- append-only provider parsing and old-database migrations;
- config defaults, bounded validation, per-repository merge, and no repository-executed setup;
- main/linked/separate-clone/bare repository identity;
- native pool marker creation and transient-checkout discovery without database access;
- concurrent acquires receiving different slots and respecting capacity;
- stale lease ID, owner, and version refusing release after re-lease;
- idempotent release after the slot succeeded but the domain row has not cleared;
- exact SHA reset, dirty/untracked rejection, ignored-cache preservation, setup success/failure;
- occupancy containment, PID churn, partial `lsof`, timeout/unknown, and known-vs-unknown reporting;
- crash points around reserve, Git add, setup, lease commit, return reset, and prune intent;
- reconciliation of every lifecycle state, with uncertainty quarantined;
- right-size preview refusing leased, referenced, dirty, unmerged, occupied, or unknown slots;
- two different clones of the same remote never sharing a pool.

Prefer injected unit tests for state-machine permutations and a small number of real temporary Git
repositories for contracts only Git can prove.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/worktree-manager.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/worktree-reconciliation.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/worktree-occupancy.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/git.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No Playwright spec is required in this phase because no browser-visible behavior changes.

## Merge and exit criteria

- All new and existing tests pass and build/smoke succeed.
- No current dispatch, check, or manual-session provider behavior changed.
- A native allocator can be driven through tests across acquire, release, crash, reconcile, and
  quarantine without Treehouse installed.
- The database and `app_config` have one source for each fact, and no native path can overlap a
  Treehouse or disposable Git directory.
- The daemon constructs, reconciles, and shuts down exactly one manager.

## Downstream handoff

Phase 2 may rely on:

- provider ID `mission`;
- `WorktreeManager.acquire`, conditional/idempotent release, exact lease object, owner-reference seam,
  and native status;
- `app_config.worktrees` default-on policy and per-repo resolver;
- canonical common-directory identity and `WORKTREE_POOLS_DIR`;
- native maintenance accepting the check-domain reclamation hook.

Phase 2 must not weaken quarantine, change state/provider IDs, add a second allocator, bypass exact
SHA verification, or make a session exit authorize cleanup.

## Cross-phase audit record

- **Initial audit:** no earlier phase exists. This phase matches the root plan's allocator, safety,
  process, Git, and configuration requirements.
- **Refinement recorded in the index:** policy moved from illustrative pool-table fields into the
  repository's existing `app_config` pattern, leaving operational rows as the sole source for slot
  state.
- **Prepared for Phase 2:** last-released identity and the owner-reference seam exist specifically so
  task/check rows can be cleared after release without an unsafe crash window.
- **Reconciled after Phase 2 draft:** the acquire contract now names `notAcquired` versus
  `outcomeUnknown`, because Phase 2's Git degradation is safe only when it can prove no native lease
  was granted. The provider, lease, owner, maintenance, and release contracts otherwise matched.
- **Prepared for Phase 3:** every native pool has a provider-neutral marker so dependency cleanup can
  generalize hook-install safety without teaching the installer to inspect daemon state.
