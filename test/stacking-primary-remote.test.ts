import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stack parent's branch is fetched from the remote its pull request actually lives on. A
// checkout whose `origin` is not GitHub (a local mirror) but which has one GitHub remote has
// that remote as its primary repository, and a parent branch that exists only there must
// still be fetchable, or every stacked dispatch is refused and retried forever.
//
// Real git, no network: the GitHub remote's URL is rewritten to a local bare repository with
// `url.<path>.insteadOf`, so the checkout's config names github.com while the fetch is local.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-primary-remote-"));
process.env.HARNESS_HOME = home;
const { primaryBranchSha, primaryGitHubRemote, primaryGitHubRepository } = await import("../src/server/stacking/github.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV }).trim();
}

let n = 0;
/** A local mirror `origin` with `main` only, and a GitHub `hub` that also has `feat/parent`. */
function world(): { checkout: string; parentTip: string; mirror: string } {
  n += 1;
  const root = join(home, `w${n}`);
  const mirror = join(root, "mirror.git");
  const hub = join(root, "hub.git");
  git(home, "init", "-q", "--bare", "-b", "main", mirror);
  git(home, "init", "-q", "--bare", "-b", "main", hub);
  const author = join(root, "author");
  git(home, "init", "-q", "-b", "main", author);
  writeFileSync(join(author, "base.txt"), "base\n");
  git(author, "add", "base.txt");
  git(author, "commit", "-q", "-m", "base");
  git(author, "push", "-q", mirror, "main");
  git(author, "push", "-q", hub, "main");
  git(author, "checkout", "-q", "-b", "feat/parent");
  writeFileSync(join(author, "parent.txt"), "parent\n");
  git(author, "add", "parent.txt");
  git(author, "commit", "-q", "-m", "parent");
  git(author, "push", "-q", hub, "feat/parent");
  const parentTip = git(author, "rev-parse", "HEAD");

  const checkout = join(root, "checkout");
  git(home, "clone", "-q", mirror, checkout);
  git(checkout, "remote", "add", "github", `https://github.com/acme/repo-${n}.git`);
  git(checkout, "config", `url.${hub}.insteadOf`, `https://github.com/acme/repo-${n}.git`);
  return { checkout, parentTip, mirror };
}

test("a checkout with a local-mirror origin and one GitHub remote fetches the parent branch from that remote", async () => {
  const { checkout, parentTip } = world();
  assert.deepEqual(await primaryGitHubRemote(checkout), { remote: "github", identity: { owner: "acme", repo: `repo-${n}` } });
  assert.deepEqual(await primaryGitHubRepository(checkout), { owner: "acme", repo: `repo-${n}` });

  const tip = await primaryBranchSha(checkout, "feat/parent");
  assert.deepEqual(tip, { ok: true, value: parentTip }, "origin lacks the branch, so the primary GitHub remote supplies it");
  assert.equal(git(checkout, "rev-parse", "refs/remotes/github/feat/parent"), parentTip, "fetched into that remote's tracking ref");
  const originRef = spawnSync("git", ["-C", checkout, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/feat/parent"]);
  assert.notEqual(originRef.status, 0, "nothing was written under origin's remote-tracking refs");
});

test("origin is still asked first, and a branch on it is taken from it", async () => {
  const { checkout, mirror } = world();
  // The mirror gets its own feat/parent at another commit.
  const other = join(home, `other-${n}`);
  git(home, "clone", "-q", mirror, other);
  git(other, "checkout", "-q", "-b", "feat/parent");
  writeFileSync(join(other, "mirror.txt"), "mirror\n");
  git(other, "add", "mirror.txt");
  git(other, "commit", "-q", "-m", "mirror");
  git(other, "push", "-q", "origin", "feat/parent");
  const mirrorTip = git(other, "rev-parse", "HEAD");
  assert.deepEqual(await primaryBranchSha(checkout, "feat/parent"), { ok: true, value: mirrorTip },
    "origin's tip is returned; the dispatch then refuses it if it is not the pull request's head");
});

test("a branch on neither remote is refused with both reasons, and an origin that is GitHub has no fallback", async () => {
  const { checkout } = world();
  const missing = await primaryBranchSha(checkout, "feat/nowhere");
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.reason : "", /origin/);
  assert.match(!missing.ok ? missing.reason : "", /github/);

  // When origin itself names GitHub it is the primary, and nothing else is tried.
  git(checkout, "remote", "set-url", "origin", "https://github.com/acme/origin-repo.git");
  git(checkout, "config", `url.${join(home, `w${n}`, "mirror.git")}.insteadOf`, "https://github.com/acme/origin-repo.git");
  assert.equal((await primaryGitHubRemote(checkout))?.remote, "origin");
  const fromOrigin = await primaryBranchSha(checkout, "feat/parent");
  assert.equal(fromOrigin.ok, false, "origin is the primary GitHub remote and lacks the branch: no other remote is asked");
  assert.doesNotMatch(!fromOrigin.ok ? fromOrigin.reason : "", /github has no branch/);
});
