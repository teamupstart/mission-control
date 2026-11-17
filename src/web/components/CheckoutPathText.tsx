import { matchCheckoutPaths } from "../lib/workspaceLinks.ts";
import { WORKSPACE_PATH_CLASS } from "../lib/rehypeWorkspacePaths.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Plain question text with every real checkout path in it opening that file in Files.
 *
 * Membership decides, as it does in the transcript (`matchCheckoutPaths`), so a path the
 * agent only mentions, or one that no longer exists, stays the text it typed.
 */
export function CheckoutPathText({
  text,
  paths,
  onOpen,
}: {
  text: string;
  paths: ReadonlySet<string> | null;
  onOpen?: (path: string) => void;
}): React.JSX.Element {
  if (!onOpen || !paths) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const token of matchCheckoutPaths(text, paths)) {
    if (token.start > at) parts.push(text.slice(at, token.start));
    parts.push(
      <Tooltip key={token.start} label="Open in Files; the question stays pending">
        <a
          className={WORKSPACE_PATH_CLASS}
          href={token.path}
          onClick={(event) => {
            event.preventDefault();
            onOpen(token.path);
          }}
        >
          {token.raw}
        </a>
      </Tooltip>,
    );
    at = token.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
