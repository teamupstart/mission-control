# Phase 1: The Library exit contract

## Outcome

A person who opens a Persona, Action or Command can get back out. Escape leaves the screen, a
visible `← Library` row leaves the screen, and neither discards an unsaved draft. This is the
reported bug, and it ships on its own so the fix is not held behind three screen rebuilds.

## Entry conditions and dependencies

- No phase dependencies. This is the root of the graph.
- Depends on the planning session's pull request merging, which publishes this file.
- Read [`plan.md`](plan.md) and [`phased-plan.md`](phased-plan.md) first.
- Re-read `src/web/components/SettingsPage.tsx`, `src/web/components/Overlay.tsx` and
  `src/web/workflows/useWorkflowRoute.ts` before editing. SettingsPage is the precedent for both
  halves of this phase and the reason not to invent a third pattern.

## Scope

### Included

- a shared `← Library` control rendered at the top of all four authoring rails;
- a page-level Escape ladder owned by the Library surfaces;
- threading whatever the ladder needs into `CommandLibrary`, which does not receive it today;
- the CSS for the new control;
- render tests and a Playwright spec covering every exit path, including the dirty gate.

### Excluded

- every visual change from the Rail direction other than the back row itself: no rail grouping, no
  property chips, no header overflow menu, no table rebuild. Those are Phases 2 to 4.
- any change to `WorkflowLibrary`'s pipeline and graph editors beyond mounting the same back row.
- any server, schema, route-codec or persisted-identifier change.
- the "used by" footer, which is Phase 5.

## Repository findings

These were verified against the running app and the source; do not re-derive them, but do re-check
them if the surrounding code has moved.

1. **Escape is absent, not swallowed.** `src/web/App.tsx` runs its global keydown work and then
   returns for any page that is not the fleet, above the entire Escape ladder. Nothing under
   `src/web/library/`, `PersonaLibrary`, `PersonaEditor`, `SessionActionLibrary`,
   `SessionActionEditor` or `CommandLibrary` registers an Escape handler.
2. **The comment above that guard states the architecture**: every page that is not the fleet owns
   its own keys, and `SettingsPage` demonstrates it with a page-local Escape listener. This phase
   follows that contract - the ladder belongs to the Library surfaces, not to App's global handler.
3. **Copying SettingsPage's handler verbatim would be dead in the pane that fills the screen.** It
   bails when the event target is inside `input, textarea, select, [contenteditable='true']`, and
   CodeMirror's content host is `contenteditable`.
4. **CodeMirror does not stop the event in the common case.** `basicSetup` binds Escape three times
   (`simplifySelection` from `defaultKeymap`, `closeCompletion` from `completionKeymap`,
   `closeSearchPanel` scoped to the search panel). None declares `preventDefault` or
   `stopPropagation`, and CodeMirror calls `preventDefault()` only when a bound command returns
   `true`. With a collapsed cursor, no selection, no open autocomplete and no search panel, Escape
   bubbles to `window` with `defaultPrevented === false`. With a selection or an open completion it
   bubbles with `defaultPrevented === true`.
5. **So no CodeMirror keymap extension is required.** There is no `Prec.high`, `Prec.highest` or
   `EditorView.domEventHandlers` anywhere in `src/web`, and the only `keymap.of` is
   `FileEditor.tsx`'s `indentWithTab`. Introducing a precedence layer here would be a new pattern
   for no gain; detect the editor from the focused element instead.
6. **Escape-to-blur already exists on plain inputs**: `WorkQueue.tsx` blurs the current target on
   Escape, and `App.tsx` and `TranscriptPanel.tsx` do the same for their own inputs. Follow that.
7. **The overlay channel is already threaded.** `Overlay` is not centralised - each instance installs
   its own `window` listener gated on being topmost - and the derived `anyOpen` guard reaches the
   Library through an `isOverlayOpen: () => boolean` prop that App builds from a ref and passes to
   `PersonaLibrary` and `SessionActionLibrary` today. It is a getter over a ref precisely so it is
   correct in the same commit a modal mounts. **`CommandLibrary` does not receive it** and will need
   it.
8. **The dirty gate already exists and must not be bypassed.** `useWorkflowRoute`'s `navigate`
   returns `false` and raises `WorkflowConfirmModal` when a draft is dirty.
   `test/workflow-route.test.ts` source-scans for this and asserts the gate never uses
   `window.confirm`.
9. **There is an Escape-ladder precedent to match in spirit**: `e2e/specs/line-drawers.spec.ts`
   asserts "Escape peels the planner first and the drawer second".

## Implementation steps

1. Add `src/web/library/LibraryBackRow.tsx`: a single button rendering `← Library` with a trailing
   `esc` hint. Give it an accessible name that says where it goes ("Back to Library"), take an
   `onLeave` callback, and do not let it own any navigation logic of its own. Select it in tests by
   role and name; **do not add a `data-testid`**.
