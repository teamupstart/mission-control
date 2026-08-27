# Phase 1 - Shared find in Preview and Editor

## Outcome

Pressing Cmd+F (or Ctrl+F) while a document is on screen in the Files workspace opens a
find bar over that document, counts the matches, marks them, and steps between them with
Enter / Shift+Enter - in **Markdown preview** and in the **Editor**, from one find session
whose query and case flag survive the Preview/Editor toggle, each surface counting the string
it actually shows. HTML previews jump to the block containing the match. The chord stops
switching the detail to Conversation.

Value: the documents this dashboard is built to read - plans, reports, source files - become
searchable with the gesture every reader already has, and the app gains exactly one find
rather than a third one.

## Entry criteria and dependencies

None. This is the first phase.

## Scope

- A surface-agnostic find core, split out of `src/web/lib/find.ts`.
- A reusable `FindBar`, extracted from `src/web/components/ConversationFind.tsx`.
- Markdown preview marks via a new rehype plugin.
- Editor decorations, and claiming Mod-f away from CodeMirror's own search panel.
- `FileWorkspace` owning the find session and the chord, including in the extracted window.
- HTML preview: reveal the block containing the match, through paths that already ship.
- Unit tests, and one Playwright spec.

## Non-goals

- Character-accurate highlighting inside the HTML preview. That needs a hash-pinned script
  in the sandbox and is Phase 2.
- A results rail for documents. The conversation's rail is a conversation affordance; a
  document reader gets the bar, the count and the ring.
- A new rebindable keybinding action. The submitted decision is a contextual claim.
- Find in the Compare (conflict) panes, the image preview, or the diff viewer.
- Find in the other three `FileEditor` hosts - the Persona, Session action and Foreman profile
  editors. The adapter is built so they can have it, but giving each one a find owner is its own
  change; they keep today's behaviour here.
- Regular expressions or whole-word matching. Literal find, as `buildMatcher` already is.

## Repository findings

Verified against the checkout before writing this phase.

1. **The chord currently leaves the document.** `src/web/App.tsx:2626` binds `cmd+f` to
   `findInConversation`. `ConsoleDetail.tsx` mounts tabs conditionally (the conversation at
   :732, files at :813), so with Files open no transcript is mounted, `findHandles` has no
   entry, and the handler calls `requestConversationTab` - which switches the tab. Fixing
   this needs no edit to App: its handler returns early on `e.defaultPrevented` (:2245), and
   `FileWorkspace` already registers a **capture-phase** window keydown listener (:332) that
   runs before App's bubble-phase listener (:2801).
2. **`cmd+f` is a literal chord.** `chordFromEvent` (`keybindings.ts:406`) emits `cmd` for
   `metaKey` and `ctrl` for `ctrlKey`, and there is no platform normalization anywhere in
   that module. So Ctrl+F does not match the default `cmd+f` binding. The ask names both
   keys, so the workspace accepts the resolved `findInConversation` chord **or** a bare
   `ctrl+f`/`cmd+f` pair. Recorded as a decision below.
3. **The editor's find is CodeMirror's.** `FileEditor.tsx:359` includes `basicSetup`, which
   carries `@codemirror/search` (6.7.1, `package-lock.json`) and its `searchKeymap`. App
   returns early on `isTypingTarget` (:2483) and `.cm-content` is `contentEditable`, so
   today Cmd+F in the editor opens CodeMirror's panel. Its theme already styles
   `.cm-searchMatch` and `.cm-searchMatch-selected` (:389-390), which the new decorations
   reuse rather than replace.
4. **Decorations must be derived, never position-mapped.** `FileEditor.tsx:78-88` states the
   rule and `commentModel` (:122-124) is the pattern: a `StateEffect` carries a model, a
   `StateField` holds it, decorations are recomputed from it. Three of the component's four
   update paths destroy mapped decorations, including the mount effect's rebuild on `path`,
   `readOnly` or `lineSeparator` change.
5. **`Markdown` is memoized with an explicit comparator.** `markdownPropsEqual`
   (`Markdown.tsx:378`) lists every compared prop and its own comment warns that "a prop
   missing from here is not a slow render, it is a silently ignored prop." A find prop must
   be added there, and the `rehypePlugins` array is a nested conditional over `paths` and
   `diagramRenderers` that needs restructuring rather than a fourth nesting level.
6. **Rendered markdown text is not source text.** `rehypeHighlight` runs before
   `rehypeWorkspacePaths` and splits code into many spans, so a match can straddle two
   rendered text nodes. `hitsInWindow` (`find.ts`) already exists for exactly this case -
   the transcript's tool chip is searched as one string and rendered as two spans - and its
   contract is that a straddling hit is clipped into both halves under one key.
