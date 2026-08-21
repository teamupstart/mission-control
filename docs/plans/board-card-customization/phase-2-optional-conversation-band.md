# Phase 2: The conversation band becomes optional

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).
Direct prerequisite: [Phase 1](phase-1-customizable-board-card.md).

## Outcome

The console detail's `PATH` and `BRANCH` cells each become an item the operator can switch off, in the
same panel Phase 1 built. When both are off and nothing else occupies the band, the whole
`<dl class="detail-sub">` stops rendering and the conversation grows by its height.

This is the half of the request that buys vertical space back, and it is only honest because Phase 1
gave the board card somewhere else to put those two facts.

## Entry criteria and dependencies

**Phase 1 must have merged.** This phase consumes six things it created and changes none of them:

| Inherited contract | Shape |
| --- | --- |
| Config key | `UiConfig.hiddenDisplayItems: string[]` - one array, both groups |
| Registry entry | `{ id, group: "card" \| "conversation", label, description }` |
| Panel sectioning | One section per distinct `group` found in the registry |
| Visibility hook | `useDisplayItems(): (id: DisplayItemId) => boolean` |
| Default | `[]` - everything visible |
| `RuntimeMetaRow` | `omit?: ReadonlySet<...>` - **not touched by this phase** |

Because `group` and the per-group sectioning already exist, this phase adds **entries, not layout**,
and touches no shared contract: no schema field, no `coerce()` line, no route, no migration.

## Scope

1. Two `group: "conversation"` entries in `src/web/lib/board-card.ts`: `detailPath` and
   `detailBranch`.
2. `ConsoleDetail.tsx` - gate the two `.kv` cells, and guard the whole `<dl>` so an empty band does
   not render.
3. Any style fallout from the band's absence.
4. Tests and documentation.

### Non-goals

- **Changing the defaults.** D2 is binding: both cells ship visible. Adding either id to
  `UI_CONFIG_DEFAULTS.hiddenDisplayItems` is out of scope and would break three e2e specs (F3).
- **The task chip, `TaskRepoPrs`, or anything else in the band.** They keep their existing rules. This
  phase makes two cells optional and teaches the container to disappear when empty.
- **Relocating the path into the tab strip.** That was measured and rejected by the
  console-header-density work, and `test/detail-tabs-ladder.test.ts:104` actively forbids it. The
  path moves to the *board card*, which Phase 1 already delivered, or it is simply not drawn.
- **`RuntimeMetaRow`, `SessionTile`, the card items.** Phase 1 owns them.

## Repository findings

- **F3 - three live assertions read this band, and D2 keeps them passing.**
  `e2e/specs/console-tabs-toolbar.spec.ts:163-166` reads the path out of `.detail-sub .kv` to derive
  its subject, and `e2e/specs/native-worktree-dispatch.spec.ts:107,110,178` assert
  `.detail-sub dd.mono` contains `worktree-pools/` and that hovering shows the full path. Because the
  defaults keep both cells visible, **all three specs must remain unmodified**. A diff that touches
  either file means the defaults drifted, and that is the first thing to check in review.

- **F4 - the band has company, so the saving is conditional.** The same `<dl>` hosts the task chip
  (`ConsoleDetail.tsx:507-537`) and `TaskRepoPrs` (`:544`). Hiding both cells collapses the band only
  when nothing else is in it. It usually is nothing else: `taskPillParts`
  (`src/shared/task.ts:341-353`) returns `silent: true` when the kind is the default `ship`, the task
  title equals `session.name`, and there is no outcome and no `scheduleId` - the ordinary dispatched
  session, because `dispatcher.ts:799` sets its name to the task title. A scout task, a re-assigned
  session, a task with an outcome link, a scheduled task or a multi-repo task keeps the band.

  The measured figure is ~37-55px: `.detail-sub` is `padding: 10px 22px` over an ~16px line plus a 1px
  border (`styles.css:22182-22219`), and `docs/plans/console-header-density/plan.md:35` measured the
  row at 55px before it acquired company.

- **Nothing structural depends on the band existing.** Verified: `styles.css` contains no adjacency or
  child selector naming `.detail-sub` (only `.detail-sub`, `.detail-sub .kv`, `dt`, `dd`, `.branch`),
  and both neighbours carry their own bottom rule - `.detail-head` at `:22119` and `.detail-tabs` at
  `:22240`. Removing the band leaves the head's border directly above the tab strip, with no doubled
  and no missing divider. **Do not add a compensating border.**

- **Guard the element, not `:empty`.** The band carries padding and a border, so an empty one is a
  visible bar of chrome saying nothing - the exact thing `ConsoleDetail.tsx:505-509` already reasons
  about for the task chip. A CSS `:empty` rule would also be defeated by the whitespace JSX leaves
  between children. Compute the guard in the component.

