# Phase 3: legacy drain and dependency retirement

## Outcome

Treehouse is no longer installed, configured, probed, or selected for normal Mission Control
operation. A deliberately narrow compatibility module can still describe persisted
`provider = "treehouse"` resources and conditionally return a lease only when stable identity is
available and still matches. Unverifiable and foreign legacy worktrees are left untouched with an
actionable explanation.

User-visible value: upgrading or installing Mission Control no longer requires Go, curl-piped
installation, `treehouse.toml`, or a Treehouse binary on `PATH`. Existing operator data remains safe
instead of being relabeled or deleted during the transition.

## Entry criteria and direct dependencies

- **Direct dependency: Phase 2.** All new task, check, and manual acquisitions must already select
  `mission` or `git`, and the native maintenance loop must already invoke check-domain recovery.
- Re-read the approved plan, phased index, Phases 1 and 2, the current pool/check tests, setup docs,
  `hooks/install-checks.mjs`, and Treehouse v2.1.1 JSON/conditional-return contracts.
- Prove with tests or an instrumented seam that no production caller can invoke Treehouse `get`
  before deleting any acquisition code.

## Scope

- Replace the broad pool modules with one read/conditional-return-only legacy Treehouse adapter.
- Add a structured legacy inventory and drain projection for the Phase 4 HTTP/UI layer.
- Preserve provider-authoritative cleanup for historical task and Workflow check rows.
- Remove the external reaper, text parsing, holder-history maps, Treehouse call mutex, and every
  direct or duplicated Treehouse acquisition path.
- Remove Treehouse from bootstrap, active repository configuration, runtime PATH assumptions, and
  ordinary operating documentation.
- Generalize transient-checkout hook-install safety across native and legacy pool markers.
- Migrate the old reaper environment setting to the native maintenance setting.

### Explicit non-goals

- Do not delete or rename the persisted `treehouse` provider value.
- Do not adopt a Treehouse worktree into native SQLite state, rewrite it as `git`, or call
  `git worktree remove` behind Treehouse's bookkeeping.
- Do not force-return an unverifiable or foreign legacy lease, even when its path or holder looks
  familiar.
- Do not add the Settings panel or expose destructive public routes. Phase 4 owns presentation and
  operator confirmation.
- Do not remove arbitrary `.treehouse` path fixtures that test path formatting or linked-checkout
  behavior rather than active Treehouse integration.

## Repository findings and inherited contracts

- `src/server/pool-lease.ts` currently combines four unrelated duties: the Treehouse process
  adapter, an in-process per-repository lock, pending/acquired generation maps, and check holder
  vocabulary. After Phase 2, only historical status/return belongs in production.
- `src/server/pool.ts` owns text status parsing, workspace discovery, generic reaping, process/Git
  safety, and the old cadence. Native manager reconciliation and occupancy now own every equivalent
  duty for new worktrees, while domain rows own historical task/check cleanup.
- Existing rows do not generally persist a Treehouse v2.1.1 lease ID. A path plus the shared
  `mission-control` holder cannot distinguish the original lease from a later same-holder lease.
  Such a row is `identityUnverifiable`, not evidence that conditional return is safe.
- The Treehouse v2.1.1 JSON surface is the compatibility baseline. An older binary may be read via a
  bounded text fallback for diagnosis, but its result cannot authorize mutation.
- The current global pool sweep can reach an external `~/.treehouse` pool even when the daemon's
  `MISSION_HOME` is disposable. Removing it closes the e2e and demo isolation hazard that currently
  requires `MISSION_POOL_REAP_MS=0`.
- `hooks/install-checks.mjs` rejects installs only when it finds `treehouse-state.json`. Phase 1's
  `.mission-control-worktree-pool` marker supplies the provider-neutral native signal. The legacy
  marker must remain recognized because an old slot is still transient.
- `src/shared/harness-runtime.mjs` exports holder labels only because acquisition once crossed the
  JavaScript/TypeScript boundary. After `make session` becomes a daemon client, those labels belong
  privately to the compatibility module.

## Implementation steps

### 1. Replace the broad adapter with a legacy compatibility module

Create `src/server/worktrees/legacy-treehouse.ts` as the only module allowed to spawn the
`treehouse` binary. Move the historical holder constants into it and expose a small injected
interface:

- `capabilities()` identifies missing, v2.1.1 JSON/conditional, or diagnostic-only legacy binaries;
- `status(repoRoot)` returns typed trees, lease ID/holder/acquired time, process hints, source
  capability, and bounded stderr;
- `conditionalReturn(ref)` accepts an exact path plus persisted lease ID and expected holder;
- no acquire, init, update, completion, prune, destroy, or generic force-return method exists.

For v2.1.1, invoke `status --json` and `return` with both the stable lease ID and expected holder
conditions supported by that version. Re-read status immediately before the conditional return and
map a mismatch to a stable conflict result. Treat malformed JSON, unsupported fields, timeouts,
missing binaries, and nonzero exits as unreadable, never as an empty pool.

