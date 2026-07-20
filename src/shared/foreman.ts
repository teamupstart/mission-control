// Foreman predicates that BOTH the server and the dashboard have to agree on,
// defined once - the same reason `noteKeyFor` and `reportBucket` live in
// src/shared rather than being mirrored by hand on each side.

import { repoAllowlisted } from "./allowlist.ts";

export { cwdAllowlisted } from "./allowlist.ts";

/**
 * Whether Foreman may TYPE in a session, given where it's running (`cwd`) and which
 * repo that checkout belongs to (`repoRoot`).
 *
 * A named alias of the shared `repoAllowlisted` rather than a second implementation:
 * the Inspector asks the identical question about the same paths, and this name is
 * what the server's gate (`foremanMayActLive`) and the work-queue panel's explanation
 * both read as. The panel's whole job there is to answer "why is nothing sending?",
 * so a copy that disagreed by a trailing slash would have the panel promise a send
 * that never comes - see `allowlist.ts` for why the boundary match is the way it is.
 */
export function foremanAllowlisted(
  cwd: string | null,
  repoRoot: string | null,
  allowlist: readonly string[],
): boolean {
  return repoAllowlisted(cwd, repoRoot, allowlist);
}
