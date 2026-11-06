# Resident drawer: residents leave the fleet

Residents move off the Board and the Console rail into a drawer that slides out from the right
edge. The drawer is the default placement. **Settings → Display → Residents** lets anyone switch
back to today's placement. Opening a resident by click or hotkey still lands on the same full
conversation you use today.

The HTML rendering of this plan (`plan.html`) draws the drawer open, closed with a visitor card,
and pinned.

## Adopted decisions

Submitted from the dashboard review of revision 2.

- **Surface:** A, the slide-out drawer on the right. Mockups B to F (rail, Residents page,
  bottom dock, top-bar chips, strip) are not being pursued.
- **Default:** the drawer, for new installs and for anyone who never changed the setting.
  **Settings → Display → Residents → Where residents live** offers **Drawer** or **Board and
  Console** (today's placement).
- **Needs you:** a visitor card, shown only while the drawer is closed.
- **Next:** a phased implementation plan.

## Behavior

### Where residents live

| Setting (Settings → Display → Residents) | Choices | Default |
|---|---|---|
| Where residents live | **Drawer** · **Board and Console** | Drawer |

- Stored per machine beside **Layout**. A machine with no stored value gets **Drawer**, which
  includes existing installs that upgrade.
- **Board and Console** keeps today's placement: residents sit in Board columns and the
  Console rail with their marker, the pin to top of column applies, and the top-bar
  **⌂ Residents** button and `⇧H` open today's Residents dock. `⌥1`…`⌥9` also work there (see
  "Opening a resident").
- **Drawer:** no resident card appears in any Board column and no resident row in the Console
  rail, except the visitor card below. **Session display → Resident marker** and the profile's
  **Pin to top of column** have nothing to act on in this mode, and their settings say so. The
  marker color and label still drive the drawer and the visitor card.
- Switching the setting takes effect live, like **Layout**.

### The drawer

- **Opening.** The top-bar **⌂ Residents** button, `⇧H`, or the edge tab slides a 330px
  drawer in from the right over the current page, dimming what is behind it. In Drawer mode
  these controls replace today's dock popover. Escape or a click outside closes the drawer.
- **Edge tab.** While the drawer is closed, a tab on the window's right edge shows ⌂ and the live
  count, with no number when nothing is running, and turns amber while any resident needs you.
- **Cards.** One card per live resident, in its marker color, in the order the dock uses today.
  The top line holds the chip, name, state dot and the resident's `⌥`-number. Under it
  are tags for state, iteration, next wake, and any pause or wake reason.
- **Selected card.** The selected card expands to show the latest message or open question, any
  question options as buttons, a reply box (`⌘⏎` sends), and **Open**, **Run now** and
  **Pause** / **Resume**. The arrow keys move the selection and Enter opens the selected card.
- **Footer.** Profiles with **Launch** / **Launch…**, with the same launch behavior the dock has
  today (*starting…*, *still starting*, resuming the same launch), plus **Manage residents**.
- **Pin.** **Pin** docks the drawer as a column beside the fleet, so the Board narrows instead
  of being covered. The pin persists per machine. **Unpin** or `⇧H` closes it.

### Opening a resident

- **Open** on a card, Enter on the selected card, or `⌥1`…`⌥9` from anywhere
  opens that resident's full detail. This is the same detail as today: Conversation, Work
  queue, Workflows, Diff, Files, with the resident band. On the Board it opens as the drill-in;
  in Console, in the detail pane. An open resident never joins the Board columns, the drill-in
  rail or the Console rail: the detail pane shows it while the fleet lists stay fleet-only.
- `⌥1`…`⌥9` work in both placements. They number live residents in the order the drawer and
  the dock both list them, and are not bound to anything today. In **Board and Console** they
  open the resident's detail the same way, with no drawer to return to. macOS turns Option+digit
  into a symbol, so they match on the physical key and are ignored while a text field has focus.
  `⌘1`…`⌘9` keep numbering only fleet sessions.
