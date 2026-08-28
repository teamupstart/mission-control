import { createElement, memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { markdownLinkUrl } from "../lib/workspaceLinks.ts";
import { rehypeWorkspacePaths, WORKSPACE_PATH_CLASS } from "../lib/rehypeWorkspacePaths.ts";
import { blockRangeFromNode, type MarkdownBlockRange } from "../lib/markdownBlocks.ts";
import {
  rehypeFindMarks,
  type MarkdownFindHit,
  type MarkdownFindReport,
} from "../lib/rehypeFindMarks.ts";
import {
  diagramFenceFromPre,
  rehypeDiagramFences,
  type DiagramHastNode,
} from "../lib/rehypeDiagramFences.ts";
import { MERMAID_MAX_DIAGRAMS } from "../lib/mermaidPreview.ts";
import { Tooltip } from "./Tooltip.tsx";
import type { MarkdownDiagramRegistry } from "./markdownDiagramRegistry.tsx";

export type WorkspaceLinkHandler = (href: string, probe?: boolean) => boolean | Promise<boolean>;

/*
 * Re-exported rather than moved away: `blockRangeFromNode` and its range are now shared
 * with `rehypeFindMarks`, which cannot import this component, but every existing caller
 * still names the renderer as the place the rule lives.
 */
export { blockRangeFromNode } from "../lib/markdownBlocks.ts";
export type { MarkdownBlockRange } from "../lib/markdownBlocks.ts";
export type { MarkdownFindHit } from "../lib/rehypeFindMarks.ts";

const HIGHLIGHT_OPTIONS = { detect: false, ignoreMissing: true };

/** A checkout listing the caller has, or nothing yet - see `rehypeWorkspacePaths`. */
export type WorkspacePaths = ReadonlySet<string> | null;

function WorkspaceAnchor({
  href,
  onLink,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  onLink: WorkspaceLinkHandler;
}): React.JSX.Element {
  const handler = useRef(onLink);
  handler.current = onLink;
  const [claim, setClaim] = useState<{ href: string; value: boolean } | null>(null);
  const claimed = claim?.href === href && claim?.value === true;

  useEffect(() => {
    let live = true;
    if (!href) return;
    const result = handler.current(href, true);
    if (typeof result === "boolean") {
      setClaim({ href, value: result });
    } else {
      void result.then((next) => {
        if (live) setClaim({ href, value: next });
      });
    }
    return () => { live = false; };
  }, [href]);

  // A path this app marked up is never a destination the browser should follow: the agent
  // wrote a word, not a link, so `docs/plan.md` reaching the router as a relative URL is a
  // navigation nobody asked for. Written links keep their existing behaviour, where the
  // default is only cancelled once the handler confirms it opened the file here.
  const marked = String(props.className ?? "").split(" ").includes(WORKSPACE_PATH_CLASS);

  // Where the link actually goes, which is the one thing markdown's own rendering hides -
  // and, for a checkout-contained link, that clicking it opens the file here rather than
  // in a browser tab. A link this app claims and one it hands to the OS look identical.
  return (
    <Tooltip
      label={
        claimed || marked
          ? `Open ${href} in this session's files`
          : (href || "Blocked link")
      }
    >
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (marked) event.preventDefault();
          let shouldOpen = claimed;
          if (!shouldOpen && href) {
            const result = handler.current(href, true);
            shouldOpen = typeof result === "boolean" && result;
          }
          if (href && shouldOpen && handler.current(href) === true) event.preventDefault();
        }}
      />
    </Tooltip>
  );
}

/**
 * What a caller does when a reader points at a rendered block.
 *
 * A callback rather than a boolean, and ABSENT rather than empty when off, matching
 * `diagramRenderers` - `undefined` is the "off" signal this file already uses, and every
 * other caller keeps rendering exactly the markup it renders today.
 */
export type MarkdownBlockAnchorHandler = (range: MarkdownBlockRange) => void;

