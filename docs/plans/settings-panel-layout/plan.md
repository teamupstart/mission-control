# Settings panel layout

Restructure `SettingsModal` so settings live in navigable categories instead of one long
scroll - and so Skills stops being buried at the bottom.

> **Decided:** Option A (two-pane sidebar), **structure-only** scope for the first PR.
> Migrating the Alerts and Foreman bars into the panel is deferred follow-up.

## Problem

`SettingsModal` renders a single scrolling column (`.settings-body`,
`max-height: 74vh; overflow: auto`). Keyboard shortcuts fill most of the viewport, and
**Skills is the last thing in the scroll** - you have to scroll past every shortcut to
reach it. `SkillsPanel` is just a second `.settings-section` stacked under the first,
divided by a `border-top`.

This does not scale. The app already has settings-shaped state living *outside* the modal
that are natural future categories:

- **Notifications / alerts** - `useAlertSettings` (desktop notifications, sound, AFK,
  digest interval), today surfaced in the top `AlertBar`.
- **Foreman** - the automation controls in `ForemanBar`.
- Likely later: **Appearance**, **General**, per-agent defaults.

Every category added to today's structure makes the scroll longer and pushes the ones
below it further out of sight. We need a structure where adding a category is adding a
peer, not lengthening a scroll.

## Constraints

- Pure front-end reorg. No change to how settings persist (keybindings in localStorage,
  skills through the daemon, alerts in localStorage). The state hooks stay as they are.
- Keep everything that works: `useKeybindings`, `SkillsPanel` (with its master toggle,
  `fieldset disabled` cascade, and async error path), Esc-to-close, the capture listener.
- Sections keep their existing internal markup (`.kb-row`, `.settings-group`, badges).
  The change is the container that *arranges* sections, not the sections themselves.
- Reached from the topbar gear and the native `⌘,` menu - both just open the modal.

## Options

### Option A - Two-pane (sidebar + detail)  ·  recommended

A category rail down the left, the selected category's content on the right. Only the
active category renders; each pane scrolls on its own, so no category is ever "below" the
others. Widen the modal to ~780px.

```
┌───────────────────────────────────────────────┐
│ Settings                                    ✕  │
├──────────────┬────────────────────────────────┤
│ ⌨  Keyboard  │  Keyboard shortcuts            │
│ ✦  Skills  ◄─┤                                │
│ 🔔 Notifs    │  Anywhere                       │
│ 🤖 Foreman   │   [ New session ]      ⌘N       │
│              │   [ Focus search ]     /        │
│              │  Selected session               │
│              │   [ Open logs ]        ⌘L       │
│              │   ...                           │
└──────────────┴────────────────────────────────┘
```

- **Scales cleanly** - a new category is one rail entry + one panel, nothing else moves.
- **Skills is a peer**, one click from open, never scrolled past.
- Matches the mental model people already have (macOS System Settings, VS Code).
- Cost: widen the modal, add a rail + active-tab state, a responsive rule to collapse the
  rail to a top strip on a narrow window. Most CSS of the three.

### Option B - Top tabs

A horizontal tab strip under the header; one panel visible at a time. Keeps the modal
narrow (~600px).

```
┌───────────────────────────────────────────────┐
│ Settings                                    ✕  │
├───────────────────────────────────────────────┤
│  Keyboard │ Skills │ Notifications │ Foreman   │
├───────────────────────────────────────────────┤
│  Skills                                        │
│  [x] Enable Mission Control skills             │
│   /deep-research           [toggle]            │
│   /no-mistakes             [toggle]            │
└───────────────────────────────────────────────┘
```

- Lighter change; familiar; stays narrow.
- Skills is a peer tab, not a scroll target.
- Cost: tabs crowd and wrap once categories pass ~5-6, and there's little room for a
  category description. Scales worse horizontally than the rail scales vertically.

### Option C - Accordion (collapsible sections)

Keep the single column, but make each section a collapsible disclosure; only one open at a
time. Smallest change, no width change.

```
┌───────────────────────────────────────────────┐
│ Settings                                    ✕  │
├───────────────────────────────────────────────┤
│  ▸ Keyboard shortcuts                          │
│  ▾ Skills                                      │
│      [x] Enable Mission Control skills         │
│       /deep-research        [toggle]           │
│  ▸ Notifications                               │
└───────────────────────────────────────────────┘
```

- Smallest diff; every category visible as a header at once; no layout rewrite.
- Cost: an open section is still a scroll, nested inside the modal scroll; only partly
  solves "buried" (Skills' *header* is visible, its content still scrolls). Feels least
  like a real settings surface as categories grow.

## Recommendation

**Option A.** It's the only one that scales to the categories already waiting (alerts,
foreman) and beyond without degrading, and it makes Skills a first-class destination
rather than the tail of a scroll. B is a reasonable lighter step if we expect to stay at
3-4 categories; C is the least work but the least durable.

## Scope of the first change

Two ways to size the first PR:

1. **Structure only** - build the chosen container, move the existing Keyboard and Skills
   sections into it, leave `AlertBar` / `ForemanBar` where they are. Smallest, lowest
   risk; migrating the bars becomes follow-up.
2. **Structure + migrate the bars** - also fold Notifications (`useAlertSettings`) and
   Foreman into the new panel as categories, consolidating settings into one place and
   thinning the topbar. Larger, but delivers the full payoff in one step.

## Implementation sketch (Option A, structure only)

- `SettingsModal` holds `active` category state; renders a `<nav>` rail of categories and
  the active category's panel.
- Extract a `CATEGORIES` list: `{ id, label, icon, render }`. Keyboard and Skills each
  become a `render`. Adding a category later is appending to this list.
- The Keyboard block moves into its own `KeyboardPanel` component (today it's inline in
  `SettingsModal`); `SkillsPanel` already stands alone.
- Recording/capture and Esc logic stay in `SettingsModal` (Esc still closes when not
  recording; the capture listener is unchanged).
- CSS: `.settings-modal` widens; add `.settings-nav` (rail) + `.settings-pane`; a
  `max-width` media query collapses the rail to a top strip. Section styles unchanged.

## Testing

- Render test (`react-dom/server`, matching the repo's `*-render.test.ts` convention):
  the rail lists every category; switching `active` swaps the panel; Skills is reachable
  without scrolling the Keyboard content.
- Keep the keybinding capture/reset behavior verified after the extraction.

## Out of scope

- Any change to how settings persist or to the state hooks.
- Search-across-settings (a filter box) - revisit if the category count gets large.
