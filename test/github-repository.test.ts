import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { parseRemoteConfig, pickCheckoutRepository } = await import("../src/shared/github-repository.mjs");
const { checkoutGitHubRepository, configuredGitHubRepositories } = await import("../src/server/github/repository.ts");
const inspector = await import("../src/server/inspector/github.ts");
const shared = await import("../src/shared/github-repository.mjs");

// `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` output, as a fork checkout prints it.
const FORK = [
  "remote.origin.url git@github.com:me/fork.git",
  "remote.upstream.url https://github.com/org/parent.git",
].join("\n");

const pick = (config: string) => pickCheckoutRepository(parseRemoteConfig(config), "~/Dev/x");

test("parseRemoteConfig groups url and gh-resolved entries by remote, in config order", () => {
  assert.deepEqual(
    parseRemoteConfig(
      [
        "remote.origin.url git@github.com:me/fork.git",
        "remote.my.fork.url https://github.com/me/other.git",
        "remote.origin.gh-resolved base",
        "remote.origin.url https://github.com/me/second.git",
        "",
      ].join("\n"),
    ),
    [
      {
        name: "origin",
        urls: ["git@github.com:me/fork.git", "https://github.com/me/second.git"],
        effectiveUrls: ["git@github.com:me/fork.git", "https://github.com/me/second.git"],
        ghResolved: "base",
      },
      {
        name: "my.fork",
        urls: ["https://github.com/me/other.git"],
        effectiveUrls: ["https://github.com/me/other.git"],
        ghResolved: null,
      },
    ],
  );
});

test("a pin set twice keeps the last value, as git does", () => {
  const config = `${FORK}\nremote.upstream.gh-resolved base\nremote.upstream.gh-resolved me/fork`;
  assert.equal(parseRemoteConfig(config)[1]!.ghResolved, "me/fork");
});

// `git remote get-url`, which the poller used before, applies these; the raw config does not.
test("an origin that is a GitHub alias through insteadOf resolves, and the longest prefix wins", () => {
  const alias = "url.git@github.com:.insteadof gh:\nurl.git@github.com:me/.insteadof gh:mine/\n";
  assert.deepEqual(pick(`${alias}remote.origin.url gh:org/parent`), { ok: true, repo: "org/parent", source: "origin" });
  assert.deepEqual(pick(`${alias}remote.origin.url gh:mine/fork.git`), { ok: true, repo: "me/fork", source: "origin" });
  // The rewrite makes a pin on the aliased remote count too.
  const pinned = `${alias}remote.origin.url gh:mine/fork\nremote.up.url gh:org/parent\nremote.up.gh-resolved base`;
  assert.deepEqual(pick(pinned), { ok: true, repo: "org/parent", source: "gh-default" });
});

test("a GitHub origin rewritten to a local mirror still names its GitHub repository", () => {
  const config = "remote.origin.url https://github.com/me/fork.git\nurl./srv/mirror.git.insteadof https://github.com/me/fork.git";
  assert.equal(parseRemoteConfig(config)[0]!.effectiveUrls[0], "/srv/mirror.git");
  assert.deepEqual(pick(config), { ok: true, repo: "me/fork", source: "origin" });
});

test("the error never repeats a URL's credentials", () => {
  const result = pick("remote.origin.url https://me:s3cret@gitlab.com/me/fork.git");
  assert.ok(!result.ok);
  assert.match(result.error, /origin is https:\/\/gitlab\.com\/me\/fork\.git/);
  assert.doesNotMatch(result.error, /s3cret/);
});

test("a gh default pin on origin resolves to origin and reports origin", () => {
  assert.deepEqual(pick(`${FORK}\nremote.origin.gh-resolved base`), { ok: true, repo: "me/fork", source: "origin" });
});

test("a gh default pin on another remote wins over origin and reports gh-default", () => {
  assert.deepEqual(pick(`${FORK}\nremote.upstream.gh-resolved base`), {
    ok: true,
    repo: "org/parent",
    source: "gh-default",
  });
});

test("an owner/name pin value names that repository; origin's own name still reports origin", () => {
  assert.deepEqual(pick(`${FORK}\nremote.upstream.gh-resolved org/renamed`), {
    ok: true,
    repo: "org/renamed",
    source: "gh-default",
  });
  assert.deepEqual(pick(`${FORK}\nremote.upstream.gh-resolved Me/Fork`), { ok: true, repo: "Me/Fork", source: "origin" });
});

