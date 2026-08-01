# Automation cost line - runtime evidence

See [`focused-test-run.md`](focused-test-run.md) for the verbatim focused test run proving a
headless report is accepted through the route, recorded under its role key, and read back per
role. The screenshots below are the operator-facing half of the same claim.

The Fleet Strip showing what the app spent on itself, captured from a running dashboard
rather than from static markup.

## How it was produced

An isolated daemon (its own `MISSION_HOME`) and a Vite dev server pointed at it, so the
screenshots show this branch's code and not the main checkout. **Re-captured against the
final branch state**, because `FleetStrip.tsx` changed after the first capture - the
pipeline's documentation pass touched it, and the `main` merge brought in a usage-bar change
- so the original images no longer showed the shipping UI. Five headless runs
were delivered through the real route the Foreman worker uses:

```
POST /api/usage/automation   x5   -> 204
```

The daemon priced them itself from the Codex Standard API snapshot, exactly as it does for
a live run. The resulting ledger:

| role | model | cost | tokens |
|---|---|---|---|
| `inspector:review` | gpt-5.6-terra | $5.5563 | 1,125,000 |
| `foreman:verify` | gpt-5.6-terra | $2.4050 | 499,000 |
| `foreman:review` | gpt-5.6-terra | $1.3790 | 289,100 |
| `inspector:reply` | gpt-5.6-terra | $0.2989 | 114,100 |
| `foreman:triage` | gpt-5.6-luna | $0.0588 | 61,800 |

Every row carries `spend_kind = 'automation'`, and the strip's session figures stayed at
zero throughout - which is the separation this feature exists to make visible.

## `fleet-strip.png`

The strip with **$9.70 automation today** ($5.5563 + $2.4050 + $1.3790 + $0.2989 + $0.0588
= $9.698, rounded). No session figures are drawn, because no session spent anything.

## `fleet-strip-tooltip.png`

The same stat hovered, listing every role that contributed with its cost, tokens and run
count. This is the drill-down that makes "which loop is expensive" answerable.

## Two defects this capture found

Both are fixed in the same change; neither was visible in static-markup assertions, which
is the argument for capturing it at runtime.

1. **A bare `$0.00/hr` estimated rate.** Once the automation line could hold the strip open
   on its own, a fleet with no session usage drew a confident zero rate beside it. The rate
   stat now requires `> 0`, matching the daily estimate it sits next to and the strip's own
   rule against claiming a measured zero.
2. **The tooltip was clipped off the top of the viewport.** `Tooltip` decided above/below
   before the bubble existed, so it could only ask whether the trigger was near the top of
   the screen - not whether this bubble fitted above it. A tooltip with a line per role is
   taller than the topbar's offset, so it overflowed. The flip is now re-decided in the
   measure pass that already corrects horizontally, where the real height is known.
