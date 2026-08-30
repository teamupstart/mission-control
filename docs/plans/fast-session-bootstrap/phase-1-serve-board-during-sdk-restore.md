# Phase 1: Serve the Board while SDK sessions restore

## Outcome and user-visible value

Make the installed Mission Control app paint its real frame and Board before persisted SDK drivers
finish restoring. The operator immediately sees one inert restoring card per readable live SDK
session, then each card becomes the exact real session when its driver is adopted.

This phase delivers the complete selected feature. There are no later implementation phases.

## Entry criteria and direct dependencies

- Direct dependency: the planning session and its pull request containing `plan.md`,
  `phased-plan.md`, and this phase file must be merged.
- Required baseline: the default branch after that planning merge.
- Governing instructions: repository `AGENTS.md`, `docs/agent-guides/architecture.md`,
  `docs/agent-guides/change-contracts.md`, and `e2e/README.md`.
- Freshness condition: inspect current `src/server/index.ts`, `src/server/sdk/supervisor.ts`,
  `src/server/sse.ts`, and the session Board before editing. Adapt if newer merged startup work has
  changed an owner, but preserve the fixed outcome and record the deviation in the pull request.

## Scope

- Introduce a bounded transient projection for persisted SDK sessions whose drivers are restoring.
- Prepare that projection before HTTP serves its initial snapshot.
- Serve routes and the built React application before awaiting driver restoration.
- Keep terminal discovery and first-observation reconciliation behind the settled restore promise.
- Make background restoration and shutdown one owned supervisor lifecycle.
- Close the SSE snapshot-to-subscription lost-update window.
- Render provisional Board cards and an honest pre-snapshot empty state.
- Add focused unit and built-browser regressions, including visual evidence.
- Update architecture and packaged-app startup documentation.

## Explicit non-goals

- No parallel SDK restoration.
- No new persisted status, table, column, migration, or duplicate source of truth.
- No synthetic entry in `Registry.sessions` and no `SessionState` expansion solely for presentation.
- No browser polling, second bootstrap endpoint, or packaged local loading application.
- No change to terminal discovery cadence or the meaning of durable `session_remove`.
- No restoring-row participation in Line, Sitrep, alerts, notifications, Foreman, Workflows,
  session search totals, cost, drag/drop, selection, or actions.
- No attempt to make an adopted agent ready sooner than its provider protocol allows.
- No dependency on or edit to the separate uncommitted loading-spinner worktree.

## Repository findings and inherited contracts

### Startup and writer ownership

`src/server/index.ts` acquires the native state-home lock before `openDb()`. That is the sole-writer
boundary and remains the first startup requirement. Managers and routes may serve only after the
lock, migrations, token, Registry, and injected dependencies are ready.

The current restore await occurs before `buildApp()` and `serve()`. Moving only the await would be
insufficient because route construction itself is still below it. Reorder the complete construction
sequence deliberately instead of starting a second app or server.

### Restoration and first observation

`SdkSupervisor.restore()` reads all persisted rows, filters readable live statuses, and resumes them
oldest first. Its comments and `TaskManager`/`WorkflowManager` twins require every live SDK row to
register or evict before the first completed terminal discovery observation. Preserve that gate by
starting `startPoller(registry)` only after background restore settles.

### Real-session authority

`Registry.sessions` feeds more than rendering. A session with runtime `sdk` can satisfy
`canMessage` before its driver has actually bound, and session ids participate in task ownership,
workflow eligibility, attention, drafts, notifications, and cleanup. Do not represent a pending
driver as a normal `Session`.

### Existing provisional UI

`StartingStrip` is the visual precedent for a thing that has durable identity but does not exist as
a session yet. It is not the data model. The restoring component may reuse compatible CSS tokens or
small presentational primitives, but it consumes only the new restore view.

### SSE bootstrap

`sseHandler` captures and writes `registry.snapshot()` before subscribing. Once restores mutate the
Registry after HTTP bind, that order can miss an event. Subscribe first and queue before snapshot
capture. Replayed duplicate upserts and removes are acceptable because the browser collections are
keyed maps and removal is idempotent.

### E2E restart fixture

