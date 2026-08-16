# Phase 4: Settings worktree operations

## Outcome

Mission Control exposes its native pools and bounded legacy Treehouse state in a full
**Settings > Worktrees** category. Operators can configure repository policy, understand capacity
and safety, open or copy exact paths, and run preview-first Return, Prune, Reconcile, Destroy, and
legacy-drain actions without bypassing task/check ownership.

User-visible value: worktree management becomes an explainable application capability rather than a
hidden side effect or a separate CLI. Every risky action says what would be lost, revalidates before
acting, and reports why a checkout was preserved.

## Entry criteria and direct dependencies

- **Direct dependency: Phase 3.** Native and legacy inventory/action services, final provider
  classifications, dependency cleanup, and migration documentation must be merged.
- Re-read the approved source plan, phased index, Phases 1 through 3, Settings registry/search tests,
  `src/web/components/SettingsPage.tsx`, `src/web/useEventStream.ts`, `src/server/routes.ts`, and
  `e2e/README.md`.
- Run the backend inventory/action contract tests before adding routes so browser work consumes the
  final semantics rather than redefining them.

## Scope

- Add shared, schema-validated configuration, inventory, preview, and execute contracts.
- Add authenticated loopback HTTP routes over the singleton manager and legacy bridge.
- Add a content-free exhaustive `worktrees_changed` SSE invalidation event.
- Register and build the Settings > Worktrees panel with repository summaries and expandable slots.
- Expose default/per-repository policy and operator-authored setup argv.
- Expose preview-first native Return, safe Prune/right-size, Reconcile, exact Destroy, and exact
  legacy return where identity is provable.
- Reuse existing task/check/manual ownership and terminal-launch mechanisms for all mutations.
- Add unit, route, component, built Playwright, runtime, accessibility, and visual coverage.

### Explicit non-goals

- Do not add a new primary navigation destination, tray app, or standalone worktree CLI.
- Do not put volatile inventory detail in the global SSE snapshot.
- Do not add `data-testid`, a browser-side ownership source of truth, or client-only risk decisions.
- Do not add a global one-click destroy or accept arbitrary filesystem paths as action targets.
- Do not kill unknown processes, force an unverifiable/foreign Treehouse lease, or infer task cleanup
  from a stopped session.
- Do not let routes construct a second manager or write SQLite directly.

## Repository findings and inherited contracts

- `SETTINGS_CATEGORIES` is the single registry for route validity, rail order, group/scope labels,
  settings search, arrow-key navigation, and coverage discovery. Worktrees belongs in the
  `sessions` group with `machine` scope, adjacent to Harnesses.
- `SettingsPage.renderCategory` is exhaustive but imports each panel explicitly. The registry entry,
  component import, hook ownership, switch case, search anchors, and render tests must land together.
- Content-free invalidations already establish the right wire pattern. `worktrees_changed` should
  bump a revision in `useEventStream`; it must not carry Git status, process lists, or unbounded slot
  rows.
- Worktree detail is more expensive than ordinary config because it invokes Git, disk, and process
  observations. Fetch on panel open/invalidation and use a slow reconnect backstop, not a short
  unconditional poll.
- The browser can open a terminal only through the daemon's existing terminal target/launcher
  abstraction. A Worktrees button supplies a validated manager-known cwd to that mechanism; it does
  not spawn platform commands from React.
- Copy path is browser-local and needs a success/error affordance. It is not an ownership action.
- A task/check resource remains domain-owned even when shown in an infrastructure panel. The route
  must delegate to the existing cleanup/recovery owner instead of directly clearing slot state.

## Implementation steps

### 1. Define one shared projection and action protocol

Add bounded browser-safe types and Zod schemas in the existing shared contract modules. Keep
Node-only implementation detail under `src/server/worktrees/`.

The inventory response includes:

- effective global policy and repository overrides;
- one summary per known repository: pool/provider availability, root, configured maximum, actual
  slots, leased/available/quarantined/over-capacity counts, disk total, last reconcile, and status;
- paged or bounded slot detail with stable pool/slot IDs, provider, state/classification, path,
  owner kind/key/link, lease age, exact HEAD, default-branch relationship, dirty/untracked counts,
  process summary, disk use, quarantine/error, and safe next actions;
