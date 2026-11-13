# Phase 3: Display choice with chip, popover and Agents tab

Source: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## Outcome

Settings › Display › Board card gains a Background sub-agents radio beside Task type with two values, Chip and popover and Nested sub-cards (default). Chip and popover swaps the sub-cards for a chip in the tile's flags that opens the agent list, and the tray for an Agents rail tab, at once and without a reload.

## Entry and scope

Entry: Phase 2 merged. In: the persisted key, picker entry, preview fixture, settings search, SubagentChip and popover, three-way rail, docs/ui.md and docs/skills-and-settings.md. Out: an Off value, the top-bar count.

## Repository findings

- Choice keys follow taskKindCard (commit 4b9ea92ec): protocol.ts tuple, default and schema field (3964, 4155, 4283); app-config-entries.ts uiFields (268-295, compile-enforced); uiCache.ts coerce (148-161); board-card.ts DisplayChoiceValues, copy and DISPLAY_CHOICES (447, 420, 465); test/fixtures/route-surface.json; settings-search.ts board-card entry (216-265).
- ChoicePicker is generic; the preview stage is inert, so the popover never opens there.
- SessionToolbarMenu is portalled with Escape and outside-click dismissal, but is role menu with an icon trigger.
- ConversationActivity: ActivityTab is activity or yours (53), and a yoursTab boolean drives about ten branches (89-355); the wide rail is 244 px (styles.css:9280).

## Steps

1. UiConfig.backgroundAgentsStyle, "nested" or "chip", default "nested", parsed with .catch to the default; uiFields setting; coerce; route-surface snapshot.
2. DISPLAY_CHOICES entry, group card, after Task type, with the plan's copy.
3. Sample agents on previewSession so both styles show in the preview.
4. SubagentChip in .tile-marks: "⑂ N agents" with one pip per agent, opening a non-modal portalled popover named Background agents with the tree's rows; generalise SessionToolbarMenu's trigger or add a small popover, not role menu.
5. ConversationActivity: a three-way tab; Agents exists only in chip style; switching to nested while on Agents falls back to Activity; the collapsed strip names the tab.
6. SessionTile and TranscriptPanel read the key through useDisplayChoice to pick chip or tree, Agents tab or tray.
7. Search keywords on the board-card and conversation-header entries.

## Tests

- Unit: key parse and fallback, coerce, backup coverage, picker entry, rail and chip markup.
- Electron: three rail tabs fit 244 px in board and terminal fonts.
- e2e/specs/background-agents-display-choice.spec.ts: two options with Nested selected; Chip and popover shows the chip, opens the popover, shows the Agents tab and hides tray and sub-cards without reload; switching back restores them. Add the picker to PICKERS in display-choice-scroll.spec.ts.
- npm run typecheck, lint, focused tests, build, test:e2e.

## Exit and handoff

Merged with the specs green. The key name and values are persisted and final.

## Audit record

Adds the only new persisted key; consumes Phase 1 and 2 components unchanged.
