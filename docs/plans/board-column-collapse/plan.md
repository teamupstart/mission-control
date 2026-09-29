# Board column widths: collapsed, normal, expanded

Every board column gets three widths instead of two. Today a column is either **normal** or
**expanded** (the `‹›` toggle and the head double-click, which gives it twice a normal column's
share). This plan adds a third, **collapsed**: the column folds down to a thin strip that still
says what it is and how many cards it holds, and one click brings it back to its normal size.

Collapsing is added beside expanding, not in place of it. Expanded keeps working exactly as it
does today.

**Decided: mock-up A, the three-stop switch.** The other three mock-ups are kept below as the
record of what was compared. They are interactive in [plan.html](plan.html), beside this file:
every control in the page works, including a button that sends a new session to **Needs you**,
which shows what a collapsed column does when something arrives.

## What the repository already provides

Checked against the code:

- **Expanded already exists.** `BoardView` holds `wideCol` (one column id or `null`) and
  `toggleWide`. `ColumnWidthToggle` in `src/web/components/session-bits.tsx` is the `‹›`
  control, and `.board[data-focus="none"] .board-col.is-wide` in `src/web/styles.css` gives
  the column `flex-grow: 2` with a `--board-col-wide` (520px) floor. The Backlog column
  (`BacklogColumn.tsx`) takes the same `wide` and `onToggleWide` props as the tone columns.
- **Column ids are already shared.** `"backlog"` plus the five tones from `TONE_GROUPS` in
  `src/web/lib/tone.ts`: needs you, working, idle, unconfirmed, gone.
- **Hiding cards already has one correct pattern.** Folding a repository frame takes cards out
  of the DOM, so `src/web/lib/repo-collapse.ts` is a module store that `App` reads to drop
  those cards from `boardColumns`, the arrays the arrow keys and the ⌘-number shortcuts walk.
  A collapsed column has the same problem and uses the same approach.
- **Empty columns are already stashed.** `boardColumnModes` hides empty columns in the
  `board-stash` chip rail. That is about emptiness, not the operator's choice, and stays
  separate from collapsing.

## Behavior shared by every mock-up

These rules hold whichever mock-up is picked:

1. **Three widths, per column.** Collapsed, normal, expanded. Any column can be collapsed,
   including Backlog and Needs you. Several columns can be collapsed at once.
2. **One expanded column at a time**, as today. Expanding a column returns the previously
   expanded one to normal. It does not collapse it.
3. **Collapsed is a strip about 40px wide.** It shows the column's colored dot, its card count,
   and its name written vertically. It is never blank, and it never takes more room than the
   strip.
4. **Collapsed Needs you still asks for attention.** The strip uses the attention color, and its
   count pulses when a new session arrives. How loud that is depends on the decision below.
5. **Double-clicking a column head still toggles expanded.** Nothing about that gesture
   changes.
6. **Opening a session works as today.** The column holding that session becomes the rail at
   its fixed width, whatever width it had been set to. The other columns fold away during the
   morph. Coming back to the board restores every column to the width it had before.
7. **Hidden cards are out of keyboard reach.** Arrow keys and ⌘-number shortcuts skip the cards
   in a collapsed column, the same way they skip a folded repository frame.
8. **Keyboard reachable.** Every width change is a real button with an accessible name
   ("Collapse Backlog", "Restore Backlog", "Expand Working"). A collapsed strip is itself a
   button.

## The mock-ups

All four are drawn at the app's real sizes and colors: a 250px column minimum, a 520px expanded
floor, and a 40px collapsed strip. They differ in the control that changes the width and in
what a collapsed column looks like.

### A. Three-stop switch (chosen)

A small three-segment switch in each column head: a thin bar (collapsed), a medium bar
(normal), and a wide bar (expanded). The current width is highlighted. Like today's `‹›`, the
switch appears when the head is hovered or focused and stays visible whenever the column is not
at normal width. A collapsed column is an in-place strip. Clicking anywhere on it restores the
column to normal.

- **For:** All three widths are visible at once, so there is nothing to discover. The switch
  shows where the column is now as well as where it can go.
- **Against:** It is the widest control in the head, about 54px, against today's 22px. On a
  crowded head (Idle, with its `free` and `held` pills) that space is taken from the title.

### B. Narrower / wider stepper

Two chevrons in the head: `‹` makes the column one step narrower and `›` one step wider. The
steps are collapsed, normal, expanded. At either end the chevron that cannot move further is
disabled. A collapsed strip shows only `›`, and clicking the strip does the same thing.

- **For:** It is the smallest change from today (two 18px buttons where one 22px button is
  now), and it is one idea: narrower or wider. It works well from the keyboard.
- **Against:** Going from collapsed to expanded takes two clicks. The current width is shown
  only by which chevrons are enabled.

### C. Collapse to a dock

The head has a `–` (collapse) button next to today's `‹›` (expand) toggle. A collapsed column
leaves its place and becomes a vertical tab in a dock at the left edge of the board. Collapsing
several columns stacks them in that one dock instead of leaving a strip where each one was.
Clicking a tab puts the column back in its usual position at normal width.

