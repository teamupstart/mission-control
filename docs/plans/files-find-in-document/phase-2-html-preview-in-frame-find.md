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
5. **The frame already announces readiness.** The comment bridge posts
   `HTML_PREVIEW_READY_MESSAGE` as its last act, precisely because the parent cannot know when
   a `srcdoc` document finished running its scripts. The find bridge uses the same signal, and
   the parent falls back to Phase 1's block reveal until it arrives.
6. **Escape from inside the frame already has a meaning.** The keyboard bridge posts an "exit"
   action, which the workspace uses to hand focus back to the file list. With find open, that
   same message must close find first. This is a parent-side decision and needs no script
   change.

## Decisions recorded in this phase

- **Highlight with the CSS Custom Highlight API, not with `mark` elements.** The bridge builds
  `Range` objects over text nodes and registers them in `CSS.highlights`, styled by
  `::highlight()` rules added to the existing injected style block (`style-src 'unsafe-inline'`
  already permits it, so this adds no policy). Nothing is inserted into the document, so
  finding 3's block paths keep resolving and comment mode is unaffected. If the API is absent
  at runtime, the bridge reports zero and the parent keeps Phase 1's block reveal - a
  degradation, never a DOM mutation.
- **The new script owns the chord forwarding.** Putting it in the new bridge rather than
  extending the existing scroll bridge keeps the other three bodies and hashes untouched
  (non-goal 1), so the diff against the security boundary is one added script and one added
  hash.
- **For HTML documents, the frame's count is the count.** It counts what is rendered, which is
  the invariant the whole feature rests on: every counted match is one a person can see. The
  source-derived count Phase 1 used for HTML is replaced, and the bar's note goes with it.

## Implementation steps

1. **`src/web/lib/htmlPreview.ts`**:
   - add `PREVIEW_FIND_MESSAGE` (parent to frame: query, case flag, current index, or a clear)
     and `PREVIEW_FIND_RESULT_MESSAGE` (frame to parent: count, current index);
   - add `PREVIEW_FIND_SCRIPT`, gated on `event.source === parent` like every other bridge,
     which walks text nodes, builds ranges, registers them under a named highlight, scrolls
     the current range into view, posts its count, and clears on an empty query. It also
     forwards the find chord up and announces itself when ready. No literal `<` anywhere in
     the body (finding 2);
   - add its hash to `PREVIEW_CSP` and inject the script in `htmlPreviewSource` after the
     existing three;
   - add the `::highlight()` rules to `PREVIEW_COMMENT_STYLE` (or a sibling constant), in the
     app's find colours;
   - export the two message constants beside the existing ones.
2. **`src/web/components/FileWorkspace.tsx`**:
   - post the find message to the frame on query, case-flag and index changes, and on clear;
   - accept the result message (verifying `event.source` is the preview frame, as the block
     handler already does) and use its count and index for HTML documents;
   - treat the keyboard bridge's exit action as "close find" while find is open (finding 6);
   - drop the block-reveal call and the bar's note once the frame has reported ready; keep
     both as the fallback path when it has not (finding 5).
3. **`test/html-preview.test.ts`**: extend the hash recomputation to the fourth script, and
   assert the CSP lists exactly four hashes and still carries `default-src 'none'`,
   `connect-src 'none'` and no `allow-same-origin`.

## Tests and verification

- `test/html-preview.test.ts`: hashes recomputed for all four scripts; CSP invariants asserted;
  a test that the find script body contains no literal `<`.
- `e2e/specs/file-find-in-document.spec.ts` (extended, not replaced): on an HTML fixture whose
  markup contains the query inside an attribute as well as in visible text, assert the count
  equals the visible occurrences only, that stepping moves the highlight, and that the
  document's own script still never runs (the existing no-script assertion in
  `file-default-view.spec.ts` is the precedent).
- A Scouts spec run to confirm an archived report still renders and comments unchanged.
- `npm run typecheck`, `npm run lint`, `npm test`, then `npm run build && npm run test:e2e`.

## Merge and exit criteria

- Find in an HTML preview marks visible text, counts only visible matches, and steps.
- Cmd+F works with focus inside the preview.
- The CSP admits exactly four hashes, carries no new directive relaxation, and the sandbox
  attribute is unchanged.
- HTML comments still anchor and resolve while find is open, with a highlight active.
- Scouts renders and comments exactly as before.
- The bar shows no block-level note for HTML documents.
- All four gates green.

## Downstream handoff

Nothing depends on this phase. If a later surface wants find inside a sandboxed preview -
Scouts is the obvious candidate - it reuses this bridge and its message pair rather than
adding a fifth script.

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