2. Add `src/web/library/useLibraryEscape.ts`, a hook taking `{ isOverlayOpen, onLeave }` and
   installing one `window` keydown listener. In order, it must:
   - return immediately when the key is not `Escape` or when `event.defaultPrevented` is set;
   - return when `isOverlayOpen()` is true, so the topmost overlay closes itself and the page stays;
   - when the focused element sits inside a CodeMirror host (`closest(".cm-editor")`), call
     `preventDefault()`, blur that element, and stop - **do not navigate**;
   - otherwise call `preventDefault()` and `onLeave()`.
   Read the focused element rather than the event target, and keep the callbacks in refs so the
   listener is installed once.
3. Thread a leave callback from `App.tsx` into the four authoring surfaces. It navigates to the
   Library index route through the existing router so the dirty gate applies unchanged. Do not add a
   second navigation path and do not call `history` directly.
4. Pass `isOverlayOpen` to `CommandLibrary` the same way `PersonaLibrary` and `SessionActionLibrary`
   already receive it.
5. Mount `LibraryBackRow` and `useLibraryEscape` in `PersonaLibrary`, `SessionActionLibrary`,
   `CommandLibrary` and `WorkflowLibrary`. The row sits above the rail heading in every one, so it
   is first in reading order and never scrolls with the list.
6. Add the CSS for the row in the existing Library/authoring section of `src/web/styles.css`, beside
   the rules that already style these rails. Reuse `kb-hint` for the `esc` cap rather than styling a
   new one.
7. Confirm by hand in the running dashboard that the three-step case reads correctly: with text
   selected in the guidance editor, the first Escape collapses the selection (CodeMirror), the
   second blurs the editor, the third leaves the page. This is intended behaviour, not a defect -
   record it in the pull request so a later reader does not "fix" it.

## Compatibility

- No data, API, schema or migration change. The route codec is untouched; leaving the page reuses
  the existing Library index route.
- The `w` chord and its typing guard are unchanged. The back row and Escape are additions, not
  replacements, and `test/keybindings.test.ts` must stay green without edits.
- `WorkflowLibrary` gets the same row so the four authoring surfaces do not disagree, but none of its
  editors change.

## Tests and verification

### Unit and render

- [ ] Extend `test/persona-editor-render.test.ts`, `test/session-action-library-render.test.ts` and
      `test/command-library-render.test.ts` with a case asserting the back row renders in each rail
      with an accessible name, above the rail heading.
- [ ] Add focused coverage for the ladder's decision order: overlay open stands down, a
      `defaultPrevented` event stands down, an editor-focused Escape blurs without leaving, and a
      page-focused Escape leaves.
- [ ] `test/workflow-route.test.ts` and `test/keybindings.test.ts` stay green unedited. If either
      needs a change, that is a signal the ladder took the wrong owner - re-read finding 2 before
      editing them.

### Playwright, required

A new spec in `e2e/`, because only a browser can prove this. Select by role and label; never add a
`data-testid`, and never spend model tokens.

- [ ] Escape on a Persona, an Action and a Command detail lands on `#/library`.
- [ ] Escape with focus inside the guidance editor blurs the editor and **stays** on the detail
      route; a second Escape then lands on `#/library`.
- [ ] The `← Library` row lands on `#/library` from all three screens.
- [ ] With a dirty draft, Escape raises the existing leave-with-unsaved-changes dialog rather than
      discarding; cancelling stays on the route with the draft intact, confirming leaves.
- [ ] While that dialog is open, Escape closes the dialog and does **not** also leave the page.

### Commands

```
npm run typecheck
npm run lint
npm test
npm run build && npm run test:e2e
```

## Merge and exit criteria

- [ ] All four authoring rails render the back row; all three detail surfaces answer Escape.
- [ ] No unsaved draft can be lost through either new exit.
- [ ] The full gate above passes, and the new Playwright spec fails against `main` without this
      change.
- [ ] Screenshots of the back row on each of the three screens attached to the pull request, from a
      gitignored location - evidence is never committed.

## Downstream handoff

Phases 2, 3 and 4 may rely on:

- `LibraryBackRow` existing and being mounted at the top of every authoring rail. They restyle the
  rail around it; they do not remove it or move it below the heading.
- `useLibraryEscape` owning Escape for these routes. A later phase adding a popover or menu must
  route it through `Overlay` (or blur-on-Escape locally) rather than adding a second `window`
  listener, or the ladder's stand-down check stops being sufficient.
- `CommandLibrary` receiving `isOverlayOpen`.

They must not change: the decision order inside the ladder, the fact that leaving routes through the
dirty gate, or the back row's accessible name, which the Playwright specs select by.

## Cross-phase audit record

- Original decomposition. No earlier phase to reconcile against.
- Reconciled with the source plan's "shared exit contract": this phase implements it in full, and
  Phases 2 to 4 consume it rather than re-deriving it.
- Deviation from the source plan: the plan describes a two-step ladder. The repository adds a third
  step in one case, because CodeMirror consumes the first Escape when a selection is live. Recorded
  here and in step 7 rather than pretended away.
