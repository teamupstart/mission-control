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

- **Match over logical runs, and count logical hits.** The gates above decide which text nodes
  are eligible; the match is then made over a **run** built by joining those nodes, because a
  per-node scan misses matches a reader sees as one word - `foo<strong>bar</strong>` searched for
  `foobar` finds nothing node by node, while the reader sees one continuous word. The rules:
  - a run breaks at every **visible separation**, not only at a block boundary: a `br` (a line
    break with no text node of its own, so `foo<br>bar` must not match `foobar`), and any element
    whose computed `display` is not `inline` or `contents` - which is the definition
    `missionBlock` in the comment bridge already uses, so the two bridges answer "is this one
    box of text" the same way rather than each keeping a tag list;
  - a run is **not** broken by a node the gates excluded for occupying no space at all
    (`display: none`, head content, a `script` or `style` body) - that text is absent from what
    the reader sees, so the visible characters either side of it really are adjacent;
  - a run **is** broken by an excluded node that still occupies layout space, `visibility: hidden`
    being the case that matters: it leaves a visible gap, so joining across it would claim a
    contiguity the reader does not see.

  One logical hit maps to one `Range` even when its ends lie in different text nodes - a Range
  spans element boundaries natively and the Custom Highlight API paints every fragment - so a hit
  split by inline markup is highlighted whole. **The count is logical hits, never the number of
  ranges or the number of client rects**, both of which are larger for a single hit that wraps a
  line or crosses markup. This is the same rule Phase 1's Markdown adapter follows, for the same
  reason.

  The count the frame reports is therefore the number of logical hits that survived the gates,
  which is exactly the number it highlighted. A count that can disagree with the highlights is the defect this
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
     highlight, so the parent can decide whether the fallback is still needed), and
     `PREVIEW_FIND_CHORD_MESSAGE` (frame to parent: the reader pressed the find chord inside the
     preview). The chord message is a **named part of the contract, not an implied side effect**:
     "the script forwards the chord" describes no wire format, and without one the keystroke is
     still lost - which is the whole reason finding 4 exists. The frame's handler calls
     `preventDefault` before posting, so the host browser's own find does not open over the
     dashboard;
   - add `PREVIEW_FIND_SCRIPT`, gated on `event.source === parent` like every other bridge,
     which walks text nodes **through the three gates in the decision above** - skipping
     non-rendered containers, then invisible subtrees (with `checkVisibility`'s flags spelled
     out, never the bare call), then dropping any range with no client rects - joins the eligible
     nodes into per-block runs and matches over those rather than node by node, builds one
     `Range` per logical hit (spanning text nodes where the hit does), registers them under a
     named highlight, scrolls the current one into view, posts the **logical hit count**, and
     clears on an empty query. It also forwards the find chord up and announces itself when
     ready. No literal `<` anywhere in the body (finding 2);
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
   - **handle the chord message**: on receipt, verify `event.source` is this workspace's preview
     frame - the same check the block handler performs, and load-bearing here because a message
     that opens a UI surface must not be actionable by any other frame - then open the find bar
     and focus its input, exactly as the workspace's own chord handler does. One entry point, two
     ways in. Without this handler the message is posted into a parent that ignores it, which
     looks identical to the keystroke being lost;
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

  Assert that the reported count equals the visible occurrences alone, that stepping moves the
  highlight, and that the document's own script still never runs (the no-script assertion in
  `file-default-view.spec.ts` is the precedent). The fixture also carries a match **split by
  inline markup** - `foo<strong>bar</strong>` searched for `foobar` - asserting it counts as one
  hit and highlights whole; a match separated by a `visibility: hidden` span, asserting it does
  **not** join across the visible gap; and `foo<br>bar` searched for `foobar`, asserting a
  rendered line break separates as firmly as a paragraph does. An attribute-only case is not sufficient
  coverage here and must not be mistaken for it - see finding 7.
- The chord path end to end: click into the preview so focus is inside the frame, press the
  chord, and assert the find bar opened with its input focused. Assert too that a chord message
  from any other frame is ignored - the `event.source` check is what keeps a UI-opening message
  from being actionable by an arbitrary sender.
