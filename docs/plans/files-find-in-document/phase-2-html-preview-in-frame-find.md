# Phase 2 - Character-accurate find inside the HTML preview

## Outcome

Find in an HTML preview marks the words a reader can actually see, counts only those, and
steps between them - the same behaviour Markdown preview and the Editor got in Phase 1 -
without weakening the sandbox that renders untrusted checkout HTML.

Value: HTML is what this repository's own report and plan skills generate, so it is the
document type most often being read in the Files tab. Phase 1 can tell you which block a
match is in; this phase tells you which word, and stops counting matches that exist only in
markup.

## Entry criteria and dependencies

**Depends on Phase 1.** It needs `documentFind.ts`, `FindBar` (including its optional note,
which this phase retires), and `FileWorkspace` owning the find session and the chord.

## Scope

- One new hash-pinned bridge script in `src/web/lib/htmlPreview.ts`, and the CSP
  `script-src` hash that admits it.
- Highlighting inside the frame without mutating its DOM.
- The frame reporting its own match count and current position, which becomes the count the
  bar shows for HTML documents.
- Forwarding the find chord out of the frame, so Cmd+F works while the reader's focus is
  inside the preview.
- Retiring Phase 1's "matches located by block" note for HTML documents.
- Updating `test/html-preview.test.ts`, which recomputes every script hash.

## Non-goals

- Any change to the other three bridge scripts or their hashes. Their bodies stay byte-identical
  so their hashes do not move.
- Any change to `HTML_PREVIEW_SANDBOX`. `allow-scripts` alone, and `allow-same-origin` never.
- Scouts behaviour. Scouts shares this module and must render exactly as it does today when
  the parent never sends a find message.
- Any new capability for the frame: it reads the document it is already inside and posts to
  the parent that sent it, like the other three bridges. No fetch, no navigation, no token.

## Repository findings

1. **The boundary is shared and hash-pinned.** `src/web/lib/htmlPreview.ts` is the dashboard's
   one sandboxed preview, used by both the Files tab and Scouts. `PREVIEW_CSP` names exactly
   three SHA-256 script hashes; `allow-scripts` runs those three and the document's own
   `<script>` is blocked by the hash allowlist rather than by the sandbox.
   `test/html-preview.test.ts` extracts each script and recomputes its hash, which is what
   makes a stale hash a loud failure instead of a bridge that silently never runs.
2. **A script body may not contain a literal less-than character.** The hash test extracts
   script bodies with a regex that stops at the first `<`, so one comparison operator
   truncates the body and fails the test - the loud version - or, worse, ships a body whose
   hash no longer matches. The module says so at length above `PREVIEW_COMMENT_SCRIPT`.
3. **Element insertion would break HTML comments.** The comment bridge addresses a block by
   indexing element children from `document.body`, and the daemon resolves that same path
   against a parse5 tree of the source. Wrapping matches in `mark` elements inserts elements
   into the live tree and shifts those indices, so a comment anchored afterwards would resolve
   to a neighbour. Highlighting therefore must not touch the DOM at all - see the decision
   below.
4. **A keystroke inside the frame does not reach the parent.** The scroll bridge forwards only
   Tab and Escape, and handles `u`/`d` itself, and only while the parent has armed the
   keyboard bridge. So Cmd+F with focus inside the preview is currently lost.
5. **The existing readiness signal belongs to the comment bridge and cannot speak for a later
   script.** `PREVIEW_COMMENT_SCRIPT` posts `HTML_PREVIEW_READY_MESSAGE` as its last act, and
   the module's comment above it says why: "an arm message posted a moment early reaches a
   window with no listener and is simply lost", so "the LAST thing this script does is tell the
   parent it exists, and the parent replies with the current state. Ordering stops being a
   question anybody has to get right." That guarantee is about the script that sends it. The
   comment bridge is the second of the three injected scripts and the link bridge already runs
   after it, so a find bridge injected fourth would be announced ready by a script that had not
   yet run - reintroducing precisely the race that sentence removed, with a silent failure
   mode: the parent's first find message arrives at a window with no find listener, is lost,
   and nothing highlights until the reader edits the query. The find bridge therefore posts its
   own readiness message.
   The same signal is load-bearing for a second reason. The preview's `srcDoc` is rebuilt from
   the debounced, stylesheet-inlined `previewText`, so an edit to the file reloads the document
   and destroys the highlight along with it. A parent that replies to find-readiness with the
   current find state restores the highlight after every such reload; a parent that only posts
   on change does not.