- legacy capability/drain totals: exact, unverifiable, foreign, unreadable, and blocked reason;
- observation timestamp and an inventory revision suitable for stale-response guards.

Never send raw environment, full process command lines, Git diffs, or unbounded stderr. Bound labels,
paths, error summaries, process rows, and inventory page size in schemas.

Use one discriminated action request with `return`, `prune`, `reconcile`, `destroy`, and
`legacyReturn` variants. Targets are stable repository/pool/slot IDs, never arbitrary paths. A
preview returns:

- an opaque, short-lived preview token bound server-side to action and canonical targets;
- observed provider, lease/owner, slot versions, and inventory revision;
- exact affected slots and disk estimate;
- risk classes such as leased, domain-owned, occupied, unknown occupancy, dirty, untracked,
  unlanded, quarantined, over-capacity, legacy-unverifiable, or foreign;
- required acknowledgement keys and whether execution is currently allowed;
- plain-language blockers and consequences.

Execute accepts the opaque token plus the exact acknowledgement keys. It rescans ownership, lease,
processes, Git state, and slot versions. Any changed fact returns `409` with a fresh-preview reason.
Tokens expire, are single use, are held only in bounded daemon memory, and become invalid on restart.

### 2. Add manager-backed HTTP routes

Append the singleton worktree service to `buildApp` through the existing optional dependency pattern
so route tests can inject a fake without touching real Git or SQLite.

Add authenticated loopback routes:

- `GET /api/worktrees` for summaries and bounded detail/filtering;
- `GET /api/worktrees/config` for the stored plus effective policy;
- `PUT /api/worktrees/config` for a schema-validated whole config or established patch shape;
- `POST /api/worktrees/actions/preview` for a non-mutating observation;
- `POST /api/worktrees/actions/execute` for token-bound, revalidated execution;
- `POST /api/worktrees/:slotId/open` using the existing terminal launcher.

Return `404` for unknown stable IDs, `409` for stale previews/ownership conflicts, `422` for missing
acknowledgements or disallowed risk, and `503` when the manager or legacy observation is unavailable.
Do not collapse these into `500`; the panel needs to distinguish refresh, refusal, and outage.

Configuration writes affect only future acquisition/capacity choice. Lowering a maximum below the
current count marks a pool over capacity and offers a prune preview. It never removes a slot as a
side effect of the PUT. Setup argv is rendered and stored as an argv list, never parsed as shell.

### 3. Preserve domain ownership through every action

Make the route's action dispatcher the only orchestration layer and keep underlying owners intact:

- **Task-owned native slot:** Return/Destroy preview links the task and states that work is retained
  until explicit cleanup. Execute calls the existing task cleanup path, including snapshots and
  multi-repository accounting, then asks the manager to prune only if Destroy targeted the returned
  slot. It never clears task columns itself.
- **Check-owned native slot:** active/supervised checks cannot be manually returned. Terminal check
  rows go through `CheckLeaseManager` recovery and its process-group proof. A live attempt remains a
  blocker.
- **Manual native slot:** Return uses the exact durable lease ID/owner. Known terminal closure uses
  its existing owner; unknown occupancy remains an unacknowledgeable blocker.
- **Available native slot:** safe Prune is allowed only after clean, merged, process-free,
  unreferenced revalidation. Destroy may acknowledge dirty/unlanded work only for an exact target;
  unknown occupancy is never overrideable.
- **Quarantined native slot:** Reconcile may restore only positively proven state. Destroy retains
  the same exact-target and risk acknowledgements as any other slot.
- **Legacy exact slot:** call Phase 3's conditional adapter only after matching domain and occupancy
  gates. Unverifiable, foreign, and unreadable rows have no execute action.

Pool-scoped Destroy is a preview over an enumerated fixed slot set and fails if that set or any
observed version changes. There is no target meaning "all pools".

Emit `worktrees_changed` once after a successful config write, completed action batch, acquisition,
release, reconciliation change, or legacy status change that affects visible classification. Do not
emit on an observation that restates the same facts.

### 4. Add the exhaustive invalidation path and browser state

Append `{ type: "worktrees_changed" }` to `ServerEvent`, register it in the Registry's allowed event
set, add `emitWorktreesChanged`, and handle it exhaustively in `useEventStream` by incrementing a
`worktreesRevision` counter exposed on `MissionState`.

