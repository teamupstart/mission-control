# Fast installed-app session bootstrap

## Status and approved direction

Approved for phased implementation on 2026-08-30.

The operator selected the direction discussed in the startup investigation: load the Board as soon
as the daemon can serve HTTP, project persisted SDK sessions as non-interactive restoring cards,
and let the real session cards replace them as driver restoration completes. The existing Starting
strip is the visual precedent, but its task projection is not reused as session authority.

The operator directly requested the phased-plan follow-up, so there is no unresolved implementation
follow-up decision.

## Problem

The installed Electron app opens a dark `BrowserWindow` and points it at the daemon origin. The
daemon currently restores every resumable SDK session before it binds HTTP. Restoration is serial:
each persisted row may start an agent subprocess, initialize its protocol, resolve configuration,
and resume the native conversation before the next row starts.

A controlled installed-bundle measurement with eight resumable SDK sessions observed:

| State | Time until `/api/health` | Result |
|---|---:|---|
| Normal SDK restoration | 4.653 seconds | Electron remained on its dark background |
| Same database with only live SDK rows marked exited | 0.381 seconds | Dashboard became available |

The 4.272-second delta represented 91.8% of measured pre-ready time. This plan moves that restore
work off the first-paint path. It does not claim that the agent conversations themselves will finish
restoring faster.

## Desired outcome

- The installed app paints its ordinary Mission Control frame and Board near the non-restore
  baseline instead of showing a black window for the whole SDK restore.
- Every readable persisted live SDK row appears immediately as a restoring card with stable identity,
  task title or durable display name, agent, and repository context.
- Restoring cards are visibly provisional and expose no session action, selection target, composer,
  workflow binding action, drag target, notification, or automation eligibility.
- Each restoring card hands off to the real session card without disappearing, duplicating, changing
  identity, or briefly becoming actionable before its driver exists.
- Terminal discovery and all first-observation reconciliation still wait until every live SDK restore
  row has either registered a real session or followed the existing register-and-evict failure path.
- A restore failure remains visible long enough for existing task, workflow, review, and cleanup
  subscribers to settle through `session_remove`.
- A dashboard connecting at any point during restoration receives a snapshot plus later events with
  no lost update window.

## Repository findings

### HTTP is behind restoration

`src/server/index.ts` awaits `sdkSessions.restore()` before `startPoller`, `buildApp`, static web
middleware, and `serve()`. The Electron window cannot load even the React entry point while this
await is pending.

The newly merged state-home ownership boundary is earlier still: `acquireStateOwnership()` runs
before `openDb()`. That order stays fixed. Serving earlier must not weaken exclusive state ownership
or permit a request before the daemon owns and has opened its configured state.

### The restoration order protects durable reconciliation

`SdkSupervisor.restore()` reads `sdk_sessions` oldest first and awaits `resume(row)` serially. Its
documented invariant is not that HTTP must wait. The invariant is that SDK sessions must be
registered or evicted before the first completed terminal discovery sweep fires
`Registry.onSessionsObserved`.

`TaskManager`, `WorkflowManager`, reviews, file comments, retention, and ensemble recovery all use
that observation gate or `session_remove`. The safe change is therefore:

1. serve HTTP after transient restoring state is prepared;
2. start SDK restoration in the background; and
3. start terminal discovery only after that restoration promise settles.

### Existing ghost rows are tasks, not sessions

`StartingStrip` renders `Task` rows where `status === "dispatching"` and `sessionId === null`.
It deliberately avoids synthetic `Session` objects because normal sessions enter selection,
actions, grouping, notifications, workflow logic, and automation.

Restored SDK rows are different. They are durable sessions, but they do not yet have a live driver.
They need a separate transient wire projection rather than fake entries in `Registry.sessions` or a
new persisted task/session state.

### The initial snapshot can lose a concurrent update

`src/server/sse.ts` currently captures and writes the Registry snapshot before it subscribes to
events. That is safe only while startup mutations finish before HTTP. Background SDK adoption would
make the gap load-bearing. The SSE handler must subscribe first, capture and write the snapshot,
then drain queued events. Duplicate idempotent upserts or removes are acceptable; missing an event is
not.

### Current browser state already distinguishes pre-snapshot loading

`useEventStream` exposes `hasSnapshot`, and an active uncommitted experiment uses it to show
"Waiting for the daemon" after React loads. That fallback is useful, but it cannot address the
installed-app black interval while HTTP remains unbound. This plan may incorporate that honest
pre-snapshot state, but the core fix is early serving plus a truthful restore projection.