6. **Escape from inside the frame already has a meaning.** The keyboard bridge posts an "exit"
   action, which the workspace uses to hand focus back to the file list. With find open, that
   same message must close find first. This is a parent-side decision and needs no script
   change.
7. **A previewed document is full of text nobody can see.** `title`, `style`, `script`,
   `template` and `noscript` contents are ordinary text nodes, and so is text inside a
   `display: none` or `visibility: hidden` subtree. The preview adds to that itself: the CSP
   meta, the injected style block and the bridge scripts land in the head, and
   `inlinePreviewStyles` rewrites each checkout `link` into a `style` element **wherever that
   link appeared**, so a stylesheet's text can sit in the body. A naive text-node walk would
   count matches in all of it, which is precisely the promise this phase is making. An
   attribute-only test case cannot expose this, because an attribute value is not a text node
   and a naive walk already reports zero for it. Nor can geometry alone expose it:
   `visibility: hidden` and `opacity: 0` text is laid out and returns client rects, so it is
   invisible to a reader and perfectly visible to `getClientRects()`.

## Decisions recorded in this phase

- **Highlight with the CSS Custom Highlight API, not with `mark` elements.** The bridge builds
  `Range` objects over rendered text nodes and registers them in `CSS.highlights`, styled by
  `::highlight()` rules added to the existing injected style block (`style-src 'unsafe-inline'`
  already permits it, so this adds no policy). Nothing is inserted into the document, so
  finding 3's block paths keep resolving and comment mode is unaffected. If the API is absent at
  runtime the bridge does not mutate the DOM instead - it declares that it cannot highlight, and
  the parent keeps Phase 1's block reveal.
- **Incapacity is declared, never reported as a result.** The readiness message carries whether
  this frame can highlight, and the parent retires the block reveal and the bar's note **only
  when readiness says it can**. A frame that cannot highlight must not answer with a count of
  zero: zero is a claim about the document, and a query that does match would then get no
  highlight, no block reveal, and a number saying there is nothing to find - worse than either
  mode alone. The result message reports results; the ready message reports capability. Keeping
  those two apart is what makes the fallback reachable at all.
- **Only text the frame can actually paint is counted.** A text-node walk is not a rendered-text
  walk, and the difference is the whole promise of this phase (finding 7). Three gates, in this
  order:
  1. **Skip by container.** Never descend into `script`, `style`, `template`, `title`,
     `noscript` or a comment node - remembering that `inlinePreviewStyles` rewrites a checkout
     `link` into a `style` element wherever that link sat, so CSS text can appear in the body
     and not only in the head.
  2. **Skip by visibility, with the options spelled out.** `Element.checkVisibility()` does
     **not** consider `visibility: hidden` or `opacity: 0` by default - it answers `true` for
     both - so the bare call would pass exactly the text this phase promises to exclude. Call it
     with the flags set, and pass both the current and the original spellings, since unknown
     dictionary members are ignored and the two names shipped at different times:
     `{ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true,
     checkOpacity: true, contentVisibilityAuto: true }`. Keep a computed-style fallback for
     `display` and `visibility` where the method is absent.
     The fallback reads the **nearest element's own computed** `visibility`, which is the right
     question rather than a convenience: `visibility` inherits and a descendant may re-assert
     `visible` inside a hidden subtree, so an ancestor scan would wrongly drop text a reader can
     actually see, while the computed value already accounts for both.
  3. **Gate on paintable geometry.** A candidate `Range` whose `getClientRects()` is empty
     generates no box at all, so it cannot be highlighted and must not be counted. This catches
     `display: none`, a collapsed ancestor, a zero-size box and whatever the container list did
     not think of - but it is **not** a paintedness test and must not be trusted as one:
     `visibility: hidden` and `opacity: 0` text is laid out and still returns rects, which is
     precisely why gate 2 carries its own flags rather than leaning on this one.

  The count the frame reports is the number of ranges that survive all three gates, which is
  exactly the number it highlighted. A count that can disagree with the highlights is the defect this
  phase exists to remove, not a rounding error.
- **The new script owns the chord forwarding.** Putting it in the new bridge rather than
  extending the existing scroll bridge keeps the other three bodies and hashes untouched
  (non-goal 1), so the diff against the security boundary is one added script and one added
  hash.
- **The find bridge announces its own readiness, and the parent answers it with state.** A
  distinct `PREVIEW_FIND_READY_MESSAGE`, posted as the find script's last act, with the parent
  replying with the current query, case flag and index - exactly the arm-on-ready handshake
  `armFrame` already performs for comment mode. Nothing keys off another script's ready
  message (finding 5). One handshake covers three cases that would otherwise each need their
  own reasoning: find opened before the document finished loading, find already open when the
  reader selects an HTML file, and the `srcDoc` reload that follows every edit.
