# Phase 5: Preview surfaces

## Outcome

Comment mode works where you actually read a spec: hover any paragraph, heading, table, code block
or diagram in Markdown Preview, or any block in HTML Preview, and leave a comment anchored to its
exact source lines. The feature now covers every surface decision 1 approved.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 2**, merged. This phase reuses the thread and composer components and
  the comment eligibility predicate rather than reimplementing them.
- May merge in either order with **Phase 3** and **Phase 4**. It consumes no contract they own, and
  they consume none of its. Expect a textual conflict in `FileWorkspace.tsx`: this phase edits the
  renderer branch (`:446-487`), phase 3 edits the toolbar region (`:422-444`).

## Scope

1. **Markdown block anchors.** `src/web/components/Markdown.tsx` gains one more **opt-in** prop, in
   the same shape as the existing `diagramRenderers` opt-in that `FileWorkspace` alone passes: a
   block-anchor callback. When present, block-level components read `node.position` and wrap their
   output in an anchor host carrying the line range.
   - **The prop must be added to `markdownPropsEqual` (`Markdown.tsx:242-251`)** or the memo
     silently ignores changes to it. This is the single easiest thing to get wrong here.
   - It must default to absent, not to an empty object: `undefined` is the "off" signal the file
     already uses (`if (!diagramRenderers) return { a: anchor };`, `:173`).
   - Nine other callers render `<Markdown>` bare - conversations, plans, Foreman notes and
     episodes, recommendations, scout reports, and three Library editors. All must render
     byte-for-byte as today. That containment is the rule the Mermaid work established
     (`Markdown.tsx:108-110`).
2. **The HTML preview bridge.** A third hashed script in `src/web/lib/htmlPreview.ts`, inert until
   the parent enables comment mode over the existing `postMessage` channel. While enabled, a click
   reports the nearest block-level ancestor's bounded `textContent` and its structural index path.
   - It gains **no capability the two existing bridges lack** - it reads the document it is inside
     and posts to the parent that sent it - and it never gets `allow-same-origin`.
   - `HTML_PREVIEW_SANDBOX` stays a single exported constant so no call site can add a token.
   - **`test/html-preview.test.ts:25` hard-codes `assert.equal(scripts.length, 2)`** and must become
     3. The extraction regex is `/<script>([^<]+)<\/script>/g`, so **the bridge body must contain no
     literal `<`** - the existing link bridge uses `instanceof Element` rather than a comparison
     operator for exactly this reason.
   - The hash is a hand-written base64 SHA-256 constant with no build step; the test recomputes it
     from the emitted script, so an edited bridge with a stale hash fails there rather than failing
     invisibly as a bridge that simply does not run.
   - `src/web/components/scouts/ScoutReader.tsx` shares this module. It must be unaffected: the
     bridge is inert unless the parent enables it, and Scouts never will.
3. **Resolving reported text to a source line** in the parent, by searching the file. Where the text
   is not unique the thread still carries its exact quote and reports its line as **approximate**
   rather than inventing one.
4. **`docs/ui.md`** - the preview surfaces.

## Non-goals

- No comments on images. They have no lines; the control stays disabled with a reason.
- No comments in the Scouts report viewer, which shares the preview boundary but not the checkout
  write model.
- No change to delivery, the walkthrough, or the MCP tool.
- No new sandbox token, ever.

## Repository findings this phase rests on

- **Markdown line mapping is verified, not assumed.** Running this repository's exact plugin chain
  (`remark-parse` → `remark-gfm` → `remark-rehype` → `rehype-highlight`) shows every top-level hast
  element retains `position.start.line` and `position.end.line`, and `rehype-highlight` does not
  strip them. `react-markdown@10` passes that node to a custom component as `node?: Element`. The
  `pre` override already receives and uses `node` (`Markdown.tsx:176`), which is the existing hook.
- **The sandbox is hash-gated, not sandbox-gated.** `PREVIEW_CSP` names exactly two SHA-256 hashes;
  the previewed document's own JavaScript is blocked by that allowlist. The header at
  `htmlPreview.ts:3-25` states that neither consuming surface may weaken the policy for its own
  documents.
- `test/html-preview.test.ts` also pins a strict ordered regex over the link bridge body
  (`:40-52`), the CSP-before-`<title>` ordering (`:9-17`), and `doesNotMatch(/allow-same-origin/)`.
  A third bridge must leave all of those passing.

## Verification

- `test/html-preview.test.ts` - updated count, and the recomputed-hash assertion covering all three
  scripts.
- `test/markdown-block-anchors.test.ts` - `renderToStaticMarkup` proving the anchor host carries the
  right line range for each block type, and proving a bare `<Markdown>` renders identically to
  before. Add a case pinning that the new prop is present in `markdownPropsEqual`.
- `e2e/specs/file-comment-preview-surfaces.spec.ts` - comment on a Markdown block and on an HTML
  block; assert each anchors to the right source line by opening the Editor and checking the marker
  is on that line. Flip to the Console layout first.
- Confirm the Scouts reader is untouched by running its existing specs.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- A comment made in Markdown Preview lands on the same source line the Editor shows.
- A comment made in HTML Preview lands on the right line, or is honestly marked approximate.
- All nine bare `<Markdown>` callers render unchanged.
- The preview sandbox has three hashed scripts, no `allow-same-origin`, and one exported sandbox
  constant.
- The Scouts report viewer is unaffected.

## Downstream handoff

This is the last phase. The feature is complete: comment mode on three surfaces, a queue that walks
one comment at a time, and replies that land in the thread.

Anything that follows - a `list_file_comments` read tool, suggested-edit blocks, diff-hunk comments,
cross-file threads - is out of this plan's scope and starts a new one.

## Cross-phase audit record

- Initial authoring, after Phase 4.
- Confirmed this phase consumes only Phase 2's contracts (anchor module, eligibility predicate,
  thread components) and therefore does not depend on Phase 3 or 4. Concurrency recorded in
  `phased-plan.md`.
- Recorded the `markdownPropsEqual` obligation as a first-class scope item rather than an
  implementation detail: it is a silent failure, not a loud one.
- Recorded the no-literal-`<` constraint on the third bridge, which is not obvious from reading
  `htmlPreview.ts` alone and is only visible in the test's extraction regex.
