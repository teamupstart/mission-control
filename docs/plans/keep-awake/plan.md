# Keep Awake mode

## Outcome

Add an operator-controlled **Keep awake** mode to Mission Control's live indicator. When it
is on, macOS may dim and lock the display normally, but it does not put the computer to sleep
only because the user is idle. Mission Control and its agents can therefore keep working while
the operator is away.

The macOS command is spelled `caffeinate`. The interface should use **Keep awake**, not the
command name, because that describes the result and leaves room for other operating-system
providers later.

This is an idle-sleep inhibitor, not a wake scheduler. Closing the lid, choosing Sleep, losing
power, shutting down, and thermal or low-battery safeguards may still suspend the Mac. Existing
Recurring Missions catch-up guarantees remain unchanged.

## Recommendation

Let the daemon own a small keep-awake manager and start:

```text
/usr/bin/caffeinate -i -w <mission-control-daemon-pid>
```

`-i` prevents user-idle system sleep. It does not prevent display sleep. `-w` binds the
assertion to the daemon PID, so an ungraceful daemon exit also releases it. Mission Control
must never add `-d`, `-u`, or `-s`: those would keep the display awake, impersonate user
activity, or change the requested sleep semantics.

This is preferable to Electron's `powerSaveBlocker` for this product. The Electron API has the
right native behavior, but only the Electron main process can own it. Mission Control also runs
as a standalone daemon with a browser dashboard, and the packaged shell may adopt a daemon it
did not launch. Daemon ownership gives every supported launch mode the same behavior and one
live source of truth.

Ship a macOS provider first behind a small provider interface. Other platforms report
**Unavailable on this system** instead of pretending the mode is active. A later Linux or
Windows provider can implement the same interface without adding platform branches to routes
or React components.

References:

- [Apple: PreventUserIdleSystemSleep](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridlesystemsleep)
- [Electron: powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)

## User experience

### Placement and states

Make the connection segment at the leading edge of the existing fleet pulse a button. It keeps
its connection meaning and opens a compact dropdown anchored to that segment.

```text
off         [ ● live                    | 4 sessions | 2 working ]
on          [ ● live · awake            | 4 sessions | 2 working ]
failed      [ ● live · awake failed     | 4 sessions | 2 working ]
disconnected[ ● reconnecting            | stale figures...       ]
                   │
                   └── anchored Keep awake dropdown
```

Use the existing palette deliberately:

| State | Visible treatment | Meaning |
|---|---|---|
| Off | Existing green `#35c08a` live dot | The daemon connection is healthy |
| On | Purple `#a371f7` dot, steady halo, and `live · awake` | Connected and holding the idle-sleep assertion |
| Starting or stopping | Purple dot with restrained pulse and action disabled | A requested transition is in progress |
| Failed | Red `#f85149` dot and `live · awake failed` | The daemon is connected, but the assertion is not held |
| Reconnecting | Existing red reconnecting treatment takes precedence | The dashboard cannot claim current power state |

The label change is required. Color alone must not carry the mode, and `awake` must not replace
`live` because the first segment still qualifies every streamed figure beside it.

The dropdown reuses the fleet pulse's panel, border, radius, typography, and 30px control rhythm.
Its active border and switch use the same purple as the active dot. This should look like the
indicator opening to explain itself, not like an unrelated settings card.

```text
┌──────────────────────────────────┐
│ KEEP AWAKE                    ON │
│ Keep this Mac awake          [●] │
├──────────────────────────────────┤
│ The screen can dim and lock      │
│ normally. Prevents idle sleep.   │
│                                  │
│ Lid close and manual Sleep still │
│ work. Uses more battery power.   │
└──────────────────────────────────┘
```

The control needs `aria-haspopup="dialog"`, `aria-expanded`, a stateful accessible name,
visible keyboard focus, Escape dismissal that does not reach App's global Escape handler,
outside-click dismissal, and focus restoration to its trigger. In the Electron title bar, the
dropdown must be added to the explicit `-webkit-app-region: no-drag` coverage.

