# Session spend from the driver - runtime evidence

What a dispatched session's work costs, captured from a running dashboard after Claude Code's
OpenTelemetry export stopped producing and took every Claude session's cost to zero with it.

Complements `docs/evidence/cost-chip/`, which photographs the same surfaces fed the other way.
Those captures seeded their figures by POSTing to `/v1/metrics` - the exporter's own route - and
so cannot show this bug at all: they prove the popover renders a number the exporter supplied.
The captures here supply nothing. Every figure below was EARNED by a session the daemon ran.

## How it was produced

`e2e/specs/session-spend.spec.ts`, against the BUILT dashboard served by the BUILT daemon on an
isolated `MISSION_HOME`, with the evidence gate on:

```sh
npm run build
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 \
  npx playwright test e2e/specs/session-spend.spec.ts --reporter=list
```

No route was called to seed spend, and that is the whole point of the setup. The spec clicks
**Dispatch**, which cuts a real git worktree and starts a real Agent SDK session against a real
child process. The child is `e2e/fixtures/fake-claude.mjs`, so the suite spends nothing on
models, and its `result` frame carries the same keys the vendor's does - `uuid`, `modelUsage`,
`total_cost_usd` - copied from a frame captured off `claude -p --output-format stream-json`. The
daemon reads that frame, writes the ledger, and pushes `cost_fleet` over SSE. Everything in
these images arrived in the browser that way.

| Reported by the turn's `result` frame | Value |
|---|---|
| `total_cost_usd` | $2.50 |
| `modelUsage` input / output | 1,000 / 500 |
| `modelUsage` cache read / write | 20,000 / 3,000 |
| Tokens today, summed and compacted | 24,500 → `25k` |

The **Automation** line is correctly absent from every capture: nothing headless ran, and that
absence is the point. In the bug, it was the ONLY line with a figure on it.

Each screenshot is taken immediately after the assertion that already checked the number it
shows, and the pointer is parked in the corner first so `Tooltip`'s portalled bubble cannot land
clipped across the figure being photographed. A capture is never the assertion - a PNG proves a
pixel existed, not that a total was right.

## `topbar-chip-session.png`

The bar at rest, before the popover is opened, so the chip is shown alone. `≈$2.50` in the
machinery purple every cost surface wears, beside `1 session`. Before this change this chip did
not render at all on a fleet of driven sessions: with no session rows in the ledger there was no
priced usage and no quota reading, and `fleetCostHasContent` correctly declined to show a
confident `$0.00`. An operator watching agents work saw no cost surface whatsoever.

## `spend-popover-session.png`

The chip opened. **Fleet today `≈$2.50`**, **Rate now `$2.50/hr`**, **Tokens today `25k`** - the
three rows that were empty. Compare against the reported symptom, where this popover carried an
Automation line reading `≈$14.84` with its per-role split and nothing above it.

`Tokens today` is the load-bearing row for the diagnosis. 25k is the sum of all four tiers off
`modelUsage`, so its presence proves the per-model breakdown was read rather than the frame's
flat `usage` block - which excludes subagents and would have under-reported a delegating session
by roughly a third while looking entirely self-consistent.

`Per shipped PR` is absent because the run opened no pull request; that row renders only for a
day with PRs the app can prove it opened. No quota runway appears because no `statusline` payload
was posted, which is also why the chip carries no rate-limit colour.

## `session-card-cost.png`

The card that earned it, reading `≈$2.50` beside its model. The fleet total is an aggregate and
would look correct even if every row were filed under the wrong key, so this is the capture that
shows attribution: the row reached the right note key through the driver's `bound` event.

This image is also the one that caught a real bug. The first implementation recorded the ledger
row BEFORE the idle transition, and `applyDriverState` rebuilds the session from the snapshot the
handler captured on entry - silently reverting the cost that had just been denormalized onto it.
The ledger row was durable and correct, the fleet total was correct, and only this chip was
missing, so every layer except a browser reported success. It is now pinned by name in
`test/sdk-cost-single-count.test.ts`.

## `cost-settings-warning.png`

**Settings · Cost** in the state that previously had no symptom at all: telemetry installed,
session spend landing, and the exporter having never delivered once. Every older signal reads
healthy here - the toggle is on, the `env` block is in the file, the dashboard has numbers - so
the panel now says which sessions are missing from a total that looks complete, in amber:

> Claude Code has never exported telemetry to this daemon, so the estimate covers only sessions
> Mission Control runs. Sessions you started yourself in a terminal are not counted.

The long absolute path in the capture is the isolated test home, not what an operator sees; in
normal use it reads `~/.claude/settings.json`. The first-run hint (*"No Claude telemetry has
reported yet"*) is asserted ABSENT in the same test, because both messages at once would
contradict each other - spend has plainly reported.