7. **The HTML preview is opaque, but a jump already works.** `FileWorkspace` resolves a
   comment's source line to a rendered block with `resolveHtmlBlockTarget`
   (`lib/api.ts:2143`, `POST /api/sessions/:id/html-block-target`, taking the path, the
   start and end lines and an optional revision) and reveals it by posting
   `HTML_PREVIEW_TARGET_MESSAGE` into the frame, where the scroll bridge scrolls to it and
   adds `mission-comment-target`. That is the whole mechanism this phase reuses.
8. **HTML preview text is prepared, and its revision lags.** `previewText` is the
   debounced, stylesheet-inlined rendering and `previewRevision` is the revision it came
   from, not always the buffer's (`FileWorkspace.tsx:395-405`). Find over an HTML document
   therefore searches `buffer.text` (the real source) and sends `previewRevision` to the
   endpoint, which refuses a path resolved against different bytes.
9. **The extracted window disables the workspace's own chords.** `FileWorkspace`'s keydown
   effect returns immediately when `extracted` (:311). Those are bare letters; the find
   chord carries a modifier and must stay live there, because `App.tsx` stands every
   session chord down while an overlay is open (:2381) and `FileWindow` is an `Overlay`.
10. **The bar's position is conversation-specific.** `.find-bar` is `position: absolute`
    inside `.find-logwrap` (`styles.css:7121-7132`). `mark.find-hit` and
    `mark.find-hit.is-current` (:7228, :7236) are element-scoped and reusable as they are.

## Decisions recorded in this phase

- **Ctrl+F is accepted as well as Cmd+F.** Finding 2 shows the existing chord is
  Mac-literal. The submitted decision was "no new bindable action", not "Mac only", and the
  ask names both keys, so the workspace matches the resolved chord or the platform pair.
- **Editor decorations carry CodeMirror's own class names** (`cm-searchMatch`,
  `cm-searchMatch-selected`), so finding 3's existing theme rules keep applying and no
  editor CSS is added.
- **Mod-f is claimed with the highest precedence.** Extension order gives `basicSetup`
  (first in the array) precedence over a later `keymap.of`, so the claim needs an explicit
  `Prec.highest` to beat `searchKeymap`. Verify at runtime that no CodeMirror panel opens.
- **HTML find counts over source and says so.** The bar renders a short note for HTML
  documents ("matches located by block") because the count is taken over source text and can
  include matches the rendered page does not show. Phase 2 removes both the note and the
  caveat.
- **Each surface's model is the string that surface renders.** One matcher, applied per
  surface - not one hit list shared by two surfaces that show different text. The Editor shows
  source, so its hits are offsets into `buffer.text`. Markdown preview shows rendered text, so
  its hits are the marks the rehype plugin actually produced, reported back in document order.
  A markdown document genuinely contains occurrences that render to nothing - a link
  destination in `[label](matching-url)`, a reference definition, a fence info string, an
  emphasis marker - and a shared source-derived count would have offered the reader matches
  Preview cannot highlight or step to, breaking the invariant this whole feature rests on. So
  the count is per surface, and each one is honest about what it shows. Hit keys are namespaced
  by surface, so a rendered key and a source key can never be mistaken for one another.
- **A source-to-rendered offset mapping is rejected, not deferred.** `remark` and `rehype` drop
  emphasis markers, decode entities, rewrite autolinks and hoist reference definitions, so no
  exact character mapping survives the transform. Only block-level `position` data is reliable,
  which is why it is used for the coarse job below and for nothing finer.
- **Position is carried across the toggle best-effort, and is not claimed to be exact.** The
  current mark's block carries a source line range (`blockRangeFromNode`, already used for
  comments), so switching to the Editor lands on the first hit at or after that line, and
  switching back lands on the first mark in or after the Editor hit's line. The same
  neighbourhood, not the same character - which is what these two surfaces can honestly promise
  each other.

## Implementation steps

1. **`src/web/lib/documentFind.ts`** (new). Move `buildMatcher`, `matchesIn`,
   `splitForHighlight`, `hitsInWindow`, `stepIndex` and `FindSegment` here unchanged;
   re-export them from `find.ts` so the transcript's imports and
   `test/conversation-find-model.test.ts` keep working. Add:
   - a document find session shape holding the query, the case flag and the index. It does
     **not** hold a hit list: hits belong to whichever surface is on screen, because the two
     surfaces search different strings;
   - `documentHits(text, query, opts, surface)` returning hits of `{ key, start, end, line }`
     over **whatever string it is given** - source for the Editor, rendered text for a caller
     that has one - with keys stable for a given query and namespaced by surface, so React, the
     ring and the current-hit lookup cannot cross surfaces;
   - `hitLine(text, offset)` for the source line a hit sits on, which the HTML and editor
     jumps both need.
