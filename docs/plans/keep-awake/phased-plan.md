# Keep Awake mode: phased implementation

## Source of truth

- Approved product plan: `docs/plans/keep-awake/plan.md`
- Review render: `docs/plans/keep-awake/plan.html`
- Human decision: Keep awake applies only to the current daemon run. A restart resets it to off
  and Mission Control does not persist or reacquire the power assertion.

The user-visible goal is fixed: an operator can prevent idle system sleep from the live
indicator while the display remains free to dim and lock. The implementation route may adapt
where repository evidence requires it, but it must preserve that goal and the approved transient
lifecycle.

## Investigated findings

1. The existing connection segment is an inert `div` inside `FleetPulse` in `src/web/App.tsx`.
   It already leads the fleet pulse, owns the live/reconnecting label, and is the correct anchor.
2. `useEventStream` is exhaustive over `ServerEvent`, seeds permanent chrome from the opening
   snapshot, and deliberately clears status that becomes untrustworthy on disconnect. Keep-awake
   state must follow that model, including clearing to unknown when SSE drops.
3. `Registry.snapshot()` and Registry events are the existing convergence path for daemon-owned
   live state. A second browser polling loop would create a competing source of truth.
4. `buildApp()` already accepts optional injected managers at the end of its signature so broad
   route tests can keep using small stubs. The keep-awake manager should follow that compatibility
   pattern.
5. The daemon has an ordered `SIGINT`/`SIGTERM` shutdown in `src/server/index.ts`. The manager
   belongs in that sequence, while `caffeinate -w <daemon PID>` covers exits that cannot run it.
6. The topbar ladder is measurement-driven, but its rung-3 filter rule currently hides every
   pulse segment except the review button and may hide the entire pulse when no review button is
   present. Converting the live segment into a control requires changing that contract so both
   interactive segments survive filter compaction.
7. Floating topbar panels must be explicitly included in the Electron no-drag rule. Existing
   source-level tests fail when a new floating layer is omitted.
8. CI and Playwright run on Linux. The implementation needs an injected platform/spawn seam for
   unit tests and a `MISSION_KEEP_AWAKE_BIN` override for the built-daemon browser fixture. The
   production default remains `/usr/bin/caffeinate` on macOS; unsupported platforms without an
   override report unavailable.
9. The approved restart behavior removes every persistence concern. There is no `app_config`
   write, database migration, startup restore, or automatic child restart.

## Phase graph

| Phase | Outcome | Direct dependencies | Can run concurrently |
|---|---|---|---|
| 1. Keep Awake vertical slice | Daemon-owned transient idle-sleep inhibition, live indicator dropdown, cross-window SSE truth, tests, and documentation | Planning PR merged | No other implementation phase exists |

```text
planning PR merge
       |
       v
Phase 1: Keep Awake vertical slice
       |
       v
reviewable implementation PR + green required checks
```

## Why one phase

The feature crosses shared contracts, a daemon process owner, Registry/SSE, and the leading
topbar segment. Splitting the server contract from its only control would land unused public state;
splitting the UI first would create a dead control or a second local source of truth. One vertical
slice is the fewest merge-safe phases and remains reviewable because it adds one bounded manager,
two routes, one event, and one compact control with focused tests.

## Request and status flow

```mermaid
flowchart LR
  UI[Live indicator dropdown] -->|PUT enabled| API[Daemon route]
  API --> Manager[KeepAwakeManager]
  Manager -->|fixed argv| OS[/usr/bin/caffeinate -i -w daemon-pid]
  OS -->|spawn, exit, error| Manager
  Manager -->|observed status| Registry[Registry snapshot and events]
  Registry -->|SSE| UI
```

The route response reports the completed transition, while Registry SSE makes every open dashboard
converge on the same observed state. A disconnect clears the browser status to unknown, disables
the toggle, and gives reconnecting precedence over any stale awake label.

## Cross-phase contracts

There is one implementation phase, so these are integration contracts inside its vertical slice:

- `KeepAwakeStatus` describes observed runtime state, never a saved preference.
- Every daemon starts off and never reacquires the assertion automatically.
- `-i` and `-w <daemon PID>` are required; `-d`, `-u`, and `-s` are forbidden.
- The child executable and arguments are passed directly to `spawn`, never through a shell.
- Unexpected child exit becomes a visible error and is not silently restarted.
- Registry plus SSE is the only browser state source.
- The live control and review control remain reachable at every supported topbar width.
- Unsupported platforms refuse visibly instead of drawing an on state.
- Away mode, Recurring Missions, and Electron IPC remain unchanged.

## Merge order and release gate

Phase 1 depends directly on this planning session. Its Mission Control task stays in the backlog
until the planning PR merges these paths to the default branch. The implementation PR then carries
the complete feature and all of its proof; no later cleanup phase is expected.

## Final verification strategy

The implementation phase owns all checks introduced by its behavior:

- focused manager, route, Registry/SSE, render, ladder, popover, and drag-region tests;
- `npm run typecheck`, `npm run lint`, and `npm test`;
- `npm run build` followed by `npm run smoke`;
- the new Playwright keep-awake spec plus the existing topbar width suite;
- an active-dropdown screenshot for review; and
- a real macOS runbook receipt using `pmset -g assertions` to prove the display can lock while
  `PreventUserIdleSystemSleep` is held, then prove restart returns the mode to off.

## Final compatibility audit

- Every approved source-plan requirement is owned by Phase 1.
- The daemon-run-only human decision is reflected in runtime ownership, UI copy, tests, and the
  absence of persistence work.
- No concurrent phase can introduce schema, API, CSS, or test conflicts because there is no
  second implementation phase.
- The phase ends with an operable repository and does not rely on undocumented follow-up work.
- All task-referenced artifact paths are relative to the repository root and will be verified in
  the pushed planning commit before the task is created.

## Artifact index

- `docs/plans/keep-awake/phase-1-keep-awake-vertical-slice.md`