Create `useWorktrees(revision)` owned locally by `SettingsPage`, because nothing outside the panel
needs the inventory. It must:

- fetch when the Worktrees category mounts;
- refresh on a newer SSE revision and after every action/config result;
- use a slow backstop only to converge after a missed reconnect;
- abort or sequence overlapping reads so an older status cannot overwrite a newer action result;
- display `null` as unknown/unavailable, not cached truth;
- serialize config writes and revert optimistic fields when a write is refused;
- discard an action preview when revision, target, or config changes.

Keep the inventory out of `MissionState` and the reconnect snapshot. Only the monotonic local
revision belongs there.

### 5. Register Settings > Worktrees

Append a Worktrees category to `SETTINGS_CATEGORIES` in the `sessions` group with `machine` scope,
an intentional icon, a plain-language blurb, and search keywords covering pool, worktree, slot,
lease, capacity, prune, Treehouse, and cleanup. Add it adjacent to Harnesses so session execution and
its checkout policy remain conceptually together.

Add the exhaustive `renderCategory` case and a `WorktreeSettingsPanel`. The panel begins with a short
safety explanation and separates three layers:

1. **Policy:** default enable, default maximum, repository override, and setup argv controls. State
   clearly that setup runs only on newly created slots and is operator-authored.
2. **Native pools:** repository summary rows expanding into slot detail and actions.
3. **Legacy Treehouse:** drain counts, binary/capability state, exact historical rows, and read-only
   remediation for unverifiable/foreign/unreadable worktrees.

Every control row receives a stable `data-anchor="worktrees/<slug>"` for settings search. Use roles,
labels, buttons, tables/lists, disclosure controls, and dialog semantics already present in the app.
Do not add `data-testid`.

### 6. Design inventory and confirmation states for comprehension

Use a compact repository summary with visible counts and status tone, then disclose slot rows. Keep
paths and SHAs in monospace with Copy and Open terminal actions. Pair colors/icons with text labels
so available, leased, occupied, dirty, quarantined, legacy, and over-capacity states are accessible.

Action flow:

1. the operator chooses an exact action/target;
2. the panel asks the preview route and opens a focus-trapped dialog;
3. the dialog lists affected paths, owner links, processes, Git/disk risks, and what is preserved;
4. required acknowledgement checkboxes are derived from server-provided risk keys;
5. Execute stays disabled for unacknowledgeable blockers;
6. submit sends only token plus acknowledgements;
7. success closes and refreshes; `409` replaces the preview with a changed-state message and a
   Refresh preview action; other errors remain in the dialog.

Reconcile copy must promise only re-observation and quarantine repair, never deletion of uncertainty.
Legacy rows without stable identity show the exact manual status/remediation guidance from Phase 3,
but no misleading disabled Force button.

At narrow widths, the settings rail behavior stays unchanged. Summary cards stack, while slot detail
uses an explicitly bounded horizontal scroll region instead of making the page itself overflow.
Large pools render a bounded page/disclosure slice rather than every process and slot at once.

### 7. Update documentation and migration guidance with the final surface

Add screenshots only if they are durable product documentation, not proof artifacts. Update the
worktree/setup/configuration/troubleshooting docs with:

- where Settings > Worktrees lives and what each count means;
- default-on lazy capacity, repository disable, and right-sizing;
- setup argv trust and execution timing;
- task/check/manual ownership and why some Return actions are blocked;
- safe Prune, exact Destroy, Reconcile, stale preview, and unknown-process behavior;
- how `make session --return` and panel Return relate;
- legacy classifications, drain completion, and when Treehouse can be removed;
- the fact that foreign Treehouse leases are intentionally outside application ownership.

## Data, API, and compatibility details

- `app_config.worktrees` remains the only policy source. UI summaries may show resolved values but do
  not persist them elsewhere.
- Inventory is an observation, not durable state. Slot rows plus domain owners remain authoritative.
- Action preview tokens authorize no broader scope than the exact server-held target/action and do
  not survive daemon restart.
- Provider remains authoritative throughout preview and execution. A config/binary change never
  converts a target to another provider.
- Native task/check lease IDs remain internal ownership facts; the UI receives bounded display IDs
  only if needed for diagnosis and never sends them as authority.
