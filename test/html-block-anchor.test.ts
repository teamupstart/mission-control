import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

import {
  resolveHtmlBlockAnchor,
  resolveHtmlBlockPath,
} from "../src/server/html-block-anchor.ts";
import { htmlPreviewSource } from "../src/web/lib/htmlPreview.ts";
import type { HtmlBlockPathStep } from "../src/shared/protocol.ts";

/**
 * Resolving a clicked HTML preview block to the source lines it came from.
 *
 * The paths under test are built from a parse5 tree of the FULL PREVIEW DOCUMENT - CSP meta,
 * three bridge scripts and all - and then resolved against the file's own bytes. That is the
 * production round trip: the bridge indexes the tree the browser built from the prefixed
 * srcdoc, and the daemon walks a tree of the raw file. Building the path from the prefixed
 * document here is what proves the prefix cannot shift a body path, which is the entire
 * reason the bridge starts its walk at `document.body`.
 *
 * Every case below is one a text-matching resolver would have got wrong. That approach was
 * specified, reviewed, and rejected precisely because `<p>Read <strong>this</strong></p>` has
 * DOM text that appears nowhere in the source.
 */

type ParsedElement = DefaultTreeAdapterTypes.Element;
type ParsedNode = DefaultTreeAdapterTypes.Node;

function isElement(node: ParsedNode): node is ParsedElement {
  return "tagName" in node;
}

function elementChildren(node: ParsedElement): ParsedElement[] {
  return node.childNodes.filter(isElement);
}

/**
 * The structural path the bridge WOULD report for the nth element matching `tag` in the
 * rendered preview, walked from `<body>` exactly as `PREVIEW_COMMENT_SCRIPT` walks it.
 */
function pathInPreview(source: string, tag: string, ordinal = 0): HtmlBlockPathStep[] {
  const document = parse(htmlPreviewSource(source));
  const html = document.childNodes.filter(isElement).find((node) => node.tagName === "html")!;
  const body = elementChildren(html).find((node) => node.tagName === "body")!;
  const found: ParsedElement[] = [];
  const parents = new Map<ParsedElement, ParsedElement>();
  const walk = (node: ParsedElement): void => {
    for (const child of elementChildren(node)) {
      parents.set(child, node);
      if (child.tagName === tag) found.push(child);
      walk(child);
    }
  };
  walk(body);
  const target = found[ordinal];
  assert.ok(target, `the preview has no ${tag} at ordinal ${ordinal}`);
  const path: HtmlBlockPathStep[] = [];
  let node: ParsedElement = target;
  while (node !== body) {
    const owner = parents.get(node)!;
    path.unshift({ index: elementChildren(owner).indexOf(node), tag: node.tagName });
    node = owner;
  }
  return path;
}

function anchor(source: string, tag: string, ordinal = 0) {
  return resolveHtmlBlockAnchor(source, pathInPreview(source, tag, ordinal));
}

test("a block whose DOM text appears nowhere in the source still anchors", () => {
  // The case that killed text search: `textContent` here is `Read this`, and the source says
  // `Read <strong>this</strong>`. No substring search can connect the two.
  const source = [
    "<html>",
    "<body>",
    "<p>Read <strong>this</strong> carefully.</p>",
    "</body>",
    "</html>",
  ].join("\n");
  const result = anchor(source, "p");
  assert.equal(result.ok, true);
  assert.deepEqual(
    { start: result.ok && result.startLine, end: result.ok && result.endLine },
    { start: 3, end: 3 },
  );
  assert.equal(result.ok && result.quote, "<p>Read <strong>this</strong> carefully.</p>");
});

test("the quote is the SOURCE slice, entities and all, not the rendered text", () => {
  // `&amp;` renders as `&`, so a resolver quoting the DOM would store text that `reanchor()`
  // could never find in the file again. The whole point of quoting source is that searching
  // the file for it later means something.
  const source = ["<body>", "<p>Fish &amp; chips &mdash; twice.</p>", "</body>"].join("\n");
  const result = anchor(source, "p");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.quote, "<p>Fish &amp; chips &mdash; twice.</p>");
});

test("two blocks with identical text resolve by position, not by competition", () => {
  const source = [
    "<body>",
    "<p>The retry budget is thirty seconds.</p>",
    "<p>The retry budget is thirty seconds.</p>",
    "</body>",
  ].join("\n");
  const first = anchor(source, "p", 0);
  const second = anchor(source, "p", 1);
  assert.equal(first.ok && first.startLine, 2);
  assert.equal(second.ok && second.startLine, 3);
});

