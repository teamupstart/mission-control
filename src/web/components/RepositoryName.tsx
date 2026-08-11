import { repoLeaf } from "../lib/format.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * A repository's compact display identity.
 *
 * Repository roots remain absolute paths in state, inputs, filtering and accessible control
 * names. Read-only labels use only the final directory name so path bookkeeping does not take
 * over the interface; the complete root stays available through the application's tooltip.
 */
export function RepositoryName({
  path,
  className,
}: {
  path: string | null | undefined;
  className?: string;
}): React.JSX.Element {
  const name = repoLeaf(path);
  if (!path) return <span className={className}>{name}</span>;

  return (
    <Tooltip label={path}>
      <span className={className}>{name}</span>
    </Tooltip>
  );
}
