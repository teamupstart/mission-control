import {
  configuredGitHubRepositories,
  fetchPrRefs,
  isAncestor,
  mergeBase,
  parseGitHubRemoteUrl,
  parsePrUrl,
  retargetPr,
  type GhResult,
  type GitHubRepositoryIdentity,
  type PrRefs,
} from "../inspector/github.ts";
import { freshRemoteBranchSha, type RemoteProbe } from "../git/remote-default.ts";
import { run } from "../util/exec.ts";

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
  /**
   * The one GitHub repository a checkout's own pull requests belong to, or null when that
   * cannot be told. See `primaryGitHubRepository`.
   */
  primaryRepository(repoRoot: string): Promise<GitHubRepositoryIdentity | null>;
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
  primaryRepository: (repoRoot) => primaryGitHubRepository(repoRoot),
  retarget: retargetPr,
};

/**
 * The GitHub repository a checkout's pull requests are opened in: `origin`'s, when `origin`
 * is a GitHub remote, else the checkout's only GitHub remote. Null when neither holds - two
 * GitHub remotes and no GitHub `origin`, or none at all - because a parent pull request
 * matched against "some remote" can sit in a repository the child's pull request never
 * opens in, and the child would then get no stack lineage and no stacking hold.
 *
 * A read of the repository root's git config; it never runs git inside a worktree.
 */
export async function primaryGitHubRepository(repoRoot: string): Promise<GitHubRepositoryIdentity | null> {
  const origin = await run("git", ["config", "--get", "remote.origin.url"], { cwd: repoRoot });
  if (origin.code === 0 && !origin.outcomeUnknown) {
    const identity = parseGitHubRemoteUrl(origin.stdout.trim());
    if (identity) return identity;
  }
  const all = await configuredGitHubRepositories(repoRoot);
  return all.length === 1 ? all[0]! : null;
}

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