## Approved design

### 1. Add a transient restoring-session projection

Define one browser-safe shared view, proposed as `RestoringSession`, containing only durable display
facts that exist before a driver launches. The exact final shape should be minimized against current
card needs, but is expected to include:

- session id;
- agent type;
- display name derived through the existing restored-name rule;
- working directory and repository root when known;
- task id and task title when bound;
- durable created time; and
- restore phase or failure-neutral status needed to render "Restoring".

The collection is transient and bounded by the count of readable live rows in `sdk_sessions`. It is
not persisted, is not task lifecycle authority, and is not included in normal session counts.

Add it to the initial SSE snapshot and add exhaustive upsert/remove events, unless repository
inspection during implementation finds that one whole-collection startup event is simpler without
losing reconnect correctness. Update `MissionState`, `Registry.snapshot()`, and the event reducer
together. Decide explicitly that these events do not recompute the Line, alerts, or session-derived
automation because provisional cards are presentation only.

### 2. Split restoration preparation from driver restoration

Refactor `SdkSupervisor` so startup reads and classifies persisted rows once:

- unreadable future statuses remain untouched and are not presented as restorable;
- non-live rows remain excluded;
- each readable live row is converted to a restoring view before HTTP can answer; and
- the prepared rows are retained for the asynchronous restore pass instead of querying the table a
  second time.

The supervisor owns the transient collection lifecycle. A successful `adopt()` emits the real
`session_upsert`; the UI lets the real session win by the same stable id, then the supervisor removes
the restoring projection. A failed `resume()` still calls the existing `registerAndEvict()` before
the restoring entry is removed. No new teardown path is introduced.

The startup restore remains serial in this change. Parallel driver restoration has subprocess,
provider-rate, credential, and ordering risks and is not needed to remove restore work from first
paint.

### 3. Serve after preparation, restore in the background, and gate discovery

Reorder `src/server/index.ts` around explicit startup phases:

```text
acquire state-home lock -> open/migrate DB -> construct managers
      -> prepare restoring projection -> build routes/static UI -> bind HTTP
      -> start SDK restore asynchronously -> await restore -> start terminal discovery
      -> first completed discovery observation -> durable reconciliation
```

The bind callback remains the point after which recovery that requires sole-writer HTTP ownership
may begin. `/api/health` may report success once the listener is serving, because that endpoint means
the daemon process and authenticated API are reachable. The snapshot and restoring cards carry the
truth that session recovery is still underway.

The implementation must retain an owned restore promise. Shutdown can now race restoration, which
was impossible while restore blocked the listener. `SdkSupervisor.stopAll()` or an adjacent startup
coordinator must prevent another prepared row from launching after shutdown begins, settle or abort
the in-flight launch through existing driver ownership, remove transient projections, and then stop
adopted handles. Do not add a process-kill path outside the supervisor.

### 4. Render restoring cards as inert Board bootstrap state

Render restoring entries in Board repository groups using the same visual language as Starting:
dashed or otherwise provisional surface, spinner, stable title, agent/repository context, and the
word "Restoring". The cards occupy the position their real sessions will take, but they remain a
separate component and collection.

The real `Session` collection always wins when both collections briefly contain the same id. The
transition must not duplicate Board counts, the Console rail, the Line, Sitrep, search totals, or
notifications. Restoring cards are not keyboard-selectable, draggable, droppable, clickable session
details, or visible to action predicates.

If no sessions or restoring entries exist before the first snapshot, render the honest daemon
loading state rather than "No agent sessions detected". Once a snapshot arrives with both
collections empty, retain the existing empty state.

### 5. Close the snapshot-to-subscription race

Subscribe to Registry events before capturing the initial snapshot. Queue events while the snapshot
is serialized and written, then drain them in order. Keep unsubscribe and abort cleanup exact.

Map-based browser reducers already make repeated upserts harmless. Remove events must also remain
idempotent. Add a focused test that mutates the Registry during initial snapshot delivery and proves
the client-observable sequence cannot miss the mutation.

## Data and request flow

### Before

```text
Electron dark window -> daemon state lock and DB -> serial SDK restore (all rows)
                     -> HTTP bind -> React/SSE snapshot -> real session cards
```

### After

```text
Electron dark window -> daemon state lock and DB -> prepare transient restore views -> HTTP bind
                     -> React/SSE snapshot -> restoring Board cards
                     -> serial SDK restore in background -> real session upsert -> restore view removed
                     -> terminal discovery -> first-observation reconciliation
```

## Failure and compatibility behavior

