# Phase 3 - Settings → Dispatch, the durable home

## Outcome

The guided-dispatch preference gets a permanent, findable home: a **Dispatch** category in
Settings with the toggle in it, indexed so ⌘K finds and flips it by name.

Until now the only way to reach the preference is the toggle in the dispatch modal's header,
which is discoverable only if you are already dispatching. This phase makes it something you can
look up.

## Entry criteria and dependencies

- Direct prerequisite: **Phase 2**.
- Inherited contracts: `useGuidedDispatch()` (Phase 1) and a preference that already changes
  behaviour (Phase 2). Landing this before Phase 2 would ship a toggle that toggles nothing.

## Scope

1. A `dispatch` category in the settings registry.
2. A `DispatchSettingsPanel` rendering the toggle.
3. The `renderCategory` case.
4. A `SETTINGS_CONTROLS` entry and its ⌘K runtime binding.
5. The tests the category registry obliges, and one e2e spec.

### Non-goals

- No change to the guided pass itself, to `DispatchModal.tsx`, or to any dispatch behaviour.
- No new preferences. One toggle.
- The shipped default stays `false`. Phase 5.
- Does not remove the modal header toggle - both surfaces are wanted.

## Repository findings

`SettingsPage.tsx` holds **no** list of categories. The single source of truth is
`SETTINGS_CATEGORIES` in `src/web/lib/settings-registry.ts:90`, a twelve-entry
`as const satisfies` array; the rail, the router, the ⌘K panel rows and the tablist are all
derived from it. Adding a category therefore costs two edits and a pile of obligations:

- **The entry must sit contiguously within its group**, because the arrow keys walk the flat
  array while the rail draws group by group. `test/settings-sidebar-render.test.ts:134-139` pins
  it. Group `screen` currently holds `display` then `keyboard`, so a third `screen` category
  goes immediately after `keyboard`.
- **A panel component and a `renderCategory` case** (`SettingsPage.tsx:466`). The switch is
  exhaustive over `SettingsCategoryId` with no `default`, so omitting it is a type error.
- **The panel must render under a static render with no props and no effects.**
  `test/settings-search.test.ts:76-84` renders `SettingsPage` once per category with only
  `category, onNavigate, onLeave, foreman, cost, llm, layout, onLayoutChange, settingsStatus`.
  This is fine here: `useUiConfig()` is a synchronous module store, unlike the daemon-backed
  panels that must render disabled-but-present until their poll lands.
- **Every category must contribute at least one `data-anchor`** rendered inside its own panel
  (`settings-sidebar-render.test.ts:184-203`) **and at least one indexed control**
  (`settings-search.test.ts:116-121`). The single toggle satisfies both.
- Any `<svg>` in the new panel must declare `width` and `height`
  (`settings-sidebar-render.test.ts:248`).

`SETTINGS_CONTROLS` (`src/web/lib/settings-search.ts:92`) requires `id`, `label`,
`description`, `category`, `anchor`, `keywords`, `kind`. The anchor must be
`"<category>/<slug>"` **and its prefix must equal `category`**, enforced at
`settings-search.test.ts:86-96`. A non-risky `kind: "toggle"` is automatically a member of
`BINDABLE_CONTROL_IDS` (`settings-search.ts:397-399`), which is asserted to be exactly the
non-risky toggles - so it needs no test edit, but it silently degrades to a plain jump unless a
runtime source is also wired in `buildSettingsBindings` (`settings-search.ts:431-449`) and
`App.tsx:626-637`. `richText` is the worked example of a browser-local toggle doing this.

The canonical toggle markup for a browser-local `UiConfig` boolean is the `settings-toggle`
label wrapping a `Tooltip`-wrapped checkbox plus a `settings-toggle-text` block -
`AppearancePanel.tsx:16-27` and `KeyboardPanel.tsx:99-119`.

### The placement decision, and how to overturn it

The approved plan chose **Settings → Dispatch**. The repository shows this is the most expensive
of the three surfaces, not the cheapest as the plan assumed - hence its own phase.

It is kept because `UiConfig` booleans live under browser-scope categories, and neither existing
one fits: `display` is "how the dashboard arranges sessions, and how transcripts are drawn", and
`keyboard` is "rebind any shortcut". A dispatch preference is neither.

