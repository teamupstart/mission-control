import { buildMatcher, matchesIn, type FindOptions } from "./documentFind.ts";
import { blockRangeFromNode, type MarkdownBlockRange } from "./markdownBlocks.ts";
import { DIAGRAM_LIMIT_PROPERTY, DIAGRAM_TAG_PROPERTY } from "./rehypeDiagramFences.ts";

/**
 * Mark find hits in RENDERED markdown, and report what was marked.
 *
 * This plugin is Markdown preview's MODEL as well as its renderer, and that is the whole
 * reason it reports back. Preview shows rendered text, which is not the source: a query
 * that occurs only in a link destination, an image URL, a reference definition or a fence
 * info string has nothing on screen to highlight, so a count taken over source would offer
 * the reader matches this surface cannot reach - the one invariant find rests on. What the
 * bar counts is therefore what this plugin actually drew.
 *
 * Two rules do the work, and they pull in opposite directions.
 *
 * **Match over logical runs, not text node by text node.** `foo**bar**` renders as a text
 * node plus a `strong`, and `rehypeHighlight` splits one code line into many spans, so a
 * per-node scan would find nothing for `foobar` - a word the reader sees whole. Text nodes
 * are therefore joined into a run and the run is matched.
 *
 * **A run breaks at every VISIBLE separation, not only at a block boundary.** Joining
 * everything inside a block is as wrong in the other direction: `foo<br>bar` would match
 * `foobar`, and a `br` is a line break with no text node of its own to notice. So a run
 * breaks at a `br`, at any element that is not phrasing content (a nested block, a list
 * item, a table cell edge), and at an excluded node that still occupies space - an image,
 * or a diagram fence whose source the reader never sees. It does NOT break at an inline
 * element boundary, which is the point, nor at a node occupying no space at all.
 *
 * One logical hit may therefore be drawn as SEVERAL `mark` elements, and they all share
 * one key - the same clipping contract `hitsInWindow` already gives the transcript's
 * two-span tool chip. The count is logical hits, never mark elements.
 *
 * Every reported hit also carries the source line range of the block it sits in, because a
 * key identifies a rendered hit and says nothing about where in the source it came from -
 * and that range is what carries the reader's place across the Preview/Editor toggle.
 * Nullable, because the parser does not place every node, and a missing line is not an
 * excuse to guess one.
 */

/** The class every drawn fragment carries, and the CSS hook. See `mark.find-hit`. */
export const FIND_HIT_CLASS = "find-hit";
/** The class the ACTIVE hit's fragments carry as well. */
export const FIND_CURRENT_CLASS = "is-current";
/**
 * How a fragment publishes its logical hit's key.
 *
 * Two names for one thing, because hast and the DOM spell it differently: the hast
 * property is camelCase (as `rehypeDiagramFences` already writes its own), and what
 * reaches the document - and therefore any selector - is the dashed attribute.
 */
export const FIND_KEY_PROPERTY = "dataFindKey";
export const FIND_KEY_ATTRIBUTE = "data-find-key";

/** One logical hit, as the plugin reports it back to the surface that asked. */
export interface MarkdownFindHit {
  /** Shared by every fragment drawn for this hit. Namespaced `rendered:`. */
  key: string;
  /** The source lines of the block this hit sits in, or null when the parser placed none. */
  range: MarkdownBlockRange | null;
}

/**
 * Where the plugin puts what it found.
 *
 * A mutable sink rather than a callback the plugin invokes, because a rehype plugin runs
 * inside `ReactMarkdown`'s own render: calling a parent's setter from there is a state
 * update during another component's render. The renderer fills this during render and
 * forwards it in an effect, after the commit.
 */
export interface MarkdownFindReport {
  hits: MarkdownFindHit[];
}

export interface RehypeFindMarksOptions extends FindOptions {
  query: string;
  /** The key drawn as current, or null when nothing is. */
  currentKey: string | null;
  report: MarkdownFindReport;
}

/** The parts of hast this walker needs, spelled structurally so no type-only dep is added. */
interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: unknown;
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

function isText(node: HastNode): node is HastText {
  return node.type === "text" && typeof (node as HastText).value === "string";
}

function isElement(node: HastNode): node is HastElement {
  return node.type === "element" && typeof (node as HastElement).tagName === "string";
}