- **`.detail-conv`'s child combinators are not affected.** `pane-dialog-scroll.test.ts` and
  `styles.css:18086-18094` select `.detail-conv > .pane-dialog` and `.detail-conv > .transcript`.
  `.detail-sub` is a sibling of `.detail-body`, not a child of `.detail-conv`, so nothing here may
  introduce a wrapper inside `.detail-conv`.

## Implementation

### 1. Two registry entries

`src/web/lib/board-card.ts` - append `detailPath` and `detailBranch` with `group: "conversation"`.
Phase 1's panel renders a second section automatically; do not edit `BoardCardPanel.tsx` layout.

Their `description`s must carry F4's condition: switching these off gives the conversation the band's
height **when nothing else is in the band**, which is the common dispatched session but not all of
them. Say what is lost and when the gain applies. A preference that promises height unconditionally is
a bug report waiting to be filed.

These are deliberately **not** the same switches as the card's `branch` and `worktree` items. An
operator may want the path in both places or in neither, and coupling them would make one checkbox
mean two things with no way to express "neither".

### 2. The band

`src/web/components/layouts/ConsoleDetail.tsx`:

- Call `useDisplayItems()` and gate the `path` cell (`:493-498`) and the `branch` cell (`:499-504`).
  The branch cell keeps its existing `session.gitBranch &&` condition - the preference is an
  additional gate, not a replacement.
- Compute whether the band has any content at all: either cell visible, or a non-silent task pill, or
  repo PRs. Render the `<dl>` only then.

Keep the `Tooltip` carrying the full `session.cwd` on the path cell - `native-worktree-dispatch.spec.ts`
asserts it, and it is the only place the untruncated path is readable.

### 3. Styles

Expect none. Verified above that no selector depends on the band and that both neighbours own their
borders. If a gap appears, fix the cause rather than adding a compensating rule, and record why in the
pull request.

## Data, API and compatibility

**Nothing.** No schema field, no default change, no `coerce()` line, no route, no migration, no
`ServerEvent`. Two ids join an array that Phase 1 already ships, and an id this build does not know is
already ignored by design.

A profile that hid card items under Phase 1 is unaffected: its array simply does not mention the two
new ids, so both cells are visible, which is D2.

## Tests and verification

`test/`:

- `console-detail-header.test.ts` - extended. The band renders nothing when both cells are hidden and
  the pill is silent; it still renders when the pill is **not** silent, and when repo PRs are present.
  Both halves matter - the second is what stops the guard from being "hide the band whenever the cells
  are hidden".
- `board-card-items.test.ts` - the Phase 1 source scan now also covers the two conversation entries
  and the `ConsoleDetail` conditionals they gate. Extend its scan rather than starting a second test.
- `ui-config-cache.test.ts` - no change expected; the key already exists.

`e2e/`:

- **`conversation-band-optional.spec.ts`** (new) - with both cells hidden, `.detail-sub` is absent and
  the transcript's share of `.detail-conv` rises. State the threshold as a **share**, not a pixel
  count, following `console-tabs-toolbar.spec.ts:177-190`: the absolute figure is a function of the
  window and the font stack, while the split between the log and the chrome above it is what this
  change moved. Measure the before and after on the machine, then set the floor between them with
  room on both sides, exactly as that spec's comment describes.
- `console-tabs-toolbar.spec.ts`, `native-worktree-dispatch.spec.ts` - **unmodified.** Verify this
  explicitly; it is the F3 property.

Commands: `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build` followed by
`npm run test:e2e`.

## Merge and exit criteria

- Every listed test passes; `typecheck`, `lint`, `build` and the e2e suite are green.
- `e2e/specs/console-tabs-toolbar.spec.ts` and `e2e/specs/native-worktree-dispatch.spec.ts` are
  byte-unchanged.
- A profile with no stored config renders a console detail byte-identical to the previous release
  (D2).
- The measured share improvement is recorded in the pull request, with the condition under which it
  does not apply (F4).
- `docs/ui.md` describes the two conversation items alongside the card items.

## Downstream handoff

This is the last phase. It introduces no contract a later phase must respect. Two notes for whoever
comes next:

- The registry's `group` field now has both of its values in use, so a third surface would add a third
  group and the panel would section it without change.
- F7 (no `ui_config` ServerEvent, so a second tab picks changes up on reload) remains open and
  unowned. It applies to every Display preference, not just these.

## Cross-phase audit record

- **Against Phase 1:** consumes `hiddenDisplayItems`, the registry entry shape, the per-group
  sectioning and `useDisplayItems` exactly as handed over. Changes none of them, adds no config key,
  and does not touch `RuntimeMetaRow` or `SessionTile`. The only shared file is
  `src/web/lib/board-card.ts`, and only by appending entries.
- **Against the source plan:** the plan proposed the key name `boardCardHidden`; Phase 1 renamed it to
  `hiddenDisplayItems` precisely because this phase's ids share the array (index P1). This phase uses
  the new name.
- **Dependency direction verified:** every contract flows Phase 1 → Phase 2. There is no reverse edge,
  and no concurrency claim to check, because this phase cannot start until Phase 1 merges.
