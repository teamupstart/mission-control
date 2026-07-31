import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { markdownLinkUrl } from "../lib/workspaceLinks.ts";
import { rehypeWorkspacePaths, WORKSPACE_PATH_CLASS } from "../lib/rehypeWorkspacePaths.ts";
import { Tooltip } from "./Tooltip.tsx";

export type WorkspaceLinkHandler = (href: string, probe?: boolean) => boolean | Promise<boolean>;

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
}

function MarkdownBody({
  children,
  breaks = false,
  onLinkClick,
  filePaths = null,
}: MarkdownProps): React.JSX.Element {
  const paths = onLinkClick ? filePaths : null;
  // The handler reaches the rendered anchors through a ref, and that is load-bearing
  // rather than tidy. Both call sites build it as a fresh closure per render
  // (`cardProps`, ConsoleDetail's inline arrow), so a `components.a` that closed over it
  // was a NEW COMPONENT TYPE on every SSE frame - and React unmounts a subtree whose
  // element type changed. Every anchor in every turn was being destroyed and rebuilt a
  // few times a second: the hover tooltip could never finish opening, the claim state
  // was thrown away and re-probed, and text selection inside a turn collapsed. Behind a
  // ref the map is built once, the types are stable, and the anchors survive the frame.
  const linkHandler = useRef(onLinkClick);
  linkHandler.current = onLinkClick;
  const linkable = Boolean(onLinkClick);
  const components = useMemo(() => ({
    a: ({ node: _node, href, onClick: _onClick, ...props }: React.ComponentPropsWithoutRef<"a"> & {
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
      ),
  }), [linkable]);
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      rehypePlugins={
        paths
          ? [
              [rehypeHighlight, HIGHLIGHT_OPTIONS],
              [rehypeWorkspacePaths, { paths }],
            ]
          : [[rehypeHighlight, HIGHLIGHT_OPTIONS]]
      }
      urlTransform={(url, key) => key === "href" ? markdownLinkUrl(url) : defaultUrlTransform(url)}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}

/**
 * Whether a re-render can be skipped. Exported so the rule is stated once and testable:
 * the default shallow compare cannot express it, and getting it wrong is invisible - it
 * fails as heat and a lost hover, never as a wrong pixel.
 *
 * `onLinkClick`'s IDENTITY is deliberately not compared. Both call sites rebuild it on
 * every render, so comparing it means "never equal", which is what this memo was while
 * its doc comment claimed the opposite. The rendered tree reaches the live handler
 * through a ref, so only its PRESENCE matters here - that is what picks the branch.
 */
export function markdownPropsEqual(before: MarkdownProps, after: MarkdownProps): boolean {
  return (
    before.children === after.children &&
    before.breaks === after.breaks &&
    before.filePaths === after.filePaths &&
    Boolean(before.onLinkClick) === Boolean(after.onLinkClick)
  );
}

export const Markdown = memo(MarkdownBody, markdownPropsEqual);