- Legacy absence affects only the Legacy section. Native config/inventory/actions remain usable.
- Every filesystem action stays inside a manager-known native pool or the exact conditional legacy
  adapter. Routes never accept a caller-chosen destination path.

## Tests and verification

Add or update unit and route coverage for:

- inventory schema bounds, summaries, pagination, process/error redaction, and effective config;
- config validation, future-only capacity effect, over-capacity preview, and setup argv preservation;
- action token binding, expiry, single use, acknowledgement validation, and restart invalidation;
- execute revalidation of version, lease, owner, processes, Git state, and target set;
- task cleanup delegation, check recovery delegation, manual return, safe prune, quarantine
  reconcile, exact destroy, and exact legacy return;
- unknown occupancy and unverifiable/foreign legacy rows remaining unexecutable;
- `worktrees_changed` emission, allowed-event registry, exhaustive browser handling, and no volatile
  payload in snapshot/SSE;
- Settings registry route/search/order/scope/anchor coverage and panel rendering of every state;
- stale response/preview guards and optimistic config rollback.

Add a focused built Playwright suite using fake agents and disposable repositories. Cover:

- navigation/search/deep-link to Settings > Worktrees;
- default policy plus a per-repository disable/capacity edit;
- native available, leased task, manual, occupied, dirty, quarantined, and over-capacity states;
- Return, safe Prune, Reconcile, exact Destroy, stale-preview conflict, and confirmation focus;
- task/check ownership blockers and manual-session return;
- legacy exact, unverifiable, foreign, and binary-missing presentations;
- SSE invalidation updating two open dashboard pages without polling stale content;
- Copy path/Open terminal with an injected launcher and no real external window;
- desktop and narrow viewport scrolling with no page-level sideways overflow.

```sh
node --test --import ./test/setup-state.mjs --import tsx test/worktree-routes.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/worktree-actions.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/worktree-settings-panel.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-sidebar-render.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-route.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-search.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/registry-event-order.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/settings-worktrees.spec.ts
```

Run the full built `npm run test:e2e` before merge. Capture gitignored desktop and narrow evidence for
the repository inventory, an actionable preview, an unacknowledgeable blocker, and legacy status.

## Merge and exit criteria

- Settings routing, search, keyboard navigation, scope labeling, and anchors reach Worktrees through
  the shared registry.
- Operators can inspect every manager-known native slot and every known legacy classification without
  volatile detail entering the SSE snapshot.
- Every mutation uses preview, exact stable targets, required acknowledgements, and fresh server-side
  revalidation.
- Task/check/manual ownership remains authoritative and no unknown process can be killed or bypassed.
- Policy edits affect future acquisitions and capacity reductions never delete as a side effect.
- Desktop and narrow runtime checks show accessible focus, scroll, and confirmation behavior.
- Unit, typecheck, lint, build, smoke, and full Playwright gates are green.
- Final operating docs let an operator install, configure, inspect, recover, and drain worktrees
  without consulting Treehouse documentation for normal use.

## Downstream handoff

This is the final implementation phase. A future initiative may remove the narrow legacy adapter
only after a supported migration can prove no durable database row can contain `treehouse`. It may
also add import/management of arbitrary user-created Git worktrees, but neither is implied here.

The completed initiative must leave:

- one daemon-owned native allocator and one narrow compatibility reader/conditional-return adapter;
- one worktree policy source and one inventory/action HTTP surface;
- task, check, and manual acquisition sharing the same native slots;
- provider-authoritative cleanup across native, disposable Git, and historical Treehouse rows;
- no external Treehouse prerequisite for setup or ordinary operation.

## Cross-phase audit record

- **Reconciled with Phase 1:** the panel exposes the existing policy, state machine, status, and
  preview primitives without creating browser-owned state or direct filesystem operations.
- **Reconciled with Phase 2:** task/check/manual actions delegate to their durable owners and retain
  exact lease IDs, explicit task cleanup, and check supervisor rules.
- **Reconciled with Phase 3:** legacy classifications and capability rules are presented exactly;
  no UI affordance invents authority that the backend refused.
- **Complete-set audit:** every root-plan operation, adopted decision, failure mode, documentation
  change, and visible behavior now has one owning phase and a named verification path.
