# Phase 2: Blocked placement setting

## Outcome

**Settings → Display → Blocked sessions** chooses where idle blocked sessions appear: **In
Needs you** (default, stacked lanes), **At the top of Idle** (red frame), or **Own column**. The
Console rail and keyboard order follow the same placement.

## Entry criteria

Phase 1 has merged: `Session.blocker`, `hasBlocker`, the `is-blocked` tile and the card items
exist on the default branch.

## Scope

The setting, the placement rules, the three Board renderings, the Console rail Blocked group,
keyboard and `⌘`-number order, docs and tests for them. Non-goals: any change to the record,
tools, gates, card items or detail band.

## Findings and inherited contracts

Settings precedent is `ResidentPlacementPanel` with `RESIDENT_PLACEMENTS`, `UiConfig` and an
`app-config-entries.ts` row. Ordering is computed once in `src/web/lib/fleet-order.ts` and
consumed by `BoardView` and `App`'s `boardColumns`; empty-column hiding is `boardColumnModes` in
`src/web/lib/tone.ts`; column collapse and width live in `src/web/lib/column-width.ts`.

## Steps

1. **Setting.** `BLOCKED_PLACEMENTS = ["needs-you", "idle", "column"]`,
   `BlockedPlacementSchema`, `UiConfig.blockedPlacement` defaulting to `needs-you`, the config
   entry, and `BlockedPlacementPanel` beside Residents with the plan's copy and
   `data-anchor="display/blocked"`.
2. **Ordering.** In `fleet-order`, pull idle or unconfirmed sessions with `hasBlocker` into one
   blocked group (reply flagged first, then oldest `startedAt`); asking and working sessions
   stay in their columns; blocked wins over held. One ordering feeds every placement.
3. **In Needs you.** Two lanes in the attention column, each with a head and its own scrollport;
   Blocked sized between one card and 45%; lanes hide when empty; `boardColumnModes` shows the
   column when either lane has sessions; the collapsed strip shows both counts; the drill-in
   rail morph keeps both lanes.
4. **At the top of Idle.** A red frame reusing the repository frame shape, head with count and
   oldest age, fold state persisted per machine in `UiConfig`.
5. **Own column.** `BoardColumnId` `"blocked"` between Needs you and Working, hidden when empty,
   with width and collapse through `collapsedBoardColumns`.
6. **Keyboard and rail.** `boardColumns` follows the rendered order (a lane follows the lane
   above it); the Console rail draws a red Blocked group in the matching position.
7. **Docs.** `docs/ui.md`: the setting, the three placements, ordering.

## Compatibility

A missing `blockedPlacement` reads as `needs-you`; unknown stored column ids are already
preserved by `column-width.ts`. CSS uses existing tokens only, so every skin passes
`test/style-literals.test.ts` and `test/skins.test.ts`.

## Tests

Unit: `BlockedPlacementSchema` default and parsing; fleet ordering and `boardColumnModes` for each
placement; keyboard arrays. E2E `e2e/specs/board-blocked-placement.spec.ts`: default lanes with
Blocked showing at least one whole card while Needs you is full, both lanes scrolling
independently; switch to each other placement and find the card; Console rail group. Then
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
`npm run test:e2e`.

## Exit criteria

All three placements render from one ordering, the default is In Needs you, and every check
above passes.

## Handoff

Final phase. Later work may add placements to `BLOCKED_PLACEMENTS` but must keep the single
ordering.

## Cross-phase audit

Checked against Phase 1: uses only its published contracts (`Session.blocker`, `hasBlocker`,
`is-blocked`, card item ids) and edits none of its files' behavior. No conflicts.
