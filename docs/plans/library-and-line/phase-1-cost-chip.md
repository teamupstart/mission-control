# Phase 1 - Cost chip and spend popover

## 1. Outcome

The topbar's second row (UsageBar → FleetStrip) is gone. In its place, a compact machinery-purple
cost chip sits in the single topbar row (`≈$12.40 · $3.1/hr` shape); clicking it opens a spend
popover carrying everything the strip showed: today's estimated cost, current rate, tokens today,
estimated cost per shipped PR, the automation overhead line (per role), and per-provider rate-limit
runway meters. Cost detail becomes a glance plus a drill-down instead of permanent chrome.

Visual reference: `docs/mockups/automation-prominence-2/1-library-line.html`, Frame B topbar and
the open "Spend - today" popover.

## 2. Entry criteria and dependencies

- Direct prerequisites: none. This phase can start immediately after the plan PR merges.
- Entry state: `main` with `docs/plans/library-and-line/` present.

## 3. Scope and non-goals

In scope:

- Remove the `UsageBar` second row and its fold affordance from the topbar.
- Add the cost chip and popover; keyboard and screen-reader accessible (the chip is a `button`
  with `aria-expanded`; the popover is a labelled dialog, `esc` closes it).
- Preserve every fact the FleetStrip displayed, inside the popover.
- README cost/usage sections updated to the new surface.

Non-goals:

- No change to `FleetCost` computation, `cost_fleet` emission, `useCost`/cost config, or the
  Cost settings panel (the popover links to it).
- No per-PR cost on the Line's Shipped stage (phase 3 owns the strip).
- No session-card `≈$` changes (cards are untouchable per the plan).

## 4. Repository findings and inherited contracts

- `src/web/App.tsx`: imports `compactFleetCost, FleetStrip, fleetStripHasContent` (line ~27) and
  `useUsageBarCollapsed` (~44); reads `fleetCost` from the event stream (~128); renders
  `<UsageBar fleet={fleetCost} view={...} collapsed onToggleCollapsed={...}>` (~1644) inside
  `<header className="topbar">`; defines `UsageBar` in-file (~2420) rendering `FleetStrip` when
  expanded and `compactFleetCost` when collapsed.
- `src/web/components/FleetStrip.tsx`: `FleetStrip` (stats-vs-windows order flips on
  `view: "usd" | "plan"`), `fleetStripHasContent`, `compactFleetCost`, `FleetStats`,
  `FleetWindows` (runway projection via `projectRunway`), `FleetStat` tiles.
- `src/web/lib/usageBar.ts`: `useUsageBarCollapsed` persisting `app_config.ui.usageBarCollapsed`.
- `src/shared/types.ts` `FleetCost` (~285): `estimatedCostToday`, `estimatedBurnPerHour`,
  `tokensToday`, `prsToday`, `rateLimits`, `rateLimitSources?`, `automation`, `updatedAt`.
- Tones: `src/shared/cost.ts` (`costTone`, `COST_ATTENTION_USD`, `COST_DANGER_USD`);
  formatting: `src/web/lib/format.ts` (`fmtUsd`, `compactTokens`, `fmtRunway`, `untilReset`).
- Inherited contracts: none (first phase).

## 5. Implementation steps

1. `src/web/components/CostChip.tsx` (new): the chip button (compact figures from
   `compactFleetCost`-equivalent logic, tone from `costTone`) plus the popover dialog. Reuse
   `FleetStrip.tsx` internals rather than duplicating them: refactor `FleetStats` and
   `FleetWindows` into exported pieces consumed by both the popover and any remaining callers,
   or move them wholesale if the popover becomes the only caller. The popover keeps the
   `view: "usd" | "plan"` ordering behavior and the automation line, and links to
   `#/settings/cost`.
2. `src/web/App.tsx`: replace the `UsageBar` render with `<CostChip fleet={fleetCost} view={...}>`
   placed in the main topbar row (right side, before the ghost buttons); delete the in-file
   `UsageBar` component and the `useUsageBarCollapsed` usage.
3. `src/web/lib/usageBar.ts`: delete if no caller remains; the persisted
   `app_config.ui.usageBarCollapsed` key is simply no longer read (leave stored values alone -
   config is a bag, no migration needed). Note the retirement in the README.
4. Hide-when-empty: when `fleetStripHasContent` is false (cost telemetry off), render no chip;
   the popover's config link surface moves to Settings · Cost as today.
5. Styles in the app's CSS convention beside existing topbar styles; machinery-purple border/text
   per the mockup; `prefers-reduced-motion` respected (no new animation is required).
6. README: rewrite the usage-bar section to describe the chip + popover; update any screenshots
   references textually.
7. Tests:
   - `test/` unit coverage for chip visibility/tone/format decisions (pure helpers), using
     `node:test` + `renderToStaticMarkup` where markup shape matters.
   - e2e spec `e2e/specs/cost-chip.spec.ts`: with seeded cost data, the topbar shows the chip and
     no second row; clicking opens the popover (role dialog, accessible name), `esc` closes it;
     the popover lists rate, per-PR, automation, and runway content.

## 6. Data / API / migration

None. `FleetCost` and `cost_fleet` are consumed unchanged. No DB or config migration; one config
key becomes dormant.

## 7. Verification

`npm run typecheck && npm run lint && npm test`; `npm run build && npm run smoke`;
`npm run test:e2e` including the new spec. Runtime check: with cost telemetry enabled, chip figures
match Settings · Cost; with it disabled, no chip renders.

## 8. Merge and exit criteria

- No `UsageBar` row in any state; single-row topbar.
- Popover carries every retired FleetStrip fact; keyboard accessible.
- All checks green; README matches.

## 9. Downstream handoff

Later phases may rely on: the chip existing as the only topbar cost surface; the popover dialog's
accessible name ("Spend"); `FleetCost.prsToday` remaining available for phase 3's Shipped-stage
figure. Later phases must not: reintroduce a second topbar row or move the chip (phase 2 adds the
page segment on the topbar's left; the right side is this phase's layout).

## 10. Cross-phase audit record

- 2026-08-02: drafted against `81fd089`. Topbar ownership split recorded (P1 right side, P2 left
  side) to keep the two phases mergeable in either order.