- **For HTML documents, the frame's count is the count.** It counts what is rendered, which is
  the invariant the whole feature rests on: every counted match is one a person can see. The
  source-derived count Phase 1 used for HTML is replaced, and the bar's note goes with it.

## Implementation steps

1. **`src/web/lib/htmlPreview.ts`**:
   - add `PREVIEW_FIND_MESSAGE` (parent to frame: query, case flag, current index, or a clear),
     `PREVIEW_FIND_RESULT_MESSAGE` (frame to parent: count, current index), and
     `PREVIEW_FIND_READY_MESSAGE` (frame to parent, posted by the find script as its last act -
     never reuse the comment bridge's ready message, finding 5 - carrying whether this frame can
     highlight, so the parent can decide whether the fallback is still needed);
   - add `PREVIEW_FIND_SCRIPT`, gated on `event.source === parent` like every other bridge,
     which walks text nodes **through the three gates in the decision above** - skipping
     non-rendered containers, then invisible subtrees (with `checkVisibility`'s flags spelled
     out, never the bare call), then dropping any range with no client rects - builds ranges from what survives, registers them under a named highlight, scrolls
     the current range into view, posts the surviving count, and clears on an empty query. It
     also forwards the find chord up and announces itself when ready. No literal `<` anywhere
     in the body (finding 2);
   - add its hash to `PREVIEW_CSP` and inject the script in `htmlPreviewSource` after the
     existing three;
   - add the `::highlight()` rules to `PREVIEW_COMMENT_STYLE` (or a sibling constant), in the
     app's find colours;
   - export the two message constants beside the existing ones.
2. **`src/web/components/FileWorkspace.tsx`**:
   - post the current find state to the frame whenever the find bridge announces readiness,
     and on every later query, case-flag and index change, and on clear. The readiness reply is
     not an optimisation: without it the first message can be lost and nothing highlights until
     the reader edits the query, and the highlight does not come back after a `srcDoc` reload
     (finding 5). Follow `armFrame`'s existing shape rather than inventing a second handshake;
   - accept the result message (verifying `event.source` is the preview frame, as the block
     handler already does) and use its count and index for HTML documents;
   - treat the keyboard bridge's exit action as "close find" while find is open (finding 6);
   - drop the block-reveal call and the bar's note only once **the find bridge specifically** has
     reported ready **and that report says it can highlight**. Keep both until then, again after
     a reload that has not yet re-announced, and permanently in a frame that declared it cannot
     highlight - which is the one path where Phase 1's behaviour is the finished behaviour rather
     than a stopgap.
3. **`test/html-preview.test.ts`**: extend the hash recomputation to the fourth script, and
   assert the CSP lists exactly four hashes and still carries `default-src 'none'`,
   `connect-src 'none'` and no `allow-same-origin`.

## Tests and verification

- `test/html-preview.test.ts`: hashes recomputed for all four scripts; CSP invariants asserted;
  a test that the find script body contains no literal `<`.
- `e2e/specs/file-find-in-document.spec.ts` (extended, not replaced). One HTML fixture carrying
  the query in every place it must NOT be counted, because the count is the claim:
  - in visible prose (the only occurrences the count may include);
  - inside an attribute value;
  - inside a `style` element in the **body**, which is where `inlinePreviewStyles` puts an
    inlined checkout stylesheet, and inside a `script` element;
  - inside the document `title`;
  - inside a `display: none` subtree and a `visibility: hidden` one.

  Assert that the reported count equals the visible occurrences alone, that the number of
  highlighted ranges equals that count, that stepping moves the highlight, and that the
  document's own script still never runs (the no-script assertion in
  `file-default-view.spec.ts` is the precedent). An attribute-only case is not sufficient
  coverage here and must not be mistaken for it - see finding 7.
- A Scouts spec run to confirm an archived report still renders and comments unchanged.
- A case where the frame declares it cannot highlight: the bar keeps its note, the count stays
  source-derived, and stepping still reveals the block. Reachable in a test by having the bridge
  report the capability as false rather than by finding a browser without the API.
- `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build && npm run test:e2e`.

## Merge and exit criteria

- Find in an HTML preview marks visible text, counts only visible matches, and steps. The
  reported count equals the number of highlighted ranges on a document that also contains the
  query in a head element, a body `style`, a `script`, an attribute and a hidden subtree.
- Cmd+F works with focus inside the preview.
- A query typed before the preview finished loading highlights as soon as it loads, with no
  second keystroke, and the highlight returns by itself after an edit reloads the `srcDoc`.