- A Scouts spec run to confirm an archived report still renders and comments unchanged.
- A case where the frame declares it cannot highlight: the bar keeps its note, the count stays
  source-derived, and stepping still reveals the block. Reachable in a test by having the bridge
  report the capability as false rather than by finding a browser without the API.
- `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build && npm run test:e2e`.

## Merge and exit criteria

- Find in an HTML preview marks visible text, counts only visible matches, and steps. The
  reported count equals the number of highlighted ranges on a document that also contains the
  query in a head element, a body `style`, a `script`, an attribute and a hidden subtree.
- Cmd+F works with focus inside the preview: the frame posts the chord message, the workspace
  validates its source and opens the bar with the input focused.
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

## Implementation record

What was built as written, and the three places the repository argued for something else.

**Followed as written.** One added script (`PREVIEW_FIND_SCRIPT`) and one added CSP hash, with
the other three bodies and hashes byte-identical - pinned literally in
`test/html-preview.test.ts`, because recomputing hashes from the emitted scripts proves the CSP
matches them and only a literal can prove the scripts themselves did not move. No sandbox token,
no new directive, no element inserted into the previewed document. `PREVIEW_FIND_READY_MESSAGE`
is the find bridge's own and is posted as its last statement; the parent answers it with current
state; the block-reveal fallback, its note and its source-derived count are retired together on
`htmlInFrame`, and only on a readiness report that says the frame can highlight.

**Deviation 1 - `missionBlock` is called, not restated.** The phase asked run breaks to use "the
definition `missionBlock` in the comment bridge already uses". The find bridge calls
`missionBlock(node)===node` rather than re-expressing the display rule, so the two bridges cannot
drift on what one box of text is. The cross-script reference is order-independent: function
declarations are hoisted per script at execution, and the call happens inside a message handler
that runs long after all four scripts have. That keeps the phase's own exit criterion - injecting
the find script in any position must not change the outcome.

**Deviation 2 - the CAPABILITY survives a `srcDoc` reload; the COUNT does not.** The phase asked
the fallback to return "again after a reload that has not yet re-announced", and this was first
read as "drop everything", then rejected wholesale on the grounds that it fires on every
debounced revision and flashes the count and the "by block" note in and out. **Half of that was
wrong, and GitHub Inspector caught it on PR #827 (round 2).** The two facts pull apart:

- *The count is about one document.* A reload destroys the old document's `CSS.highlights`, so a
  count carried across it describes highlights that no longer exist - the same
  count-to-highlight break as round 1, in a window the size of a parse, a style pass and four
  scripts rather than a message round trip. `frameFindCount` is therefore keyed on the previewed
  source as well as the query and the case flag, and reads null across a reload. The flicker
  that argued against clearing was `No results`, which round 1's fix removed: once "not known"
  is representable, clearing is free.
- *The capability is about the browser.* Whether `CSS.highlights` exists does not change because
  a document reloaded, so `htmlFindBridge` is dropped on document identity changes and when the
  preview leaves the screen, not on every revision. Dropping it per revision would flap to the
  block-reveal fallback - the daemon resolve, the outline and the note - for a document that is
  about to highlight perfectly well.

So the fallback returns on a reload in the only sense that matters: the bar stops claiming a
number. `a query typed before the preview loaded highlights by itself, and survives an edit`
covers the restore, and `a count does not survive the srcDoc reload that destroys the highlights
it counted` in `test/document-find.test.ts` covers the interval.

**Deviation 3 - a superseded reply is unknown, not the previous count and not zero.** The result
message echoes the query it counted, as specified. What to show for the round trip after that
took two attempts, and the first was wrong:

- *Rejected, and shipped briefly:* keep the previous count. The reasoning was that carrying the
  last agreed number beat flashing `No results` over a query that matches. It ignored the frame,
  which applies the new query and repaints **before** its reply is delivered - so changing a
  three-hit query to a no-hit one showed `1 / 3` over a document with nothing highlighted. That
  is the count-to-highlight invariant this phase exists to establish, broken by the phase itself.
  Found by GitHub Inspector on PR #827.
