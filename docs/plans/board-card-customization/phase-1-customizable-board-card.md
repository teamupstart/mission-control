# Phase 1: The customizable board card

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

**Settings → Display → Board card** ships: a checklist of every optional item a board card can draw,
with a live preview card that redraws as items are toggled, applied immediately to every card in every
column. The worktree joins the card as a new item.

An operator who runs one model can retire the model pill. An operator who never opens a workflow can
retire the workflow panel. An operator who lives in worktrees can put the worktree on the card, which
is what makes Phase 2 possible.

Delivers **D1**, **D3** and **D4** whole, and sets the defaults **D2** requires.

## Entry criteria and dependencies

**None.** This is the first phase. It needs only that this planning session's pull request has merged,
so `docs/plans/board-card-customization/` resolves on the default branch.

## Scope

1. `UiConfig.hiddenDisplayItems` - the persisted preference, its default, its schema field and its
   `coerce()` line.
2. `src/web/lib/board-card.ts` - the item registry, its id type and the visibility hook.
3. `src/web/lib/board-card-preview.ts` - the fixture session the preview card mounts.
4. `src/web/components/BoardCardPanel.tsx` - the panel, its checklist and its preview host.
5. `SettingsPage` mounting it; `settings-search.ts` indexing it.
6. `SessionTile` gating each optional item, and drawing the new worktree cell.
7. `RuntimeMetaRow` gaining `omit`, replacing `showEffort`.
8. Styles, documentation and tests for all of the above.

### Non-goals

- **The console detail's `PATH`/`BRANCH` band.** Phase 2 owns it. Do not add `"conversation"` entries
  to the registry here - a checkbox that does nothing is a dead surface, and P2 in the index is the
  contract that lets Phase 2 add them without restructuring anything.
- **The attention flags.** D3 pinned them on. Do not add `.tile-marks` entries to the registry.
- **`RailRow` and `BacklogCard`.** Out of scope in the source plan, for reasons stated there.
- **A `ui_config` ServerEvent.** F7. Pre-existing, and not this phase's problem.
- **Reordering, density, or a compact card variant.** Visibility only.

## Repository findings

The source plan's F1-F8 are binding; read them. These are the ones this phase must act on, plus what
the phase boundaries added.

- **F6 is the silent failure.** `src/web/lib/uiCache.ts` rebuilds the cached config field by field,
  never a spread. A key added to `UI_CONFIG_DEFAULTS` and `UiConfigSchema` but **not** to `coerce()`
  type-checks, round-trips through the daemon correctly, and resets on every cold paint. Add the line.
- **F5 - `RuntimeMetaRow` is shared.** `session-bits.tsx:1566-1621`, mounted by both
  `SessionTile.tsx:307` and `ConsoleDetail.tsx:488`. A card preference must not reach the console
  detail. The component already has `showEffort` for exactly this reason
  (`session-bits.tsx:1569,1573-1574`); fold it into `omit` rather than growing a third and fourth
  boolean, and widen the early return at `:1577` to "nothing left to draw". Do **not** re-inline the
  pills in the tile - `test/session-leaf-parity.test.ts` exists to catch that.
- **F2 - the branch cell has a fallback.** `SessionTile.tsx:321` renders
  `session.gitBranch ?? session.nameSource`. Hiding "branch" hides the branch; a session with no
  branch still shows its name source exactly as it does today. `.tile-branch` is `flex: 1` with
  ellipsis (`styles.css:24606-24614`), so the new worktree cell shares that row's budget and needs its
  own `min-width: 0`.
- **F2 - print the leaf, not the path.** A pool worktree path is sixty characters of bookkeeping;
  `TranscriptPanel.tsx:376-380` already says so and prints only the leaf for that reason. The card
  prints the leaf with the full `session.cwd` in a `Tooltip`. `shortenCwd` (`format.ts:254-263`) is
  the console detail's answer and is too long for `.tile-foot`.
- **P3 - there is no fixture session in `src/web`.** `test/helpers/session-fixture.ts` is in `test/`
  and the bundle cannot import it. The Tour spotlights real tiles rather than a fixture, and demo
  mode seeds the daemon, not the browser. The preview needs a new fixture, and it must populate
  **every** registry item or a checkbox will look broken.
- **`useSyncExternalStore` is SSR-safe here.** `uiConfig.ts:100` passes `getSnapshot` as the server
  snapshot, so the existing `renderToStaticMarkup` tests keep working and read the shipped defaults.
- **The settings index is tested.** `test/settings-search.test.ts` fails on a `SETTINGS_CONTROLS`
  anchor with no rendered control, and `test/settings-sidebar-render.test.ts` checks anchor uniqueness
  and category reachability. Use `kind: "jump"` (as `layout` does), not `"toggle"` - a checklist has
  no single boolean for the palette to flip, and `"toggle"` additionally requires an `App.tsx`
  binding.

