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
- **Claiming Mod-f alone is not enough, because Mod-f is not the only way in.**
  `searchKeymap` also binds find-next and find-previous (`F3`, `Mod-g`, and their shifted
  pairs) and go-to-line (`Mod-Alt-g`), and its find commands are documented to **open the
  search panel when no query is set** - so the old panel is still one obscure chord away from a
  reader who never presses Mod-f. The exit criterion says no CodeMirror panel can open from a
  Files document, and one binding does not deliver it.
  The find-owner editor therefore claims every panel-opening binding at `Prec.highest`, and
  repurposes rather than deadens the useful ones: **find-next and find-previous drive our ring**,
  so `F3` and `Mod-g` keep meaning what a reader expects while the bar owns the query. Go-to-line
  is claimed and left inert, because it belongs to a panel this surface no longer has.
  **A chord list is a list, and this repository has learned twice what lists do** - the comment
  bridge's tag list "was never finished", which is why it now decides blocks by computed display.
  So the guarantee is asserted over the DOM rather than over the list: a test exercises every
  `searchKeymap` chord and asserts `.cm-panels` never appears. If a binding is ever missed, that
  test fails rather than the panel quietly reappearing. Should enumeration prove leaky in
  practice, the fallback is to stop taking `@codemirror/search`'s keymap for this editor at all -
  either by configuring `search()` with a panel factory that yields nothing, or by composing the
  editor's extensions without `basicSetup`'s search half - and that is a decision for the
  implementation, made against a failing test rather than against a guess.
  All of this is inside the find-owner path, so the other three `FileEditor` hosts keep
  `searchKeymap` intact, panel and all.
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
- **Position is carried across the toggle best-effort, and is not claimed to be exact.** Every
  reported Preview hit carries the source line range of the block it sits in
  (`blockRangeFromNode`, already used for comments) - the plugin must report it, because a key
  identifies a rendered hit and says nothing about where in the source it came from. Switching
  to the Editor lands on the first hit at or after that range's start line; switching back lands
  on the first mark whose block contains or follows the Editor hit's line. The same
  neighbourhood, not the same character - which is what these two surfaces can honestly promise
  each other, since a block's range is coarser than a character offset.
  Where the metadata is absent - the parser records no position for some nodes, which is why
  `blockRangeFromNode` is nullable - the toggle keeps the query and lands on the first hit rather
  than guessing a position. A missing line is not an excuse to pick the wrong one.

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
   **Match over logical runs, not text node by text node.** A per-node scan misses matches a
   reader sees as one word: `foo**bar**` renders as `foo` plus a `strong`, and
   `rehypeHighlight` splits a code line into many spans, so searching `foobar` would find
   nothing. Build a run by joining the text nodes within one block, match the run, then emit the
   marks that cover that hit.
   **A run is broken by every visible separation, not only by a block boundary.** Joining
   everything inside a block is as wrong in the other direction: `foo<br>bar` would match
   `foobar`, and a `br` is a line break the reader can see, with no text node of its own to
   notice. So the run breaks at:
   - a `br`;
   - any element that is not phrasing content - a nested block inside the block, a list item, a
     table cell edge - because text either side of it is on a different line or in a different
     cell;
   - a node the gates excluded that still occupies space (see Phase 2's mirror of this rule).

   It does **not** break at an inline element boundary (`strong`, `em`, `code`, a
   `rehypeHighlight` span), which is the whole point, nor at text that occupies no space at all,
   which the reader never saw. One logical hit may therefore be drawn as several `mark` elements, which
   all share **one key**: that is exactly what `hitsInWindow`'s clipping contract already does
   for the transcript's two-span tool chip (finding 6).
   **The plugin is Preview's model, not only its renderer.** It reports, in document order, one
   record per logical hit: its key, and the source line range of the block it sits in
   (`blockRangeFromNode`, nullable when the parser recorded no position). The bar's count is the
   number of **logical hits**, not the number of `mark` elements - a hit split across inline
   markup is one match to a reader and must be one match to the count. Nothing derives Preview's
   count from source text.
   The source line range is not decoration: it is what carries position across the mode toggle
   (see the decisions). A key alone identifies a rendered hit and says nothing about where in
   the source it came from, so without this metadata the toggle rule cannot be performed at all.
4. **`src/web/components/Markdown.tsx`**. Add an optional find prop (query, case flag,
   current key), thread it into the plugin list - restructuring `rehypePlugins` into a built
   array rather than nested ternaries - and add it to `markdownPropsEqual` per finding 5.
   Absent for the nine callers that do not pass it, exactly as `diagramRenderers` and
   `blockAnchor` are.
5. **`src/web/components/FileEditor.tsx`**. Add an optional find model prop and a find-chord
   callback:
   - a `StateEffect` and `StateField` pair following `commentModel`'s pattern (finding 4),
     with decorations built from the model's offsets;
   - a highest-precedence keymap claiming **every panel-opening binding `searchKeymap` carries**
     - Mod-f, find-next and find-previous (`F3`, `Mod-g` and their shifted pairs), and
     go-to-line (`Mod-Alt-g`) - calling the callback through a ref and returning true so
     `searchKeymap` never sees any of them. Find-next and find-previous step **our** ring rather
     than being deadened; go-to-line is claimed and inert. **Installed only when the caller
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
     preview, pass the query to `Markdown` and take back the ordered records the plugin
     produced - key plus block source range per logical hit - using the count for the bar and
     the ranges for the toggle. Never feed source hits to Preview or rendered hits to the Editor. The
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
  the number of **distinct find keys** equals the count the plugin reported (not the number of
  `mark` elements, which is larger when a hit is split across inline markup), `is-current`
  appears on exactly one hit's fragments, a match inside a fenced code block still marks, and a
  query that occurs **only** in a link destination, an image URL, a reference definition or a
  fence info string produces no marks and a reported count of zero. Plus:
  - `foo**bar**` matched by `foobar` is **one** hit, drawn as two fragments sharing one key;
  - a match spanning a `rehypeHighlight` span boundary inside a code fence behaves the same way;
  - a match is never joined across a block boundary - the last word of one paragraph and the
    first of the next do not combine;
  - `foo<br>bar` is **not** matched by `foobar`, and neither are two adjacent table cells or
    list items whose text would concatenate to the query;
  - each reported hit's block source range matches the source lines of the block it sits in, and
    a node for which the parser recorded no position still marks, reporting a null range.
- `test/file-editor-find.test.ts` (new), or an addition to the existing editor markup test:
  decoration ranges for a known document and query.
- The panel guarantee, in `e2e/` because only a browser can prove a panel did not appear: with a
  Files document in Editor mode, press each chord `searchKeymap` binds - Mod-f, `F3`, `Mod-g`,
  their shifted pairs, `Mod-Alt-g` - and assert `.cm-panels` is absent throughout, that `F3` and
  `Mod-g` moved our current hit, and that the same chords in a Persona editor still open
  CodeMirror's own panel, which is what proves the claim is scoped to the find owner.
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
- No CodeMirror search panel can be opened from a Files document, in either mode, **by any
  binding `searchKeymap` carries** - not only Mod-f. Asserted by exercising each of those chords
  and checking that `.cm-panels` never appears, so a missed binding fails a test rather than
  quietly restoring the old panel.
- `F3` and `Mod-g` step the shared ring, so find-next and find-previous keep working where a
  reader expects them.
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

### Phase 2 must do this, and Phase 1 could not

**Clear the reveal outline when nothing is being revealed.** Closing find over an HTML document
leaves the last revealed block outlined, and this phase cannot fix it. The frame's `missionJump`
removes the previous target only as it sets a new one; a non-array path returns early and an
empty array walks zero steps to `document.body`, so posting "nothing" would outline the whole
page. The three bridges are injected into the implicit `<head>`, so `document.body.children`
holds only checkout-controlled elements and there is no invisible element to park the outline
on, and the sandbox is `allow-scripts` with no `allow-same-origin`, so the parent cannot reach
the frame's DOM. The only correct fix adds a clear branch to `PREVIEW_SCROLL_SCRIPT` and
recomputes `PREVIEW_SCROLL_SCRIPT_HASH` - an edit to `src/web/lib/htmlPreview.ts` and its CSP,
which this phase is explicitly forbidden to make and Phase 2 already makes.

This was raised as a review finding during Phase 1 and put to the operator, who chose to keep
the constraint rather than relax it, so the behaviour ships as a known limitation. Two things
carry it forward rather than leaving it to be rediscovered:

- `e2e/specs/file-find-in-document.spec.ts` pins the current behaviour in "a closed find leaves
  the last HTML outline standing, which the sandbox cannot clear", with a comment telling Phase 2
  to **delete that test** and assert the outline goes.
- The reveal decision already funnels through one owner (`htmlRevealChoice`), so Phase 2 adds the
  clear message at a single call site rather than to two competing effects.

Phase 2 should also note that adding the branch changes that script's pinned hash, which
`test/html-preview.test.ts` recomputes and verifies.

## Implementation record

What was built, where it departed from the route above, and why. The outcome, the scope, the
non-goals and the exit criteria were all met as written; these are mechanism choices made
against the checkout.

- **`blockRangeFromNode` moved to `src/web/lib/markdownBlocks.ts`.** `rehypeFindMarks` needs the
  block range rule and cannot import the component that runs it. `Markdown.tsx` re-exports both
  the function and the type, so every existing caller and
  `test/markdown-block-anchors.test.ts` are untouched.
- **The plugin reports through a mutable sink, not a callback it invokes.** A rehype plugin runs
  inside `ReactMarkdown`'s own render, so calling the workspace's setter from there would be a
  state update during another component's render. `Markdown` fills the sink during render and
  forwards it in an effect, guarded by the reported signature so an unchanged render reports
  nothing and cannot drive a loop.
- **The Editor scrolls the current hit through the find model's own nonce, not `scrollTo`.** The
  nonce discipline is the one step 5 asked for, and the reason it is a second nonce rather than
  the same prop is precision: `scrollTo` carries a LINE, because its two callers - a deep link
  and the comment walkthrough - only know a line, while find knows the character offset. Sharing
  the prop would have thrown that away and put the two request sources in each other's way.
- **The HTML reveal keeps its own target ref rather than sharing `htmlTarget` state.** The comment
  jump's effect sets `htmlTarget` to null whenever no thread jump is live, and its dependencies
  move on any thread change, so a find reveal written into that state would have been cleared by
  an unrelated comment arriving. It reuses `revealHtmlTarget`, the request-nonce guard and the
  ready-replay path; the comment target still wins when both are live.
- **A failed HTML block resolve is not reported to the reader.** It has one cause - the file moved
  under a render still on screen, which is the 180 ms debounce window - and the count and the ring
  are unaffected. Raising the comment path's refusal notice on a keystroke would have been louder
  than the thing that went wrong.
- **The chord is its own capture-phase listener**, beside the workspace's bare-letter one rather
  than inside it. That listener stands down when `extracted`, on `isTypingTarget` and on three
  key-specific guards, and find inverts all three (finding 9) - threading the inversions through
  one handler would have made both harder to read than two.
- **`hitsInWindow` became generic** over `{ start, end }` so the document surfaces can use the
  clipping contract the transcript relies on. `find.ts` re-exports it and the conversation's
  callers still resolve it at `FindHit`.
- **A rendered Mermaid fence is skipped, and an over-limit one is searched.** Not named in the
  route, and it follows the same rule: the `pre` override replaces a diagram fence with a rendered
  diagram, so a mark inside its source is a counted match with nothing on screen. An over-limit
  fence renders as ordinary source and is searched like any code block.
- **Reopening find restores the last query** from a ref that survives the close and is cleared when
  another file is selected. The route says reopening keeps the last query; the session itself is
  dropped on close, so the memory had to live beside it.
- **The unit test for the plugin's report drives the plugin directly** over hand-built hast, while
  what is DRAWN is asserted through the real component and this repository's real plugin chain.
  `renderToStaticMarkup` runs no effects, so the report cannot be observed through the component -
  and the hand-built tree is also the only way to state the case a parser will not produce on
  demand: a node it recorded no position for. Every reported hit draws at least one fragment
  carrying its key, so the distinct keys in the markup are the reported count.

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
- Review round 8 (PR #818): the plan claimed Mod-f only, while `searchKeymap` also binds
  find-next, find-previous and go-to-line, and its find commands open the panel when no query is
  set - so the exit criterion "no CodeMirror panel can open" was not delivered by the mechanism
  beside it. Every panel-opening binding is now claimed for the find-owner editor, with find-next
  and find-previous repurposed to step our ring rather than deadened, and the guarantee is
  asserted over the DOM (`.cm-panels` absent after each chord) rather than over the chord list -
  because a list is what the comment bridge already learned not to trust. The other three hosts
  keep `searchKeymap` whole, since all of this sits inside the find-owner path.
- Review round 7 (PR #818): run joining said "within a block", which over-joins - `foo<br>bar`
  would have matched `foobar`, and a `br` is a visible line break with no text node of its own to
  notice. Runs now break at every visible separation: a `br`, any non-phrasing element, and an
  excluded node that still occupies space. Phase 2 took the same correction, expressed through
  computed display. The source plan and its rendering were also brought into line with round 5's
  per-surface model: they still described one session holding a shared hit list and claimed the
  two surfaces "read the same string, so their counts agree", which is exactly the shared
  source-derived count this phase rejects - a contradiction that could have led an implementation
  straight back to it.
- Review round 6 (PR #818): two consequences of round 5's model, both fixed together.
  The toggle rule needed the current mark's source line range while the plugin was only required
  to report keys - a key identifies a rendered hit and carries no source position, so the rule
  could not have been performed. The plugin now reports a block source range per hit, nullable,
  and the toggle lands on the first hit rather than guessing when it is absent.
  The plugin was also described as matching text node by text node, which misses what a reader
  sees as one word: `foo**bar**` searched for `foobar`, or a match crossing a `rehypeHighlight`
  span inside a fence. Matching is now over per-block runs of joined text nodes, one logical hit
  is drawn as however many fragments it needs under **one key**, and the count is logical hits -
  correcting round 5's own sentence that the count is "literally the number of marks on screen",
  which is larger whenever inline markup splits a hit. The unit test asserts distinct keys rather
  than mark elements for the same reason. Phase 2 took the identical correction in the same pass.
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
