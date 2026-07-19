import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";

/**
 * The one markdown renderer in the app - plans, Foreman briefs, and chat turns all
 * come through here, so a fence looks the same wherever you read it.
 *
 * `remarkBreaks` is load-bearing, not cosmetic. Agent prose is full of single
 * newlines that markdown would otherwise fold into one paragraph, and the surfaces
 * this replaced were `white-space: pre-wrap` - so without it, switching to markdown
 * would silently reflow every message that already exists.
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
export const Markdown = memo(function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
    >
      {children}
    </ReactMarkdown>
  );
});
