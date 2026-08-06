# Phase 1: Keep Awake vertical slice

## Outcome

Mission Control gains a transient **Keep awake** mode in the live indicator. On macOS, enabling
it starts an idle-sleep assertion that allows the display to dim and lock while Mission Control
and its agents continue working. The state is truthful across dashboard windows, visible when it
fails, and resets to off whenever the daemon quits or restarts.

## Entry criteria and direct dependencies

- The planning PR containing `docs/plans/keep-awake/plan.md`, `phased-plan.md`, and this phase file
  is merged to the default branch.
- There are no implementation-phase prerequisites.
- Read the approved source plan and phased-plan index in full before editing.

## Scope

- Shared keep-awake request and status contracts.
- One daemon-owned manager with a macOS `caffeinate` provider and injected test seams.
- Loopback GET/PUT routes and Registry/SSE synchronization.
- A matched dropdown opened from the fleet pulse's connection segment.
- Responsive, accessible, Electron-safe topbar behavior.
- Unit, route, SSE, render, Playwright, documentation, and real macOS verification coverage.

## Non-goals

- Persisting or reacquiring the mode after daemon restart.
- Keeping the display awake or simulating user activity.
- Blocking lid-close, manual Sleep, thermal, low-battery, shutdown, or power-loss behavior.
- Waking a suspended machine or changing Recurring Missions guarantees.
- Coupling the feature to Away mode, schedules, or agent activity.
- Shipping Linux or Windows production providers.
- Adding Electron IPC or `powerSaveBlocker` ownership.

## Repository findings and inherited contracts

### Live state

`src/shared/types.ts` owns the append-only `ServerEvent` union. `src/server/registry.ts` owns the
opening snapshot and event fanout. `src/web/useEventStream.ts` exhaustively reduces that union and
already clears untrustworthy status on `EventSource.onerror`. Extend these three together so a new
browser never waits for a later mutation and a disconnected browser never claims an old assertion
is still held.

### Process ownership

`src/server/index.ts` wins the loopback port, constructs long-lived managers, and performs ordered
shutdown. The keep-awake child is owned there, not by Electron and not by a browser component.
The existing signal handlers make graceful cleanup available; `caffeinate -w <daemon PID>` is the
backstop for an abrupt exit.

### Route compatibility

`buildApp()` has many test callers and appends optional injected services. Add the keep-awake
manager at the end of the signature. Production always supplies it; a missing manager returns a
clear service-unavailable response instead of creating a second owner inside the route module.

### Topbar behavior

`FleetPulse` currently renders `.pulse-link` as an inert leading `div`. Rung 3 in `styles.css`
hides `.pulse-seg:not(.pulse-btn)` and may hide `.pulse:not(:has(.pulse-btn))` while filter is
focused. Once the leading segment is interactive, update these selectors and their source-level
tests so the keep-awake trigger and trailing review button both survive. Do not reuse `.pulse-btn`
for the leading control: that class owns trailing-edge rounding and attention-colored hover.

The dropdown is a floating layer inside the Electron title-bar drag region, so its class must join
the explicit no-drag selector list. Follow the dismissal behavior in `SpendChip`, `AlertBar`, and
`ForemanBar`, then improve it with trigger focus restoration as required by the approved plan.

### CI platform

Required CI runs on Ubuntu. Unit tests inject platform, spawn, PID, timers, and signaling. The built
Playwright daemon needs a fake executable through `MISSION_KEEP_AWAKE_BIN`; when that override is
present it is the provider under test even off macOS. Without the override, the production provider
is available only on Darwin and resolves `/usr/bin/caffeinate` directly.

## Implementation steps

### 1. Define the shared contracts

In `src/shared/types.ts`, add an exhaustive runtime status with:

- `supported` and a bounded unavailability reason;
- `state`: `off`, `starting`, `on`, `stopping`, or `error`;
- `provider`: `caffeinate` or null;
- `since`: the timestamp at which the active assertion was confirmed, otherwise null; and
- a bounded runtime error separate from availability.

Append the status to the snapshot and add `keep_awake_status` to `ServerEvent`. In
`src/shared/protocol.ts`, add a strict `{ enabled: boolean }` request schema and exported input type.
Do not add a persisted config schema.

### 2. Implement the daemon manager