The Playwright daemon fixture runs `dist/server/index.mjs`, supports crash/restart on the same port
and state home, and uses fake SDK agents. `sdk-idle-restore.spec.ts` already proves real restart
identity and final Board/Sitrep state. Add a resume-only fake delay rather than sleeps in the test or
production hooks.

## Implementation steps

### 1. Define the transient shared projection

Add a browser-safe `RestoringSession`-style type under `src/shared/`. Prefer the existing session or
protocol module that owns adjacent wire types. Include only facts available from an `SdkSessionRow`
and its optional task before driver launch:

- stable session id;
- known agent;
- restored display name;
- cwd and repository context;
- optional task identity/title;
- created time; and
- one bounded presentation phase if more than "restoring" is genuinely needed.

Do not copy the full `Session` shape or invent placeholder values for driver facts. Document the
collection bound as the number of readable live SDK rows loaded at startup.

Add the collection to the snapshot event and `Registry.snapshot()`. Add focused upsert/remove events
if incremental changes use them. Update `MissionState` and the exhaustive `useEventStream` switch in
the same commit. Explicitly leave the event kinds out of `LINE_INPUT_EVENTS` because provisional
rows do not count as live fleet work.

Use optional snapshot decoding only where current bundle version-skew conventions require it. The
same packaged release changes server and browser together, so do not turn missing current fields
into a second permanent compatibility mode.

### 2. Give `SdkSupervisor` a prepared restore lifecycle

Refactor startup restore into two owned operations, names chosen to fit current style:

1. a synchronous preparation step that reads `listSdkSessions()` once, classifies rows, stores the
   prepared readable live rows, and publishes their restoring views; and
2. an asynchronous start/settle step that processes those exact rows serially.

Preparation must use existing helpers for live-status interpretation and restored naming. It must
not change unreadable, non-live, or malformed future rows. A second call must be idempotent or
refused explicitly so one daemon cannot launch a row twice.

For each prepared row:

- keep its provisional view until the existing success or failure lifecycle has produced the real
  Registry event;
- on success, let `adopt()` publish the real `session_upsert`, then remove the provisional entry;
- on failure, let `registerAndEvict()` register and begin ordinary eviction before removing the
  provisional entry; and
- ensure a thrown cleanup path cannot strand the provisional entry indefinitely.

The browser projection should suppress a restoring card whenever a real session with the same id is
present. This makes the handoff one-for-one even if React renders between the real upsert and the
provisional remove.

Keep restore ordering serial. Record timestamps or logs only if they are bounded and useful for
diagnosis; do not add a new persisted startup ledger.

### 3. Own restore-versus-shutdown concurrency

Early serving allows `SIGINT` or `SIGTERM` during restore. Add an explicit supervisor-owned state:
prepared, restoring, stopping, and settled behavior may be represented with simpler fields, but the
observable rules are fixed.

- Starting restoration more than once launches no duplicate driver.
- Once stopping begins, no later prepared row launches.
- An in-flight launch either reaches adoption and is stopped through the existing handle path, or
  fails and cleans its disposable agent state, MCP descriptor resources, managed Pipeline markers,
  and caller credentials.
- `stopAll()` waits for or coordinates with the restore promise before it reports completion.
- Every transient restore view is removed during settled shutdown.
- No direct child kill or Registry teardown path is added outside existing owners.

Add focused tests with a controllable launch promise to prove shutdown during row one never starts
row two and leaves no provisional entries or handles.

### 4. Reorder daemon startup around the listener

In `src/server/index.ts`, preserve state lock, database open, configuration, Registry construction,
manager construction, and all startup subscribers before serving.

After the TaskManager and other consumers needed for restored names and lifecycle are ready:

1. prepare the SDK restore projection;
2. build the Hono app and static middleware;
3. bind HTTP;
4. in the successful serving callback, start recovery loops that already require sole-writer
   ownership and start the SDK restore promise;
5. after that promise settles, start terminal discovery exactly once; and
6. retain the existing first-observation recovery ordering.

Do not let a failed port bind start drivers. Make stop handles nullable or idempotent where startup
can now be partially complete. Shutdown must safely cover signals before the poller starts and after
it starts.

