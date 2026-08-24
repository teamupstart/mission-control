import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Markdown,
  blockAnchorLabel,
  blockRangeFromNode,
  markdownPropsEqual,
} from "../src/web/components/Markdown.tsx";
import { FILES_DIAGRAM_RENDERERS } from "../src/web/components/markdownDiagramRegistry.tsx";

/**
 * Commenting on a rendered Markdown block.
 *
 * `renderToStaticMarkup` is the right layer for the two claims here that a browser cannot
 * make cheaply: that a block's anchor host carries the SOURCE lines the block came from, for
 * every block type, and - the one that matters more - that a `<Markdown>` rendered WITHOUT
 * the opt-in is byte-for-byte what it was. Nine callers depend on that second claim and none
 * of them would notice it breaking.
 *
 * The e2e spec drives the click, the composer and the anchored line. This proves the markup
 * underneath it.
 */

const DOC = [
  "# The spec",                                 // 1
  "",                                           // 2
  "The retry budget is thirty seconds.",        // 3
  "",                                           // 4
  "## Limits",                                  // 5
  "",                                           // 6
  "| Retries | Window |",                       // 7
  "| --- | --- |",                              // 8
  "| 3 | 30s |",                                // 9
  "",                                           // 10
  "> A quoted caveat.",                         // 11
  "",                                           // 12
  "- first",                                    // 13
  "- second",                                   // 14
  "",                                           // 15
  "```ts",                                      // 16
  "const x = 1;",                               // 17
  "```",                                        // 18
].join("\n");

/** The Files preview: both opt-ins on, which is the only configuration that passes either. */
function renderCommenting(md: string): string {
  return renderToStaticMarkup(createElement(Markdown, {
    children: md,
    diagramRenderers: FILES_DIAGRAM_RENDERERS,
    diagramDocumentKey: "docs/spec.md",
    blockAnchor: () => {},
  }));
}

/** Every anchor host in render order, as the line range it declares. */
function hosts(html: string): { start: number; end: number }[] {
  return [...html.matchAll(
    /<div class="md-block-anchor" data-start-line="(\d+)" data-end-line="(\d+)"/g,
  )].map((match) => ({ start: Number(match[1]), end: Number(match[2]) }));
}

test("every block type is wrapped in a host carrying its own source lines", () => {
  const found = hosts(renderCommenting(DOC));
  // Heading, paragraph, heading, table, quote, the quote's own paragraph, list, fence - each
  // at the lines it was written on, and the multi-line ones spanning all of them.
  assert.deepEqual(found, [
    { start: 1, end: 1 },
    { start: 3, end: 3 },
    { start: 5, end: 5 },
    { start: 7, end: 9 },
    { start: 11, end: 11 },
    { start: 11, end: 11 },
    { start: 13, end: 14 },
    { start: 16, end: 18 },
  ]);
});

test("each host offers one named control, and the name says which lines", () => {
  const html = renderCommenting(DOC);
  assert.match(html, /aria-label="Comment on line 3"/);
  assert.match(html, /aria-label="Comment on lines 7 to 9"/);
  assert.match(html, /aria-label="Comment on lines 16 to 18"/);
  // One control per host, so a reader hovering a paragraph is offered exactly one thing.
  assert.equal([...html.matchAll(/class="md-block-comment"/g)].length, hosts(html).length);
});

test("a nested block is anchored too, and the INNERMOST one is what a hover offers", () => {
  // A paragraph inside a quote is a block in its own right, so it gets its own host. Two
  // buttons visible at once would be the bug, and the stylesheet is where that is settled:
  // `.md-block-anchor:hover:not(:has(.md-block-anchor:hover))` reveals only the deepest one
  // under the pointer, which is the same "nearest block" rule `closest()` gives the HTML
  // preview. Pinned here so the markup and that rule cannot drift apart.
  const html = renderCommenting("> A caveat.\n");
  assert.equal(hosts(html).length, 2, "the quote and its paragraph are both anchorable");
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.md-block-anchor:hover:not\(:has\(\.md-block-anchor:hover\)\) > \.md-block-comment/,
  );
});

test("a Mermaid fence is anchored like any other block, and still renders as a diagram", () => {
  const html = renderCommenting("```mermaid\ngraph TD;\nA-->B;\n```\n");
  assert.deepEqual(hosts(html), [{ start: 1, end: 4 }]);
  // The diagram host, not a `<pre>`: the anchor wraps what the registry produced rather than
  // replacing it.
  assert.doesNotMatch(html, /<div class="md-block-anchor"[^>]*><pre>/);
});

test("a bare Markdown renders exactly what it rendered before the opt-in existed", () => {
  // The containment rule, and the reason this file exists at all. Nine callers render
  // `<Markdown>` bare - conversations, plans, Foreman notes and episodes, recommendations,
  // scout reports, three Library editors - and a wrapper appearing in any of them would be a
  // silent layout change nobody asked for.
  const bare = renderToStaticMarkup(createElement(Markdown, { children: DOC }));
  assert.doesNotMatch(bare, /md-block-anchor/);
  assert.doesNotMatch(bare, /md-block-comment/);
  assert.doesNotMatch(bare, /data-start-line/);
  assert.match(bare, /^<h1>The spec<\/h1>/);
});