- **For:** It frees the most space. Four collapsed columns take one 40px dock instead of four
  40px strips. It matches the existing empty-column stash, so the board has one idea of
  "columns set aside".
- **Against:** A collapsed column is no longer where it was. On a board you read left to right,
  Needs you moving from first place into a dock is a real change of layout. When more columns
  are docked than fit its height, the dock scrolls.

### D. Width menu with peek

A single width button (`⇔`) in the head opens a small menu with three choices: Collapse,
Normal, Expand, each with a one-line hint. A collapsed column is an in-place strip that also
shows **one dot per card** in the card's own color, so a collapsed Working column still shows
three sessions running. Hovering a strip for a moment **peeks**: the column floats over its
neighbors at normal width without changing the board's layout. Clicking the strip restores it.

- **For:** It carries the most information while collapsed (dots and peek), and the head gains
  only one 22px button, no bigger than today's.
- **Against:** Changing the width takes two clicks (open the menu, pick). Peek is a hover
  behavior with no touch equivalent, and it must not steal the cursor while a card is being
  dragged. It is also the most work to build and test.

## Decisions

Resolved in the Mission Control plan review on 2026-09-25:

- **Mock-up: A, the three-stop switch.**
- **Collapsed columns survive a reload**, stored in `UiConfig`. Expanded stays unsaved, as
  today.
- **A collapsed Needs you stays collapsed when a session arrives**, and its count pulses in
  the attention color.
- **No phased implementation plan for now.** This plan stops here.

## Implementation

Built in this branch, following the decisions above. Items 3 and 4 are where mock-up A
differs from the others: the head control is the three-stop switch, and a collapsed column is
an in-place strip.

1. **Width store**: `src/web/lib/column-width.ts`. A module store, like `repo-collapse.ts`. The
   collapsed set comes from `UiConfig`; the expanded column is the store's own unsaved state,
   moved out of `BoardView`'s `wideCol`, so the one-expanded rule lives in one place. It
   exports `useColumnWidths()`, `setColumnWidth(id, width)`, and the pure `columnWidthOf`,
   `withColumnWidth` and `collapsedColumnSessionIds`. Expanding a collapsed column removes it
   from the collapsed set, and collapsing the expanded column clears the expansion.
2. **Persistence**: `collapsedBoardColumns: string[]` in `UiConfig` (default `[]`) in
   `src/shared/protocol.ts`, registered in `src/shared/app-config-entries.ts` and copied by
   `src/web/lib/uiCache.ts`. Ids are not validated, like `hiddenDisplayItems`, and an id this
   build does not know is carried through untouched. A fold the daemon refuses is taken back
   by `updateUiConfig`.
3. **Head control**: `ColumnWidthControl` in `session-bits.tsx` replaces `ColumnWidthToggle`.
   It is a group labelled "<name> width" of three pressed buttons: "Collapse <name>",
   "<name> at normal width" and "Expand <name>". It is not a radio group, because a radio
   group's arrow keys would fight the board's own card navigation. Both the tone heads in
   `BoardView.tsx` and the Backlog head in `BacklogColumn.tsx` draw it, never while the column
   is the drill-in rail. It stays drawn while its column is expanded.
4. **Collapsed rendering**: `CollapsedColumnStrip` in `session-bits.tsx` (swatch, count,
   vertical name), a button labelled "Restore <name>, <n> cards", rendered in place of the
   head and body. CSS: `.board[data-focus="none"] .board-col.is-collapsed` fixes the track at
   `--board-col-collapsed` (40px) in both `flex-basis` and `min-width`, the same properties
   the morph animates.
5. **Keyboard**: `App.tsx` adds a collapsed column's session ids to `foldedIds`, so the arrow
   keys and ⌘-numbers skip them. Only on the Board overview: the Console has no columns, and
   in a drill-in the focused column is drawn as the rail in full, so its rows stay walkable.
6. **Needs you signal**: the strip's count pulses when the Needs you count goes up while
   collapsed, and not under `prefers-reduced-motion`.
7. **The empty Needs you rail**: since this plan was written, an empty Needs you became a slim
   all-clear rail (#1141). That rail keeps its behavior and offers no width control or
   double-click, because it is already slim. Collapsed wins over it: a Needs you the operator
   collapsed stays the same strip when it empties, so the strip is still mounted to pulse when
   a session arrives.

## Testing

- `test/column-width.test.ts`: the store rules. Only one expanded column at a time, expanding
  a collapsed column, collapsing the expanded one, the collapsed sessions navigation skips,
  and saving (including a refused save being taken back).
- `test/board-column-width.test.ts`: both heads draw the shared control and the shared strip,
  the drill-in rail is never a strip, and the stylesheet answers the classes.
- `test/ui-config-cache.test.ts`: the new field round-trips the cache.
- `e2e/specs/board-column-width.spec.ts`: collapse Backlog, Needs you and Idle and measure each
  strip at 40px; restore from the strip; expand a column beside the strips; reload and check
  that the folds persisted and the expansion did not; one expanded column at a time; a
  session arriving in a collapsed Needs you updates and pulses its count; and the arrow keys
  never land on a hidden card. The browser measures the strip width, so no separate Electron
  geometry test was needed.