Keep `/api/health` as daemon-serving health unless current route contracts require an additive
startup phase field. Do not delay health until restore completion, because Electron and the E2E
fixture must be able to observe the early-serving boundary. If adding an optional phase field makes
tests materially clearer, keep `ok` semantics unchanged and document the field.

### 5. Make SSE initial delivery race-free

In `src/server/sse.ts`, establish the Registry subscription and abort cleanup before capturing the
snapshot. Queue any event that arrives during snapshot serialization or write, then drain in normal
order.

Add a narrow injectable or stream-controlled test seam if necessary. Prove at least:

- an upsert during initial snapshot delivery is represented by the snapshot, queued event, or both;
- a remove during the same window cannot leave a row visible indefinitely;
- abort unsubscribes exactly once; and
- steady-state heartbeat behavior is unchanged.

Do not add sequence polling or another browser fetch. Duplicate keyed events are the safe side of
the boundary.

### 6. Render inert restoring cards in the Board

Derive restoring Board entries separately from the fleet's real-session groups. Use task and
repository facts already present in the projection to place cards under the same repository group
their real session will occupy. If a durable row lacks repository context, use the Board's existing
unknown/unscoped placement rather than inventing a path.

Render a dedicated accessible component with:

- a provisional visual treatment consistent with Starting;
- spinner honoring `prefers-reduced-motion`;
- stable title, agent, repository context, and "Restoring" copy;
- `role="status"` or another appropriate non-interactive semantic; and
- no interactive descendants or session detail navigation.

Do not pass these rows through fleet sorting, session selection, `SessionTile`, action bars,
drag/drop, search totals, or attention bucketing. The real session wins by id during overlap. Board
column and repository counts remain counts of real sessions.

Before the first snapshot, if there are no client-known sessions or restoring rows, show an honest
"Waiting for the daemon" state instead of the definitive empty fleet. After a snapshot with both
collections empty, retain "No agent sessions detected".

Add pure render/projection tests where they protect no-action semantics or one-for-one suppression,
but do not substitute them for Playwright.

### 7. Add the built restart regression and visual evidence

Add a resume-only delay control to the fake SDK agent. The default must be zero so every other E2E
spec remains unchanged. Prefer a bounded environment value parsed by the fake and used only on a
native resume request.

Add `e2e/specs/sdk-startup-bootstrap.spec.ts`, or extend the existing idle-restore spec only if the
result remains focused and readable. Against the built daemon and Board layout:

1. dispatch one SDK session and wait until its durable row is idle;
2. crash the daemon;
3. restart with resume deliberately held;
4. prove the restart helper returns from `/api/health` while the fake has not completed resume;
5. reload or reconnect the built dashboard;
6. assert exactly one restoring card with the original identity/title and "Restoring" copy;
7. assert it has no buttons, links, draggable behavior, composer, selection, or duplicate real card;
8. capture a checkout-relative gitignored screenshot of this state;
9. let resume complete;
10. assert the restoring card disappears and exactly one real session appears with the existing idle
    state and correct Board/Sitrep counts; and
11. capture the settled state.

Avoid sleeps for correctness. Synchronize on fake-agent records, database facts, HTTP state, or
visible transitions. Keep every agent binary fake so the test spends no model tokens.

### 8. Update lifecycle documentation

Update `docs/agent-guides/architecture.md` startup order to distinguish:

- exclusive state ownership and DB initialization;
- prepared transient restore views;
- HTTP availability;
- background serial SDK adoption;
- terminal discovery; and
- first-observation reconciliation.

Update `docs/desktop-and-packaging.md` to say the Electron window loads the daemon-served Board while
session restoration may still be running. State explicitly that provisional cards are not live or
actionable and that health does not mean every driver is ready.

Do not copy test-only command detail or the prior investigation report into product docs.

## Data, API, migration, and compatibility details

- Persistence: unchanged. Existing `sdk_sessions` and `tasks` rows are the only durable inputs.
- Migration: none.
- HTTP: existing route and health semantics remain; no polling endpoint is added.
- SSE: one bounded additive restore collection in the snapshot plus the minimum incremental events.
- Browser state: one transient map keyed by stable SDK session id.
- Session authority: `Registry.sessions` remains real sessions only.
- Failure: existing `registerAndEvict()` and `session_remove` remain the only durable reconciliation
  route for an unresumable live row.