While SSE is disconnected, the dropdown may show the last observed state but must disable the
toggle and say that Mission Control is reconnecting. It must not imply that a stale `on` value
is a current OS assertion.

### Approved lifecycle

Keep awake is off by default, always requires an explicit operator action, and applies only to
the current daemon run. Mission Control does not persist or reacquire the assertion. A hot
reload, crash, orderly quit, or supervised daemon restart returns the mode to off, and the
dropdown says **On until Mission Control quits or restarts**.

This choice minimizes surprise battery use. The tradeoff is deliberate and visible: a daemon
restart can remove protection while the operator is away, so the `-w <daemon PID>` cleanup and
the reconnect snapshot must converge to off rather than silently recreating the assertion.

Do not couple Keep awake to Away mode. Away mode changes alert delivery, while Keep awake changes
host power behavior. Either may be useful without the other, and automatically combining them
would make a notification choice consume battery.

## Runtime design

### State and ownership

Add a shared `KeepAwakeStatus` with an exhaustive state such as `off`, `starting`, `on`,
`stopping`, or `error`, plus `supported`, `provider`, `since`, and a bounded error string. Keep
the current request in manager memory and separate it from observed runtime state so a failed
process never renders as on merely because enablement was requested.

The daemon constructs one `KeepAwakeManager` before accepting HTTP traffic. The manager:

- selects a provider from the daemon's platform;
- starts `caffeinate` with an absolute executable path and an argument array, never a shell;
- treats the child `spawn` event as on and an unexpected `error` or `exit` as error;
- makes repeated enable or disable requests idempotent and serializes concurrent requests from
  multiple dashboard windows;
- sends `SIGTERM` on disable, waits for confirmed exit, and uses a bounded forced-stop fallback
  only for the child process it owns;
- stops during the daemon's existing ordered shutdown; and
- uses `-w <daemon PID>` as the crash-safety backstop when orderly shutdown cannot run.

The macOS provider should be dependency-injected for tests. Production resolves
`/usr/bin/caffeinate`; the browser fixture supplies a fake executable so Linux CI can exercise
the full interaction without changing host power settings.

### API and live synchronization

Add:

```text
GET /api/keep-awake
PUT /api/keep-awake  { "enabled": true | false }
```

The PUT body is parsed by a shared Zod schema. Unsupported platforms return a clear refusal.
Spawn or stop failures return an error and publish the observed error state. The existing
loopback middleware protects both routes, and fixed arguments avoid shell injection.

Keep-awake state belongs on the existing SSE channel because multiple browser windows and the
Electron renderer must agree immediately. Add it to the opening snapshot and add one exhaustive
`keep_awake_status` event. `useEventStream` becomes the browser's only source of truth; no
localStorage and no second polling loop are introduced.

```mermaid
flowchart LR
  UI[Live indicator dropdown] -->|PUT enabled| API[Daemon HTTP route]
  API --> Manager[KeepAwakeManager]
  Manager -->|spawn fixed argv| OS[/usr/bin/caffeinate -i -w daemon-pid]
  OS -->|spawn, exit, or error| Manager
  Manager -->|status update| Registry[Registry live state]
  Registry -->|snapshot or keep_awake_status SSE| UI
```

## Repository changes

| Area | Change |
|---|---|
| `src/shared/types.ts` | Add `KeepAwakeStatus`; extend the snapshot and `ServerEvent` union append-only |
| `src/shared/protocol.ts` | Add the strict enable/disable request schema |
| `src/server/keep-awake.ts` | Add the manager, provider seam, fixed macOS command, transition serialization, and cleanup |
| `src/server/registry.ts` | Hold current status for snapshots and emit `keep_awake_status` only when it changes |
| `src/server/routes.ts` | Add read/write routes with injected manager ownership and clear error codes |
| `src/server/index.ts` | Construct before serving and stop during shutdown; every new daemon starts off |
| `src/web/useEventStream.ts` | Seed and exhaustively reduce keep-awake state from SSE |
| `src/web/lib/api.ts` | Add the typed write helper |
| `src/web/components/KeepAwakeControl.tsx` | Own trigger, dropdown, focus, dismissal, pending state, and inline errors |
| `src/web/App.tsx` | Replace the inert live segment with the control while preserving all fleet counts |
| `src/web/styles.css` | Add matched dropdown treatment, active/error states, responsive behavior, reduced motion, and no-drag coverage |
| `README.md` and a runbook | Document exact guarantees, battery cost, restart policy, and real macOS verification |