## Implementation

In execution order.

### 1. The contract

- `src/shared/protocol.ts` - add `hiddenDisplayItems: []` to `UI_CONFIG_DEFAULTS` and
  `hiddenDisplayItems: z.array(z.string().min(1)).default([])` to `UiConfigSchema`. Follow
  `trustStaged` (`protocol.ts`), which is the existing precedent for a plain string array owned whole
  by one panel. Comment why it is a hidden-list rather than a booleans map, and why the ids are not
  validated here - the reasoning is in `plan.md` under "The stored shape", and it is the same
  deliberate looseness `keybindings: z.record(z.string())` already documents.

  **The name is `hiddenDisplayItems`, not `boardCardHidden`** (index P1). One array serves both the
  card and, in Phase 2, the console detail band. The key is persisted on operators' machines, so this
  name is effectively permanent.

- `src/web/lib/uiCache.ts` - add the `coerce()` line. A fresh array, like `trustStaged`, so the panel
  can build its next patch without mutating a shared literal.

### 2. The registry

`src/web/lib/board-card.ts` (new). Web-only, not `src/shared/` - the daemon stores the ids opaquely
and has no use for prose it never shows, which is the same split as `LAYOUT_MODES` (shared) versus
`LAYOUTS` (web).

```ts
export type DisplayItemGroup = "card" | "conversation";
export type DisplayItemId = (typeof DISPLAY_ITEMS)[number]["id"];
export const DISPLAY_ITEMS = [ /* { id, group, label, description } */ ] as const;
export function useDisplayItems(): (id: DisplayItemId) => boolean;
```

The `group` field ships in this phase with **only `"card"` entries** (index P2). `"conversation"` is
declared in the type and documented as Phase 2's, so Phase 2 appends entries rather than restructuring
the panel.

Each `description` says **what unchecking loses**, not what the item is. That is the difference
between a label an operator can act on and one they cannot.

The card entries, and where each is drawn today:

| id | Item | Site |
| --- | --- | --- |
| `goal` | Goal line | `SessionTile.tsx:204` |
| `activity` | Live activity ticker | `:212-219` |
| `workflow` | Workflow peek / ladder | `:226-251` |
| `model` | Model pill | `session-bits.tsx:1585`, via `omit` |
| `context` | Context meter | `session-bits.tsx:1607`, via `omit` |
| `effort` | Effort picker | `SessionTile.tsx:308` |
| `mode` | Permission mode picker | `:316` |
| `cost` | Cost chip | `:317` |
| `branch` | Branch | `:321` |
| `worktree` | Worktree leaf (new) | `.tile-foot` |
| `lastSeen` | Elapsed / last seen | `:322-324` |

### 3. `RuntimeMetaRow`

`src/web/components/session-bits.tsx` - replace `showEffort?: boolean` with
`omit?: ReadonlySet<"model" | "effort" | "context">`. Update the one existing call site
(`SessionTile.tsx:307`, currently `showEffort={false}`) and leave `ConsoleDetail.tsx:488` passing
nothing, which must keep meaning "draw everything". Widen the early return so the row draws nothing
when every part is omitted or absent.

### 4. The tile

`src/web/components/layouts/SessionTile.tsx` - call `useDisplayItems()` once and gate each optional
item. Add the worktree cell to `.tile-foot`: the leaf of `session.cwd`, in a `Tooltip` carrying the
full path, rendering nothing when `session.cwd` is null.

Do not gate the tone spine, the session name and its stretched open button, the agent dot, the `held`
tag or the drag drop-hint. `SessionTile.tsx:192-194` explains why `held` in particular has to stay.

### 5. The panel

`src/web/components/BoardCardPanel.tsx` (new). Follow `AppearancePanel.tsx` for the
`.settings-section` / `.settings-toggle` shape and `LayoutPanel.tsx` for a panel that renders from a
registry. One section per distinct `group` present in the registry (P2). Carries
`data-anchor="display/board-card"`.

Include the copy F4 requires: hiding a fact does not always reclaim height in the conversation,
because the band it shares is also home to the task chip. Say it plainly rather than promising
unconditionally.

`src/web/lib/board-card-preview.ts` (new) - the fixture `Session`. It must populate every registry
item, or toggling one does nothing visible. Mount the **real** `SessionTile` against it, not a
hand-drawn mock: a mock is a second source of truth for what a card looks like, which is the thing
this feature exists to avoid. Render it inert - its open button and its interactive pickers must not
navigate or dispatch, because the session does not exist.

### 6. Wiring

- `src/web/components/SettingsPage.tsx` - import and mount in `case "display"`, after
  `AppearancePanel`. The stacking comment at `:488-500` explains the order; extend it rather than
  replacing it.
