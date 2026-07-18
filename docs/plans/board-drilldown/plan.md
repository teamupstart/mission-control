# Board → Console drill-in

Click a card on the **board** and, instead of a narrow right-hand drawer sliding
over the columns, the board **morphs into the console view**: the column you
clicked slides to the left edge and becomes a console-style rail, and a full
detail pane - the tabbed conversation with its pinned reply box - grows into the
space the other columns vacate. Escape (or a back control) reverses the morph
back to the full board.

The board stays your chosen layout. This is a **drill-in, not a layout switch**:
you pop back to the exact board you left, nothing reflowed.

## Why

- The board's job is the at-a-glance *shape* of the fleet - how many need you,
  how many are working. That's a great overview and a poor place to read a
  conversation and type a reply.
- The console's detail pane is the good surface for that work. Today the board
  answers a click with a cramped 620px drawer that overlays (and hides) the
  board behind a scrim. Handing off to the real console detail is both roomier
  and one less bespoke surface to maintain.
- Because it's a drill-in, the overview is never lost - closing returns you to
  the same board, so you keep using the board *as* the board.

## The interaction

1. **Board overview** - a column per state (needs you / working / idle /
   unconfirmed / gone), tiles stacked in each.
2. **Click a tile** in, say, *working*.
3. **The morph** (skipped under `prefers-reduced-motion`):
   - The columns to the left and right of *working* collapse to zero width and
     fade out.
   - *working* slides to the left edge and narrows to rail width (~320px); its
     tiles restyle to the console's dense rail-rows.
   - A **detail pane grows in from the right** into the freed space, showing the
     selected session's `ConsoleDetail` - the *Conversation / Work queue / Gate /
     Diff* tabs, with the pinned reply box + action bar.
4. **While focused** - click another row in the rail to swap the detail pane;
   press **Esc** or the rail's back control to reverse the morph to the full
   board.

## The one decision: what does the rail list?

When you drill into *working*, the left rail can show **only that column's
sessions**, or **every session grouped by state** (exactly the console rail).
This is the load-bearing choice and is presented as options in the dashboard /
question prompt - the rest of the plan assumes the recommended **"only that
column"**, and notes where the alternative differs.

- **Only that column (recommended).** The clicked column *is* the rail - it
  matches "all items in that column show up in the left column," and gives the
  cleanest morph (the thing you clicked slides over and becomes the rail). To
  work a different column, Esc back to the board and open one there.
- **Every session, grouped (full console rail).** Identical to the console
  layout - you can jump to any session without leaving focus - but the rail then
  holds more than the column you clicked, so the morph reads as "the column
  expands into the whole rail" and is built as a board→console cross-dissolve
  rather than a single column sliding over.

## Architecture

### The morph is one animated CSS grid

`.board` becomes an explicit `display: grid` whose tracks are **one per tone
column plus one trailing detail track**. The entire transition is a single
`transition` on `grid-template-columns`:

- **Overview:** `repeat(5, minmax(250px, 1fr)) 0fr` - five equal columns, the
  detail track collapsed to nothing.
- **Focused on column _i_:** every column track goes to `0fr` except column _i_
  at `320px`, and the detail track becomes `minmax(440px, 1fr)`.

Browsers interpolate `grid-template-columns` between two track lists of the same
length (`fr` and `px` are animatable), so the columns slide closed and the
detail pane grows open with **no JS measuring, no FLIP, and it reverses for
free**. Each column sets `overflow: hidden` so its tiles clip cleanly as the
track closes.

*Why not a shared-element / FLIP animation across the two layouts' DOM trees:*
it would have to measure element positions across a React remount, fight the
rail's independent scroll, and re-break every time either layout's markup
changes. One grid whose template animates is stable, reversible, and
reduced-motion is a single media query.

### Before → after (the flow this changes)

Overview is five equal grid tracks with the detail track at `0fr`. On select,
the grid template animates so the non-selected column tracks go to `0fr`, the
selected column track goes to a fixed rail width, and the detail track opens to
`1fr` - the same DOM, a different template. Deselect animates the template back.
(Rendered as an inline SVG in `plan.html`.)

### DOM - one stable tree, mounted across the morph

```
<main class="board" data-focus={focusedTone ?? "none"}>
  <section class="board-col" data-tone="attention"> …tiles / rail-rows… </section>
  … one <section> per tone …
  <aside class="board-detail">
    {selected && <ConsoleDetail key={selected.id} view={props} session={selected} />}
  </aside>
</main>
```

Every column **and** the detail aside stay mounted through the morph, so both
directions animate. The detail track is `0fr` in overview; its `ConsoleDetail`
child mounts only when a session is selected (there's nothing to render
otherwise) and is clipped while the track is closed.

### Reuse over rebuild

- **Detail pane = the existing `ConsoleDetail`, verbatim.** It already is "the
  other view from the console," and `BoardView` already receives
  `SessionViewProps` - exactly what `ConsoleDetail` needs. No new detail code.
- **Rail rows = the console's `RailRow`.** Extract it from `ConsoleView.tsx`
  into a small shared module so the focused column reads identically to the
  console rail, instead of a second copy that can drift.
- **Delete the board drawer.** `board-scrim`, `board-drawer`, and the
  `.app-board .card.expanded` hosting rules all go - the full `SessionCard` is no
  longer hosted inside the board, so that whole block of CSS retires.

### Selection & state - nothing new

`props.selectedId` already drives board selection.
`focusedTone = selected ? stateDisplay(selected).tone : null` derives the focused
column. Clicking a tile calls the existing `onSelect`; Esc / back calls the
existing `onDeselect`.

**Edge - the selected session changes tone while focused** (e.g. *working →
needs input*): `focusedTone` follows the session, so the focused column re-scopes
to the session's new tone and the rail's contents shift with it. The detail pane
is keyed by session id, so it stays put. This is coherent under "only that
column" and a no-op under "full rail."

### Keyboard

When the board is focused, arrow keys should walk the **rail** vertically (like
the console) rather than the 2-D board. `layoutNav.ts` gains a focused-board
branch; Esc deselects back to the overview (already wired).

## Files touched

| File | Change |
| --- | --- |
| `src/web/components/layouts/BoardView.tsx` | Overview + focused in one tree; host `ConsoleDetail`; remove the drawer. |
| `src/web/components/layouts/ConsoleView.tsx` | Export `RailRow` (move to a shared bits module) for reuse. |
| `src/web/styles.css` | Board grid template + focus-state `grid-template-columns` transition; rail-in-board styles; remove drawer rules; `prefers-reduced-motion` guard. |
| `src/web/lib/layoutNav.ts` | Focused board navigates vertically within the column. |

## Verification

- **E2E in the real app** (vite on my own port, not `:5173`): board overview →
  click a *working* tile → watch the morph → detail pane with a working reply box
  → click another rail row (detail swaps) → **Esc** back to the board.
- **Reduced motion:** the state change is instant, no transition.
- **Narrow window:** rail + detail still fit; overview still scrolls
  horizontally as today.
- **Empty column:** a state column with no tiles can't be focused (nothing to
  click) - the empty "needs you" column still reads as information.
- **Regression:** the console and grid layouts are untouched; drawer removal
  leaves no dead CSS.

## Out of scope

- **Switching the persisted layout preference.** This is a drill-in; the board
  stays the board.
- **Animating the Settings layout switcher (board ↔ console).** The same grid
  machinery could later power that transition, but it's a separate change.
