import {
  configuredGitHubRepositories,
  fetchPrRefs,
  isAncestor,
  mergeBase,
  parsePrUrl,
  retargetPr,
  type GhResult,
  type GitHubRepositoryIdentity,
  type PrRefs,
} from "../inspector/github.ts";
import { freshRemoteBranchSha, type RemoteProbe } from "../git/remote-default.ts";

/**
 * Everything Stacked pull requests asks of GitHub and of git, behind one seam.
 *
 * Each is a READ, except `retarget`, which edits a pull request's base and writes no code.
 * Nothing here runs git inside a worktree: the branch refresh is a remote-tracking fetch at
 * the repository root, and every ancestry question goes to GitHub's compare API. The seam is
 * injectable so the readiness, dispatch, release and diff rules are testable without a
 * network or a `gh` on the machine.
 */
export interface StackGitHub {
  /** The small set of facts stacking reads about one pull request, by its URL. */
  prRefs(cwd: string | null, prUrl: string): Promise<GhResult<PrRefs>>;
  /** Is `ancestor` in `head`'s history, per GitHub's compare API? */
  isAncestor(cwd: string | null, owner: string, repo: string, ancestor: string, head: string): Promise<GhResult<boolean>>;
  /** The commit a pull request from `head` onto `base` is diffed from, per GitHub. */
  mergeBase(cwd: string | null, owner: string, repo: string, base: string, head: string): Promise<GhResult<string>>;
  /** Fetch one origin branch at the repository root and return its verified tip. */
  branchSha(repoRoot: string, branch: string): Promise<RemoteProbe<string>>;
  /** The GitHub repositories a checkout's remotes name. */
  repositories(repoRoot: string): Promise<readonly GitHubRepositoryIdentity[]>;
  /** Point a pull request at another base branch. */
  retarget(cwd: string | null, owner: string, repo: string, number: number, base: string): Promise<GhResult<void>>;
}

export const defaultStackGitHub: StackGitHub = {
  prRefs: async (cwd, prUrl) => {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) return { ok: false, error: `not a GitHub pull request URL: ${prUrl.slice(0, 120)}` };
    return fetchPrRefs(cwd, parsed.owner, parsed.repo, parsed.number);
  },
  isAncestor,
  mergeBase,
  branchSha: (repoRoot, branch) => freshRemoteBranchSha(repoRoot, branch),
  repositories: configuredGitHubRepositories,
  retarget: retargetPr,
};

/** Does this pull request URL belong to one of the repositories a checkout names? */
export function prInRepositories(prUrl: string, repositories: readonly GitHubRepositoryIdentity[]): boolean {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return false;
  return repositories.some(
    (repository) =>
      repository.owner.toLowerCase() === parsed.owner.toLowerCase() &&
      repository.repo.toLowerCase() === parsed.repo.toLowerCase(),
  );
}
