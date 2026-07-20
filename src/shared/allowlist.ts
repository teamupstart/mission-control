// "Is this checkout one the operator has trusted?" - the one path-prefix rule that
// every consent gate in the app is built on, defined once.
//
// Extracted from `foreman.ts` when the Inspector became a second gate asking the same
// question. That file's own doc comment already warned that a drifting copy is
// invisible until it lies to someone; two features deciding whether to act on the
// operator's behalf is exactly when you do not want two matchers.

/** Drop a single trailing "/" (keeping bare "/") so "/repo/" and "/repo" compare equal. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Whether `cwd` sits inside the allowlist.
 *
 * A prefix match on the path BOUNDARY, not `startsWith` alone: `/repo-backup` must not
 * match an allowlisted `/repo`, so the boundary has to be a separator or an exact hit.
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
 * Whether a checkout is allowlisted, given where it sits (`cwd`) and which repo it
 * belongs to (`repoRoot`, from git's common dir - see `GitInfo`).
 *
 * Two ways to clear the bar, because the allowlist answers a question about REPO
 * IDENTITY that a path prefix alone can only answer about LOCATION:
 *  - `cwd` under an allowlisted root: the literal rule. Kept so an allowlisted
 *    directory that isn't a repo at all still works.
 *  - `repoRoot` under an allowlisted root: the checkout is a worktree OF an
 *    allowlisted repo, wherever it physically sits.
 *
 * The second is what makes any of this usable. Every real session runs in a worktree
 * parked outside the repo (`~/.treehouse/...`, the daemon's worktrees dir), so a user
 * who allowlists their repo and switches to live gets a dashboard where *nothing*
 * happens and everything waits on a confirmation they thought they'd turned off - the
 * guardrail firing on the exact repo they cleared.
 *
 * This widens consent to any worktree of an allowlisted repo, which is the intent being
 * expressed: the allowlist entry names a project, and a worktree of that project is that
 * project. It does NOT reach a different repo that merely sits inside an allowlisted
 * directory tree - that was already allowed by the prefix rule, and is unchanged.
 *
 * `repoRoot` defaults to null so a caller without one degrades to the cwd rule -
 * fail-closed: a missing repoRoot can only ever withhold consent, never grant it.
 */
export function repoAllowlisted(
  cwd: string | null,
  repoRoot: string | null,
  allowlist: readonly string[],
): boolean {
  return cwdAllowlisted(cwd, allowlist) || cwdAllowlisted(repoRoot, allowlist);
}
