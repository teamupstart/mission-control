/**
 * A rendered markdown block's place in its SOURCE.
 *
 * Lifted out of `Markdown.tsx` so a rehype plugin can read it without importing the
 * component that runs the plugin. Nothing about the rule changed: it is still the one
 * answer to "which source lines did this rendered block come from", and both the comment
 * anchors and find's cross-surface position depend on that being a single answer.
 */

/** A block's range in the markdown SOURCE, 1-based and inclusive. */
export interface MarkdownBlockRange {
  startLine: number;
  endLine: number;
}

/** The hast node a custom component receives, narrowed to the one field this needs. */
interface PositionedNode {
  position?: { start?: { line?: number }; end?: { line?: number } };
}

/**
 * The source range a rendered block came from, or null when the parser did not record one.
 *
 * Verified rather than assumed: this repository's exact plugin chain (`remark-parse` ->
 * `remark-gfm` -> `remark-rehype` -> `rehype-highlight`) leaves `position.start.line` and
 * `position.end.line` on every top-level hast element, and `rehype-highlight` does not strip
 * them. A node without one still renders - it simply renders without a comment button, which
 * is the containment rule this file has kept since the Mermaid work. Find takes the same
 * containment: a hit in an unplaced block still marks, and reports a null range.
 */
export function blockRangeFromNode(node: unknown): MarkdownBlockRange | null {
  const position = (node as PositionedNode | undefined)?.position;
  const startLine = position?.start?.line;
  const endLine = position?.end?.line;
  if (typeof startLine !== "number" || typeof endLine !== "number") return null;
  if (startLine < 1 || endLine < startLine) return null;
  return { startLine, endLine };
}