Add `src/server/keep-awake.ts` with one `KeepAwakeManager` and narrow dependencies:

- platform, environment, daemon PID, clock, `spawn`, timers, and child signaling;
- an `onStatus` callback for Registry publication; and
- a production resolver that chooses `MISSION_KEEP_AWAKE_BIN` when explicitly set, otherwise
  `/usr/bin/caffeinate` only on Darwin.

Enable with direct argv `['-i', '-w', String(daemonPid)]` and `shell: false`. Treat the child
`spawn` event as the on boundary. Treat `error` before spawn as an enable failure. Treat an
unexpected exit after spawn as error, keep the mode off, and do not restart it.

Serialize transitions so concurrent dashboard writes cannot create two children or leave the last
response lying about state. Repeated requests for the already-achieved state are idempotent. On
disable, publish stopping, send `SIGTERM`, wait for exit, and use a short bounded `SIGKILL` fallback
only for the child the manager owns. Publish off only after exit is observed. Bound external error
text before it reaches SSE.

Expose `status()`, `setEnabled(boolean)`, and `stop()`. Every new instance starts off. `stop()` uses
the disable path but never writes durable state, because none exists.

### 3. Wire HTTP, Registry, SSE, and daemon shutdown

Teach `Registry` to hold the current keep-awake status, include it in every snapshot, and emit
`keep_awake_status` only when the observable fields change. Seed Registry from the manager before
the server accepts traffic.

Append the optional manager dependency to `buildApp()`. Add:

```text
GET /api/keep-awake
PUT /api/keep-awake  { "enabled": boolean }
```

Return 409 for an unavailable host, 502 for a failed OS transition, and 503 when a legacy test app
did not supply the manager. Successful writes wait for the manager's confirmed transition and
return its current status. Keep the existing loopback middleware and shared body parser.

Construct the manager in `src/server/index.ts`, pass it to `buildApp()`, and stop it in the ordered
shutdown before `server.close()`. Do not restore or start it during boot. Confirm an Electron-owned
daemon, adopted daemon, LaunchAgent daemon, and `npm start` all reach the same server implementation
without preload changes.

### 4. Reduce live state and build the control

Add `keepAwakeStatus: KeepAwakeStatus | null` to `MissionState`. Seed it from `snapshot`, reduce
`keep_awake_status`, and set it to null on SSE error. Use a runtime null fallback for a snapshot from
an older daemon during development.

Add the typed PUT helper in `src/web/lib/api.ts`. The helper returns the server's status or bounded
error and never throws into React.

Create `src/web/components/KeepAwakeControl.tsx`. It owns:

- the leading pulse trigger and anchored dialog;
- `aria-haspopup="dialog"`, `aria-expanded`, a stateful accessible name, and visible focus;
- a real switch control whose pending state is disabled;
- outside-pointer dismissal, Escape dismissal that stops before App's global handler, and focus
  restoration to the trigger;
- inline unavailable, reconnecting, and transition-failure copy; and
- exact lifecycle copy: **On until Mission Control quits or restarts**.

Do not optimistically render on. Starting may render as pending, but only manager/SSE status may
render `live · awake`. When `connected` is false or status is null, reconnecting takes precedence
and the switch is disabled.

Replace only the leading connection segment inside `FleetPulse`; preserve every count and the
attention inbox behavior. The visible labels are `live`, `live · awake`, `live · awake failed`, and
`reconnecting`, so color is never the only state carrier.

### 5. Integrate the visual and responsive contracts

Use the existing green live, purple off-palette, and red failure tokens. Add a wrapper that anchors
the panel without breaking the hairline between the leading control and the next pulse segment.
Keep the leading-edge radius distinct from the review button's trailing-edge radius.

Add active, pending, failed, hover, focus, reduced-motion, and dialog styles. The panel reuses the
fleet pulse's dark surface and opens beneath the leading segment. Add its class to the Electron
no-drag rule.

Update rung-3 selectors so filter focus preserves both interactive pulse controls. Update the empty
pulse rule because the leading control means the pulse is no longer empty when the review button is
absent. Let `fitTopbar` measure the added awake text; do not introduce a fixed breakpoint.

### 6. Add proof and operator documentation

Add focused tests for:

- exact `caffeinate` executable and argv, with explicit absence of `-d`, `-u`, and `-s`;
- unsupported platforms, override resolution, idempotence, serialized opposite requests, spawn
  error, unexpected exit, graceful disable, forced fallback, and shutdown;
- route validation and 409/502/503 behavior;
- opening snapshot and incremental SSE convergence;
- browser disconnect clearing keep-awake state;
- static rendering of off, on, pending, unavailable, reconnecting, and error states;
- Escape/focus behavior and Electron no-drag coverage; and
- topbar ladder preservation of both interactive pulse controls.

Extend `e2e/fixtures/fake-agents.ts` with a fake keep-awake process that records argv and its exit,
and pass its path through `e2e/fixtures/daemon.ts`. Add `e2e/specs/keep-awake.spec.ts` to drive:

1. open the live indicator dialog;
2. read the lock, lid, manual Sleep, battery, and restart copy;
3. enable and verify `-i -w <daemon PID>` in the fake's record;
4. observe `live · awake` through SSE in two pages;
5. disable and observe the fake exit plus both pages returning to live; and
6. disconnect and prove the stale control disables.

Run the active state through `e2e/specs/topbar-one-row.spec.ts` and capture one active dropdown
screenshot under `docs/evidence/keep-awake/` with a README regeneration command.

Update README's feature list, fleet pulse section, and desktop/browser behavior. Add
`docs/runbooks/keep-awake.md` with the exact guarantee, non-guarantees, `pmset -g assertions`
checks, screen-lock observation, disable cleanup, abrupt-exit cleanup, and restart-reset receipt.

## Data, API, and compatibility details

- No database or configuration write exists, so there is no migration or downgrade concern.
- Adding snapshot and event fields is append-only. A newer daemon's incremental event is ignored
  once by an older browser's existing unknown-event guard; a newer browser treats a missing older
  snapshot field as unknown/offline, never on.
- The optional `buildApp()` parameter keeps legacy route-test construction source-compatible.
- The env override is read through the existing `MISSION_`/`FLEET_`/`HARNESS_` compatibility
  helper when practical; production documentation names only `MISSION_KEEP_AWAKE_BIN`.
- Fixed argv and loopback middleware preserve the current command-injection and DNS-rebinding
  boundaries.

## Verification commands

Run focused tests while iterating, then the required gates from the repository root:

```sh
node --test --test-concurrency=2 --import tsx test/keep-awake.test.ts
node --test --test-concurrency=2 --import tsx test/keep-awake-http.test.ts
node --test --test-concurrency=2 --import tsx test/keep-awake-sse.test.ts
node --test --test-concurrency=2 --import tsx test/keep-awake-render.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- e2e/specs/keep-awake.spec.ts e2e/specs/topbar-one-row.spec.ts
```

Perform the runbook on macOS and record the observed assertion, screen-lock behavior, cleanup, and
restart-reset results in the implementation PR.

## Merge and exit criteria

- The complete vertical slice is operable with no later phase.
- Every automatic check above passes, or a base-branch failure is demonstrated and reported.
- The review screenshot and macOS receipt exist.
- README and the runbook state the exact idle-sleep guarantee and restart-off lifecycle.
- The implementation PR records any justified deviation from this proposed route.
- No unrelated files, persistence changes, Electron IPC, or production Linux/Windows provider land.

## Downstream handoff

There is no planned downstream phase. Future platform providers may rely on the shared status,
manager/provider boundary, routes, and UI vocabulary. They must not change macOS from idle-sleep
inhibition to display-sleep prevention, and they must preserve the approved restart-to-off policy
unless a new human decision explicitly replaces it.

## Cross-phase audit record

- 2026-08-05: Source plan and repository inspected. One vertical slice chosen because shared,
  daemon, SSE, and UI work form one operable unit.
- 2026-08-05: Approved transient lifecycle reconciled through manager memory, startup behavior,
  UI copy, compatibility notes, tests, and explicit absence of persistence.
- 2026-08-05: Rung-3 filter compaction and Electron no-drag coverage moved into this phase after
  repository inspection showed the source plan's general responsive note was not specific enough.
- 2026-08-05: Final audit found every source requirement owned once, no downstream dependency,
  and no unresolved schema, API, ownership, or merge-order conflict.
