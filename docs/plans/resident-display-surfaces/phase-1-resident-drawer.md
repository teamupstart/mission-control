# Resident drawer - Phase 1: Drawer placement and fleet exclusion

Source plan: `docs/plans/resident-display-surfaces/plan.md`. Index:
`docs/plans/resident-display-surfaces/phased-plan.md`. This file is the proposed route. Where the
repository disagrees, follow the repository and record the deviation in the pull request.

## 1. Outcome

Residents leave the Board columns and the Console rail and live in a slide-out drawer on the right,
which is the new default. **Settings → Display → Residents → Where residents live** switches
between **Drawer** and **Board and Console** (today's placement), live. In Drawer mode:

- The drawer opens from the top-bar button, `⇧H`, or an edge tab.
- It can be pinned as a column.
- It opens any resident's full detail by click, Enter, `⌥1`…`⌥9` or the ⌘K palette.
- A resident that needs you shows a visitor card in Needs you only while the drawer is closed.

**Value:** the fleet holds task sessions only, and residents stay one key away.

## 2. Entry criteria and dependencies

- The planning session's pull request has merged, so this file and the source plan are on the
  default branch.
- No phase prerequisites. This is the first phase.

## 3. Scope

**In scope:**
- The placement and pin UI config fields.
- The placement predicate and its App wiring.
- The floating and pinned drawer, the edge tab, and drawer cards with tags and Open, Run now and
  Pause / Resume.
- The footer with profiles and Launch.
- `⌥N` jump chords, Escape returning to the drawer, the palette path, and the visitor card.
- Inert notes on the Resident marker and Pin to top of column settings.
- Updates to existing tests and specs for the new default, plus the docs.

**Non-goals:**
- The latest-message preview, question option buttons and the reply box inside the drawer card.
  Those are Phase 2.
- Any change to resident profiles, launch semantics, the loop, session control or the Console
  band.
- Removing or restyling the Residents dock, which **Board and Console** mode keeps.

## 4. Repository findings and inherited contracts

Verified at `c90f6287d`. The full findings are in the index.

- **Resident identity:** `residentBySession` in `src/web/App.tsx` (around line 2208), built by
  `residentMarksBySession` in `src/web/residents/marker.ts`.
- **The filter site:** the `fleet` memo in `App.tsx` (around 2216 to 2223), which calls
  `matchesSessionFilter` and then `orderSessions(... pinnedResidents)`. Everything downstream
  reads `visible` / `fleet`:
  - `boardColumns` (around 2393)
  - `assignCardShortcuts` (around 2429)
  - `viewProps.sessions` (around 2791)
- **Detail lookup:** the detail is looked up in `props.sessions` (`ConsoleView.tsx:51`,
  `BoardView.tsx:191`), and App's `selected` is `visible.find(...)`. Step 5 adds a lookup so a
  resident can be the open detail without being in that list.
- **Opening a session:** `openSessionOnFleet` (`App.tsx` around 1780) is already layout-aware. It
  navigates to Fleet and sets `selectedId`, and only when `layout === "board"` does it also call
  `setBoardOpen(true)`. So it opens the Board drill-in in Board, and in Console the selection
  alone shows the session in the detail pane.
- **The dock:** `ResidentsDock.tsx` holds local `launches` state. It is opened by
  `openResidentsDock` / `residentsDockRequest` (`App.tsx` 525 to 526), the `⇧H` arm (around 3140),
  and the palette entry `command:residents-dock` (`src/web/lib/palette-index.ts:538`).
- **Keybindings:** `src/web/lib/keybindings.ts` (`chordFromEvent` uses `e.key`, and
  `reservedChordReason` is at 577).
- **Side panel pattern:** `<Overlay>` with `as="aside"`, as `ReportPanel.tsx` does (around 368),
  styled by `.report-panel` (styles.css around 12492).
- **UI config:** `src/shared/protocol.ts`:
  - `UI_CONFIG_DEFAULTS` (around 3598)
  - `UiConfigSchema` (3713)
  - `UiConfigPatchSchema` (3902)
  - `UiConfigViewSchema` (3923)

No inherited contracts. This phase defines the ones listed in the index.

## 5. Implementation steps, in order

1. **UI config fields.** In `src/shared/protocol.ts`:
   - Add `RESIDENT_PLACEMENTS = ["drawer", "fleet"] as const` with its Zod enum.
   - Add `residentPlacement` (default `"drawer"`) and `residentDrawerPinned` (default `false`) to
     `UI_CONFIG_DEFAULTS`, `UiConfigSchema`, the patch schema and the view schema, next to
     `layout`.

   Then add both fields to:
   - `uiFields` in `src/shared/app-config-entries.ts`. It is exhaustive by type, so it fails to
     compile until they are there.
   - `coerce()` in `src/web/lib/uiCache.ts`.
   - `test/fixtures/route-surface.json` (the `GET /api/ui/config` snapshot).

   A stored config without the fields must parse to the defaults, so existing installs get the
   Drawer.
2. **Settings UI.** Add a **Residents** section to the Display panel stack (`SettingsPage.tsx`
   around 557 to 579, beside `LayoutPanel.tsx`):
   - A radiogroup **Where residents live** with **Drawer** and **Board and Console**.
   - `data-anchor="display/residents"`.
   - Saved through `updateUiConfig`, the way the Layout radiogroup saves.

   Add a `settings-search.ts` entry with the same backup domain as Layout. In Drawer mode, show a
   one-line note beside the **Resident marker** Display item (`src/web/lib/board-card.ts:191`) and
   beside the profile editor's **Pin to top of column** saying they apply only in Board and
   Console.
3. **Shared launch state.** Move the `launches` state, `patchLaunch` and `launch()` out of
   `ResidentsDock.tsx` into `src/web/residents/useResidentLaunches.ts`, owned once by App and
   passed to whichever of the dock or the drawer is mounted. Keep the dock's behavior and its
   Escape handler (pinned by `test/topbar-popover-dismiss.test.ts`) byte-for-byte where the tests
   assert them.
4. **Placement predicate.** Create `src/web/lib/resident-placement.ts` exporting one pure
   function. It takes:
   - `placement`
   - `residentIds`
   - a way to read each resident's tone, the same tone `orderSessions` groups by
   - `drawerOpen` (true when floating open or pinned)
   - `openDetailId`: the session whose detail is open, if any. Derive it from `selectedId`,
     `boardOpen` and `layout`, not from `visible`, so the predicate does not depend on its own
     output.

   It returns:
   - `excluded: Set<string>`: residents not placed on the fleet
   - `visitors: Set<string>`: residents shown as visitor cards

   Rules in Drawer mode:
   - A resident is a visitor when its tone is `attention`, the drawer is not open, and it is not
     `openDetailId`. The open detail is already showing its ask, so its visitor card is withheld
     until the detail closes.
   - Every other resident is excluded, including the one whose detail is open.

   In `fleet` mode nothing is excluded and the sets are empty.
5. **App wiring.**
   - Apply `excluded` in the `fleet` memo, beside `matchesSessionFilter`, before
     `orderSessions`.
   - Add one `detailSession` lookup: the session with the detail id from `visible`, or else, in
     Drawer mode, the live resident with that id from all `sessions`. Pass it to `BoardView` and
     `ConsoleView` and use it where they now call `props.sessions.find(...)` for the detail.
     Replace App's `selected = visible.find(...)` with the same lookup, so the selected-session
     actions (send, terminal, complete, kill and the rest) work on an open resident.
   - An open resident is never added to `visible`, `boardColumns` or any rail. In the Board
     drill-in, the rail shows the fleet column for the resident's tone without it, and no row is
     highlighted. In Console, no rail row is highlighted. `↑`/`↓` then move into the fleet as
     they do with nothing selected.
   - Remove visitor ids from the columns passed to `assignCardShortcuts`, so ⌘-numbers number
     only fleet sessions. The arrow keys keep `boardColumns`, which still holds visitors.
   - Add App state for the drawer: open (floating), the selected resident id, and `returnTo` for
     Escape. `residentDrawerPinned` comes from UI config.
6. **The drawer.** Create `src/web/residents/ResidentsDrawer.tsx`.

   **Floating mode:**
   - An `<Overlay as="aside">` aligned right, like `.report-panel`, 330px wide.
   - It holds the head ("Residents · N live", the `⇧H` keycap, **Pin**, close).
   - One card per live resident in `runs` order, the order the dock uses.
   - Each card has the marker chip and color, name, state dot, its `⌥N` keycap, and tags for
     state, iteration, next wake and any pause or wake reason.
   - The selected card expands into `ResidentDrawerCardBody`, which holds **Open**, **Run now**
     and **Pause** / **Resume**, reusing the dock's existing calls.
   - The footer holds profiles with **Launch** / **Launch…** through `useResidentLaunches`, and
     **Manage residents**.
   - Arrow keys move the selection and Enter opens it. Escape and a backdrop click close it,
     which `<Overlay>` provides.

   **Pinned mode:**
   - The same content rendered as a non-modal `<aside aria-label="Residents">` column beside the
     fleet layout. The Board or Console narrows instead of being covered.
   - **Unpin** writes `residentDrawerPinned: false`.

   **Edge tab:** while in Drawer mode and the drawer is closed, show a tab on the right edge with
   ⌂ and the live count (no number at zero). It turns amber while any resident's tone is
   `attention`.
7. **Routing the open controls.** In Drawer mode:
   - The `Topbar` Residents button opens the drawer instead of the dock. Keep its element, its
     `residents-btn` class and its `Residents - N live` accessible name.
   - The `⇧H` arm and the `command:residents-dock` palette entry toggle the drawer.

   In `fleet` mode all three behave exactly as today.
8. **Opening a resident.** One function, `openResidentDetail(sessionId, { fromDrawer })`:
   - Closes the floating drawer, leaving a pinned one in place.
   - Records `returnTo` only when the open came from the floating drawer. An open from the
     pinned drawer records no `returnTo`: the pinned drawer stays on screen with that resident
     still selected.
   - Calls `openSessionOnFleet`, which opens the detail where the current layout shows it:
     - **Board:** the drill-in (`selectedId` plus `boardOpen`).
     - **Console:** the detail pane (`selectedId` alone).

     In both layouts the detail reads the resident through the `detailSession` lookup from step
     5, and the resident joins no fleet list.

   It is used by the card's **Open**, by Enter on a card, by `⌥N`, and by palette results for
   live residents. Add palette entries that find a live resident by name or label, if the
   palette does not already list them.
9. **`⌥1`…`⌥9`.** In `keybindings.ts`, add `RESIDENT_SHORTCUT_CHORDS` (`alt+1`…`alt+9`) and reserve
   them in `reservedChordReason`. In App's keydown handler, add an arm before the
   `route.page !== "fleet"` return. It matches `e.altKey` and `e.code` `Digit1`…`Digit9` with no
   Meta, Ctrl or Shift, outside typing targets and when no overlay other than the drawer is open,
   and opens resident N in `runs` order, which the drawer and the dock share. It works in both
   placements: in Drawer mode through `openResidentDetail`, and in **Board and Console** mode
   through `openSessionOnFleet` directly, with no drawer return target. Either way the detail
   opens per layout: the Board drill-in in Board, the Console detail pane in Console.
10. **Escape returns to the drawer.** The Escape that leaves the detail is the one that closes
    the Board drill-in, or in Console the one that hands the reader back to the rail.
    - **Opened from the floating drawer** (`returnTo` set): that Escape reopens the floating
      drawer with the resident selected, then clears `returnTo`.
    - **Opened from the pinned drawer** (no `returnTo`): that Escape leaves the detail as usual
      and moves focus to the resident's card in the pinned drawer, which still has it selected.
      No floating drawer opens.
    - Opened by `⌥N` or the palette with the drawer closed: Escape leaves the detail as usual.
11. **Visitor card.** Pass `visitors` through `viewProps` to `BoardView`, `ConsoleView` and the
    card and rail-row components. A visitor renders as a dashed outline in the marker color with
    the chip, the name, and *Resident · opens in the drawer*. Its click and Enter call
    `openDrawerOn(sessionId)`, which opens the floating drawer with that resident selected and
    expanded, instead of the drill-in.
12. **CSS.** In `src/web/styles.css`, beside `.report-panel`:
    - `.residents-drawer`
    - `.residents-drawer-pinned`
    - `.residents-edge-tab`
    - `.resident-visitor`

    Use existing tokens: `--resident-<id>` and `--attention`.
13. **Docs.**
    - `docs/residents.md`: rewrite "Finding a resident" and "The Residents dock" for both
      placements, and add a "The Residents drawer" section.
    - `docs/ui.md`: add `⇧H`, `⇧A` and `⌥1`…`⌥9` to the keyboard table, and the Display →
      Residents setting.

## 6. Data and compatibility

- The two new UI config fields are optional on read and default to `drawer` and `false`. No
  SQLite migration, since UI config is a JSON blob in `app_config`.
- Settings backup covers them through the `ui` domain. Check that
  `test/settings-backup-coverage.test.ts` passes.
- A stored override on `alt+1`…`alt+9` is dropped on read by `isReservedChord` / `sanitize`,
  which is the existing behavior for reserved chords.

## 7. Tests and verification

**Unit tests (`node --test --import ./test/setup-state.mjs --import tsx <file>`):**
- A new `test/resident-placement.test.ts` covering every rule in step 4, in both placements,
  and the `detailSession` fallback from step 5.
- Updates to:
  - `test/ui-config-cache.test.ts`
  - `test/settings-search.test.ts`
  - `test/settings-backup-coverage.test.ts`
  - `test/route-surface-oracle.test.ts`
  - `test/keybindings.test.ts` (reserved chords, unique defaults)
  - `test/overlay-registry.test.ts`
  - `test/topbar-items.test.ts`
  - `test/palette-index.test.ts`
  - `test/residents-board.test.ts`, where the default changes what it asserts

**e2e:** a new `e2e/specs/residents-drawer.spec.ts`, using fake agents and residents launched
through `POST /api/residents/profiles` and `/launch` as `residents-needs-you.spec.ts` does. It
proves:
- With default config, no resident card on the Board or row in the Console rail.
- The top-bar button, `⇧H` and the edge tab open the drawer, and Escape and an outside click
  close it.
- Cards list live residents in marker color.
- **Open**, Enter and `⌥1` open the full detail in each layout: in Board as the drill-in, and in
  Console in the detail pane with the Board drill-in never involved. After an open from the
  floating drawer, Escape reopens it with the resident selected. After an open from the pinned
  drawer, Escape leaves the detail, focus lands on that resident's card in the pinned drawer, and
  no floating drawer (no second Residents dialog) appears.
- While a resident's detail is open, no Board column, drill-in rail row or Console rail row names
  it. That includes a resident that needs you, opened by `⌥1` with the drawer closed: it has no
  visitor card while its detail is open, and the card returns when the detail closes if the ask
  is still open.
- Pin docks the drawer, narrows the Board, and survives a reload.
- A resident made to need you through `askResident()` (`POST /mcp/reviews`) shows a visitor card
  only while the drawer is closed. The card opens the drawer on that resident, and disappears once
  the ask is resolved.
- Switching to **Board and Console** restores today's placement and the dock, live, and `⌥1`
  still opens the first resident's detail there.

Call `expectContentClearsBorder` from `e2e/fixtures/modal-inset.ts` for the floating drawer.

Update every existing resident spec that asserts Board or Console presence to set
`residentPlacement: "fleet"` through `PUT /api/ui/config`. This includes
`residents-dock.spec.ts`, `residents-dock-card.spec.ts` and `residents-needs-you.spec.ts`; check
the rest of `e2e/specs/residents-*.spec.ts`.

**Commands:** `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
`npm run test:e2e`.

## 8. Merge and exit criteria

- Source-plan acceptance criteria 1, 2, 4, 5, 6, 7 and 8 hold and are covered by the specs above.
  That includes criterion 1 while a resident's detail is open.
  Criterion 3 is met except for replies and question answers, which Phase 2 adds.
- In **Board and Console** mode, the existing resident specs still pass for today's placement,
  markers, pinning and dock. `⌥1`…`⌥9` are the mode's one addition.
- Every command above passes, and the docs match.

## 9. Downstream handoff

Phase 2 may rely on these and must not change them:
- `ResidentsDrawer.tsx`: its structure, card list and selection behavior.
- The drawer's selection state.
- `openResidentDetail` and the `detailSession` lookup.
- The placement predicate.
- The UI config fields.

Phase 2 may add content inside `ResidentDrawerCardBody`, the selected card's expanded region,
which exists for that purpose. It keeps that region's Open, Run now and Pause / Resume actions.

## 10. Cross-phase audit record

- First phase. It defines every contract in the index's "Cross-phase contracts".
- Phase 2 was checked against this file and needs only `ResidentDrawerCardBody`, the selected
  resident id, and the session object. No change was required here.
- Repair round 1 (Plan Validation run `28667a3b`): removed the rule that admitted an open
  resident into the fleet list. Step 5's `detailSession` lookup shows it in the detail pane
  instead, and a new e2e assertion checks no fleet list names it. Phase 2 needs no change.
- Repair round 2: step 9 now makes `⌥1`…`⌥9` open resident N in both placements, matching the
  source plan, with e2e coverage in Board and Console. The handoff now states that Phase 2 adds
  content inside `ResidentDrawerCardBody`.
- Repair round 3: the exit criteria and outcome now say what stays unchanged in **Board and
  Console** (placement, markers, pinning and dock), with `⌥1`…`⌥9` as its one addition.
- Repair round 4: steps 8 and 10 now separate the floating and pinned cases. Only a
  floating-drawer open sets `returnTo`; a pinned-drawer open returns focus to the pinned card, and
  the e2e spec checks that no floating drawer appears.
- Repair round 5: section 4 now describes `openSessionOnFleet` as it is, layout-aware. Steps 8
  and 9 state that a resident opens as the Board drill-in in Board and in the detail pane in
  Console, and the e2e spec covers both layouts.
- CodeRabbit review on PR #1382: step 4 takes `openDetailId` again and withholds the open
  resident's own visitor card, so a needs-you resident opened by `⌥N` with the drawer closed is
  not both the open detail and a visitor. The e2e spec covers that case.