/**
 * Which rendered elements can take a comment.
 *
 * The blocks a person points at in a spec: paragraphs, headings, quotes, lists, tables, and
 * fenced code - which is also where a Mermaid diagram lands, because a diagram IS a fence
 * and the `pre` override is what replaces it.
 *
 * `li` is absent deliberately. A bullet is inside a list that already anchors, and the list
 * is the thing a reader points at; anchoring both would put a control on every bullet of
 * every list in the document.
 *
 * Blocks that genuinely contain other blocks - a paragraph inside a quote, a table inside a
 * list item - do nest, and both are anchorable, which is right: they are different things to
 * say something about. Which ONE a hover offers is settled in the stylesheet, by the same
 * "nearest block" rule `closest()` gives the HTML preview.
 */
const BLOCK_ANCHOR_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table", "ul", "ol", "pre",
] as const;

/**
 * What the control's tooltip says: the ACTION and where it lands.
 *
 * Deliberately not the same sentence as the accessible name. The name answers "what is this
 * control" for a reader stepping through them; the tooltip answers "what happens if I click
 * it", which is the thing a rendered document cannot show - the comment is anchored to source
 * lines, not to the paragraph as it appears.
 */
export function blockAnchorTooltip(range: MarkdownBlockRange): string {
  return range.startLine === range.endLine
    ? `Comment on this block, anchored to source line ${range.startLine}`
    : `Comment on this block, anchored to source lines ${range.startLine}-${range.endLine}`;
}

/** How a block's comment control reads to a screen reader, and to a browser test. */
export function blockAnchorLabel(range: MarkdownBlockRange): string {
  return range.startLine === range.endLine
    ? `Comment on line ${range.startLine}`
    : `Comment on lines ${range.startLine} to ${range.endLine}`;
}

/**
 * The one markdown renderer in the app - plans, Foreman briefs, and chat turns all
 * come through here, so a fence looks the same wherever you read it.
 *
 * `breaks` turns on `remarkBreaks`, and it is a chat-turn concern specifically. Chat
 * turns used to render as `white-space: pre-wrap`, so their single newlines were real
 * line breaks; without `remarkBreaks` the switch to markdown would silently reflow
 * every message that already exists. Plans and Foreman briefs were never pre-wrap -
 * they have always rendered through markdown's own reflow - so the prop defaults to
 * off and only `TranscriptPanel` opts in. Turning it on everywhere would put a `<br>`
 * at every newline of hard-wrapped plan prose.
 *
 * `rehypeHighlight` runs with `detect: false` on purpose. Auto-detection guesses a
 * language for every unlabelled fence, and agents emit plenty of fences that aren't
 * code at all - log tails, file trees, error dumps. A wrong guess paints those in
 * confident, meaningless colour, which reads worse than no colour.
 *
 * `filePaths` turns bare paths in the prose into links, and needs `onLinkClick` to mean
 * anything - a word is worth marking up only where clicking one goes somewhere. It is the
 * checkout listing, not a predicate, because the answer has to be the same for every token
 * in the message and has to be settled before the markup exists; see
 * `rehypeWorkspacePaths`. Callers with no session behind them (plans, Foreman briefs, the
 * Markdown file preview) pass neither and render exactly as before.
 *
 * `diagramRenderers` is a separate, opt-in capability for the Files preview. Keeping the
 * registry absent by default is what leaves every other caller's fences as source code.
 *
 * `blockAnchor` is the second opt-in of that shape, and the Files preview is again its only
 * caller. With it, every block-level element renders inside a host carrying the SOURCE lines
 * it came from, so a reader can point at the paragraph they are reading rather than at the
 * line number beside it. Without it - nine callers, from conversations to the Library
 * editors - the markup is byte-for-byte what it has always been.
 *
 * Memoized on the rendered text: highlighting is real work, and the transcript
 * re-renders on every SSE frame. Turns are append-only (see `mergeById`), so an
 * existing message's text never changes and this stays a hit for the whole session -
 * which required the explicit comparator below, because the default shallow one compared
 * a handler both call sites rebuild per render and therefore never hit at all.
 */