The diagnostic text fallback may reuse a minimized parser while old binaries remain in the wild,
but every returned record is explicitly `identityUnverifiable` and the adapter exposes no mutating
operation for it.

### 2. Build one legacy inventory from durable owners

Add a legacy projection alongside native manager status. Seed repository queries only from known
Mission Control repository roots and persisted `treehouse` task/check resources. Do not walk every
workspace or scan `~/.treehouse` globally.

Correlate status by canonical path into four explicit classes:

| Class | Evidence | Allowed behavior |
| --- | --- | --- |
| `ownedExact` | durable domain row has lease ID, path/provider/holder and live JSON status all match | conditional return after domain and occupancy gates |
| `identityUnverifiable` | a historical domain row correlates by path/holder but has no stable lease ID | read-only, pinned, manual remediation |
| `foreign` | status contains no matching Mission Control domain row | read-only, never return or adopt |
| `unreadable` | binary missing/old, status malformed, or repository/pool cannot be resolved | preserve domain row and show the exact diagnostic |

Include linked task/check IDs, occupancy from the shared Phase 1 service, dirty/process hints, and
whether the binary can execute a conditional return. Never convert a current observation into a
persisted lease ID: observing an ID after the fact cannot prove which historical owner acquired it.

Provide backend preview/execute methods for exact legacy return so Phase 4 can expose the same
action protocol as native worktrees. They remain un-routed in this phase. Preview and execute both
revalidate domain ownership and occupancy; execute additionally requires the same lease ID and
holder to remain in live JSON status.

### 3. Preserve historical domain cleanup without broad reaping

Keep the `treehouse` entry in the task and check provider registries. Its release behavior is:

1. load the persisted provider/path/lease identity from the domain row;
2. refuse if the binary is unavailable or the row has no stable lease ID;
3. revalidate exact live JSON identity and Mission Control domain ownership;
4. close only known processes through the existing task/check owner path;
5. require the shared occupancy scan to be empty;
6. invoke conditional Treehouse return and confirm the lease disappeared or changed;
7. clear the domain resource fields only after success is proven.

An unverifiable row remains pinned and returns an actionable result naming the repository, path,
provider, missing identity, and Treehouse command/status needed for manual resolution. Check recovery
maps this to `retry` with bounded backoff; task cleanup leaves its resource fields intact. Neither
path force-returns.

Delete the generic Treehouse reaper and workspace discovery. After Phase 2 there is no safe class of
unrecorded Mission Control lease it can identify: a status row with no durable owner is foreign from
the application's perspective.

### 4. Delete redundant allocation and safety machinery

Once tests prove all acquisitions bypass Treehouse, remove or collapse:

- `acquireLease`, `poolAvailableFor`, `treehouseInstalled`, `isTreehouseRepo`, and direct `get`
  command construction;
- `withPoolLock`, its promise chains, pending-registration TTLs, lease generations, acquisition-time
  maps, and holder-based ABA defenses;
- the old `parsePoolStatus`, candidate planning, workspace/pool repository discovery, and generic
  `reapPool` scheduler;
- duplicated process/Git safety logic now provided by native occupancy, domain ownership, and the
  exact legacy bridge;
- check-specific Treehouse parsing or process interpretation outside the provider.

Keep focused compatibility names only where a historical row still consumes them. A repository grep
must show exactly one production spawn site for `treehouse`, and no production `treehouse get`.

### 5. Remove bootstrap, config, and runtime assumptions

Update the setup surface as one behavior change:

- remove Treehouse detection/installation, the Go-or-curl installer, and `treehouse init` from
  `scripts/init.mjs`;
- remove Treehouse wording from `make init`, `make claude`, PATH comments, daemon comments, and setup
  output while retaining PATH support needed by Git, tmux, WezTerm, and other terminals;
- delete the repository's active `treehouse.toml` and any code that treats it as an enablement gate;
- remove shared `LEASE_HOLDER`/`LEASE_HOLDERS` exports and update historical tests to inject legacy
  fixtures from the compatibility module;
- update e2e/demo daemon configuration to use only `MISSION_WORKTREE_SWEEP_MS`, whose pools are scoped
  under that daemon's `MISSION_HOME`;
- retire `MISSION_POOL_REAP_MS` rather than silently retargeting an external-pool cadence to the
  native allocator. If it is present, log one bounded startup migration warning naming the new key.

Remove helper functions from `scripts/init.mjs` only when no remaining step uses them. Preserve
`--dry-run`, hooks, build, dependency, and optional Playwright behavior.

### 6. Generalize transient-checkout install safety

Rename `transientCheckoutRoot` documentation and output so it describes a pooled/transient checkout,
not a Treehouse-only checkout. It must recognize:

- Phase 1's `.mission-control-worktree-pool` marker; and
- the historical `treehouse-state.json` marker.

