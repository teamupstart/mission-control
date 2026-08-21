# Board card customization - phased implementation

Source plan: [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html)).

Two phases, serial. Phase 1 delivers the customizable board card and the Settings panel that drives
it. Phase 2 spends the new mechanism on the console detail's `PATH`/`BRANCH` band, which is the half
of the request that buys vertical space back.

## Incorporated human decisions

Selected during the plan review and carried into the phases as requirements:

| | Decision | Owned by |
| --- | --- | --- |
| **D1** | "Worktree selector" is a visibility checkbox, not a control that re-points a worktree | Phase 1 |
| **D2** | Defaults preserve today's rendering exactly; the operator opts in | Phase 1 sets the defaults; Phase 2 inherits them |
| **D3** | The attention flags in `.tile-marks` stay always on and are not in the registry | Phase 1 |
| **D4** | The panel carries a live preview card that redraws as items are toggled | Phase 1 |

## Investigated findings that changed the decomposition

The source plan's findings F1-F8 stand and are not repeated here. Four things surfaced while drawing
the phase boundaries, and each changes an artifact the source plan named.

### P1 - The config key is not `boardCardHidden`

The source plan proposed `boardCardHidden`. Phase boundaries disproved the name: **one array serves
both groups**. Phase 2's two conversation entries are ids in the same list, which is what lets Phase 2
ship without touching `src/shared/protocol.ts`, `uiCache.ts` or any route at all.

A key called `boardCardHidden` holding `detail-path` would be a lie on operators' machines, and this
key is persisted - renaming it later orphans everyone's choices. **The key is `hiddenDisplayItems`**,
which is what it is: the items the Display category has been told not to draw. Phase 1 owns the name
and Phase 2 may not change it.

### P2 - The registry needs its `group` field in Phase 1, populated only by Phase 1

If Phase 1 shipped all thirteen entries, its panel would draw two checkboxes that do nothing, which is
a dead surface. If Phase 1 shipped no `group` field, Phase 2 would have to restructure the panel to
introduce sections.

So the entry type carries `group: "card" | "conversation"` from Phase 1, with **only `"card"` entries
present**, and the panel renders one section per distinct group it finds in the registry. Phase 2 then
appends two entries and its section appears with no panel restructuring. This is the single most
important cross-phase contract and is stated in both phase files.

### P3 - The preview card needs a fixture `Session` that does not exist anywhere in `src/web`

`test/helpers/session-fixture.ts` is the only session fixture in the repository and it is in
`test/`, which the web bundle cannot import. The Tour has no fixture session either - it spotlights
real tiles (`src/web/tour/target-registry.ts`). Demo mode seeds a fleet in the daemon, not in the
browser.

So D4's preview needs a new fixture in `src/web`, and it must populate **every** optional item, or
toggling an item the fixture lacks does nothing visible and reads as a broken checkbox. This is Phase
1 work and is sized into it.

### P4 - Phase 2 touches no shared contract, which is why it is a separate merge unit rather than a risk

Given P1 and P2, Phase 2's diff is confined to `ConsoleDetail.tsx`, `board-card.ts` (two appended
entries), `styles.css` and its tests. It shares no file with Phase 1's riskiest change
(`session-bits.tsx`), and it is independently revertible: if the band's render guard proves wrong, the
revert gives back the conversation band without giving back card customization.

## Sizing

**Estimate: 450-650 gross non-test implementation lines**, most likely ~550. Counted as production
lines added or materially changed, excluding `test/` and `e2e/`, and including this repository's
comment density, which is high by policy and is a real part of writing a file here.

| Area | Lines | Phase |
| --- | --- | --- |
| `src/shared/protocol.ts` - default + schema field | ~15 | 1 |
| `src/web/lib/uiCache.ts` - the `coerce()` line (F6) | ~5 | 1 |
| `src/web/lib/board-card.ts` - registry, ids, hook | ~130 | 1 |
| `src/web/lib/board-card-preview.ts` - the fixture session (P3) | ~45 | 1 |
| `src/web/components/BoardCardPanel.tsx` - checklist + preview host | ~150 | 1 |
| `src/web/components/SettingsPage.tsx` - import and mount | ~5 | 1 |
| `src/web/lib/settings-search.ts` - the `SETTINGS_CONTROLS` entry | ~14 | 1 |
| `src/web/components/layouts/SessionTile.tsx` - gating + worktree item | ~55 | 1 |
| `src/web/components/session-bits.tsx` - `RuntimeMetaRow` `omit` (F5) | ~25 | 1 |
| `src/web/styles.css` - panel, preview, tile worktree cell | ~80 | 1 |
| `src/web/components/layouts/ConsoleDetail.tsx` - optional cells + band guard | ~30 | 2 |
| `src/web/lib/board-card.ts` - two conversation entries | ~15 | 2 |
| `src/web/styles.css` - band guard fallout | ~15 | 2 |

