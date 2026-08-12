# Phase 2 - The menu, the registry, and the keys that open it

Source plan: [`plan.md`](plan.md) · Index: [`phased-plan.md`](phased-plan.md)

## Outcome

Right-click anywhere in the dashboard and get a menu. In the **desktop build that ships
today there is no context menu at all** - not even Copy - and this phase closes that hole
with the smallest target set that proves the whole chain: a live selection, an external
link, and a text field.

It also makes `window.missionDesktop.openExternal` a real caller for the first time, and
makes the menu reachable from the keyboard.

## Entry criteria and dependencies

**Direct dependency: Phase 1.** The menu's own "Copied" confirmation uses
`useCopyFeedback()` from `src/web/lib/clipboard.ts`, so the hold duration and the failure
behaviour are decided in one place rather than re-invented here.

## Scope

- `src/web/lib/context-actions.ts` - the pure target registry and resolver.
- The `ContextMenu` component and its host, mounted once in `App`.
- Targets: **any live selection**, **external link**, **text field**.
- Keyboard access: `Shift+F10` and the `ContextMenu` key.
- The `.is-desktop` no-drag allow-list entry.
- One `e2e/specs/` spec.

**Non-goals**

- **`Copy text` is not in this phase.** It strips *turn chrome*, which is a transcript
  concept; it lands in Phase 3 with the surface it clips against.
- Transcript targets (message, code, tool chip, path, timestamp) - Phase 3.
- Session card / tile / rail row targets - Phase 4.
- Diff and Files targets - deferred by decision **D3**.

## Repository findings

### Constraint 2 is resolved: do NOT join the Overlay registry

The source plan left this open. The repository answers it.

`src/web/components/Overlay.tsx` has exactly one return path, line 244:
`<div className="modal-backdrop" onClick={...}>`. There is **no opt-out prop**.
`styles.css:3738-3749` makes that `position: fixed; inset: 0; z-index: 50; background:
rgba(4,6,9,.72); backdrop-filter: blur(4px)` with `display: flex; justify-content: center`,
so the panel is a **centred flex child** - structurally hostile to `left: clientX; top: clientY`.
Joining would also set `anyOpen`, and `App.tsx:1522` (`if (overlaysRef.current.anyOpen ||
renamingId) return;`) stands the entire global handler down, which is far heavier than a menu
warrants and kills the Escape ladder at `App.tsx:1632-1661`.

The repository has already reached this conclusion in writing.
`test/overlay-registry.test.ts:89-136` maintains `UNREGISTERED_DIALOGS`, six anchored popovers
deliberately outside the registry, and records the consequence:

> All are anchored popovers, not screen-owning overlays, so they were left out of the registry
> deliberately - but the consequence is real and NOT yet fixed: while one is open, focus sits
> on a button (so the `typing` guard is false) and `anyOpen` is false, so the grid shortcuts -
> INCLUDING kill and reset - still act on the card behind the popover.

**Use the anchored-popover contract instead**, and close that gap rather than inherit it:

- Capture-phase `window` keydown, `stopImmediatePropagation()`. Not `stopPropagation` -
  `OpenInMenu.tsx:86-99` explains at length that the weaker call is "correct by the accident
  of what phase everyone else happens to have picked", and `KeyboardPanel.tsx:70` is already a
  second capture-phase `window` listener, so ordering between two of them is registration
  order and only the immediate form is deterministic.
- **While the menu is open, swallow every keydown it does not itself use.** This is the fix
  for the documented `k`/`r`/`c` gap above - a context menu is opened *on* a target with the
  operator's hands on the keyboard, so it is the surface where a stray `kill` matters most.
- Do **not** import `Overlay.tsx`: `test/overlay-registry.test.ts:158-179` then forces
  `<Overlay` + `id={OVERLAY_IDS.` and the backdrop comes with it.