- When a resident was opened from the floating drawer, which closes as the detail opens, Escape
  out of the detail reopens the floating drawer with that resident still selected. A pinned
  drawer stays on screen while the detail is open, so Escape leaves the detail and moves focus to
  that resident's card in the pinned drawer. No floating drawer opens in that case.
- The ⌘K palette finds a live resident by name or label and opens its detail the same way.

### When a resident needs you

- A resident needs you under the same rule the top-bar **Need you** count already uses. The
  count, desktop alerts and the chime keep including residents.
- **While the drawer is closed**, a visitor card appears in the Board's **Needs you** column, or
  among the Console rail's sessions that need you. It is a dashed outline in the marker color
  with the chip, the name, and *Resident · opens in the drawer*.
- The visitor card disappears when the drawer is open or pinned, because the drawer is already
  showing the ask. It also disappears once the resident no longer needs you. Closing the drawer
  brings it back if the ask is still open.
- Clicking the visitor card, or Enter on it, opens the drawer with that resident selected and
  expanded. The arrow keys reach it. `⌘`-numbers skip it, so they don't shift while an
  ask is open.

### What does not change

- Resident profiles, launch, the persistent loop, session control, MCP servers and lifecycle.
- The Console band and the resident detail itself.
- In **Board and Console** placement, residents' place in the Board columns and the Console
  rail, their markers, pinning and the Residents dock behave exactly as today. The one addition
  there is `⌥1`…`⌥9`.

## Implementation sketch

Phasing verifies these against the code.

- **One placement predicate.** A single shared predicate, "is this session placed on the
  fleet?", decides fleet membership from the placement setting, whether the session is a
  resident, whether it needs you, and whether the drawer is open. It is applied where fleet
  order and Board columns are built (`src/web/lib/fleet-order.ts` and its caller in
  `src/web/App.tsx`), so arrow keys and ⌘-numbers inherit it and no view branches on its own.
- **The drawer builds on the dock's data.** It reuses the live-resident and launch state behind
  `src/web/residents/ResidentsDock.tsx`, so there is one source of truth for live residents and
  in-flight launches. The top-bar button (`src/web/components/Topbar.tsx`) and `⇧H`
  route to the drawer or the dock by placement.
- **One detail.** Opening a resident uses the existing session selection that the Board
  drill-in and Console already use. There is no second detail component. The detail pane looks
  an open resident up directly, so opening it never adds it to a fleet list.
- **Settings.** The placement preference sits beside **Layout** in the display preferences and in
  settings search. Board presence and Resident marker settings note when Drawer mode makes them
  inert.
- **Docs.** `docs/residents.md` ("Finding a resident", "The Residents dock"), the keyboard table
  in `docs/ui.md`, and the Display settings docs.

## Acceptance criteria

1. With Drawer placement (the default, including an install with no stored value), no resident
   appears in Board columns, the Board drill-in rail or the Console rail, including while its
   detail is open. The only exception is the visitor card in criterion 6.
2. The top-bar button, `⇧H` and the edge tab each open the drawer. Escape and a click
   outside close it.
3. The drawer lists every live resident in its marker color. The selected card's reply box sends
   to that resident, and its question options answer the question.
4. **Open**, Enter and `⌥N` open the resident's full detail in Board and in Console.
   Escape returns to the drawer when the detail was opened from it: it reopens a floating drawer,
   or focuses the resident's card in a pinned one.
5. Pin docks the drawer beside the fleet and persists across reloads.
6. A resident that needs you shows a visitor card in Needs you / the Console rail only while the
   drawer is closed. Clicking it opens the drawer on that resident. The card goes away once the
   ask is answered.
7. Switching to **Board and Console** restores today's placement, markers, pinning and dock,
   live and without a reload, and `⌥N` still opens resident N's detail there.
8. The Need you count, desktop alerts and the chime still count a resident that needs you in
   both placements.
9. Playwright specs in `e2e/` cover criteria 1 to 7 with faked agents. Unit tests cover the
   placement predicate. The docs listed above match the behavior.