- Shutdown: supervisor lifecycle expands to cover in-flight startup, without changing driver stop
  ownership.
- Older persisted rows: unreadable future statuses remain untouched and absent from the transient
  projection, matching current conservative behavior.
- Development: Vite still proxies HTTP/SSE to the daemon; the built installed app benefits because
  static middleware now serves before restore completion.

## Verification commands

Run focused coverage first from the repository root with Node 24 or newer. Add the focused SSE
delivery test at `test/sse-initial-delivery.test.ts`; the repository does not currently have a
generic test owner for `src/server/sse.ts`:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/sdk-supervisor.test.ts test/session-runtime.test.ts test/sse-initial-delivery.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/sdk-startup-bootstrap.spec.ts
npx playwright test e2e/specs/sdk-idle-restore.spec.ts
git diff --check
```

Run the Playwright commands only after the successful build. On macOS under
`CODEX_SANDBOX=seatbelt`, use the repository-prescribed scoped outside-sandbox approval for Electron
geometry inside `npm test`; do not bypass the preflight.

The final implementation pull request must report actual completed command output and attach the
restoring and settled Board screenshots. Do not claim an installed-app timing improvement solely
from source inspection. Record the E2E-observed ordering and, when practical, a controlled
time-to-health comparison using the built bundle and delayed fake restore.

## Merge and exit criteria

- The daemon serves `/api/health`, static assets, and the built Board while a prepared SDK restore is
  still blocked in the fake driver.
- The initial snapshot contains all and only readable live prepared SDK rows.
- Every successful restore produces one real session and retires its provisional card with no
  actionable overlap or visual gap.
- Every failed restore follows register-and-evict and retires its provisional card without stranding
  the task or workflow binding.
- First terminal observation cannot precede settled SDK restoration.
- Shutdown during restore launches no later row and leaves no child, disposable state home, managed
  marker, credential, handle, or provisional projection behind.
- SSE bootstrap tests prove no concurrent Registry mutation is lost.
- Restoring cards are inert, accessible, correctly grouped, and excluded from real fleet counts and
  automation.
- Focused tests, typecheck, lint, the full unit suite, build, smoke, both focused Playwright specs,
  and `git diff --check` pass.
- Architecture and packaged-startup documentation match the implemented ordering.
- A reviewable pull request explains the perceived-startup benefit, unchanged actual serial restore
  duration, failure/shutdown tradeoffs, visual evidence, and any reasoned deviation from this guide.

## Downstream handoff

There are no later phases. After this phase merges, future work may rely on:

- HTTP and the Board being available before SDK restoration settles;
- one transient restoring view per readable live SDK row;
- real session identity winning by stable id;
- terminal discovery remaining behind restore settlement; and
- race-free SSE initial delivery under concurrent startup mutations.

Future optimization may instrument or parallelize SDK restore, but it must preserve provider limits,
stable handoff, supervisor shutdown ownership, and the first-observation gate. Future UI work must not
promote restoring rows into ordinary session actions or counts.

## Cross-phase audit record

- 2026-08-30: Verified against current `main` after exclusive state-home ownership and agent
  subprocess isolation merged. Both remain prerequisites, not alternate paths.
- 2026-08-30: Kept projection, server reorder, supervisor lifecycle, SSE bootstrap, Board UI, docs,
  and E2E proof in one phase because no subset is a truthful operable startup.
- 2026-08-30: Assigned transient projection ownership to the supervisor/Registry boundary and kept
  `Registry.sessions` real-only, matching existing Starting-strip reasoning and shared action
  predicates.
- 2026-08-30: Added shutdown coordination because serving before restore creates a signal race the
  current blocking startup cannot experience.
- 2026-08-30: Added subscribe-before-snapshot SSE ordering because concurrent restore events make
  the existing gap material.
- 2026-08-30: Reconciled all source-plan success criteria to this phase and confirmed no later phase,
  repository attachment, migration, or cleanup owner is missing.