- Do **not** use a literal `role="dialog"`: `test/overlay-registry.test.ts:138-156` trips on it
  unless the file is added to `UNREGISTERED_DIALOGS`. Use `role="menu"` / `role="menuitem"`,
  which is also what `OpenInMenu.tsx:164`/`:46` and `LaunchMenu.tsx:213` do.

### Keyboard access: the grammar already works, one gate does not

`src/web/lib/keybindings.ts` needs **no grammar change**. `chordFromEvent` (`:334-349`) sends
any key whose `length !== 1` down the named-key branch, so `Shift+F10` serializes to
`"shift+F10"` and `formatChord` renders `"⇧F10"` - the same path `"shift+Tab"` already ships
for `mode`. Neither `F10` nor `ContextMenu` is in `RESERVED_KEYS` (`:305-312`).

**The obstacle is `App.tsx:1610`, `if (typing) return;`.** The only bypass is
`chordHasCommandModifier` (`keybindings.ts:419-422`), which tests for `cmd`/`ctrl` -
so `chordHasCommandModifier("shift+F10")` is **false** and the chord would be eaten inside a
composer or a file editor. That is exactly where a context menu is most wanted, because that
is where `Paste` lives.

The predicate is narrower than its own justification: the rationale at `keybindings.ts:410-418`
is about chords that *type a character*, and `Shift+F10` does not. **Add a sibling predicate**
rather than widening the existing one (its truth table is pinned by
`test/keybindings.test.ts:173-184`):

```ts
/** A chord that cannot type a character, so a focused text field has no claim on it. */
export function chordIsNonTyping(chord: string): boolean;
```

covering function keys and named non-printing keys, and use it beside
`chordHasCommandModifier` at the `typing` gate.

**One action, not two.** The registry is one chord per action (`computeResolved` `:500-516`,
`findConflicts` `:582-610`); there is no alias field. So:

- Add **one** `ActionId`, `contextMenu`, with `defaultBinding: "shift+F10"`, `group: "global"`.
- Handle the dedicated `ContextMenu` key **structurally**, like `Escape` and the arrows, and
  add it to `RESERVED_KEYS`. It is the OS's key for precisely this and should not be rebindable
  to something else. Two `ACTIONS` entries for one behaviour would put two rows in the settings
  panel and two keycaps on the same control.
- Add `ContextMenu: "☰"` to `KEY_LABEL` (`keybindings.ts:381-392`), or the settings editor
  renders the literal string `"ContextMenu"` inside a `<kbd>`.

The arm must sit **above `App.tsx:1503`** (`if (route.page !== "fleet") return;`), like the
palette does - a context menu is not fleet-only.

**No shared-schema change.** `src/shared/protocol.ts:1744-1795` stores keybindings as
`z.record(z.string())` deliberately, with a comment explaining that validating the id set
there would break reading a config after an action is removed.

### The `openExternal` bridge exists and is unused

`src/preload/index.ts:12` exposes it, `src/main/index.ts:58` handles it,
`mission-desktop.d.ts:11` types it, and **no renderer code calls it**. `Open link` is its first
caller. Guard on `window.missionDesktop` (it is `undefined` in a browser tab, per
`mission-desktop.d.ts`) and fall back to `window.open(href, "_blank", "noopener")`.

## Implementation steps

1. **`src/web/lib/context-actions.ts`** - the registry, pure and DOM-only so it can be unit
   tested without a browser.

   - `ContextAction`: `{ id, label, hint?, run }` plus whatever discriminant the runner needs.
   - `ContextTarget`: `{ id, tier: "item" | "container", match, actions }`.
   - `resolveContextActions(el, ctx)`: walk tier 1 **first-match-wins in registry order**, then
     tier 2, concatenate, then dedupe.
   - **Dedupe on kind *and* payload**, not payload alone (constraint 13): `Paste` and
     `Paste as quote` share an empty payload and must both survive, while `Copy` and
     `Copy URL` on a bare autolinked URL write the same string and must collapse to one.
   - Cap at two tiers. Six items is the budget; the tests below pin it.