- *Rejected:* zero. The bar renders zero as `No results`, which is a claim about the document,
  and the old highlights may still be painted when it is made. Wrong in the mirror direction.
- *Taken:* **null, meaning not known yet.** `frameFindCount` in `documentFind.ts` owns the rule
  and is unit-tested against Inspector's exact scenario; `FindBar` accepts `count: number | null`
  and renders null as no number at all, with stepping disabled, because it cannot offer a ring
  whose size it does not know. Only a query or case-flag change opens that window - stepping
  leaves both alone - so a reader pressing Enter never sees it.

**Correction found in completion review - a hidden element is not terminal.** The gate list as
written stops at `visibility: hidden`, and the first implementation stopped the WALK there too.
`visibility` inherits, so a descendant may set `visibility: visible` and be genuinely on screen
inside a hidden subtree - and a walk that never entered the hidden element cannot find it however
carefully it asks about the element it did reach. This is round 4's defect arrived at from the
other side: that round fixed a gate that counted invisible text, this one fixed a walk that
missed visible text. The walk now descends carrying whether the current subtree is lit, a text
node is eligible when the nearest element above it is lit, and run breaks are driven by a
visibility transition (`lit!==shown`) as well as by a box - so entering a hidden subtree breaks
the run and a re-asserting paragraph inside it is broken away on both sides. `display: none`
stays terminal, because it removes the subtree from layout and nothing can put it back; so does
`opacity: 0`, which `checkVisibility` reports for a descendant as well as for the element that
set it. The `visibility: hidden` div in the counting fixture now carries two children - the
hidden text that must still not be counted, and `#reasserted`, which must be - so one subtree
proves both directions. Reverting the descent makes that spec report 2 where it must report 3.

**Also worth naming.** In-frame hits carry no source line, because the frame never sees the
file's bytes - so the Preview/Editor toggle can no longer carry the reader's place across for an
HTML document and starts the new surface's ring at its first hit. Lining the frame's ordinals up
against the source's would have been worse: they are ordinals over different sets, so the reader
would land on a match they had not selected. The scroll of the current hit is
`scrollIntoView({block:"nearest"})` on the hit's nearest element followed by a rect-based
`scrollBy`, which handles a nested scroll container and then centres the word itself; both are
instant rather than smooth, because a find step is not a reveal.

Phase 1's `a closed find leaves the last HTML outline standing` test is deleted, as Phase 1 said
it should be: in-frame find posts no target message, so no outline is set, and an empty query
clears the highlight outright.

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
- Review round 7 (PR #818): two fixes here. Run joining was defined as "within a block", which
  over-joins in the other direction - `foo<br>bar` would match `foobar`, and a `br` is a visible
  line break with no text node of its own to notice. Runs now break at every visible separation,
  defined by computed display exactly as `missionBlock` already defines a block, so the two
  bridges answer "is this one box of text" the same way. Second: the chord forwarding had no
  message and no parent handler - "the script forwards the chord" describes no wire format, so
  the keystroke stayed lost, which is the very gap finding 4 names.
  `PREVIEW_FIND_CHORD_MESSAGE` and a source-validated parent handler are now part of the
  contract, with the frame calling `preventDefault` first so the host browser's find does not
  open instead. Phase 1 took the matching run-break correction in the same pass.
- Review round 6 (PR #818): the gates decided which nodes were eligible but the match was still
  described node by node, so `foo<strong>bar</strong>` searched for `foobar` would have found
  nothing - the mirror image of round 1's defect, missing visible text instead of counting
  invisible text. The match is now made over per-block runs of eligible nodes, one logical hit
  maps to one `Range` even across node boundaries, and the count is logical hits rather than
  ranges or client rects. Run joining follows the gates: skip a node that occupies no space and
  keep the run intact, break the run at one that occupies space (`visibility: hidden` leaves a
  visible gap). Phase 1 took the same correction in the same pass, which is what keeps the two
  surfaces honest about the same question.
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
