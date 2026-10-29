# Phase 2: Board presence and the Residents dock

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

Residents are easy to find. A resident's card and Console row glow in the profile's accent with
its label, pin to the top of their column when the profile says so, and the Console header shows
a resident band. A **Residents** button beside **Foreman** in the top bar opens a dock listing live
residents and the profiles, with **Launch** and **Manage residents**.

## Entry criteria and dependencies

- Phase 1 merged.

## Scope

- Profile section `board`: `colorId` from the append-only `RESIDENT_MARKER_COLORS` palette,
  `label` (1 to 4 characters, defaulting from the name), `pin` (default on).
- A `residentRuns` SSE collection (live runs only), each row carrying its pinned revision's
  `settings`, used to join a session to its run.
- Border-glow marker on `SessionTile`, Console `RailRow`, and a band in `ConsoleDetail`.
- Pinned partition in `orderSessions`.
- The Residents dock and its top-bar button.

### Non-goals

Loop state, next wake and loop controls in the band, card and dock (Phase 3). Marker styles other
than border glow: rejected by the operator.

## Repository findings and inherited contracts

- `orderSessions` (`src/web/lib/fleet-order.ts`) is one pure function; its free/held partition is
  the template. Board and Console arrow-key order and number shortcuts derive from it.
- `TaskKindMark` and `--kind` (`src/web/components/TaskKindMark.tsx`) show how one custom property
  drives a marker; the tone spine (`.tile::before`, `--tone-color`) is state and must not change.
- `DISPLAY_ITEMS` (`src/web/lib/board-card.ts`) owns optional decorations;
  `test/board-card-items.test.ts` enforces the registry; attention flags stay always on.
- `RailRow` (`src/web/components/layouts/RailRow.tsx`) draws glyph marks;
  `ConsoleDetail` (`src/web/components/layouts/ConsoleDetail.tsx`) draws the header.
- `ForemanBar` (`src/web/components/ForemanBar.tsx`) is the top-bar Foreman control. Floating
  top-bar layers need the desktop `no-drag` rule, a `Tooltip`, and an `ACTIONS` entry.
- Inherited from Phase 1: `RESIDENT_PROFILE_SECTIONS`, `RESIDENT_EDITOR_SECTIONS`,
  `launchResident()`, the run row.

## Implementation steps

1. **Board section**: add `board` to `RESIDENT_PROFILE_SECTIONS` (optional, defaults applied on
   read) and a `ResidentBoardSection` to `RESIDENT_EDITOR_SECTIONS` with palette swatches, label
   and **Pin to top of column**. Palette colors are CSS tokens in `src/web/styles.css`, never
   arbitrary hex values.
2. **Runs on the wire**: `resident_run_upsert` and `resident_run_remove` events and a
   `residentRuns` collection bounded by live runs, with snapshot, `useEventStream` cases, an
   explicit `LINE_INPUT_EVENTS` decision and a bound test. The daemon publishes from
   `ResidentManager` on launch and run end, with the run's pinned `settings`. No field is added
   to `Session`.
3. **Client join**: a `useResidentFor(session)` selector joining session, task and run. Marker,
   label and pin come from the run's pinned `settings`; the current profile is consulted only to
   show "profile changed since launch".
4. **Marker**: one `--resident` custom property set from the profile color. `SessionTile` gets a
   `.tile.is-resident` border glow and a label chip; `RailRow` an accent edge and chip;
   `ConsoleDetail` a resident band (profile name and label; Phase 3 adds loop state and
   controls). Register the marker as a `DISPLAY_ITEMS` entry so Settings > Display can hide it.
5. **Pinning**: extend `orderSessions` with a pinned partition ahead of free and held, fed by the
   set of sessions whose run's pinned revision has pin on; keep the function pure and update the callers in `App.tsx`,
   `BoardView` and `ConsoleView` to pass the set.
6. **Dock**: a `ResidentsDock` button immediately after `ForemanBar`, with the live count; its
   panel lists live residents (name, label, session state, **Open**) and live profiles
   (**Launch** through `launchResident()`), plus **Manage residents** to `#/residents`. Keyboard
   reachable, `no-drag` in Electron, tooltip, `ACTIONS` binding and palette entry.
7. **Documentation**: the dock, marker and pinning in `docs/ui.md` and `docs/residents.md`.

## Tests and verification

- Unit: pinned partition ordering (pinned first within each column, stable otherwise), board
  section defaults and old-revision parsing, run event bound, `DISPLAY_ITEMS` registration, and
  that editing a profile's color, label or pin leaves a live run's marker and position unchanged
  while a new launch uses the edit.
- `test/layout-parity.test.ts`, `test/session-leaf-parity.test.ts`,
  `test/board-card-items.test.ts`, `test/tooltip-coverage.test.ts`, `test/keybindings.test.ts`.
- Electron geometry test for the dock panel against the top bar and window edge.
- Playwright `e2e/specs/residents-dock.spec.ts`: launch from the dock, see the glowing pinned
  card at the top of its column and the Console band, hide the marker in Settings > Display,
  and confirm `e2e/specs/topbar-one-row.spec.ts` still passes.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Residents glow, pin and show a Console band; the dock launches and opens residents; the top bar
still fits one row.

## Downstream handoff

Phase 3 adds loop state and controls to the band, the card status line and the dock rows, using
the `residentRuns` collection; it must not change the marker, palette ids or partition order.

## Cross-phase audit record

- Concurrent with Phases 4 and 7: touches only its own section, editor component and run
  events; adds one line to each Phase 1 registry.
- Repair round 1: Phase 6 now follows this phase, because its grant status renders in the band
  and dock row built here; marker and pin read the run's pinned revision.
- The dock's **Launch** uses `launchResident()`, so Phase 6's trusted click applies here without
  edits.
