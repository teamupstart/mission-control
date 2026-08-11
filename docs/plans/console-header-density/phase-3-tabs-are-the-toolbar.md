# Phase 3: Tabs are the toolbar

## Outcome

The worktree row stops being its own band. Its two controls - the Terminal-view toggle and the two
launchers - move into the tab strip, which already runs the full width with dead space after "Files".
The console detail Conversation tab reaches roughly 410px of conversation in a 600px pane, up from
243px before this work started.

**The worktree path is not relocated - it is dropped.** Option 2 keeps the `PATH`/`BRANCH` row, and
that row already shows the same string; the worktree row's copy of it is the duplicate identified at
the very start of this work ("the path is rendered twice"). Deleting the band removes the duplicate,
and no path is added to `.detail-tabs`. Adding one would recreate exactly the duplication this plan
exists to remove.

Delivers decision **D1**.

## Entry criteria and dependencies

**Direct prerequisite: Phase 2.** Phase 2 settles the shape of `.detail-conv` by removing its leading
children; this phase changes what sits above that container and edits the same two files
(`ConsoleDetail.tsx`, `TranscriptPanel.tsx`).

## Scope

1. The console detail hosts the launcher strip in its tab row; `TranscriptPanel` suppresses its own
   when the host provides one.
2. The Cards layout is unchanged - it keeps the panel-owned strip and the Terminal-view toggle.
3. `t` / `a` chords keep working in every host.
4. A give-way order for narrow panes, following `topbarLadder.ts`.

### Non-goals

- Removing the `PATH`/`BRANCH` row. That is option 1's move and was **not** approved; option 2 keeps
  it. See the lattice table in the source plan.
- Options 4, 5, 6 and collapse-on-scroll.
- An overflow-menu ("…") pattern. None exists in this codebase and this is not the change that should
  invent one. Say so in the PR rather than implying reuse.

## Repository findings

This is the phase the repository fought hardest, and F1 and F2 are binding.

- **F1 - a naive move is a deletion.** `SessionLaunchers` has exactly one mount,
  `TranscriptPanel.tsx:966-972`, and `LaunchMenu.tsx:231-233` states the intent: it "reaches the
  expanded card, the console detail and the board drill-in from one mount rather than from three
  placements kept in step by hand". `TranscriptPanel` is mounted from `SessionCard.tsx:502-530` and
  `ConsoleDetail.tsx:519-553` only. `.detail-tabs` belongs to `ConsoleDetail`, which `SessionCard`
  never renders, so moving the mount **deletes the strip from Cards**.
- **F1, second break:** `App.tsx:1757-1793` parks a `pendingLauncherAction` and clears it only when a
  `SessionLaunchers` registers for that id (`App.tsx:465-479`). In Cards the pending action would be
  set and never cleared, making `t` / `a` dead keys there and leaving a stale ref to fire on an
  unrelated later mount.
- **F1, third break:** three live e2e assertions read the toggle from a card -
  `e2e/specs/conversation-terminal-view.spec.ts:210`, `:225`, `:312`.
- **No slot exists.** `leading` (`LaunchMenu.tsx:242-251`) slots a control *into* the strip, not the
  strip into a host. `TranscriptPanel`'s props (`:127-209`) have no toolbar slot and `ConsoleDetail`
  has no children slot. The mount must be lifted and `registerLaunchers` re-threaded - that prop
  already flows through the shared bag (`layouts/types.ts:119`, `SessionCard.tsx:166`), so the
  plumbing exists and only the placement does not.
- **`ConversationViewToggle` is not exported** (`TranscriptPanel.tsx:1002-1032`) and its state comes
  from `useSessionConversationView(sessionId)` (`lib/conversation-view.ts:156-172`), which re-renders
  **only its own caller**. Calling it from `ConsoleDetail` works, because the parent re-render
  cascades into `TranscriptPanel`, which is not memoized. Calling it from a *sibling* of the panel
  would not. Verify the cascade rather than assuming it.
- **The strip would render on every tab.** `.detail-tabs` is present for Work queue, Workflows, Diff
  and Files too. That is acceptable for the launchers but wrong for the Terminal-view toggle, which
  is about the pane you are reading. Decide and record: either the toggle renders only on the
  Conversation tab, or the whole run does.
- **F2 - `.detail-tabs` is not a query container.** The only pane-scoped responsive mechanism is
  `container-type: inline-size` on `.transcript` (`styles.css:4738`) with two
  `@container (max-width: 560px)` blocks, one of which (`styles.css:5944-5975`) is already the
  precedent for a toolbar shedding controls. `.conv-launch` is inside that container today;
  `.detail-tabs` is not, and no ancestor declares `container-type`. **Moving the controls forfeits
  that mechanism.**
- **The give-way must follow `topbarLadder.ts`.** Its design note (`styles.css:2087-2098`) argues
  against container queries for exactly this case: a rung fires on the width the bar *has*, but
  whether it needs to fire depends on the width its content *needs*, and the two are independent. Its
  hard rule (`styles.css:2101-2109`) is binding: **a shed label goes visually hidden, never
  `display: none`**, so the control keeps its accessible name and only its glyph is drawn.
  `test/topbar-ladder.test.ts` and `e2e/specs/topbar-one-row.spec.ts` are the models.
- **The overflow is real.** Measured in the mockup at an 848px pane, the tab row overflows by 101px
  even with the path left in the `PATH`/`BRANCH` row. This phase is not done until that is handled.
- `test/foreman-invite-ui.test.ts:129` asserts `.detail-tabs` is "still the same strip, not a
  suppressed one" - the strip must keep its identity through this change.