interface MarkdownProps {
  children: string;
  breaks?: boolean;
  /** Return true when a session-aware caller claimed the href as a workspace file. */
  onLinkClick?: WorkspaceLinkHandler;
  /** This session's checkout listing, once it is known. Null renders no path links. */
  filePaths?: WorkspacePaths;
  /** Canonical fenced languages this caller may replace with isolated diagram hosts. */
  diagramRenderers?: MarkdownDiagramRegistry;
  /**
   * Opt-in: wrap every block-level element in a host carrying its SOURCE line range, with a
   * control that reports that range back. Absent for every caller that is not the Files
   * preview, exactly like `diagramRenderers`.
   */
  blockAnchor?: MarkdownBlockAnchorHandler;
  /** File identity for remounting async hosts when equal source comes from another file. */
  diagramDocumentKey?: string;
  /**
   * Opt-in: mark this document's find hits, and report what was marked.
   *
   * The third opt-in of `diagramRenderers`' shape, and again the Files preview is its only
   * caller. Absent for everyone else, so their markup is byte-for-byte what it was.
   *
   * It reports back because Preview's rendered text is not its source, so the plugin is the
   * only thing that knows what this surface can actually highlight - see `rehypeFindMarks`.
   */
  find?: MarkdownFindRequest;
}

/** What a caller asks find for, and where the answer goes. */
export interface MarkdownFindRequest {
  query: string;
  caseSensitive: boolean;
  /** The key of the hit drawn as current, or null. */
  currentKey: string | null;
  /**
   * The logical hits the plugin drew, in document order, after every render that ran it.
   *
   * Compared by IDENTITY in `markdownPropsEqual`, so a caller has to keep it stable - a
   * fresh closure each render would re-parse the document on every workspace render, which
   * is precisely what this component's memo exists to prevent.
   */
  onHits: (hits: MarkdownFindHit[]) => void;
}