test("the Files preview WITHOUT comment mode is also unchanged", () => {
  // Comment mode is a state, not a mount: turning it off has to give the diagram-rendering
  // preview back exactly, or the document reflows every time the reader toggles `m`.
  const off = renderToStaticMarkup(createElement(Markdown, {
    children: DOC,
    diagramRenderers: FILES_DIAGRAM_RENDERERS,
    diagramDocumentKey: "docs/spec.md",
  }));
  assert.doesNotMatch(off, /md-block-anchor/);
  const bare = renderToStaticMarkup(createElement(Markdown, { children: DOC }));
  // The two differ only where a fence becomes a diagram, and this document has none.
  assert.equal(off, bare);
});

test("the memo comparator sees the new prop", () => {
  // The single easiest thing to get wrong here, and it fails SILENTLY: a prop absent from
  // `markdownPropsEqual` means the memo skips the render, the body's ref is never refreshed,
  // and every block button keeps calling the previous closure - which carries the file, the
  // revision and the draft controller. So a comment written after switching files would be
  // filed against the file before it.
  const base = { children: DOC };
  const first = (): void => {};
  const second = (): void => {};
  assert.equal(markdownPropsEqual(base, base), true);
  assert.equal(
    markdownPropsEqual({ ...base, blockAnchor: first }, { ...base, blockAnchor: first }),
    true,
  );
  assert.equal(
    markdownPropsEqual({ ...base, blockAnchor: first }, { ...base, blockAnchor: second }),
    false,
    "a new handler must not be skipped",
  );
  assert.equal(
    markdownPropsEqual(base, { ...base, blockAnchor: first }),
    false,
    "turning comment mode on must not be skipped",
  );
});

test("a node the parser gave no position renders bare rather than anchored to a guess", () => {
  assert.equal(blockRangeFromNode(undefined), null);
  assert.equal(blockRangeFromNode({}), null);
  assert.equal(blockRangeFromNode({ position: { start: { line: 3 } } }), null);
  // An end before its start is not a range anything honest can be said about.
  assert.equal(
    blockRangeFromNode({ position: { start: { line: 9 }, end: { line: 3 } } }),
    null,
  );
  assert.deepEqual(
    blockRangeFromNode({ position: { start: { line: 3 }, end: { line: 5 } } }),
    { startLine: 3, endLine: 5 },
  );
});

test("a one-line block reads as a line, not as a range of one", () => {
  assert.equal(blockAnchorLabel({ startLine: 4, endLine: 4 }), "Comment on line 4");
  assert.equal(blockAnchorLabel({ startLine: 4, endLine: 9 }), "Comment on lines 4 to 9");
});

/*
 * ---- the two wirings in FileWorkspace that fail SILENTLY ----
 *
 * Neither of these changes what any surface renders, so no markup assertion and no browser
 * click can see them go wrong. Both are read out of the source for that reason.
 *
 * A source scan is the weaker kind of test and it is used here deliberately: the alternative
 * layers cannot reach either property. A render-count assertion would need a client renderer
 * the suite does not have, and the revision pairing only diverges inside a 180 ms debounce
 * window, which is a race to schedule rather than a case to assert.
 */
const WORKSPACE = readFileSync(
  new URL("../src/web/components/FileWorkspace.tsx", import.meta.url),
  "utf8",
);

test("the blockAnchor prop keeps one identity, so the memo it guards can still skip", () => {
  // `markdownPropsEqual` compares this prop by reference. Handing it a function rebuilt every
  // render makes the comparator answer "not equal" every time, and the remark -> rehype ->
  // highlight pipeline behind the memo reruns on every unrelated re-render of the workspace -
  // while a reader sits in comment mode reading a long spec, which is the whole feature.
  assert.match(
    WORKSPACE,
    /const stableMarkdownBlockAnchor = useCallback\(\s*\(range: MarkdownBlockRange\): void => \{\s*markdownBlockRef\.current\(range\);\s*\},\s*\[\]\);/,
    "blockAnchor must come from a useCallback with NO dependencies, reading a ref",
  );
  assert.match(
    WORKSPACE,
    /markdownBlockRef\.current = commentOnMarkdownBlock;/,
    "the ref has to be refreshed during render, so the first click after a change is current",
  );
  assert.match(
    WORKSPACE,
    /markdownBlockAnchor = commentsActive && markdownShowing\s*\?\s*stableMarkdownBlockAnchor\s*:\s*undefined;/,
    "the prop must be the stable callback or undefined, never the per-render handler",
  );
});

test("a Markdown block's quote and revision describe the same snapshot", () => {
  // The quote is sliced from `previewText`, which is debounced and can lag the live buffer.
  // `reanchor()`'s first rule skips the quote search when the revisions match, so stamping
  // that older quote with the buffer's newer revision asserts "nothing moved" without ever
  // looking - and misfiles the thread.
  assert.match(
    WORKSPACE,
    /sliceLines\(previewText, range\.startLine, range\.endLine\)\) \},\s*"markdown",\s*previewRevision,/,
    "commentOnMarkdownBlock must pass the revision previewText was taken from",
  );
  assert.match(
    WORKSPACE,
    /const previewRevision = prepared \? prepared\.revision : \(buffer\?\.document\.revision \?\? null\);/,
    "previewRevision must come from the SAME prepared snapshot previewText does",
  );
});
