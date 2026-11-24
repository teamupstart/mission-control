// Which GitHub repository a checkout's `gh` calls target.
//
// Its own pure module because three runtimes ask - the daemon, Electron main and the
// repository's `scripts/` - and each one used to decide for itself, or not at all. Left to
// choose, `gh` picks the base repository from the remotes, and outside a terminal it prefers
// one named `upstream`: on a fork, the parent, which an org enforcing SAML SSO refuses to a
// token not authorized there. So no caller leaves the choice to `gh`; it reads the checkout's
// git config, hands it to `pickCheckoutRepository`, and passes the answer as `--repo`.
//
// Nothing here runs git. The caller does, with `REMOTE_CONFIG_ARGS`, so the daemon can use its
// own subprocess runner and a script can use `execFileSync`.

/**
 * The `git` arguments whose stdout `parseRemoteConfig` reads: every remote's `url` and
 * `gh-resolved`, and every `url.<base>.insteadOf` rewrite. Exits 1 when nothing matches.
 */
export const REMOTE_CONFIG_ARGS = [
  "config",
  "--get-regexp",
  "^(remote\\..*\\.(url|gh-resolved)|url\\..*\\.insteadof)$",
];

/** Read a GitHub repository identity from one configured git remote URL, or null. */
export function parseGitHubRemoteUrl(url) {
  const value = url.trim();
  const scp = /^(?:[^@\s]+@)?github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value);
  if (scp) return { owner: scp[1], repo: scp[2] };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

/** `url` after git's `insteadOf` rewriting: the longest matching prefix wins, as in git. */
function rewriteUrl(url, rewrites) {
  let best = null;
  for (const rewrite of rewrites) {
    if (url.startsWith(rewrite.prefix) && (!best || rewrite.prefix.length > best.prefix.length)) best = rewrite;
  }
  return best ? best.base + url.slice(best.prefix.length) : url;
}

/**
 * The remotes in `git config --get-regexp` output for `REMOTE_CONFIG_ARGS`, in config order.
 *
 * `urls` keeps every `url` entry as configured, because git allows several and the first is
 * the one fetched; `effectiveUrls` are the same after `insteadOf` rewriting, which is what
 * `git remote get-url` prints. `ghResolved` is what `gh repo set-default` wrote (`base`, or an
 * `owner/name`), else null; the last value wins, as it does for git.
 */
export function parseRemoteConfig(stdout) {
  const remotes = new Map();
  const rewrites = [];
  for (const line of stdout.split("\n")) {
    const separator = line.search(/\s/);
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator).trim();
    const rewrite = /^url\.(.+)\.insteadof$/i.exec(key);
    if (rewrite) {
      rewrites.push({ base: rewrite[1], prefix: value });
      continue;
    }
    const entry = /^remote\.(.+)\.(url|gh-resolved)$/.exec(key);
    if (!entry) continue;
    const [, name, variable] = entry;
    const remote = remotes.get(name) ?? { name, urls: [], effectiveUrls: [], ghResolved: null };
    if (variable === "url") remote.urls.push(value);
    else remote.ghResolved = value;
    remotes.set(name, remote);
  }
  // Applied after the whole read, because global rewrites print before a checkout's remotes.
  for (const remote of remotes.values()) remote.effectiveUrls = remote.urls.map((url) => rewriteUrl(url, rewrites));
  return [...remotes.values()];
}

/**
 * The GitHub repository a remote fetches from: its rewritten URL when that is on GitHub (an
 * alias such as `gh:me/fork`), else its URL as configured (a GitHub URL rewritten to a local
 * mirror still names that repository).
 */
function githubRepositoryOf(remote) {
  const effective = remote?.effectiveUrls[0];
  const configured = remote?.urls[0];
  return (
    (effective === undefined ? null : parseGitHubRemoteUrl(effective)) ??
    (configured === undefined ? null : parseGitHubRemoteUrl(configured))
  );
}

/** A URL fit for an error message: any `user:password@` dropped. */
function redactUrl(url) {
  return url.replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]*@/i, "$1");
}

/** The repository a `gh-resolved` pin names, or null when the pin is unset or unusable. */
function pinnedRepository(remote) {
  const own = githubRepositoryOf(remote);
  if (!own || !remote.ghResolved) return null;
  if (remote.ghResolved === "base") return own;
  const named = /^([\w.-]+)\/([\w.-]+)$/.exec(remote.ghResolved);
  return named ? { owner: named[1], repo: named[2] } : null;
}

/**
 * Whether Mission Control should pin gh's default repository to `origin`: no remote carries a
 * `gh-resolved` pin, more than one remote is on GitHub (so `gh` would have to choose, and
 * outside a terminal it prefers `upstream`), and `origin` is one of them.
 */
export function needsGhDefaultPin(remotes) {
  if (remotes.some((remote) => remote.ghResolved)) return false;
  if (!githubRepositoryOf(remotes.find((remote) => remote.name === "origin"))) return false;
  return remotes.filter((remote) => githubRepositoryOf(remote)).length > 1;
}

const slug = ({ owner, repo }) => `${owner}/${repo}`;

/**
 * Which GitHub repository `gh` should be told to use in `checkout`, given its parsed remotes.
 *
 * 1. A gh default pin: the first remote whose `gh-resolved` is `base`, or an `owner/name` gh
 *    stored for a renamed repository. Honoured only when that remote's URL is on GitHub.
 * 2. Otherwise `origin`, when its URL is on GitHub.
 *
 * A URL is on GitHub when it parses as one either after `insteadOf` rewriting or as
 * configured (`githubRepositoryOf`).
 * 3. Otherwise an error that names the checkout and lists its remotes. Never `gh`'s own
 *    choice: that is the implicit fallback that lands on a fork's parent.
 *
 * `source` says where the answer departs from what the operator would expect, not who wrote
 * the pin: a pin naming origin's own repository reports `origin`, and only a pin naming a
 * different repository reports `gh-default`.
 */
export function pickCheckoutRepository(remotes, checkout) {
  const picked = pickCheckoutRemote(remotes, checkout);
  return picked.ok ? { ok: true, repo: picked.repo, source: picked.source } : picked;
}

/**
 * `pickCheckoutRepository`, with the name of the remote the answer was read from: the remote
 * carrying the pin, or `origin`. For a caller that has to fetch from that repository, such as
 * Stacked pull requests fetching a parent branch, so it fetches from the remote the answer names.
 */
export function pickCheckoutRemote(remotes, checkout) {
  const origin = remotes.find((remote) => remote.name === "origin");
  const originRepository = githubRepositoryOf(origin);
  for (const remote of remotes) {
    const pinned = pinnedRepository(remote);
    if (!pinned) continue;
    const sameAsOrigin =
      originRepository !== null && slug(originRepository).toLowerCase() === slug(pinned).toLowerCase();
    return { ok: true, repo: slug(pinned), source: sameAsOrigin ? "origin" : "gh-default", remote: remote.name };
  }
  if (originRepository) return { ok: true, repo: slug(originRepository), source: "origin", remote: "origin" };

  const listed = remotes.length
    ? remotes.map((remote) => `${remote.name} is ${remote.urls[0] === undefined ? "(no url)" : redactUrl(remote.urls[0])}`).join(", ")
    : "it has no remotes";
  const pin = remotes.some((remote) => remote.ghResolved) ? "the gh default is not a GitHub remote" : "no gh default is set";
  return {
    ok: false,
    error:
      `No GitHub repository for ${checkout}: ${listed}; ${pin}. ` +
      "Point origin at GitHub, or run `gh repo set-default`.",
  };
}
