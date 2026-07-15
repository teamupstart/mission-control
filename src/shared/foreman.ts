// Foreman predicates that BOTH the server and the dashboard have to agree on,
// defined once - the same reason `noteKeyFor` and `reportBucket` live in
// src/shared rather than being mirrored by hand on each side.

/** Drop a single trailing "/" (keeping bare "/") so "/repo/" and "/repo" compare equal. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Whether `cwd` sits inside the repo allowlist - i.e. whether Foreman may TYPE here
 * rather than only draft.
 *
 * Shared because a drift between the two readers is invisible until it lies to
 * someone: the server decides with it (`foremanMayActLive`), and the work-queue
 * panel explains that decision with it. The panel's whole job there is to answer
 * "why is nothing sending?" - a dispatched-task worktree isn't under the repo root,
 * so it never matches and every item sits drafted, reading as a bug in the queue -
 * so a copy that disagreed by a trailing slash would have the panel promise a send
 * that never comes.
 *
 * A prefix match on the path, NOT `startsWith` alone: `/repo-backup` must not match
 * an allowlisted `/repo`, so the boundary has to be a separator or an exact hit.
 */
export function cwdAllowlisted(cwd: string | null, allowlist: readonly string[]): boolean {
  if (!cwd) return false;
  const dir = stripTrailingSlash(cwd);
  return allowlist.some((root) => {
    const r = stripTrailingSlash(root);
    return dir === r || dir.startsWith(`${r}/`);
  });
}