2. **URL detection** - constraint 7. `e.target` on a mouse event is always an *element*, so a
   text-node scan driven from it finds nothing. Use
   `document.caretPositionFromPoint(x, y)` (with `caretRangeFromPoint` as the WebKit fallback)
   and **use the returned offset**: require the URL match to contain the caret, or
   right-clicking the word "CI" in a paragraph that also holds a URL offers `Copy URL`.

3. **`ContextMenu` + host.** Portal to `document.body`, `position: fixed`, placement clamp and
   flip in the shape of `ModePicker.tsx:54-66`. `role="menu"` with an `aria-label`; rows are
   `role="menuitem"`. Dense rows per decision **D4**: label plus a right-aligned hint, ~196px
   wide. Mount the host once in `App`; components get no right-click code.

4. **Dismissal.** Outside `mousedown`, `Escape`, `resize`. **Close on `wheel`/`touchmove`, not
   on the `scroll` event** - constraint 8. A scroll dispatched one frame after the menu opens
   closes it immediately, and in the product that frame is `.transcript-log` auto-scrolling as
   a streamed turn arrives, which would slam the menu shut mid-read. Focus the first row with
   `focus({ preventScroll: true })` (constraint 9), or focusing scrolls and closes it.

5. **Selection handling.** A right-click **outside** the current selection collapses it before
   resolving, so `Copy` is never offered for text the reader is not pointing at; a right-click
   **inside** it keeps it. Compare the point against the selection's own
   `getClientRects()`.

6. **Targets for this phase.**
   - *Text field* (`textarea, input`) - first in tier 1, since a field is never inside another
     target. Its selection is its **own**: `window.getSelection()` is empty inside a field
     (constraint 11), so read `selectionStart`/`selectionEnd`, and capture them **before the
     menu takes focus**. Actions: `Cut` · `Copy` (both only with a selection) · `Paste` ·
     `Paste as quote`.
   - *External link* - `Copy` (link text) · `Copy URL` · `Open link`. Omit `Copy` when the link
     text equals the href so the duplicate collapses.
   - *Any live selection* - `Copy`.

7. **`Paste`** - decision **Q2**. Always show it; attempt `navigator.clipboard.readText()`; on
   rejection **say so and point at ⌘V** rather than failing silently. `clipboard-read` is
   granted in the Electron renderer and prompted in a browser tab (constraint 12).

8. **Confirmation.** A transient line rendered by the **host**, not the menu - the menu closes
   on activation, so a confirmation inside it dies with it. Use `useCopyFeedback` from Phase 1
   and give it `role="status"`, matching `.action-flash` (`TranscriptPanel.tsx:1008`).

9. **`styles.css`** - add the menu's class to the `.is-desktop` no-drag allow-list at
   **1438-1470** (constraint 1). A cursor-anchored menu can open at any coordinate including
   under the titlebar, and the comment at 1436-1437 says anything that can land in the bar
   belongs in the list. `test/desktop-drag-region.test.ts` covers it.

10. **Keybindings** - as described under *Repository findings*: one `contextMenu` action,
    `ContextMenu` reserved and structural, `chordIsNonTyping`, the `KEY_LABEL` entry, and the
    arm above the fleet-only gate. Opening from the keyboard anchors the menu to the focused
    element's bounding box rather than a cursor point.

## Tests and verification

**`test/context-actions.test.ts`** - the registry is pure, so this is cheap and should be
thorough: the action list per target, first-match-wins tier-1 order, the two-tier cap, and the
dedupe (`Copy`/`Copy URL` collapse on a bare URL and survive on a worded link; `Paste` and
`Paste as quote` never collapse).

**`test/keybindings.test.ts`** - this file **will fail** until updated. `:192-233` builds a
hand-maintained `producible` set from synthetic keydowns and asserts every default binding is
reachable; add `chordFromEvent(key("F10", { shift: true }))`. Also honour its adjacency
assertions - do **not** insert the new entry between `complete`/`kill` (`:392-393`),
`focus`/`handoff` (`:487-488`), or `terminal`/`agent` (`:500`). Add `chordIsNonTyping` cases
beside the `chordHasCommandModifier` table at `:173-184`.

