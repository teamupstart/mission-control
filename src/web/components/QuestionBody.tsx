import { useCallback } from "react";
import { MARKDOWN_QUESTIONS_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";
import { matchCheckoutPaths } from "../lib/workspaceLinks.ts";
import { CheckoutPathText } from "./CheckoutPathText.tsx";
import { Markdown, type WorkspaceLinkHandler } from "./Markdown.tsx";

/**
 * The checkout file an href names, or null.
 *
 * A path the agent typed is marked up with its own text as the href (`rehypeWorkspacePaths`),
 * so `docs/plan.md:12` arrives here whole. A link the agent wrote as Markdown arrives the same
 * way. Both resolve through the one grammar that found the path in the first place, and only
 * when the WHOLE href is that path: `matchCheckoutPaths` would otherwise find a file inside a
 * longer URL.
 */
export function questionLinkPath(href: string, paths: ReadonlySet<string>): string | null {
  const [token] = matchCheckoutPaths(href, paths);
  return token && token.start === 0 && token.end === href.length ? token.path : null;
}

/**
 * The body of an `input` review: the agent's question past the heading, then its context.
 *
 * With the `markdown-questions` preview on it renders through the shared `Markdown` component,
 * so the bullets, headings and code an agent writes arrive as lists, headings and code rather
 * than one block of text. Single newlines stay line breaks (`breaks`), so a plain-text body
 * reads exactly as it did. Checkout paths still open Files, claimed by `questionLinkPath`.
 *
 * With the preview off it is the plain paragraph it always was. Either way the caller's class
 * owns the box, so a surface keeps its own type size and spacing.
 */
export function QuestionBody({
  text,
  className,
  paths = null,
  onOpenPath,
}: {
  text: string;
  className: string;
  paths?: ReadonlySet<string> | null;
  onOpenPath?: (path: string) => void;
}): React.JSX.Element {
  const markdown = useFeatureFlag(MARKDOWN_QUESTIONS_FLAG_ID);
  // Stable across renders for `Markdown`'s memo, which compares the handler by identity.
  const onLink = useCallback<WorkspaceLinkHandler>((href, probe) => {
    const path = paths && onOpenPath ? questionLinkPath(href, paths) : null;
    if (!path) return false;
    if (!probe) onOpenPath!(path);
    return true;
  }, [onOpenPath, paths]);

  if (!markdown) {
    return (
      <p className={className}>
        <CheckoutPathText text={text} paths={paths} onOpen={onOpenPath} />
      </p>
    );
  }
  const linked = Boolean(paths && onOpenPath);
  return (
    <div className={`${className} markdown question-markdown`}>
      <Markdown breaks onLinkClick={linked ? onLink : undefined} filePaths={linked ? paths : null}>
        {text}
      </Markdown>
    </div>
  );
}