test("a row in a table written without tbody anchors to its own line", () => {
  // The case a position-tracking TOKENIZER gets wrong. Both the browser and parse5 insert an
  // implicit `<tbody>`, so the reported path has a step a tag walk over the source does not,
  // and the walk lands one element off - on a fresh render of perfectly ordinary markup.
  const source = [
    "<body>",
    "<table>",
    "<tr><th>Retries</th><th>Window</th></tr>",
    "<tr><td>3</td><td>30s</td></tr>",
    "</table>",
    "</body>",
  ].join("\n");
  const path = pathInPreview(source, "tr", 1);
  assert.ok(
    path.some((step) => step.tag === "tbody"),
    "the reported path goes through the implicit tbody the browser inserted",
  );
  const result = anchor(source, "tr", 1);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.startLine, 4);
  assert.equal(result.ok && result.quote, "<tr><td>3</td><td>30s</td></tr>");
});

test("a stored source anchor resolves back through the browser tree", () => {
  const source = [
    "<body>",
    "<p>Read <strong>this</strong> carefully.</p>",
    "<table>",
    "<tr><td>3</td><td>30s</td></tr>",
    "</table>",
    "</body>",
  ].join("\n");
  const paragraph = resolveHtmlBlockPath(
    source,
    2,
    2,
    "<p>Read <strong>this</strong> carefully.</p>",
  );
  assert.deepEqual(paragraph, {
    ok: true,
    blockPath: [{ index: 0, tag: "p" }],
  });

  const row = resolveHtmlBlockPath(source, 4, 4, "<tr><td>3</td><td>30s</td></tr>");
  assert.equal(row.ok, true);
  assert.ok(
    row.ok && row.blockPath.some((step) => step.tag === "tbody"),
    "the inverse path keeps the implicit tbody the browser owns",
  );
  assert.equal(row.ok && row.blockPath.at(-1)?.tag, "tr");
});

test("a block spanning several lines quotes all of them", () => {
  const source = [
    "<body>",
    "<blockquote>",
    "  <p>One.</p>",
    "  <p>Two.</p>",
    "</blockquote>",
    "</body>",
  ].join("\n");
  const result = anchor(source, "blockquote");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.startLine, 2);
  assert.equal(result.ok && result.endLine, 5);
});

test("the preview prefix cannot shift a body path by one", () => {
  // A `<link>` in head is what the Files tab rewrites into a `<style>` before rendering, and
  // the CSP meta plus three bridges also land in head. None of it may move a body path - the
  // path is built here from the full preview document and resolved against the bare file.
  const source = [
    '<html><head><link rel="stylesheet" href="theme.css"><title>x</title></head>',
    "<body>",
    "<h1>The spec</h1>",
    "<p>The table below has no units column.</p>",
    "</body></html>",
  ].join("\n");
  const result = anchor(source, "p");
  assert.equal(result.ok && result.startLine, 4);
});

test("a path that no longer describes the source is refused, with a reload to act on", () => {
  const rendered = ["<body>", "<p>First.</p>", "<p>Second.</p>", "</body>"].join("\n");
  const path = pathInPreview(rendered, "p", 1);
  // The agent rewrote the file while the render stayed on screen: the second paragraph is
  // now a heading, so the same index names a different element.
  const edited = ["<body>", "<p>First.</p>", "<h2>Second.</h2>", "</body>"].join("\n");
  const result = resolveHtmlBlockAnchor(edited, path);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /older version/);
  assert.match(result.ok ? "" : result.reason, /Reload/);
});

test("a path that runs off the end of the document is the same refusal", () => {
  const result = resolveHtmlBlockAnchor("<body><p>Only one.</p></body>", [
    { index: 4, tag: "p" },
  ]);
  assert.equal(result.ok, false);
});

test("an empty path is refused rather than resolving to the body", () => {
  assert.equal(resolveHtmlBlockAnchor("<body><p>x</p></body>", []).ok, false);
});

test("an empty block still quotes text a later re-anchor can search for", () => {
  // The quote is source, so even a `<div>` with nothing inside it carries its own tags -
  // which is exactly what `CreateFileCommentSchema` refuses a comment for lacking. There is
  // no such thing here as a block that resolves and cannot be anchored.
  const source = ["<body>", "<div>", "</div>", "</body>"].join("\n");
  const result = resolveHtmlBlockAnchor(source, pathInPreview(source, "div"));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.quote, "<div>\n</div>");
  assert.ok(result.ok && result.quote.trim().length > 0);
});

test("resolution never compares text, so reordering identical blocks moves nothing", () => {
  // Position is the whole rule. Swapping the two paragraphs leaves both paths resolving to
  // the same lines they always did, which is what "duplicate wording is not a problem" means.
  const source = ["<body>", "<p>Same.</p>", "<p>Same.</p>", "</body>"].join("\n");
  for (const ordinal of [0, 1]) {
    const result = anchor(source, "p", ordinal);
    assert.equal(result.ok && result.startLine, 2 + ordinal);
  }
});