/**
 * Inline elements whose boundaries a reader cannot see.
 *
 * Text either side of one of these is on the same line, so a run crosses it - which is what
 * makes `foo**bar**` findable as `foobar`, and a match crossing a `rehypeHighlight` span
 * inside a fence findable at all. Anything NOT in this set is treated as a visible
 * separation and breaks the run, which is the safe direction: a missing entry costs a
 * findable match across markup, while a wrong entry would claim a match the reader never
 * saw as one word.
 */
const PHRASING_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "i", "ins",
  "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp", "small", "span", "strong", "sub",
  "sup", "time", "u", "var", "wbr",
]);

/**
 * Elements whose text is not rendered text at all.
 *
 * They occupy no space, so they neither mark nor break a run - the reader never saw them,
 * and a break here would split a word that is visibly one.
 */
const INVISIBLE_TAGS = new Set(["script", "style", "template"]);

/**
 * A diagram fence whose source the reader does NOT see.
 *
 * The `pre` override replaces it with a rendered diagram built from the fence's text, so a
 * mark inside it is a counted match with nothing on screen. An OVER-LIMIT fence renders as
 * ordinary source (see `MERMAID_MAX_DIAGRAMS`) and is therefore searched like any code
 * block.
 */
function isHiddenDiagramFence(node: HastElement): boolean {
  const tag = node.properties?.[DIAGRAM_TAG_PROPERTY];
  if (typeof tag !== "string") return false;
  return node.properties?.[DIAGRAM_LIMIT_PROPERTY] !== true;
}

/** One text node's place in the run being built. */
interface RunPiece {
  node: HastText;
  siblings: HastNode[];
  index: number;
  /** Where this node's text starts in the joined run. */
  at: number;
}

/** A replacement queued against one parent, applied once the whole tree has been read. */
interface Splice {
  siblings: HastNode[];
  index: number;
  parts: HastNode[];
}

function markElement(text: string, key: string, current: boolean): HastElement {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      className: current ? [FIND_HIT_CLASS, FIND_CURRENT_CLASS] : [FIND_HIT_CLASS],
      [FIND_KEY_PROPERTY]: key,
    },
    children: [{ type: "text", value: text }],
  };
}

/**
 * Turn one text node into the nodes that replace it, given the local ranges to mark.
 *
 * Ranges arrive in ascending order and never overlap, because they are slices of
 * non-overlapping run matches.
 */
function splitTextNode(
  value: string,
  ranges: { start: number; end: number; key: string; current: boolean }[],
): HastNode[] {
  const parts: HastNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ type: "text", value: value.slice(cursor, range.start) });
    parts.push(markElement(value.slice(range.start, range.end), range.key, range.current));
    cursor = range.end;
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

/**
 * Walk the tree, matching per run and queueing the marks each match needs.
 *
 * Nothing is spliced while walking: a splice changes the indices this walk is holding, so
 * every replacement is collected and applied afterwards, per parent, from the back.
 */
