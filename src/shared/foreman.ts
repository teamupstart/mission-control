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

/**
 * Whether Foreman may TYPE in a session, given where it's running (`cwd`) and which
 * repo that checkout belongs to (`repoRoot`, from git's common dir - see `GitInfo`).
 *
 * Two ways to clear the bar, because the allowlist answers a question about REPO
 * IDENTITY that a path prefix alone can only answer about LOCATION:
 *  - `cwd` under an allowlisted root: the literal, pre-existing rule. Kept so an
 *    allowlisted directory that isn't a repo at all still works.
 *  - `repoRoot` under an allowlisted root: the checkout is a worktree OF an
 *    allowlisted repo, wherever it physically sits.
 *
 * The second is what makes live mode usable. Every real session runs in a worktree
 * parked outside the repo (`~/.treehouse/...`, the daemon's worktrees dir), so a
 * user who allowlists their repo and switches to live gets a dashboard where *nothing*
 * sends and every item waits on a confirmation they thought they'd turned off - the
 * guardrail firing on the exact repo they cleared.
 *
 * This widens consent to any worktree of an allowlisted repo, which is the intent
 * being expressed: the allowlist entry names a project, and a worktree of that
 * project is that project. It does NOT reach a different repo that merely sits
 * inside an allowlisted directory tree - that was already allowed by the prefix
 * rule, and is unchanged here.
 *
 * Shared for the reason `cwdAllowlisted` is: the server decides with it and the UI
 * explains that decision with it, so a copy that drifted would have the dashboard
 * promise a send that never comes (or worse, deny one that does).
 */
export function foremanAllowlisted(
  cwd: string | null,
  repoRoot: string | null,
  allowlist: readonly string[],
): boolean {
  return cwdAllowlisted(cwd, allowlist) || cwdAllowlisted(repoRoot, allowlist);
}