2. **`src/web/components/FindBar.tsx`** (new). Lift the bar's markup out of
   `ConversationFind.tsx` verbatim, parameterized by label, placeholder, count, an optional
   note, and the existing callbacks. Keep `ConversationFindBar` as a wrapper passing
   "Find in conversation", so the transcript's accessible names and existing specs are
   untouched.
   The bar takes the **count and current position as supplied values**, never deriving them
   from a hit array of its own. Phase 2 replaces the source of that number for HTML documents
   with the count the sandboxed frame reports, and a bar that computed it could not be fed.
3. **`src/web/lib/rehypeFindMarks.ts`** (new). A rehype plugin, ordered LAST after
   `rehypeHighlight` and `rehypeWorkspacePaths`, that walks text nodes in document order,
   splits them around matches using the core's matcher, and replaces each match with a
   `mark` element carrying `find-hit` and a find key, plus `is-current` on the active key.
   Skip nothing; a hit that straddles a highlight span boundary is clipped into both halves
   under one key, per finding 6.
   **The plugin is Preview's model, not only its renderer.** It reports the keys it marked, in
   document order, so the bar's count is literally the number of marks on screen and the ring
   steps only over marks a reader can reach. Nothing derives Preview's count from source text.
4. **`src/web/components/Markdown.tsx`**. Add an optional find prop (query, case flag,
   current key), thread it into the plugin list - restructuring `rehypePlugins` into a built
   array rather than nested ternaries - and add it to `markdownPropsEqual` per finding 5.
   Absent for the nine callers that do not pass it, exactly as `diagramRenderers` and
   `blockAnchor` are.
5. **`src/web/components/FileEditor.tsx`**. Add an optional find model prop and a find-chord
   callback:
   - a `StateEffect` and `StateField` pair following `commentModel`'s pattern (finding 4),
     with decorations built from the model's offsets;
   - a highest-precedence keymap claiming Mod-f, calling the callback through a ref and
     returning true so `searchKeymap` never sees the chord - **installed only when the caller
     supplies a find owner.** `FileEditor` has four hosts, and three of them (`PersonaEditor`,
     `SessionActionEditor`, `ForemanProfileEditor`) have no find session. Claiming the chord
     unconditionally would swallow it there and suppress CodeMirror's panel at the same time,
     leaving those three editors with no find at all where they have a working one today. A
     chord is only taken by a surface that can answer it;
   - scroll the current hit into view through the existing `scrollTo` nonce mechanism
     (:440-462) rather than adding a second scroll path.
6. **`src/web/components/FileWorkspace.tsx`**. Own the session:
   - find state held per selected path, so switching files starts clean while the
     Preview/Editor toggle does not;
   - extend the existing capture-phase keydown effect: accept the find chord even when
     `extracted` (finding 9) and even when the target is a typing element, then
     `preventDefault` and `stopImmediatePropagation` so App stands down (finding 1);
   - in Editor, compute hits over `buffer.text` and hand them to `FileEditor`; in Markdown
     preview, pass the query to `Markdown` and take the count and ordered keys back from what
     the plugin marked. Never feed source hits to Preview or rendered hits to the Editor. The
     bar shows the active surface's count, and position crosses the toggle by line as the
     decisions describe. Render `FindBar` anchored in `.file-content`;
   - Escape closes find and must not also peel the detail layer - the same
     `stopPropagation` the conversation's bar performs;
   - HTML documents: on each step, resolve the current hit's line with
     `resolveHtmlBlockTarget` (sending `previewRevision`, finding 8) and post
     `HTML_PREVIEW_TARGET_MESSAGE`, reusing the existing html-target state, request-nonce
     guard and stale-revision error handling already in this file.
7. **`src/web/styles.css`**. Anchor `.find-bar` inside the file content area (finding 10) -
   a modifier class or a shared positioning rule, not a second copy of the bar's styling.
   Add the note's style if the bar's optional note needs one.

## Tests and verification

- `test/document-find.test.ts` (new): counts, wrap in both directions, case sensitivity,
  the zero-length guard, clipped straddling hits, and `hitLine` at file start, end and
  across CRLF.
- `test/markdown-find-marks.test.ts` (new): `renderToStaticMarkup` over the plugin's output -
  the number of `mark.find-hit` elements equals the count the plugin reported, `is-current`
  appears exactly once, a match inside a fenced code block still marks, and a query that occurs
  **only** in a link destination, an image URL, a reference definition or a fence info string
  produces no marks and a reported count of zero.
