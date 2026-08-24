import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { boundQuote, sliceLines } from "@shared/file-comment-anchor.ts";
import type { HtmlBlockPathStep } from "@shared/protocol.ts";

/**
 * Where in a file's SOURCE the block someone clicked in the HTML preview actually lives.
 *
 * The preview is a sandboxed iframe with no origin the dashboard can reach into, so the
 * only thing that crosses back is what `PREVIEW_COMMENT_SCRIPT` posts: a structural path of
 * element indices from `document.body` down to the clicked block, with each step's tag name
 * alongside. This module turns that into a line range and the source slice at it.
 *
 * **Two approaches that look reasonable and are wrong, named so they are not tried again.**
 *
 * 1. *Search the source for the block's text.* The DOM `textContent` of
 *    `<p>Read <strong>this</strong></p>` is `Read this`, which is not a substring of the
 *    source at all. Nested inline markup, character entities and reflowed whitespace each
 *    break the equivalence, and all three are ordinary HTML - so a text-matching resolver
 *    refuses most real blocks while appearing to work on the simple ones it was tried on.
 * 2. *Walk the tags in order with a tokenizer that tracks positions.* The path indexes the
 *    BROWSER's tree, and HTML parsing is not tokenizing: `<table><tr>` gains an implicit
 *    `<tbody>`, misnested inline tags are reparented, and malformed-but-renderable markup is
 *    repaired. A source index built by walking tags therefore disagrees with the DOM on
 *    ordinary input - one table is enough - and lands on the wrong node, on a fresh render.
 *
 * So: `parse5`, which implements the HTML5 tree-construction algorithm and retains source
 * locations on every node. Its tree is the one the iframe built, implicit `<tbody>` and all.
 * It is already a direct dependency and already used for exactly this parity in
 * `archives/html.ts`. **No text is ever compared here**, so entities, nesting and whitespace
 * never enter into it, and two blocks with identical wording resolve by position rather than
 * competing.
 *
 * Scripting stays ON - parse5's default - because the preview runs with
 * `sandbox="allow-scripts"`, so `<noscript>` content is raw text on both sides. That is the
 * opposite of `archives/html.ts`, which parses with scripting OFF because it is proving a
 * document inert and wants the wider of the two readings. Both are matching the browser they
 * are actually about.
 *
 * The path starts at `<body>`, which is what makes this independent of the preview prefix:
 * the CSP meta, the three bridge scripts and any `<link>` rewritten into a `<style>` all
 * live in `<head>`, so none of them can shift a body path by one, and this parses the file's
 * OWN bytes rather than the assembled srcdoc.
 */

type ParsedElement = DefaultTreeAdapterTypes.Element;
type ParsedNode = DefaultTreeAdapterTypes.Node;

/** The one refusal: the path does not describe this source, so the render was stale. */
export interface HtmlBlockAnchorRefusal {
  ok: false;
  reason: string;
}

export interface HtmlBlockAnchorResolution {
  ok: true;
  startLine: number;
  endLine: number;
  /**
   * The SOURCE slice at the resolved range, never the DOM text.
   *
   * That is what lets an HTML thread re-anchor through the same `reanchor()` as an editor
   * thread instead of needing a second rule: the quote is bytes that are really in the file,
   * so searching the file for them later means something.
   */
  quote: string;
}

export type HtmlBlockAnchorResult = HtmlBlockAnchorResolution | HtmlBlockAnchorRefusal;

/**
 * One sentence a person can act on, and it is the same sentence for every way the walk can
 * fail, because they are all the same fact: the document changed under a render still on
 * screen.
 *
 * Exported because the route says it too, for the one staleness this walk cannot detect: an
 * edit that rewrote a block in place, leaving a tree of the same shape that a stale path
 * resolves against perfectly well. Same fact, same remedy, so it has to be the same sentence
 * rather than a second one that means it.
 */
export const HTML_BLOCK_STALE_REASON =
  "This preview is showing an older version of the file, so that block could not be "
  + "matched to a line. Reload the preview and try again.";
const STALE = HTML_BLOCK_STALE_REASON;

function isElement(node: ParsedNode): node is ParsedElement {
  return "tagName" in node;
}

function elementChildren(node: ParsedElement): ParsedElement[] {
  return node.childNodes.filter(isElement);
}

/** The `<body>` parse5 built, implicitly or from the source's own tag. */
function documentBody(source: string): ParsedElement | null {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const html = document.childNodes.filter(isElement).find((node) => node.tagName === "html");
  if (!html) return null;
  return elementChildren(html).find((node) => node.tagName === "body") ?? null;
}

export function resolveHtmlBlockAnchor(
  source: string,
  path: readonly HtmlBlockPathStep[],
): HtmlBlockAnchorResult {
  if (path.length === 0) return { ok: false, reason: STALE };
  const body = documentBody(source);
  if (!body) return { ok: false, reason: STALE };

  let node: ParsedElement = body;
  for (const step of path) {
    const child = elementChildren(node)[step.index];
    // The tag check is the whole reason the bridge reports one. Indices alone would land on
    // a NEIGHBOUR when the document has shifted, which is the failure worth refusing: a
    // comment quietly anchored to the wrong paragraph reads exactly like a correct one.
    if (!child || child.tagName !== step.tag) return { ok: false, reason: STALE };
    node = child;
  }

  const location = node.sourceCodeLocation;
  // An element the parser INSERTED - an implicit `<tbody>`, a repaired wrapper - has no
  // source location, because it is not in the source. Nothing honest can be said about its
  // lines, so it is refused rather than attributed to its parent's range.
  if (!location) return { ok: false, reason: STALE };

  const startLine = location.startLine;
  const endLine = Math.max(startLine, location.endLine);
  // Bounded for `FILE_COMMENT_QUOTE_MAX`'s reason: the quote rides every snapshot and is
  // pasted verbatim into what the agent reads, and a preview block can be a whole table.
  //
  // It cannot come back empty. The slice always contains the element's own start tag, so
  // even a `<div>` with nothing in it quotes text a later `reanchor()` can search for -
  // which is exactly the property `CreateFileCommentSchema` refuses a comment for lacking.
  return { ok: true, startLine, endLine, quote: boundQuote(sliceLines(source, startLine, endLine)) };
}
