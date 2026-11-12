import { join } from "node:path";
import {
  REMOTE_CONFIG_ARGS,
  needsGhDefaultPin,
  parseGitHubRemoteUrl,
  parseRemoteConfig,
  pickCheckoutRemote,
  pickCheckoutRepository,
  type CheckoutRemote,
  type CheckoutRepository,
  type CheckoutRepositoryRemote,
  type GitHubRepositoryIdentity,
} from "@shared/github-repository.mjs";
import { run } from "../util/exec.ts";

export type { CheckoutRepository, CheckoutRepositoryRemote, GitHubRepositoryIdentity };

/** The checkout's remotes, or the reason its git config could not be read. */
async function readCheckoutRemotes(
  repoRoot: string,
): Promise<{ ok: true; remotes: CheckoutRemote[] } | { ok: false; error: string }> {
  const result = await run("git", [...REMOTE_CONFIG_ARGS], { cwd: repoRoot, timeoutMs: 8000 });
  // `--get-regexp` exits 1 when nothing matches: a checkout with no remotes, not a failure.
  if (!result.outcomeUnknown && result.code === 1 && !result.stderr.trim()) return { ok: true, remotes: [] };
  if (result.outcomeUnknown || result.code !== 0) {
    const detail = result.stderr.trim().split("\n")[0] || (result.outcomeUnknown ? "git did not answer" : `exit ${result.code}`);
    return { ok: false, error: `Could not read the git remotes of ${repoRoot}: ${detail}` };
  }
  return { ok: true, remotes: parseRemoteConfig(result.stdout) };
}

/**
 * The GitHub repository `gh` calls run in `repoRoot` should name with `--repo`: the gh
 * default pin, else `origin`, else an error naming the checkout and its remotes. See
 * `pickCheckoutRepository` for the precedence and why `gh`'s own choice is never used.
 */
export async function checkoutGitHubRepository(repoRoot: string): Promise<CheckoutRepository> {
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return remotes;
  return pickCheckoutRepository(remotes.remotes, repoRoot);
}

/** `checkoutGitHubRepository`, with the name of the remote the answer was read from. */
export async function checkoutGitHubRemote(repoRoot: string): Promise<CheckoutRepositoryRemote> {
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return remotes;
  return pickCheckoutRemote(remotes.remotes, repoRoot);
}

/**
 * The GitHub repositories this checkout's git config names.
 *
 * Every configured fetch remote is considered rather than assuming one named `origin`:
 * forks cloned with `--origin upstream` and checkouts with a separate fork remote are both
 * ordinary. An unreadable config, a repository with no remotes, and non-GitHub remotes all
 * answer with an empty set, which makes the adoption caller abstain.
 */
export async function configuredGitHubRepositories(repoRoot: string): Promise<GitHubRepositoryIdentity[]> {
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return [];

  const repositories = new Map<string, GitHubRepositoryIdentity>();
  for (const url of remotes.remotes.flatMap((remote) => remote.urls)) {
    const identity = parseGitHubRemoteUrl(url);
    if (!identity) continue;
    repositories.set(`${identity.owner}/${identity.repo}`.toLowerCase(), identity);
  }
  return [...repositories.values()];
}

/**
 * The config key that records Mission Control already pinned this clone. `gh repo set-default
 * --unset` removes only `remote.*.gh-resolved`, so the marker survives an undo and the pin is
 * never written back over the operator's decision.
 */
const PIN_MARKER = "mission.ghDefaultPinned";

/** Git common directories this daemon run has finished with: pinned, already pinned, or failed. */
const settledGhDefaults = new Set<string>();
/** One check per common directory at a time, so parallel dispatches cannot log it twice. */
const pinning = new Map<string, Promise<void>>();

async function gitOk(repoRoot: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
  const result = await run("git", args, { cwd: repoRoot, timeoutMs: 8000 });
  if (!result.outcomeUnknown && result.code === 0) return { ok: true, stdout: result.stdout };
  return { ok: false, detail: result.stderr.trim().split("\n")[0] || (result.outcomeUnknown ? "git did not answer" : `exit ${result.code}`) };
}

async function pinOrigin(repoRoot: string, commonDir: string): Promise<void> {
  const config = join(commonDir, "config");
  if ((await gitOk(repoRoot, ["config", "--file", config, "--get", PIN_MARKER])).ok) {
    settledGhDefaults.add(commonDir);
    return;
  }
  const remotes = await readCheckoutRemotes(repoRoot);
  if (!remotes.ok) return;
  if (remotes.remotes.some((remote) => remote.ghResolved)) settledGhDefaults.add(commonDir);
  // Otherwise not settled: a checkout that gains an `upstream` later in this run is pinned then.
  if (!needsGhDefaultPin(remotes.remotes)) return;

  settledGhDefaults.add(commonDir);
  for (const [key, value] of [["remote.origin.gh-resolved", "base"], [PIN_MARKER, "true"]] as const) {
    const write = await gitOk(repoRoot, ["config", "--file", config, key, value]);
    if (!write.ok) {
      console.warn(`[github] could not pin gh's default repository to origin in ${commonDir}: ${write.detail}`);
      return;
    }
  }
  console.log(
    `[github] pinned gh's default repository to origin in ${commonDir}, which has more than one GitHub remote; ` +
      "undo with `gh repo set-default --unset`",
  );
}

/**
 * Pin gh's default repository to `origin` in a checkout where bare `gh` calls would otherwise
 * have to choose between several GitHub remotes, and would prefer the fork's parent.
 *
 * Writes `remote.origin.gh-resolved base` - the entry `gh repo set-default` writes - into the
 * clone's shared config, so one write covers every worktree, and only when
 * `needsGhDefaultPin` says so and Mission Control has never pinned this clone before. An
 * existing pin is never overwritten. Logged once per git common directory and memoized for
 * the daemon's run. It never throws: the daemon's own `gh` calls pass `--repo` and never
 * depend on the pin, so a failure is logged and the caller carries on.
 */
export async function ensureGhDefaultRepository(repoRoot: string): Promise<void> {
  try {
    const common = await gitOk(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const commonDir = common.ok ? common.stdout.trim() : "";
    if (!commonDir || settledGhDefaults.has(commonDir)) return;
    let pending = pinning.get(commonDir);
    if (!pending) {
      pending = pinOrigin(repoRoot, commonDir).finally(() => pinning.delete(commonDir));
      pinning.set(commonDir, pending);
    }
    await pending;
  } catch (err) {
    console.warn(`[github] could not pin gh's default repository in ${repoRoot}:`, err);
  }
}