- `docs/ui.md:651-654` says the launcher shortcuts print their keys "in the conversation toolbar",
  and `docs/ui.md:289-295` says the Conversation tab is "the transcript and nothing else". Both
  become false here.

## Implementation steps

1. **Give `TranscriptPanel` a host-provides-toolbar contract.** Add one prop that suppresses the
   panel's own `SessionLaunchers` mount. Default it to the current behaviour so `SessionCard` needs
   no change. Document on the prop that it exists because the strip has three hosts and only one of
   them has somewhere better to put it.
2. **Export `ConversationViewToggle`** and have `ConsoleDetail` render it as the `leading` slot of its
   own `SessionLaunchers`. Confirm the `useSessionConversationView` re-render cascade reaches the
   panel; if it does not, lift the hook rather than duplicating its module-level map.
3. **Render the strip in `.detail-tabs`** in `ConsoleDetail`, after the tabs and before
   `ForemanRail`, passing `view.registerLaunchers` so `t` / `a` resolve in this host.
4. **Verify the Cards path is untouched** - the panel still mounts and registers its own strip there.
5. **Decide the per-tab question** from the findings and implement it.
6. **Build the give-way ladder** for the tab row, following `topbarLadder.ts` in mechanism and in its
   visually-hidden rule. Shed in this order: **the launcher labels first**, down to their glyphs,
   then the Foreman label. There is no path in this row to shed - see the Outcome; if the ladder
   seems to want a first rung before the launcher labels, that is the signal that a path has been
   added to `.detail-tabs` that does not belong there. Never shed a tab, and never shed the mode
   chip's accessible name (phase 1's contract).
7. **`styles.css`** - remove `.conv-launch`'s band styling where it no longer applies, keeping the
   rules the Cards host still needs. This file is shared; do not delete a rule another surface uses.
8. **Docs** - fix `docs/ui.md:651-654`, `docs/ui.md:289-295`, `docs/ui.md:465-466` and
   `docs/sessions.md:836-838`, all of which describe the toggle or the launchers as being "above the
   conversation" or the tab as "the transcript and nothing else".

## Tests and verification

- `test/foreman-invite-ui.test.ts` must keep passing unedited.
- `e2e/specs/conversation-terminal-view.spec.ts` must keep passing **unedited for its card
  assertions** (`:210`, `:225`, `:312`). If those fail, the Cards host has regressed and step 1 is
  wrong. Console-layout assertions in that file may need updating for the new location.
- Add a test that the `t` / `a` chords still resolve in the Cards layout, since that break is silent
  and would otherwise ship.
- **New Playwright spec** for the give-way, modelled on `e2e/specs/topbar-one-row.spec.ts`: drive
  `setViewportSize` across the breakpoint and assert the row stays one line. Use that spec's
  width-based "is it actually drawn" poll rather than `toBeVisible`, because visually-hidden labels
  still count as visible. Assert the shed controls keep their accessible names.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`.

## Merge and exit criteria

- The console detail Conversation tab has three bands - head, `PATH`/`BRANCH`, tab strip - and no
  separate worktree row.
- **`.detail-tabs` contains no worktree path.** The path appears exactly once in the pane, in the
  `PATH`/`BRANCH` row. If it appears twice, this phase has recreated the duplication the plan
  started from.
- Conversation area is materially larger; the source plan's target is ~410px in a 600px pane.
- **Cards still have the launchers and the Terminal-view toggle**, and `t` / `a` still work there.
- The tab row does not overflow at an 848px pane, and shed labels remain in the accessibility tree.
- Docs listed above no longer contain false sentences.
- Full suite green including the new give-way spec.

## Downstream handoff

Final phase. What later work must not undo:

- `TranscriptPanel` renders its own toolbar unless the host provides one. Adding a fourth host means
  deciding which side owns the strip, not adding a second mount.
- The give-way ladder is the tab row's responsive mechanism. `.detail-tabs` is still not a query
  container; do not add a `@container` rule to it and expect it to work.

## Cross-phase audit record

- **Against phase 1:** phase 1 owns the header cluster order and the `.detail-title` column. This
  phase re-flows the head row's neighbours but does not flatten the title column, and its ladder
  never sheds the mode chip's accessible name. Added that constraint to phase 1's handoff so the
  ownership is stated once, in the phase that introduces it.
- **Against phase 2:** this phase consumes phase 2's settled `.detail-conv` (no leading children,
  `.transcript` a direct child) and does not reintroduce `session.activity` into the header. Confirmed
  the no-wrapper rule is stated in phase 2, which owns those children, rather than duplicated here as
  a new decision.
- **Final set audit:** D1 is owned here alone; D2 and D3 by phase 1; D4 splits across phases 1 and 2
  exactly as the decision itself splits. No phase depends on undocumented cleanup by another, and
  each leaves the repository operable.
- **Inspector review, round 2 (`major`)** - the Outcome and the give-way step both described the
  worktree path as moving into `.detail-tabs` and being the ladder's first rung. That was written
  against an earlier draft of option 2 in which the path *did* sit in the tab row; when options 1, 2
  and 6 were re-differentiated into a lattice, option 2 changed to keep the `PATH`/`BRANCH` row and
  the path left the tab strip. Verified against `mockups.html`: option 2's tab row contains no
  `cl-path` element and no path string, while its `.detail-sub` row carries `PATH` and `BRANCH`. The
  stale prose also contradicted line 77 of this same file, which measures the 101px overflow "even
  with the path left in the `PATH`/`BRANCH` row". Both places now say the path is dropped rather than
  relocated, the ladder starts at the launcher labels, and a new exit criterion asserts the path
  appears exactly once in the pane. D1 is unchanged.
