# Phase 2: Comment mode in the Editor

## Outcome

You can turn on comment mode in the Files tab, click any line number in the Editor, write a comment,
and see it persist as a marker on that line. Expanding the marker shows the thread and lets you add
to it. Nothing is sent to any agent.

This is the first phase with user-visible value, and it is deliberately the last one that touches no
running session.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 1**, merged to the default branch. This phase consumes
  `src/shared/file-comment-anchor.ts`, both tables, the routes, and the two `ServerEvent` variants,
  and reimplements none of them.

## Scope

1. **A comment eligibility predicate**, separate from `previewable`. Finding 4 in `phased-plan.md`:
   `previewable` includes `image` (`FileWorkspace.tsx:126-128`), and it **cannot be redefined**
   because `test/console-arrow-scroll.test.ts:41-42` asserts a literal source regex over that exact
   expression. Add a new named predicate; leave `previewable` byte-identical.
2. **A Comment control in the file toolbar** (`FileWorkspace.tsx:422-444`), following the existing
   segmented-control shape exactly: wrapped in `Tooltip`, an `aria-label`, `aria-pressed` for the
   mode state, `aria-keyshortcuts` **only when `!extracted`**, and a `<kbd className="kb-hint">`
   only when `!extracted && showKeybindingHints`.
   - Images take no comments: disable the control with a reason rather than hiding it.
   - Do not style by descendant of `.file-toolbar` or `.file-mode` - `PersonaEditor.tsx`,
     `SessionActionEditor.tsx` and `ForemanProfileEditor.tsx` reuse those classes
     (`styles.css:16829-16834`).
3. **The chord.** Extend the capture-phase handler at `FileWorkspace.tsx:129-156`.
   **This is a decision to make and record in the PR, not a detail:** the mnemonic `c` is the global
   Complete-task action (`docs/ui.md:783`). Shadowing a global in-surface is established - `p`
   (Focus pane) and `e` (Open reviews) are both already shadowed, and `docs/ui.md:802-804` states
   the rule - but Complete is a heavier action to shadow than either. Take `c` and document the
   overlap in the same paragraph that documents `e`'s, or take `m` and say why. Either is
   defensible; an unrecorded choice is not.
4. **In-editor creation must be a CodeMirror keymap binding, not the window handler.** Finding 5:
   the window handler bails on `isTypingTarget`, which returns true for `contentEditable`
   (`keybindings.ts:462`), and CodeMirror's `.cm-content` is exactly that. A bare key pressed inside
   the editor never arrives. Add the binding to `FileEditor`'s own `keymap.of([...])`
   (`FileEditor.tsx:104`).
5. **The CodeMirror integration** in `src/web/components/FileEditor.tsx`:
   - a gutter marker for every line owning a thread, beside the `basicSetup` line numbers;
   - a block widget below the anchored line for an open thread or composer;
   - **decorations derived from the anchor model, never mapped through a document change.** The
     external sync at `FileEditor.tsx:155-162` replaces the whole document, which destroys
     position-mapped decorations. Worse, the `EditorView` is fully destroyed and rebuilt whenever
     `readOnly`, `path`, or `lineSeparator` change (`FileEditor.tsx:153`). All four paths must leave
     the markers correct, which they do if the model is the source of truth and positions are
     derived.
   - Add the extension through a `Compartment` if it must be reconfigured; note only `language` is
     currently reconfigured, and `editable` is a compartment that is never used as one.
6. **The thread UI**: marker, composer, thread view (original comment, replies in time order, reply
   box), and a "show resolved" toggle. Markers are real buttons with accessible names naming their
   line and state.
7. **Resolving.** A human resolves a thread; resolved threads collapse out of the gutter behind the
   toggle. Only a person closes a thread - phase 4 lets the agent mark one *addressed*, which shows
   as a suggestion and never as a closure.
8. **Drafts persist from the first keystroke** through phase 1's routes, not in browser state. The
   integrated tab and the extracted `FileWindow` are two live `FileWorkspace` instances that
   converge only through the daemon.
9. **`src/web/styles.css`** additions in the matching section.
10. **`docs/ui.md`**: the Files workspace section, the new control, the chord row in the shortcuts
   table, the in-surface-keys paragraph at `:800-804`, and the Keycaps list at `:806+`.

## Non-goals