function collect(
  tree: HastNode,
  re: RegExp,
  currentKey: string | null,
  hits: MarkdownFindHit[],
  splices: Splice[],
): void {
  let ordinal = 0;

  /** Match one joined run and queue the fragments its hits need. */
  const flush = (pieces: RunPiece[], range: MarkdownBlockRange | null): void => {
    if (pieces.length === 0) return;
    const run = pieces.map((piece) => piece.node.value).join("");
    const matches = matchesIn(run, re);
    if (matches.length === 0) return;
    /** Local ranges per text node, keyed by the node's index in the run. */
    const perPiece = new Map<number, { start: number; end: number; key: string; current: boolean }[]>();
    for (const match of matches) {
      ordinal += 1;
      const key = `rendered:${ordinal}`;
      hits.push({ key, range });
      const current = key === currentKey;
      // One logical hit, drawn as however many fragments the markup splits it into - all
      // under this one key. See `hitsInWindow`'s clipping contract.
      pieces.forEach((piece, at) => {
        const from = Math.max(match.start, piece.at);
        const to = Math.min(match.end, piece.at + piece.node.value.length);
        if (from >= to) return;
        const list = perPiece.get(at) ?? [];
        list.push({ start: from - piece.at, end: to - piece.at, key, current });
        perPiece.set(at, list);
      });
    }
    for (const [at, ranges] of perPiece) {
      const piece = pieces[at]!;
      splices.push({
        siblings: piece.siblings,
        index: piece.index,
        parts: splitTextNode(piece.node.value, ranges),
      });
    }
  };

  /**
   * Read one element's children as a sequence of runs.
   *
   * `block` is the nearest ancestor the parser placed, which is what every hit inside this
   * subtree reports as its source range.
   */
  const walk = (node: HastNode, block: MarkdownBlockRange | null): void => {
    const children = (node as { children?: HastNode[] }).children;
    if (!Array.isArray(children)) return;
    let pieces: RunPiece[] = [];
    let at = 0;
    const breakRun = (): void => {
      flush(pieces, block);
      pieces = [];
      at = 0;
    };
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (isText(child)) {
        if (child.value !== "") {
          pieces.push({ node: child, siblings: children, index, at });
          at += child.value.length;
        }
        continue;
      }
      if (!isElement(child)) {
        // A comment or a raw node: no text, no space, nothing to notice.
        continue;
      }
      if (INVISIBLE_TAGS.has(child.tagName)) continue;
      if (child.tagName === "br" || child.tagName === "img" || isHiddenDiagramFence(child)) {
        // Excluded, and it still occupies space, so text either side of it is not one word.
        breakRun();
        continue;
      }
      if (PHRASING_TAGS.has(child.tagName)) {
        // Inline: its text joins the run being built, at the position it renders in.
        const inline = (child as HastElement).children ?? [];
        const nested = collectInline(inline, at, block);
        pieces.push(...nested.pieces);
        at += nested.length;
        if (nested.broke) breakRun();
        continue;
      }
      // A nested block, a list item, a table cell: a visible separation in both directions.
      breakRun();
      walk(child, blockRangeFromNode(child) ?? block);
    }
    breakRun();
  };

  /**
   * The same reading, one level down inside an inline element.
   *
   * Its text nodes belong to the run their ANCESTOR is building, and they keep their own
   * parent array so a splice lands where the node actually lives. A visible separation
   * inside an inline element (an `img` in a link, a nested block browsers would repair)
   * still breaks the run, reported back through `broke`.
   */
  const collectInline = (
    children: HastNode[],
    start: number,
    block: MarkdownBlockRange | null,
  ): { pieces: RunPiece[]; length: number; broke: boolean } => {
    const pieces: RunPiece[] = [];
    let at = start;
    let broke = false;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (isText(child)) {
        if (child.value !== "") {
          pieces.push({ node: child, siblings: children, index, at });
          at += child.value.length;
        }
        continue;
      }
      if (!isElement(child)) continue;
      if (INVISIBLE_TAGS.has(child.tagName)) continue;
      if (child.tagName === "br" || child.tagName === "img" || isHiddenDiagramFence(child)) {
        broke = true;
        continue;
      }
      if (PHRASING_TAGS.has(child.tagName)) {
        const nested = collectInline(child.children ?? [], at, block);
        pieces.push(...nested.pieces);
        at += nested.length;
        if (nested.broke) broke = true;
        continue;
      }
      // A block inside phrasing content is invalid markup a browser would repair by
      // splitting the inline element, so the reader sees a separation here too.
      broke = true;
      walk(child, blockRangeFromNode(child) ?? block);
    }
    return { pieces, length: at - start, broke };
  };

  walk(tree, blockRangeFromNode(tree));
}

/**
 * Apply the queued replacements.
 *
 * Grouped by parent array and applied from the back, so an earlier index is never shifted
 * by a later splice.
 */
function apply(splices: Splice[]): void {
  const byParent = new Map<HastNode[], Splice[]>();
  for (const splice of splices) {
    const list = byParent.get(splice.siblings) ?? [];
    list.push(splice);
    byParent.set(splice.siblings, list);
  }
  for (const [siblings, list] of byParent) {
    list.sort((a, b) => b.index - a.index);
    for (const splice of list) siblings.splice(splice.index, 1, ...splice.parts);
  }
}

/**
 * The plugin. Ordered LAST, after `rehypeHighlight` and `rehypeWorkspacePaths`, so it marks
 * the text those two have finished producing.
 */
export function rehypeFindMarks(options: RehypeFindMarksOptions) {
  return (tree: unknown): void => {
    options.report.hits = [];
    const re = buildMatcher(options.query, { caseSensitive: options.caseSensitive });
    if (!re || !tree || typeof tree !== "object") return;
    const splices: Splice[] = [];
    collect(tree as HastNode, re, options.currentKey, options.report.hits, splices);
    apply(splices);
  };
}