Phase 1 ≈ 420-500 lines. Phase 2 ≈ 60-100 lines.

### Why two phases and not one

The estimate is well above the 200-line one-shot threshold, so the question is whether a second merge
boundary earns itself. It does, on three grounds:

1. **Size.** Combined, this is ~550 production lines across nine files plus six `test/` files and four
   `e2e/` specs in a single pull request. That is past what reviews well as one unit.
2. **Different failure modes.** Phase 1's risk is the shared `RuntimeMetaRow` and the parity tests
   that exist to stop the tile, rail and detail drifting (F5, F8). Phase 2's risk is the three live
   e2e assertions that read `.detail-sub` (F3) and the band's render guard. Mixing them means a
   revert for either reason gives back both.
3. **Independent value.** Phase 1 alone is a shipped, complete feature - the operator can customize
   their cards, including putting the worktree on them. Phase 2 is the payoff that fact enables, and
   is worth reviewing against its own measured claim.

### Why not three

Splitting the live preview card (D4) into its own phase was considered and rejected. A panel that
ships without its preview is a half-delivered decision, and the preview is part of the panel's job
rather than an enhancement to it. The skill's rule against small enhancement phases applies directly.

Splitting the contract (`protocol.ts` + `uiCache.ts` + registry) from its consumers was also
rejected: a config key nothing reads and no panel writes is a dead surface, which is exactly the
vertical-slice rule.

## Phases

| # | Phase | File | Direct prerequisites |
| --- | --- | --- | --- |
| 1 | The customizable board card | [`phase-1-customizable-board-card.md`](phase-1-customizable-board-card.md) | none |
| 2 | The conversation band becomes optional | [`phase-2-optional-conversation-band.md`](phase-2-optional-conversation-band.md) | Phase 1 |

## Dependency graph

```mermaid
graph LR
  P0[Planning session PR<br/>publishes these artifacts] --> P1[Phase 1<br/>Customizable board card]
  P1 --> P2[Phase 2<br/>Optional conversation band]
```

**Concurrency:** none. Phase 2 consumes the registry, the config key, the hook and the panel that
Phase 1 creates, so it cannot start until Phase 1 merges.

**Merge order:** planning PR → Phase 1 → Phase 2.

## Cross-phase contracts

Phase 1 owns these and Phase 2 consumes them without changing them:

| Contract | Shape | Note |
| --- | --- | --- |
| Config key | `UiConfig.hiddenDisplayItems: string[]` | P1. One array for both groups. Phase 2 adds ids to it, never a second key. |
| Registry entry | `{ id, group: "card" \| "conversation", label, description }` | P2. Phase 1 ships `"card"` entries only. |
| Panel sectioning | One section per distinct `group` present in the registry | P2. Phase 2 adds entries, not layout. |
| Visibility hook | `useDisplayItems(): (id) => boolean` | Phase 2 calls the same hook from `ConsoleDetail`. |
| Defaults | Empty array - everything visible (D2) | Phase 2 must not add an id to the shipped default. |
| `RuntimeMetaRow` | `omit?: ReadonlySet<"model" \| "effort" \| "context">`, replacing `showEffort` | Phase 2 does not touch this component. |

## Final verification strategy

Each phase runs its own verification, specified in its file. Across the set, the delivered feature is
correct when:

- `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:e2e` pass on each phase's branch.
- `e2e/specs/console-tabs-toolbar.spec.ts` and `e2e/specs/native-worktree-dispatch.spec.ts` are
  **unmodified** at the end of Phase 2. D2 guarantees this; a diff touching either is the signal that
  the defaults drifted (F3).
- `test/session-leaf-parity.test.ts` and `test/layout-parity.test.ts` are unmodified and passing,
  which is the assertion that the tile still mounts the shared leaves rather than inlining copies
  (F8).
- A fresh profile with no stored config renders a board card and a console detail byte-identical to
  the previous release (D2).