- No Markdown or HTML preview commenting. Phase 5.
- No sending. No queue controls, no Start review, no payload. Phase 3.
- No MCP tool. Phase 4.
- No Files tab pip. Phase 4 raises it, because until something arrives there is nothing to announce.

## Repository findings this phase rests on

Four source-scan gates fire on the code this phase writes:

- `test/tooltip-coverage.test.ts:196` - every `<button>`, and every `role="button"` with an
  `onClick`, needs **exactly one** `Tooltip` ancestor wrapping exactly one interactive descendant.
  The gutter button and every thread control each hit this. The same file forbids a native `title`
  attribute on any DOM element (`:205`).
- `test/overlay-registry.test.ts` - a composer using `role="dialog"` must either import
  `Overlay.tsx` and carry `id={OVERLAY_IDS....}`, or be added to `UNREGISTERED_DIALOGS` **with a
  prose reason above it**. Only `Overlay` may render `modal-backdrop`. Read that file's header
  before choosing: an unregistered popover leaves App's global shortcuts, including kill and reset,
  live behind it.
- `test/topbar-popover-dismiss.test.ts:35` - a hard-coded file list asserting the Escape-dismiss
  contract. A new popover is not automatically covered; add it and copy the template.
- `test/desktop-drag-region.test.ts` - any new absolutely or fixed-positioned rule in `styles.css`
  must be covered by the `-webkit-app-region: no-drag` list or exempted with a true reason.

Two existing tests are pinned to `FileWorkspace.tsx` **source text** and break on careless edits:
`test/console-arrow-scroll.test.ts:41-42` (the `previewable` regex) and
`test/open-in-freshness.test.ts:87` (`Not opened` must occur exactly once in the file).

And one e2e contract: `e2e/specs/file-default-view.spec.ts:264` asserts the **extracted** Files
window contains **zero** `[aria-keyshortcuts]` elements. The new control must respect `extracted`
the way Preview and Editor do.

## Verification

- `test/file-comment-editor-markup.test.ts` - `renderToStaticMarkup` over the toolbar and thread
  components. Use `createElement`, not JSX: the runner's glob is `test/**/*.test.ts` only. Assert
  tooltips with `hasTooltip` from `test/helpers/markup.ts`, never a raw `title`.
- Extend `test/keybinding-hints.test.ts` coverage if the control takes a chord.
- `e2e/specs/file-line-comments.spec.ts` - the required browser spec. It must:
  `PUT /api/ui/config {"layout":"console"}` and reload before the Files tab exists (finding 10);
  copy a local `dispatch()` from a neighbouring spec, since there is no shared fixture; open a file;
  turn on comment mode; comment on a line; assert the marker; expand it; add a reply; assert it
  persists across a reload. Select by role, label and placeholder - **never** `data-testid`. Seed
  and read durable state with `withDaemonDb`, whose callback **must be synchronous**.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
  `npm run test:e2e -- e2e/specs/file-line-comments.spec.ts`.

## Merge and exit criteria

- Comment mode toggles from the toolbar and from the chord, and is suppressed while typing and while
  an overlay is open.
- A comment can be written on any line of any file the Editor renders, and survives a reload.
- Markers rebuild correctly after an agent edit, a path change, and a read-only toggle.
- The four source-scan gates pass, and the two source-pinned tests still pass unmodified.
- `docs/ui.md` documents the control, the chord, and any global chord it shadows.

## Downstream handoff

Later phases may rely on, and must not change:

- The comment eligibility predicate, and the fact that it is **not** `previewable`.
- The toolbar control's accessible name and `aria-pressed` contract, which phase 3's queue controls
  sit beside and phase 5's e2e specs assert.
- The thread and composer components, which phase 5 reuses for the two preview surfaces rather than
  reimplementing.
- The decoration-from-model rule. Phase 3's re-anchor pass changes the model; the editor must
  already redraw from it.

## Cross-phase audit record

- Initial authoring, after Phase 1.
- Corrected the source plan's claim that the chord opens a composer with the cursor on a line -
  impossible through the window handler (finding 5). Split into a window chord for the mode and a
  CodeMirror keymap binding for creation.
- Added the comment eligibility predicate as an explicit deliverable after finding that
  `previewable` includes images and is pinned by a source regex (finding 4).
- No change required to Phase 1: the anchor shape and routes it published are sufficient for
  everything here.