function MarkdownBody({
  children,
  breaks = false,
  onLinkClick,
  filePaths = null,
  diagramRenderers,
  diagramDocumentKey = "",
  blockAnchor,
  find,
}: MarkdownProps): React.JSX.Element {
  const paths = onLinkClick ? filePaths : null;
  // The handler reaches the rendered anchors through a ref, and that is load-bearing
  // rather than tidy. It keeps `components` off the handler's identity, and a
  // `components.a` that closed over it was a NEW COMPONENT TYPE whenever the handler
  // changed - React unmounts a subtree whose element type changed, so every anchor in
  // every turn was destroyed and rebuilt: the hover tooltip could never finish opening,
  // the claim state was thrown away and re-probed, and text selection inside a turn
  // collapsed. Behind a ref the map is built once and the anchors survive.
  //
  // The ref is refreshed HERE, during this render, which is exactly why
  // `markdownPropsEqual` has to compare the handler: skip this render with a new handler
  // and every anchor keeps calling the old one.
  const linkHandler = useRef(onLinkClick);
  linkHandler.current = onLinkClick;
  const linkable = Boolean(onLinkClick);
  // Behind a ref for the reason the link handler is, stated one paragraph up: a `components`
  // map that closed over the handler would be a NEW component type on every parent render,
  // and React unmounts a subtree whose element type changed - so the whole preview would be
  // destroyed and rebuilt each time the workspace re-rendered, taking the scroll position
  // and any open selection with it. The map depends on the BOOLEAN, which changes only when
  // comment mode is turned on or off.
  const blockHandler = useRef(blockAnchor);
  blockHandler.current = blockAnchor;
  const blockAnchored = Boolean(blockAnchor);
  // Read out as fields, because that is how the comparator below compares them: the request
  // object is rebuilt by its caller every render while these three move only when the reader
  // types or steps.
  const findQuery = find?.query ?? "";
  const findCaseSensitive = find?.caseSensitive ?? false;
  const findCurrentKey = find?.currentKey ?? null;
  const findHits = find?.onHits;
  const components = useMemo(() => {
    const anchor = ({ node: _node, href, onClick: _onClick, ...props }: React.ComponentPropsWithoutRef<"a"> & {
      node?: unknown;
    }) =>
      linkable ? (
        <WorkspaceAnchor
          {...props}
          href={href}
          onLink={(link, probe) => linkHandler.current?.(link, probe) ?? false}
        />
      ) : (
        <Tooltip label={href || "Blocked link"}>
          <a
            {...props}
            href={href}
            target={href?.startsWith("http") ? "_blank" : undefined}
            rel={href?.startsWith("http") ? "noreferrer noopener" : undefined}
          />
        </Tooltip>
      );
    const fenced = diagramRenderers
      ? ({ node, ...props }: React.ComponentPropsWithoutRef<"pre"> & { node?: unknown }) => {
        const fence = diagramFenceFromPre(node as DiagramHastNode | undefined);
        const Renderer = fence ? diagramRenderers[fence.tag] : null;
        if (!fence || !Renderer) return <pre {...props} />;
        if (fence.overLimit) {
          return (
            <div className="mermaid-diagram-limit" role="note">
              <p>Diagram not rendered because this document contains more than {MERMAID_MAX_DIAGRAMS} Mermaid blocks.</p>
              <pre {...props} />
            </div>
          );
        }
        return (
          <Renderer
            key={`${diagramDocumentKey}\u0000${fence.ordinal}\u0000${fence.source}`}
            source={fence.source}
            ordinal={fence.ordinal}
          />
        );
      }
      : null;
    if (!blockAnchored) {
      // Unchanged, and this early return is the containment: with neither opt-in passed the
      // map is exactly `{ a }`, which is what nine other callers get.
      return fenced ? { a: anchor, pre: fenced } : { a: anchor };
    }
    const map: Record<string, React.ElementType> = { a: anchor };
    for (const tag of BLOCK_ANCHOR_TAGS) {
      // A fence is still a diagram host when the registry is on; the anchor wraps whatever
      // that produced rather than replacing it, so a diagram takes a comment like any block.
      const Inner: React.ElementType | null = tag === "pre" ? fenced : null;
      map[tag] = ({ node, ...props }: { node?: unknown } & Record<string, unknown>) => {
        const rendered = Inner
          ? createElement(Inner, { ...props, node })
          : createElement(tag, props);
        const range = blockRangeFromNode(node);
        // No position, no host. A block the parser did not place cannot be anchored to a
        // line, and rendering it bare is the honest outcome - the reader simply has no
        // button on that one, rather than a button that points somewhere invented.
        if (!range) return rendered;
        return (
          <div
            className="md-block-anchor"
            data-start-line={range.startLine}
            data-end-line={range.endLine}
          >
            {rendered}
            <Tooltip label={blockAnchorTooltip(range)}>
              <button
                type="button"
                className="md-block-comment"
                aria-label={blockAnchorLabel(range)}
                onClick={() => blockHandler.current?.(range)}
              >
                +
              </button>
            </Tooltip>
          </div>
        );
      };
    }
    return map;
  }, [blockAnchored, diagramDocumentKey, diagramRenderers, linkable]);
  /*
   * The plugin list, built rather than nested.
   *
   * It was a two-deep conditional over `paths` and `diagramRenderers`; find is a third
   * independent opt-in, and a fourth nesting level would have been eight literal arrays all
   * saying the same thing. The ORDER is the contract: fences are tagged before highlighting
   * so a diagram is still a diagram, and the find marks run LAST so they mark the text the
   * other three finished producing.
   */
  const findReport = useRef<MarkdownFindReport>({ hits: [] });
  const rehypePlugins = useMemo(() => {
    const plugins: PluggableList = [];
    if (diagramRenderers) {
      plugins.push([
        rehypeDiagramFences,
        { tags: Object.keys(diagramRenderers), limit: MERMAID_MAX_DIAGRAMS },
      ]);
    }
    plugins.push([rehypeHighlight, HIGHLIGHT_OPTIONS]);
    if (paths) plugins.push([rehypeWorkspacePaths, { paths }]);
    if (findQuery !== "") {
      plugins.push([
        rehypeFindMarks,
        {
          query: findQuery,
          caseSensitive: findCaseSensitive,
          currentKey: findCurrentKey,
          report: findReport.current,
        },
      ]);
    }
    return plugins;
  }, [diagramRenderers, findCaseSensitive, findCurrentKey, findQuery, paths]);

  /*
   * Hand back what the plugin drew, AFTER the commit.
   *
   * The plugin runs inside `ReactMarkdown`'s own render, which is a child of this one, so
   * the sink is already filled by the time an effect runs - and calling the caller's setter
   * from here is an ordinary post-commit update rather than a state change during another
   * component's render, which is what a callback invoked from the plugin would have been.
   *
   * Guarded by the reported signature rather than by a dependency list: it has to run on
   * every render that could have re-run the plugin, and a render that changed nothing must
   * not report again and drive a loop.
   */
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!findHits) {
      reported.current = null;
      return;
    }
    const hits = findQuery === "" ? [] : findReport.current.hits;
    const signature = hits
      .map((hit) => [hit.key, hit.range?.startLine ?? "", hit.range?.endLine ?? ""].join(":"))
      .join(",");
    if (reported.current === signature) return;
    reported.current = signature;
    findHits(hits);
  });
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      rehypePlugins={rehypePlugins}
      urlTransform={(url, key) => key === "href" ? markdownLinkUrl(url) : defaultUrlTransform(url)}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}