- A port-bind failure starts no background restore and leaves normal process failure handling intact.
- A future unreadable SDK status is neither changed nor falsely presented as restorable.
- A readable live row with no supported driver or native conversation id is registered and evicted
  through the current lifecycle so durable subscribers settle.
- A browser connecting before, during, or after restore converges through the same snapshot and
  events contract.
- A daemon shutdown during restore launches no later row and leaves no disposable agent state home,
  pipeline caller credential, managed launch marker, or child process behind.
- `Registry.sessions` remains the sole real-session collection. Terminal discovery and
  `SdkSupervisor` remain its only producers.
- No SQLite schema or migration is required. The projection is rebuilt from existing rows at every
  daemon start.
- Older browsers connecting to a newer daemon ignore additive event fields only where the existing
  version-skew conventions allow it. Current browser and daemon bundles are still changed together.
- Development through Vite retains the same API and SSE origin; only packaged/server-bundle startup
  ordering changes.

## Verification strategy

### Focused server and shared-contract tests

- Prepared projections include only readable live SDK rows and preserve stable identity and names.
- The restore loop consumes the prepared rows once, retains serial ordering, and removes each
  provisional entry only after success or register-and-evict failure handling.
- Terminal discovery cannot report its first completed sweep until the background restore promise
  settles.
- Shutdown during an intentionally delayed resume starts no later row and cleans the in-flight
  session resources.
- SSE subscription before snapshot does not lose a mutation that lands during initial delivery.
- Snapshot and event collection bounds are documented and pinned.

### Browser end-to-end test

Extend the fake SDK agent with a resume-only delay controlled by the isolated E2E environment. Use
the existing restart flow:

1. dispatch and settle one SDK session;
2. crash the daemon;
3. restart on the same disposable home with delayed resume;
4. prove `/api/health` and the built Board answer while the driver is still delayed;
5. assert one inert restoring card with the original identity and no session actions;
6. capture visual evidence of that Board state;
7. release or outwait the fake delay;
8. assert exactly one real card replaces it with the correct idle/working state and no duplicate;
9. capture the settled Board; and
10. confirm the existing SDK idle-restore and Sitrep counts remain correct.

The spec must drive `dist/server/index.mjs` and the built dashboard, never source-only rendering.

### Commands

Run from the repository root with Node 24 or newer:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/sdk-supervisor.test.ts test/session-runtime.test.ts test/sse-initial-delivery.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/sdk-startup-bootstrap.spec.ts
npx playwright test e2e/specs/sdk-idle-restore.spec.ts
```

The focused SSE file is intentionally new because the repository does not currently have a generic
test owner for `src/server/sse.ts`. On macOS under the seatbelt sandbox, run Electron-bearing tests
with the repository-prescribed scoped approval.

## Documentation

- Update `docs/agent-guides/architecture.md` so startup order distinguishes transient restore
  projection, HTTP serving, SDK adoption, and the later first terminal observation.
- Update `docs/desktop-and-packaging.md` to explain that the packaged window can render while session
  restoration continues.
- Keep the documentation explicit that restoring cards are not live sessions and that actual driver
  readiness remains asynchronous.

## Non-goals

- Do not parallelize SDK resume calls in this change.
- Do not add or change persisted SDK session statuses, task statuses, schema, or migrations.
- Do not inject synthetic entries into `Registry.sessions` or expand `SessionState` solely for the
  loading presentation.
- Do not add browser polling, a second bootstrap endpoint, or a packaged `file://` loading app.
- Do not change terminal discovery cadence or reconcile durable subscribers before the first
  completed observation.
- Do not treat `/api/health` as proof that every restored driver is usable.
- Do not include restoring rows in Line, Sitrep, alerts, Foreman, workflow, session count, cost, or
  action eligibility.
- Do not absorb the unrelated uncommitted loading-spinner worktree; implement against the default
  branch and reuse only compatible ideas.

## Success criteria

- With a delayed SDK resume, the built installed-app server serves health and the React Board before
  that resume completes.
- The Board shows one inert restoring card per readable live persisted SDK session, then exactly one
  real card per successfully restored session.
- No black interval remains attributable to serial SDK restoration after the daemon has completed
  its state lock, database, and route construction.
- The first terminal observation and all restart reconciliation still occur only after SDK
  restoration settles.
- Restore failures and shutdown use existing lifecycle owners and leave no stranded durable state or
  child resources.
- The SSE bootstrap cannot miss a concurrent Registry mutation.
- Focused tests, typecheck, lint, the full unit suite, build, smoke, and focused Playwright coverage
  pass.
