import {
  compareCommits,
  configuredGitHubRepositories,
  fetchPrRefs,
  isAncestor,
  mergeBase,
  parseGitHubRemoteUrl,
  parsePrUrl,
  retargetPr,
  type BaseComparison,
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
  /** Is `base` in `head`'s history, and how far behind it is `head`? Per GitHub's compare API. */
  compare(cwd: string | null, owner: string, repo: string, base: string, head: string): Promise<GhResult<BaseComparison>>;
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
  compare: compareCommits,
  mergeBase,
  branchSha: (repoRoot, branch) => primaryBranchSha(repoRoot, branch),
  repositories: configuredGitHubRepositories,
  primaryRepository: (repoRoot) => primaryGitHubRepository(repoRoot),
  retarget: retargetPr,
};

/**
 * The seam the daemon's stacking code reads through right now: the Inspector tick, and the
 * inject route's last-moment parent recheck. One holder, so a test that swaps it swaps it for
 * both. Replaced only by tests.
 */
let active: StackGitHub = defaultStackGitHub;
export function activeStackGitHub(): StackGitHub {
  return active;
}
export function useStackGitHub(github: StackGitHub): () => void {
  const previous = active;
  active = github;
  return () => {
    active = previous;
  };
}

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
  return (await primaryGitHubRemote(repoRoot))?.identity ?? null;
}

/** `primaryGitHubRepository`, with the name of the git remote it was read from. */
export async function primaryGitHubRemote(
  repoRoot: string,
): Promise<{ remote: string; identity: GitHubRepositoryIdentity } | null> {
  const result = await run("git", ["-C", repoRoot, "config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: repoRoot });
  if (result.outcomeUnknown || result.code !== 0) return null;
  const remotes: { remote: string; identity: GitHubRepositoryIdentity }[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    const identity = match ? parseGitHubRemoteUrl(match[2]!) : null;
    if (match && identity) remotes.push({ remote: match[1]!, identity });
  }
  const origin = remotes.find((entry) => entry.remote === "origin");
  if (origin) return origin;
  const distinct = new Map(remotes.map((entry) => [`${entry.identity.owner}/${entry.identity.repo}`.toLowerCase(), entry]));
  return distinct.size === 1 ? [...distinct.values()][0]! : null;
}

/**
 * Fetch a stack parent's branch and return its verified tip: from `origin` first, and - only
 * when that fails and the primary GitHub repository is a different remote - from that remote.
 * The parent's pull request is in the primary repository, so a checkout whose `origin` is not
 * GitHub (a local mirror, say) can lack the branch there. Either way the tip is then checked
 * against the head GitHub reports for the pull request by the caller, so a same-named branch
 * on the wrong remote is still refused. The fetch writes only that remote's remote-tracking
 * ref, at the repository root.
 */
export async function primaryBranchSha(repoRoot: string, branch: string): Promise<RemoteProbe<string>> {
  const fromOrigin = await freshRemoteBranchSha(repoRoot, branch);
  if (fromOrigin.ok) return fromOrigin;
  const primary = await primaryGitHubRemote(repoRoot);
  if (!primary || primary.remote === "origin") return fromOrigin;
  const fromPrimary = await freshRemoteBranchSha(repoRoot, branch, run, primary.remote);
  if (fromPrimary.ok) return fromPrimary;
  return { ...fromPrimary, reason: `${fromOrigin.reason}; ${fromPrimary.reason}` };
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