- No behaviour keys off the comment bridge's ready message. Injecting the find script in any
  position must not change the outcome.
- With highlighting unavailable, a matching query still gets Phase 1's block reveal, its note,
  and its source-derived count. There is no state in which a reader gets no highlight, no block
  reveal, and a count of zero.
- The CSP admits exactly four hashes, carries no new directive relaxation, and the sandbox
  attribute is unchanged.
- HTML comments still anchor and resolve while find is open, with a highlight active.
- Scouts renders and comments exactly as before.
- The bar shows no block-level note for HTML documents.
- All four gates green.

## Downstream handoff

Nothing depends on this phase. If a later surface wants find inside a sandboxed preview -
Scouts is the obvious candidate - it reuses this bridge and its messages rather than adding a
fifth script. The handshake travels with it: the find bridge's own readiness message and the
parent's reply carrying current state are part of the contract, and no consumer may substitute
another script's ready signal for it.

## Cross-phase audit record

- Reconciled against Phase 1 as written: Phase 1 must let the bar's count come from a value
  the workspace supplies rather than deriving it from `hits.length` in the bar, because this
  phase replaces the source of that number for HTML documents. Phase 1's downstream handoff
  and audit record were amended to state that contract, rather than this phase working around
  a bar that hard-codes it.
- Phase 1's `documentFind.ts` matcher stays the only matcher for Markdown and the Editor. The
  frame necessarily matches over rendered text with its own literal scan; that is a different
  string, not a second policy, and the bridge reports positions rather than re-deciding what
  counts as a match.
- Phase 1 introduces the HTML note; this phase retires it. Both files say so.
- Review round 1 (PR #818): the bridge was specified as walking text nodes while promising a
  visible-only count, which it could not have delivered - head and body `style`, `script`,
  `template`, `title` and hidden subtrees are all text nodes, and the attribute-only test case
  would have passed a naive implementation. Finding 7, the counting gates in the decisions,
  the implementation step, the fixture coverage and the exit criteria were all amended
  together. Phase 1 needed no change: its Markdown adapter runs on a hast tree with no raw
  HTML, script or style nodes, and its HTML count is explicitly source-derived and labelled as
  such until this phase replaces it.
- Review round 2 (PR #818): the find bridge was specified as reusing
  `HTML_PREVIEW_READY_MESSAGE`, which the comment bridge posts - the second of three injected
  scripts, with the link bridge already running after it. A fourth script announced by a script
  that has not yet run reintroduces the arming race `htmlPreview.ts` documents at length, and
  fails silently: the first find message reaches a window with no find listener and nothing
  highlights until the reader edits the query. The find bridge now owns
  `PREVIEW_FIND_READY_MESSAGE` and the parent answers it with current state, following
  `armFrame`'s existing shape. The same handshake closes a second hole the review did not name:
  the debounced `previewText` rebuilds `srcDoc` on every edit, reloading the document and
  destroying the highlight, which a post-on-change-only parent never restores. Finding 5, the
  decisions, both implementation steps, the exit criteria and the downstream handoff were
  amended together. Phase 1 needed no change - it posts nothing into the frame beyond the
  existing target message, which is request-response and carries no state.
- Review round 4 (PR #818): the visibility gate was specified as a bare
  `Element.checkVisibility()`, which in Chromium ignores `visibility: hidden` and `opacity: 0`
  by default and answers `true` for both - so the prescribed implementation would have counted
  and "highlighted" the fixture's hidden occurrence, failing this phase's own promise and its
  own test. Round 1's claim that the geometry gate is "the authority" was the deeper error and
  is corrected with it: `getClientRects()` proves a box EXISTS, not that anything is painted,
  and hidden or fully transparent text is laid out and returns rects. The gate list is now three
  - container, visibility with every flag spelled out (both the current and original option
  spellings, plus a computed-style fallback reading the nearest element's own `visibility`,
  because that property inherits and a descendant may re-assert it), then geometry - and the
  geometry gate is explicitly labelled as not a paintedness test.
- Review round 3 (PR #818): the decisions promised Phase 1's block reveal when the CSS Custom
  Highlight API is unavailable, while the implementation step retired that fallback the moment
  the bridge reported ready. A frame without the API announces readiness too, so the reader
  would have been left with no highlight, no block reveal, and a count of zero on a query that
  matches. Readiness now carries the capability, the fallback is retired only on a report that
  says it can highlight, and incapacity is declared on the ready message rather than disguised
  as a zero result. Recorded in the decisions, both message and parent steps, the exit criteria
  and the test list.