- `test/file-editor-find.test.ts` (new), or an addition to the existing editor markup test:
  decoration ranges for a known document and query.
- `e2e/specs/file-find-in-document.spec.ts` (new): open Files on a markdown fixture, press
  Meta+f, assert the searchbox, fill a query, assert the `mark.find-hit` count and text,
  press Enter and assert `is-current` moved, switch to Editor and assert the query and case
  flag survive with the count re-derived over source, assert the Conversation tab did not steal
  the keystroke, press Escape and assert the bar closed. Include a fixture whose query appears
  only in a link destination, asserting 0 in Preview and 1 in the Editor. Mirror `conversation-terminal-view.spec.ts:249-259`, which is the
  existing precedent for asserting find in a browser.
- `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build && npm run test:e2e`.

## Merge and exit criteria

- Cmd+F and Ctrl+F over a Markdown preview and over the Editor both open the bar, count,
  mark and step; the Conversation tab never opens as a side effect.
- The query and case flag survive the Preview/Editor toggle on the same file, and each
  surface's count equals the number of marks it drew.
- A query matching only a link destination - `[label](matching-url)` - counts 1 in the Editor
  and 0 in Markdown preview. Both numbers are correct for what their surface shows; a Preview
  that reported 1 would be offering a match nothing can highlight or step to.
- No CodeMirror search panel can be opened from a Files document, in either mode.
- The Persona, Session action and Foreman profile editors are unchanged: Cmd+F there still does
  exactly what it does today, proving the Mod-f claim is installed only with a find owner. A
  swallowed chord in those three editors is a regression, not a partial rollout.
- Find works in the extracted Files window.
- An HTML preview reveals and outlines the block containing the current match, and the bar
  says matches are located by block.
- All four gates green, with the new spec included.

## Downstream handoff

Phase 2 may rely on, and must not change:

- `documentFind.ts`'s matcher and hit shape. It is the single matcher, applied per surface to
  the string that surface renders; the in-frame bridge reports positions it can highlight, not
  a second count from a second matcher. Phase 2's frame-reported count is the HTML surface
  arriving at the same rule the Markdown adapter already follows here.
- `FindBar`'s props, including the optional note and the supplied count. Phase 2 retires the
  HTML note by passing nothing and feeds the frame's reported count through the same prop,
  neither of which requires editing the bar.
- `FileWorkspace` owning the session and the chord. Phase 2 adds a message path, not a
  second owner.
- The `HTML_PREVIEW_TARGET_MESSAGE` block-reveal path, which stays as the fallback whenever
  the frame has not reported itself ready.

## Cross-phase audit record

- Written first; nothing earlier to reconcile.
- Reconciled with Phase 2 after it was written: Phase 2 owns every edit to
  `src/web/lib/htmlPreview.ts` and the CSP. This phase touches neither, and its HTML path
  uses only the daemon endpoint and the existing target message.
- The HTML note copy is introduced here and retired by Phase 2. Recorded in both files so
  neither leaves it stranded.
- Amended after Phase 2 was written: the bar takes its count and current position as supplied
  values (step 2), because Phase 2 replaces the source of that number for HTML documents with
  the frame's own report. Moving the decision here rather than working around it later is why
  Phase 2 needs no edit to the bar.
- Review round 5 (PR #818): hits were specified as computed once over `buffer.text` and used by
  both surfaces, while `rehypeFindMarks` can only mark rendered text. A query matching only a
  link destination would have counted 1 in Preview with nothing to highlight or step to - the
  bar offering a match the reader cannot reach, which is the exact invariant this feature rests
  on. Each surface now models the string it renders, the plugin reports what it marked, hit keys
  are namespaced by surface, and an offset mapping is rejected with its reasons.
  **This changed a requirement I had written**, not only an implementation detail: "the count
  survives the Preview/Editor toggle" was not achievable honestly, because a markdown
  document's rendered text contains fewer occurrences than its source. The outcome, the
  requirements list, the exit criteria and the source plan all now say the query and case flag
  survive while each surface counts what it shows, with position carried across by line.
- Review round 3 (PR #818): the Mod-f claim was specified as unconditional, which would have
  swallowed the chord in the three other `FileEditor` hosts - Persona, Session action and
  Foreman profile - while also suppressing CodeMirror's panel there, leaving them with no find
  at all where they have a working one today. It is now installed only when a caller supplies a
  find owner, those three are named as a non-goal, and an exit criterion asserts their behaviour
  is unchanged. The source plan's "generalises for free" sentence was corrected in the same
  pass: the adapter is reusable by those hosts, not automatically inherited by them.
