# Phase 5: Preview surfaces

## Outcome

Comment mode works where you actually read a spec: hover any paragraph, heading, table, code block
or diagram in Markdown Preview, or any block in HTML Preview, and leave a comment anchored to its
exact source lines. The feature now covers every surface decision 1 approved.

## Entry criteria and dependencies

- **Direct prerequisite: Phase 3**, merged. The *code* this phase needs comes from phase 2 - the
  thread and composer components and the comment eligibility predicate, none of which it
  reimplements. It waits on phase 3 for a different reason: **the anchor-survival measurement**.
- **Read that measurement before writing any code here.** Phase 3's pull request records how many
  comments in a real six-comment review reached the head still anchored. This phase multiplies the
  thing that measurement tests: a preview anchor quotes a whole paragraph, table or code block, so
  it is disturbed by strictly more edits than a two-line editor anchor is. If the number was poor,
  stop and raise it rather than adding two more surfaces on top of it - the fix is phase 3's payload
  scoping instruction, and it is cheaper before this phase than after. If phase 3's PR did not
  record a number at all, that is the same signal.
- May merge in either order with **Phase 4**, which is its concurrent sibling. Neither consumes a
  contract the other owns and they do not collide textually - phase 4 edits `detailTabs.ts` and the
  MCP server, this phase edits `Markdown.tsx`, `htmlPreview.ts`, and `FileWorkspace.tsx`'s renderer
  branch (`:446-487`). **Do not build on phase 4's reply tool or its pip**: this phase may land
  first.

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
3. **Resolving a clicked block to a source line, by structural path and not by text search.**
   This is the part of the phase most likely to be got wrong, so it is specified rather than left
   to the implementer.
   - **Text search cannot do this job.** The DOM `textContent` of
     `<p>Read <strong>this</strong></p>` is `Read this`, which is not a substring of the source at
     all. Nested inline markup, character entities and reflowed whitespace each break the
     equivalence, and all three are ordinary HTML rather than edge cases - so a text-matching
     resolver refuses most real blocks while appearing to work on the simple ones it was tried on.
   - **Parse the source with a position-tracking tokenizer in the parent** and build, for every
     element, its structural path and its start and end line. The bridge already reports the
     clicked block's structural index path, so resolution is a lookup in that map rather than a
     search. Entities, nesting and whitespace never enter into it, because no text is compared.
   - **The quote is the source slice** at the resolved range, not the DOM text. That is what lets an
     HTML thread re-anchor through the same `reanchor()` as an editor thread instead of needing a
     second rule.
   - **Refusal narrows to one honest case:** the structural path does not resolve against the
     current source, which means the file changed under a stale render. Say that, and offer a
     reload. Duplicate headings and repeated paragraphs stop being a problem at all - the whole
     class of ambiguity disappears with the search that created it.
   - There is still deliberately **no "approximately here" state**. `reanchor()` returns unchanged,
     moved or outdated, and phase 1 froze those three.
   - Markdown Preview never takes this path: its blocks carry `node.position` from the parser. Both
     surfaces now take their line range from a parse rather than from matching text, which is the
     property that makes them behave alike.
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
- A comment made in HTML Preview lands on the right line, or is refused with a reason a person can
  act on. Cover the cases a text-matching resolver would have failed: **a block with nested inline
  markup** (`<p>Read <strong>this</strong></p>`), **one containing a character entity**, and **two
  blocks with identical text** - all three anchor correctly, because none is resolved by comparing
  text. Refusal is tested against a stale render, not against duplicate wording.
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
- Confirmed this phase consumes phase 1's anchor module, `reanchor()` and create route, plus phase
  2's eligibility predicate and thread components, and nothing from Phase 3 or 4 in code.
- Review pass: **the prerequisite was moved from Phase 2 to Phase 3 anyway.** Phase 3 states that
  the anchor-survival measurement is owed "before phase 5", but with phase 5 depending only on
  phase 2 the two could run concurrently and this phase could merge before the measurement existed.
  A gate that the graph permits you to walk past is not a gate. Sequencing it behind phase 3 costs
  the old 3-and-5 concurrency and buys a real checkpoint; phases 4 and 5 are the concurrency group
  now, and they conflict in neither contracts nor files. The scheduled task's dependency was
  repointed to match.
- Recorded the `markdownPropsEqual` obligation as a first-class scope item rather than an
  implementation detail: it is a silent failure, not a loud one.
- Recorded the no-literal-`<` constraint on the third bridge, which is not obvious from reading
  `htmlPreview.ts` alone and is only visible in the test's extraction regex.
- Review pass: scope item 3 and the exit criteria disagreed about ambiguous HTML anchors - one
  invented an "approximate" line, the other refused one. Settled on **refusal**, because the
  alternative adds a fourth outcome to a `reanchor()` contract phase 1 froze at three.
- Second review pass, and the more consequential one: **the resolver itself was wrong.** Both sides
  of that disagreement assumed the source could be found by searching it for the block's text, and
  it cannot - `<p>Read <strong>this</strong></p>` has DOM text that appears nowhere in the source,
  and that is ordinary HTML. The design would have refused most real blocks while passing a demo.
  Resolution is now a lookup by structural path against a position-tracking parse of the source -
  a path the bridge was already reporting and the design was not using. The ambiguity question the
  previous pass settled evaporates along with the search that created it.
