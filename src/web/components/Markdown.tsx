import { memo, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import { markdownLinkUrl } from "../lib/workspaceLinks.ts";

export type WorkspaceLinkHandler = (href: string, probe?: boolean) => boolean | Promise<boolean>;

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

  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        let shouldOpen = claimed;
        if (!shouldOpen && href) {
          const result = handler.current(href, true);
          shouldOpen = typeof result === "boolean" && result;
        }
        if (href && shouldOpen && handler.current(href) === true) event.preventDefault();
      }}
    />
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
 * Memoized on the rendered text: highlighting is real work, and the transcript
 * re-renders on every SSE frame. Turns are append-only (see `mergeById`), so an
 * existing message's text never changes and this stays a hit for the whole session.
 */
export const Markdown = memo(function Markdown({
  children,
  breaks = false,
  onLinkClick,
}: {
  children: string;
  breaks?: boolean;
  /** Return true when a session-aware caller claimed the href as a workspace file. */
  onLinkClick?: WorkspaceLinkHandler;
}): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      urlTransform={(url, key) => key === "href" ? markdownLinkUrl(url) : defaultUrlTransform(url)}
      components={onLinkClick ? {
        a: ({ node: _node, href, onClick: _onClick, ...props }) => (
          <WorkspaceAnchor {...props} href={href} onLink={onLinkClick} />
        ),
      } : undefined}
    >
      {children}
    </ReactMarkdown>
  );
});
