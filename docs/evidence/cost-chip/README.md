# Cost chip and spend popover - runtime evidence

The topbar's retired second row, and what replaced it, captured from a running dashboard
rather than from static markup.

Supersedes `docs/evidence/automation-cost-line/`, whose captures show the Fleet Strip this
change retires. Those remain as the record of how the automation line was verified when it
shipped; the surface they photograph no longer exists.

## How it was produced

An isolated daemon on its own `MISSION_HOME` and its own port, serving the BUILT dashboard
from `dist/` - not the shared `:5173` vite server, which serves the main checkout and would
have photographed unmodified code. Three real ingest routes seeded the figures, exactly the
transports a live fleet uses:

```
POST /v1/metrics            -> {}    session cost + tokens (OTel, token-guarded)
POST /statusline            -> 204   the subscription's 5-hour and 7-day quota windows
POST /api/usage/automation  -> 204   x2, the Inspector's and the Foreman's own model calls
```

The daemon recomputed `FleetCost` and pushed each change over `cost_fleet`; every figure
below arrived in the browser over SSE, and the escalation capture was taken without a
reload after re-posting the quota reading.

| Seeded | Value |
|---|---|
| Session cost today | $12.40 |
| Session tokens today | 8,400,000 |
| `inspector:review` | $1.23 |
| `foreman:triage` | $0.62 |
| Claude 5-hour window | 62% used, resets in 2h - then 96% used, resets in 20m |
| Claude 7-day window | 31% used, resets in 4 days |

No PR provenance was seeded, so **Per shipped PR** is correctly absent from these captures:
the row renders only when the day has pull requests the app can prove it opened. Its
arithmetic and its refusal to divide by zero are pinned in `test/spend-chip.test.ts`.

## `topbar-chip.png`

The bar at rest. One row, where there used to be two: the chip sits with the fleet pulse in
the readout half, reading `≈$12.40 · $12.40/hr`, in the same machinery purple every other
cost surface in the app wears. The rate segment is the first thing the responsive ladder
takes back at narrow widths; the figure and the caret never degrade.

## `spend-popover.png`

The chip clicked open. Every fact the retired strip carried, at a size that can afford
labels: today's estimate, the rate, tokens, the automation overhead with its per-role split
printed under it rather than buried in a tooltip, and one runway meter per quota window
carrying both the consumption we were handed (`62%`) and the projection we made (`~1h 52m`).
The footer states the estimate disclaimer once, where the strip repeated it in five separate
tooltips, and links to Settings · Cost.

## `chip-escalated.png`

The same fleet after the 5-hour window is re-read at 96% with twenty minutes left. The chip
escalates on the RUNWAY, not the dollars - `costTone`'s thresholds are per session and a
fleet clears them most afternoons - and it trades its rate for the reading that escalated
it, so the red has its subject on the chip instead of tinting a dollar figure that has not
moved. The accessible name says the same thing in words: "Claude · 5-hr window 96% used,
nearly exhausted". This is what makes hiding the meters behind a click safe; they used to be
permanently on screen, and the runway is the only forward-looking number in the app.