Return the root plus a provider-neutral reason so the hook installer can explain that pool slots are
reclaimed without teaching the global Claude configuration about provider internals. `--uninstall`
and explicit `--force` behavior stay unchanged. Add fixtures for native, legacy, nested, missing, and
ordinary durable checkouts.

### 7. Rewrite operating and migration documentation

Update `README.md`, `docs/README.md`, setup, configuration, worktree/check, troubleshooting, dispatch,
workflow, Foreman, and glossary references that describe Treehouse as an active prerequisite or
allocator. The new operating story is:

- native pooling is built in and lazy by default;
- `make session` requires the daemon, not Treehouse;
- repository controls live in Mission Control configuration, not `treehouse.toml`;
- `MISSION_WORKTREE_SWEEP_MS` is the maintenance setting;
- upgraded databases may still show a Legacy Treehouse section;
- a missing legacy binary blocks only exact historical cleanup, never new work;
- operators remove their external Treehouse installation/pool only after reviewing drain status and
  any foreign leases themselves.

Keep archived plans and historical migration documents intact. They are evidence of previous
contracts, not current setup instructions.

## Data, compatibility, and failure behavior

- `treehouse` remains a valid provider forever. New writers never choose it.
- No schema migration rewrites historical providers or manufactures lease IDs.
- A missing binary is an ordinary compatibility state: native work continues, while exact legacy
  cleanup reports blocked and preserves its row/pin.
- Old binary text output is diagnostic only. Mutation requires v2.1.1 JSON identity and conditional
  return support.
- External pools remain Treehouse-owned. Mission Control reads only known repositories and mutates
  only an exact, durably identified lease.
- Removing `treehouse.toml` changes no native policy because `app_config.worktrees` is already the
  sole authority from Phase 1.
- The legacy adapter may be deleted only in a future migration that can prove no supported database
  can contain the provider. This initiative does not make that claim.

## Tests and verification

Add or update focused coverage for:

- v2.1.1 JSON parsing, capability detection, bounded failures, and conditional return argv;
- missing/old/malformed binaries producing unreadable diagnostic state without blocking native work;
- exact legacy identity returning only after task/check/occupancy revalidation;
- null legacy lease IDs and same-holder ABA cases refusing without mutation;
- foreign status rows remaining untouched;
- task/check rows retaining provider, pin, and resource fields on every legacy refusal;
- no Treehouse acquisition after Phase 2 under default, disabled, capacity, and failure cases;
- removal of the external reaper and one maintenance owner for check recovery;
- native and legacy hook-install transient markers;
- setup dry-run/output and Make targets containing no Treehouse install/config step;
- old databases with `treehouse` and `git` rows still opening and selecting their provider.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/legacy-treehouse.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/dispatcher-cleanup.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-provider-column.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-check-lease.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/install-hooks.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/init-script.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No new Playwright spec is required for the legacy inventory yet because no new browser surface is
added. Run the existing built e2e suite because bootstrap defaults and worktree path behavior changed
in Phase 2 and its isolation variables are finalized here.

## Merge and exit criteria

- A clean setup and every new acquisition operate with no Treehouse binary, config file, or PATH
  assumption.
- One narrow module contains every remaining production Treehouse invocation, and none acquires.
- Historical exact-ID rows can be conditionally returned; unverifiable, foreign, unreadable, dirty,
  or occupied rows are preserved and explained.
- No global external-pool reaper or duplicate Treehouse lock/generation/parser machinery remains.
- Native maintenance and check recovery still pass under restart and failure tests.
- Active documentation describes native worktree management and a bounded legacy-drain procedure.
- Unit, typecheck, lint, build, smoke, and existing e2e gates are green.

## Downstream handoff

Phase 4 may rely on:

- a composite native plus legacy inventory service with stable classifications;
- backend preview/execute methods for native manager actions and exact legacy return;
- no new Treehouse leases and no background mutation of external pools;
- policy in `app_config.worktrees` and native pools entirely under `MISSION_HOME`;
- provider-neutral transient-checkout safety;
- a legacy diagnostic state that remains meaningful when the binary is absent.

Phase 4 must not add a browser-only ownership heuristic, expose arbitrary path deletion, offer a
force action for unverifiable/foreign legacy rows, or bypass task/check cleanup owners.

## Cross-phase audit record

- **Reconciled with Phase 1:** native state, occupancy, maintenance, and pool markers replace the old
  reaper's safety and hook-detection responsibilities. No second allocator or scanner remains.
- **Reconciled with Phase 2:** Treehouse is narrowed only after all new callers stop acquiring it;
  task/check provider authority and lease-ID nullability remain unchanged.
- **Legacy identity refinement:** the repository cannot retroactively prove old shared-holder leases.
  The plan therefore makes their uncertainty visible instead of weakening conditional release.
- **Prepared for Phase 4:** inventory classes and preview/execute seams are stable before the browser
  gives operators actions against them.