**`test/desktop-drag-region.test.ts`** - gains the new pop class.

**`e2e/specs/context-menu.spec.ts`** - required by `AGENTS.md`, and the only layer that can
prove a right-click produced a menu whose item wrote the clipboard.

- Follow `e2e/specs/queued-turn-recall.spec.ts` for the minimal shape: dispatch → `article.card`
  → `Expand conversation` → composer → sentinel prompt → assert the turn is on screen.
- Call `settled(card)` (`e2e/fixtures/settle.ts`) **before** right-clicking; a live card
  reflows for ~1s and Playwright refuses to click an unstable box.
- Select by role: `getByRole("menu", { name: ... })` then `getByRole("menuitem")`, following
  `continue-in-terminal-mode.spec.ts:139-150`. **No `data-testid`.**
- Clipboard: `await dashboard.context().grantPermissions(["clipboard-read","clipboard-write"])`
  **inside the test** (not in the config - a global grant would weaken
  `session-interrupt.spec.ts`'s deliberate no-permissions posture), then read back with
  `navigator.clipboard.readText()`, exactly as `workflow-run-audit.spec.ts:243-250` does. A
  green label proves the promise resolved, not that anything landed.
- Cover: right-click a selection → `Copy` writes it; right-click outside the selection → no
  `Copy`; right-click a link → `Copy URL`; `Shift`+right-click → **no** custom menu
  (decision D1); `Shift+F10` opens the menu from the keyboard, including from inside the
  composer.
- Traps from `e2e/README.md:1024-1055`: never `{ exact: true }` on a button name (`<kbd>` hints
  are part of the accessible name), and never `getByText` for tooltip prose (`Tooltip` portals
  a 1x1 `.tt-desc` into `document.body`, so the locator matches twice).

Commands: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run build && npm run smoke`, then
`npm run test:e2e -- e2e/specs/context-menu.spec.ts`.

## Merge and exit criteria

- Right-click yields a menu in both builds; `Shift`+right-click yields the native one.
- The desktop build has right-click Copy and Paste for the first time.
- `Open link` opens externally through `missionDesktop.openExternal` without navigating the
  app window.
- `Shift+F10` and the `ContextMenu` key open the menu, including from inside a text field.
- The menu is in the no-drag allow-list; no grid shortcut fires while it is open.
- Unit, typecheck, lint, build, smoke, and the new e2e spec green.

## Downstream handoff

Phases 3 and 4 consume, and must not change:

- **`resolveContextActions(el, ctx)`** and the `ContextTarget` shape - they add registry
  entries, not resolver logic.
- **Tier 1 is ordered and first-match-wins.** Phase 3 inserts tool-chip and path matchers and
  must place them so a card's `dd.mono.branch` and a tool chip's detail are not claimed by the
  path matcher (constraint 10, and the ordering note in `plan.md`).
- **The two-tier cap and the six-item budget.** Phase 3 adds `Copy text` in tier 1's
  plain-selection branch specifically so a link menu does not gain a fourth container row.
- **Dedupe on kind and payload.**
- **The capture-phase key contract** and the no-drag list entry.
- The host's confirmation surface.

## Cross-phase audit record

- Authored after Phase 1. Consumes `useCopyFeedback` from it; adds no clipboard helper of its
  own and does not touch `copyText`.
- Resolves source-plan constraint 2, which `plan.md:213-216` deliberately left open, against
  `Overlay.tsx`, `test/overlay-registry.test.ts` and `OpenInMenu.tsx`. `plan.md` should be read
  as superseded on that point by this file.
- Moves `Copy text` (decision Q1) out to Phase 3, because turn chrome is a transcript concept.
  `plan.md` describes `Copy text` in tier 1's plain-selection branch; that placement is
  unchanged, only its delivery phase.
