// Hand-written types for github-repository.mjs, so the daemon, Electron main and the tests can
// import the resolver the repository's scripts run. Same arrangement as pr-command.d.mts.

export interface GitHubRepositoryIdentity {
  owner: string;
  repo: string;
}

/** One remote from `git config --get-regexp`, as `parseRemoteConfig` reads it. */
export interface CheckoutRemote {
  name: string;
  /** As configured. */
  urls: string[];
  /** After `insteadOf` rewriting, as `git remote get-url` prints them. */
  effectiveUrls: string[];
  ghResolved: string | null;
}

export type CheckoutRepository =
  | { ok: true; repo: string; source: "gh-default" | "origin" }
  | { ok: false; error: string };

export const REMOTE_CONFIG_ARGS: readonly string[];

export function parseGitHubRemoteUrl(url: string): GitHubRepositoryIdentity | null;

export function parseRemoteConfig(stdout: string): CheckoutRemote[];

export function pickCheckoutRepository(remotes: readonly CheckoutRemote[], checkout: string): CheckoutRepository;

/** `CheckoutRepository`, with the name of the remote the answer was read from. */
export type CheckoutRepositoryRemote =
  | { ok: true; repo: string; source: "gh-default" | "origin"; remote: string }
  | { ok: false; error: string };

export function pickCheckoutRemote(remotes: readonly CheckoutRemote[], checkout: string): CheckoutRepositoryRemote;

export function needsGhDefaultPin(remotes: readonly CheckoutRemote[]): boolean;