The cheaper alternative, if a reviewer prefers it: fold the toggle into the existing
**`harnesses`** category, whose blurb is already "Defaults each agent is dispatched with", whose
keywords already include `dispatch`, and which already owns the one other dispatch-wide boolean
(`harnesses/auto-mode`). The cost is a scope mismatch - that category is `scope: "machine"` and
its other controls are daemon-backed, so one card would write to `UiConfig` while its neighbours
write to the harness config. Taking this route deletes step 1 and step 3 below and changes the
anchor to `harnesses/guided-dispatch`; nothing else in this plan moves, because no other phase
depends on the category id except Phase 5's documentation.

## Implementation steps

1. **Registry entry** in `src/web/lib/settings-registry.ts`, immediately after `keyboard` so it
   stays contiguous within the `screen` group: `id: "dispatch"`, a label, an icon glyph that no
   existing category uses (`⌘` is Workflows, `⚙` Harnesses, `⌨` Keyboard), a blurb naming what
   the category is for, `group: "screen"`, `scope: "browser"`, and keywords covering *guided*,
   *wizard*, *dispatch*, *keyboard*, *steps*.

2. **`src/web/components/DispatchSettingsPanel.tsx`** - a `settings-toggle` label with
   `data-anchor="dispatch/guided"`, a `Tooltip`-wrapped checkbox bound to `useGuidedDispatch()`,
   and label plus description text. The description should say what the pass asks and that
   <kbd>⇥</kbd> leaves it, because this is the copy someone reads when deciding whether to turn
   it off.

3. **`renderCategory` case** in `SettingsPage.tsx`, mounting the panel.

4. **`SETTINGS_CONTROLS` entry**: `id: "guided-dispatch"`, `category: "dispatch"`,
   `anchor: "dispatch/guided"`, `kind: "toggle"`, with a description matching the panel's and
   keywords a person would actually type.

5. **⌘K runtime binding** - add the source to `buildSettingsBindings` and pass it from
   `App.tsx`, following `richText`. Without this the palette row jumps to the panel instead of
   flipping in place, which is legal but worse.

## Data, API and compatibility

None. No route, schema or migration change. Adding a category is browser-only; the hash route
`#/settings/dispatch` validates through the same `isSettingsCategory()` with no router edit.

## Tests and verification

Most of the obligation is discharged by tests that already enumerate the registry and will
simply start covering the new member: `settings-sidebar-render`, `settings-route`,
`palette-index`, `settings-search`. Run them and satisfy what they ask rather than adding
parallel assertions.

Add:

- an assertion that the panel renders its anchor and its toggle under the static render harness
  (extend the existing settings render coverage rather than adding a file);
- **`e2e/`**: from a fresh dashboard, reach Settings → Dispatch, flip the toggle on, open the
  dispatch modal, and see the guided pass run - then flip it off and see today's form. This is
  the only assertion that proves the panel is wired to the same preference the modal reads, and
  it is exactly the kind of click-to-route-to-DOM claim `e2e/` exists for. Extend an existing
  settings spec if one fits; otherwise a small new file.

Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- All commands pass, including the four registry-enumerating test files with no edits that
  weaken them.
- Settings shows **Dispatch** in the *This screen* group, after Keyboard.
- ⌘K finds "guided" by name and flips it in place without navigating.
- `#/settings/dispatch` deep-links.
- The modal header toggle still works and agrees with the panel.

## Downstream handoff

Later phases may rely on the category id `dispatch` and the anchor prefix `dispatch/`. Phase 5's
documentation names that path.

Later phases must not rename either without updating Phase 5's docs in the same change.

## Cross-phase audit record

- **Against Phase 1.** Consumes `useGuidedDispatch()` unchanged.
- **Against Phase 2.** Depends on it only for the preference having an effect; touches none of
  its files. Verified disjoint: this phase owns `settings-registry.ts`, `SettingsPage.tsx`, the
  new panel, `settings-search.ts` and `App.tsx`; Phase 4 owns `DispatchModal.tsx`,
  `RepoCombobox.tsx` and the dispatch specs. The two may merge in either order.
- `src/web/styles.css` is the one file both this phase and Phase 4 could touch. This phase should
  need no new CSS at all - reuse `settings-toggle` - which removes the overlap rather than
  managing it.
- Recorded the alternative placement (fold into `harnesses`) with its exact cost, because the
  repository disproved the plan's assumption that this was the cheap surface. Overturning it
  changes this phase only.