/**
 * Whether a re-render can be skipped. Exported so the rule is stated once and testable:
 * the default shallow compare cannot express `filePaths`, and getting this wrong is
 * invisible - it fails as heat, a lost hover, or a click routed through last render's
 * state, never as a wrong pixel.
 *
 * `onLinkClick` IS compared by identity, and an earlier version of this that skipped it
 * was wrong. The ref the body keeps is refreshed DURING that body's render, so a
 * comparator that lets a new handler through without re-rendering pins every anchor to
 * the previous closure - and that closure carries App's `layout` and `sessions`, so
 * switching between Console and Board with the transcript text unchanged left path links
 * using the previous layout's destination behavior. Skipping the render is only safe when
 * the handler really has not
 * changed, which is a promise the CALLER has to make; `TranscriptPanel` makes it with a
 * stable wrapper, so this stays a hit on every SSE frame without lying about it.
 */
export function markdownPropsEqual(before: MarkdownProps, after: MarkdownProps): boolean {
  return (
    before.children === after.children &&
    before.breaks === after.breaks &&
    before.filePaths === after.filePaths &&
    before.onLinkClick === after.onLinkClick &&
    before.diagramRenderers === after.diagramRenderers &&
    before.diagramDocumentKey === after.diagramDocumentKey &&
    // `blockAnchor` is compared for `onLinkClick`'s reason, one paragraph up: the body keeps
    // it in a ref refreshed DURING its own render, so a comparator that let a new handler
    // through without re-rendering would pin every block button to the previous closure -
    // and that closure carries the file, the revision and the draft controller. A prop
    // missing from here is not a slow render, it is a silently ignored prop.
    before.blockAnchor === after.blockAnchor &&
    // Field by field rather than by identity, for the reason stated in the body: the caller
    // rebuilds this request every render. `onHits` IS compared by identity, exactly as
    // `onLinkClick` is - a render skipped with a new callback would report this document's
    // hits to a stale closure, and the closure carries the surface those hits belong to.
    before.find?.query === after.find?.query &&
    before.find?.caseSensitive === after.find?.caseSensitive &&
    before.find?.currentKey === after.find?.currentKey &&
    before.find?.onHits === after.find?.onHits
  );
}

export const Markdown = memo(MarkdownBody, markdownPropsEqual);