test("with no pin, origin wins even when a remote named upstream exists", () => {
  assert.deepEqual(pick(FORK), { ok: true, repo: "me/fork", source: "origin" });
});

test("a pin on a non-GitHub remote is ignored in favour of origin", () => {
  const config = `${FORK}\nremote.mirror.url git@gitlab.com:me/fork.git\nremote.mirror.gh-resolved base`;
  assert.deepEqual(pick(config), { ok: true, repo: "me/fork", source: "origin" });
});

test("a non-GitHub origin with no pin is an error naming the checkout and listing its remotes", () => {
  const result = pick("remote.origin.url git@gitlab.com:me/fork.git\nremote.upstream.url https://github.com/org/parent.git");
  assert.ok(!result.ok);
  assert.match(result.error, /^No GitHub repository for ~\/Dev\/x: /);
  assert.match(result.error, /origin is git@gitlab\.com:me\/fork\.git, upstream is https:\/\/github\.com\/org\/parent\.git/);
  assert.match(result.error, /no gh default is set/);
  assert.match(result.error, /gh repo set-default/);
});

test("a checkout with no remotes is an error that says so", () => {
  const result = pick("");
  assert.ok(!result.ok);
  assert.match(result.error, /^No GitHub repository for ~\/Dev\/x: it has no remotes; no gh default is set\./);
});

test("the Inspector re-exports the shared URL parser rather than keeping a copy", () => {
  assert.equal(inspector.parseGitHubRemoteUrl, shared.parseGitHubRemoteUrl);
});

function checkout(): { dir: string; git: (...args: string[]) => void } {
  const dir = mkdtempSync(join(tmpdir(), "github-repository-"));
  execFileSync("git", ["init", "-q", dir]);
  return { dir, git: (...args) => void execFileSync("git", ["-C", dir, ...args]) };
}

test("checkoutGitHubRepository reads the checkout's git config", async (t) => {
  const repo = checkout();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  repo.git("remote", "add", "upstream", "https://github.com/org/parent.git");
  repo.git("remote", "add", "origin", "git@github.com:me/fork.git");
  assert.deepEqual(await checkoutGitHubRepository(repo.dir), { ok: true, repo: "me/fork", source: "origin" });

  repo.git("config", "remote.upstream.gh-resolved", "base");
  assert.deepEqual(await checkoutGitHubRepository(repo.dir), { ok: true, repo: "org/parent", source: "gh-default" });
});

test("checkoutGitHubRepository applies the checkout's insteadOf rewrites", async (t) => {
  const repo = checkout();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  repo.git("config", "url.git@github.com:.insteadOf", "gh:");
  repo.git("remote", "add", "origin", "gh:me/fork");
  repo.git("remote", "add", "upstream", "gh:org/parent");
  assert.deepEqual(await checkoutGitHubRepository(repo.dir), { ok: true, repo: "me/fork", source: "origin" });
});

test("checkoutGitHubRepository fails with the checkout's path when nothing is on GitHub", async (t) => {
  const repo = checkout();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const none = await checkoutGitHubRepository(repo.dir);
  assert.ok(!none.ok);
  assert.equal(none.error.startsWith(`No GitHub repository for ${repo.dir}: it has no remotes`), true);

  repo.git("remote", "add", "origin", "git@gitlab.com:me/fork.git");
  const elsewhere = await checkoutGitHubRepository(repo.dir);
  assert.ok(!elsewhere.ok);
  assert.equal(elsewhere.error.startsWith(`No GitHub repository for ${repo.dir}: origin is git@gitlab.com:me/fork.git`), true);
});

test("configuredGitHubRepositories lists every GitHub remote once", async (t) => {
  const repo = checkout();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  repo.git("remote", "add", "origin", "git@github.com:me/fork.git");
  repo.git("remote", "add", "upstream", "https://github.com/org/parent.git");
  repo.git("remote", "add", "again", "https://github.com/ME/FORK");
  repo.git("remote", "add", "mirror", "git@gitlab.com:me/fork.git");
  assert.deepEqual(await configuredGitHubRepositories(repo.dir), [
    { owner: "ME", repo: "FORK" },
    { owner: "org", repo: "parent" },
  ]);
});
