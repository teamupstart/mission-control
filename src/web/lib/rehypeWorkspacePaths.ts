import { matchCheckoutPaths } from "./workspaceLinks.ts";

/**
 * The class the marked-up anchors carry, and the flag `Markdown` reads to tell one of
 * these apart from a link an agent actually wrote. It reaches the DOM either way, so it
 * is also the CSS hook - see `.markdown a.workspace-path` in `styles.css`.
 */
export const WORKSPACE_PATH_CLASS = "workspace-path";

/**
 * The elements whose text is left alone.
 *
 * `a` because it is already a link, and nesting one inside another produces invalid HTML
 * that browsers silently repair by splitting the outer anchor. `pre` because a fenced
 * block is a transcript of something - a diff, a log tail, a file tree - where nearly
 * every line holds a path, and turning a code block into a wall of links makes it
 * unreadable and fights the syntax highlighting that already coloured those spans. Inline
 * `code` is deliberately NOT here: a lone backticked path is the single most common way an
 * agent names a file, and it is the case this feature exists for.
 */
const SKIP_TAGS = new Set(["a", "pre", "script", "style"]);

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
}

type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

interface HastParent {
  children?: HastNode[];
}

function isText(node: HastNode): node is HastText {
  return node.type === "text" && typeof (node as HastText).value === "string";
}

function isElement(node: HastNode): node is HastElement {
  return node.type === "element" && typeof (node as HastElement).tagName === "string";
}

function anchorFor(text: string, href: string): HastElement {
  return {
    type: "element",
    tagName: "a",
    properties: { href, className: [WORKSPACE_PATH_CLASS] },
    children: [{ type: "text", value: text }],
  };
}

/**
 * Split one run of text into the nodes that replace it, or null when it holds no paths.
 * Returning null is what keeps the tree - and so React's reconciliation of it - untouched
 * for the overwhelming majority of text nodes, which mention no file at all.
 */
function splitTextNode(value: string, paths: ReadonlySet<string>): HastNode[] | null {
  const tokens = matchCheckoutPaths(value, paths);
  if (tokens.length === 0) return null;
  const parts: HastNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) parts.push({ type: "text", value: value.slice(cursor, token.start) });
    // The href carries the source location too: `workspaceFileTarget` parses `:line[:col]`
    // off it, so the one grammar that found the token also states what it found.
    parts.push(anchorFor(token.raw, token.raw));
    cursor = token.end;
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

function markUp(parent: HastParent, paths: ReadonlySet<string>): void {
  const children = parent.children;
  if (!Array.isArray(children)) return;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (isText(child)) {
      const parts = splitTextNode(child.value, paths);
      if (!parts) continue;
      children.splice(index, 1, ...parts);
      index += parts.length - 1;
      continue;
    }
    if (isElement(child) && SKIP_TAGS.has(child.tagName)) continue;
    markUp(child as HastParent, paths);
  }
}

/**
 * Turn the bare paths an agent typed into links to the file in this session's checkout.
 *
 * Markdown gives an agent no way to say "this word is a file" other than writing a link,
 * and agents do not - they write `docs/plans/x/plan.md` in prose or in backticks, because
 * that is how it reads in a terminal. The result was that the one dashboard surface that
 * CAN open the file rendered every reference to it as dead text, and the human retyped the
 * path into the file picker.
 *
 * The checkout listing is what decides, HERE, at tree-build time, rather than each
 * rendered anchor asking afterwards. That ordering is the whole design: a word this
 * checkout does not have a file for never becomes an anchor at all, so nothing has to
 * un-render, the markup a static render produces is the markup the browser gets, and one
 * listing answers for the whole message instead of one lookup per candidate. It is the
 * listing rather than a shape rule because a shape rule cannot tell `Makefile` or `.env`
 * from an ordinary word, and those are files an agent names as often as any other; see
 * `matchCheckoutPaths`. A caller with no listing yet passes an empty set, and the paths
 * light up on the render after it arrives.
 */
export function rehypeWorkspacePaths({ paths }: { paths: ReadonlySet<string> }) {
  return (tree: unknown): void => {
    if (tree && typeof tree === "object") markUp(tree as HastParent, paths);
  };
}