- `src/web/lib/settings-search.ts` - one `SETTINGS_CONTROLS` entry, `category: "display"`,
  `anchor: "display/board-card"`, `kind: "jump"`. Keywords should include the words an operator who
  has not read the label would type: "card", "tile", "hide", "show", "customize", "worktree",
  "branch", "model", "cost".

### 7. Styles

`src/web/styles.css` - the panel's checklist and preview host, and the tile's new worktree cell.
`.tile-foot` is a flex row where `.tile-branch` is `flex: 1` with ellipsis (`:24599-24619`); the
worktree cell shares that budget and needs `min-width: 0` so neither cell can push the other out.

## Data, API and compatibility

**No migration, no route, no `ServerEvent`.** `app_config` is a KV of JSON blobs (`db.ts:920`) and
`UiConfigSchema` is not `.strict()`, so a new field costs a default, a schema line and the `coerce()`
line. This is written down at `docs/agent-guides/change-contracts.md:36`.

**Forward compatibility:** an id in a stored array that this build does not know is ignored, and an
item this build ships that the array does not mention is visible. Both directions are deliberate. A
renamed id lapses to *visible*, which is the safe failure direction.

**Backward compatibility (D2):** the shipped default is `[]`, so an existing install renders exactly
what it rendered before. A profile that has never opened the panel must produce a byte-identical card.

## Tests and verification

`test/`:

- **`board-card-items.test.ts`** (new) - the source scan. Every optional conditional in
  `SessionTile.tsx` is gated on a registry id, and every registry id is reachable from
  `BoardCardPanel`. This is what stops the next card item shipping un-toggleable, and it is the direct
  analogue of the topbar control registries.
- `board-tile-render.test.ts` - extended. An item hidden leaves no trace in the markup; the defaults
  render exactly what ships today.
- `ui-config-cache.test.ts` - the new key survives `coerce()` (F6). Assert the reset-on-cold-paint
  failure specifically, since that is the mode this line prevents.
- `settings-search.test.ts` and `settings-sidebar-render.test.ts` - satisfied by the new anchor;
  should need no edit, and needing one is a signal.
- `session-leaf-parity.test.ts`, `layout-parity.test.ts` - **unmodified and passing.** This is the
  assertion that the `omit` refactor did not turn into an inlined copy.

`e2e/`:

- **`board-card-customization.spec.ts`** (new) - open Settings → Display, uncheck an item, return to
  the board, assert it is gone from every card, re-check it, assert it is back. Select by role and
  label; **no `data-testid`** (repository rule).
- **`board-card-worktree.spec.ts`** (new) - turning the worktree item on puts the leaf on the card and
  hovering it shows the full path.
- **`board-card-preview.spec.ts`** (new) - toggling an item changes the preview card in place without
  leaving Settings, and the preview's controls do not navigate.

Commands: `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` followed by
`npm run test:e2e` (the e2e suite drives the built dashboard and needs the build first).

## Documentation

- `docs/ui.md` - the Board section and the Layout section.
- `docs/skills-and-settings.md` - the Settings chapter's Display category.
- `docs/agent-guides/change-contracts.md` - the new contract line: **a new board card item is added to
  the registry, or it ships un-toggleable.**
- Note F7 (no cross-tab broadcast) in one line, so the first person to notice does not file it as a
  defect in this feature.

## Merge and exit criteria

- Every listed test passes; `typecheck`, `lint`, `build` and the e2e suite are green.
- A profile with no stored config renders a board card byte-identical to the previous release (D2).
- `session-leaf-parity.test.ts` and `layout-parity.test.ts` are unmodified.
- The panel's copy states F4's condition on reclaimed height.
- Documentation updated in the same change.

## Downstream handoff

Phase 2 may rely on, and must not change:

| Contract | Shape |
| --- | --- |
| Config key | `UiConfig.hiddenDisplayItems: string[]` - one array for both groups |
| Registry entry | `{ id, group: "card" \| "conversation", label, description }` |
| Panel sectioning | One section per distinct `group` found in the registry |
| Visibility hook | `useDisplayItems(): (id: DisplayItemId) => boolean` |
| Default | `[]` - everything visible |
| `RuntimeMetaRow` | `omit?: ReadonlySet<"model" \| "effort" \| "context">` |

Phase 2 adds two `group: "conversation"` entries and reads the same hook from `ConsoleDetail`. It adds
no config key, no schema field and no route.

## Cross-phase audit record

- **Against the source plan:** the config key is renamed from the plan's `boardCardHidden` to
  `hiddenDisplayItems` (index P1), because Phase 2's entries share the array and the key is persisted.
  Recorded rather than silently applied.
- **Against Phase 2:** the `group` field and the panel's per-group sectioning are introduced here,
  unpopulated for `"conversation"`, so Phase 2 appends rather than restructures (index P2). Verified
  that this leaves no dead surface in Phase 1: the panel renders exactly one section, because exactly
  one group is present.