No SQLite schema migration or `app_config` key is needed. Keep awake is deliberately transient
daemon state.

## Verification

### Fast tests

- Manager tests prove the exact executable and argv, especially `-i` and `-w`, and prove `-d`,
  `-u`, and `-s` are absent.
- Manager tests cover unsupported platforms, idempotent double-enable and double-disable,
  concurrent opposite requests, spawn failure, unexpected exit, graceful stop, forced-stop
  fallback, and daemon shutdown.
- Route tests cover schema refusal, unavailable platforms, successful transitions, failure
  status, and preservation of unrelated state.
- SSE tests prove snapshot plus incremental convergence and update the exhaustive browser reducer.
- Static React tests render off, on, busy, unavailable, disconnected, and failed dropdown states.
- Existing topbar ladder, popover Escape, and desktop drag-region tests are extended for the new
  trigger and floating panel.

### Required browser test

Add a Playwright spec that drives the built dashboard against a real isolated daemon and a fake
keep-awake executable:

1. Open the live segment with role and accessible-name locators.
2. Confirm the dropdown states that the screen may lock and that lid close or manual Sleep still
   works.
3. Turn Keep awake on.
4. Prove the fake process received exactly `-i -w <the daemon PID>`.
5. Observe the SSE-driven indicator become `live · awake` and the dropdown become on without a
   reload.
6. Open a second dashboard page and prove it receives the same on state.
7. Turn the mode off and prove the fake process exits and both pages return to live.
8. Drop the SSE connection and prove the control disables rather than claiming fresh state.

Run the active pulse through `e2e/specs/topbar-one-row.spec.ts` at the pinned widths. The added
word must not wrap the title bar or make the ladder hide an interactive segment. Capture one
review artifact showing the open active dropdown beside the pulse.

### Real macOS receipt

Automated tests can prove process ownership but cannot prove the operating system honored the
assertion. Add a short manual runbook and record one real observation:

1. Enable Keep awake and confirm `pmset -g assertions` lists `caffeinate` with a
   `PreventUserIdleSystemSleep` assertion.
2. Lock the screen and let the display turn off; confirm Mission Control work continues.
3. Disable Keep awake and confirm the assertion disappears.
4. Quit the daemon unexpectedly and confirm the `-w` child and assertion disappear.
5. Restart the daemon and confirm Keep awake returns to off and is not reacquired.

## Acceptance criteria

- A user can turn Keep awake on and off from the live indicator in every dashboard launch mode
  on macOS.
- On means the display may dim and lock while user-idle system sleep is inhibited.
- The UI never claims on before the OS process starts or after it exits.
- Reconnects and multiple windows converge on one truthful state, while daemon shutdown or restart
  releases the assertion and returns the next snapshot to off.
- Unsupported platforms and process failures are visible and actionable.
- The topbar remains one row at supported desktop widths and the dropdown is fully keyboard and
  pointer operable in the Electron drag region.
- Relevant unit, route, SSE, static render, Playwright, typecheck, lint, build, smoke, and real
  macOS receipt checks pass.

## Non-goals

- Keeping the display awake.
- Defeating lid-close, manual Sleep, low-battery, thermal, shutdown, or power-loss behavior.
- Waking a machine that is already asleep.
- Promising that a Recurring Mission runs at wall-clock time while the computer is suspended.
- Automatically enabling the mode from Away mode, a schedule, or agent activity.
- Shipping a production Linux or Windows inhibitor in the first version.
