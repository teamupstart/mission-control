import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cachedGitTree, gitIn, mkOriginAndClone, seedGitHistory, seedGitRepo } from "./helpers/git-fixture.ts";
import { tempDir } from "./temp-root.mjs";

/** Run `body` with one more git config entry in this worker's environment, then remove it. */
function withGitConfig(key: string, value: string, body: () => void): void {
  const before = process.env.GIT_CONFIG_COUNT;
  const index = Number.parseInt(before ?? "0", 10) || 0;
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  try {
    body();
  } finally {
    delete process.env[`GIT_CONFIG_KEY_${index}`];
    delete process.env[`GIT_CONFIG_VALUE_${index}`];
    if (before === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = before;
  }
}

function supportsReftable(): boolean {
  const probe = tempDir("mission-git-fixture-probe-");
  try {
    execFileSync("git", ["init", "-q", "--ref-format=reftable", probe], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test("a seeded copy is the same repository, clean and on its branch", (t) => {
  const root = tempDir("mission-git-fixture-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { "a.txt": "a\n", "dir/b.txt": "b\n" };
  const first = seedGitRepo(join(root, "first"), { branch: "main", files });
  const copy = seedGitRepo(join(root, "copy"), { branch: "main", files });
  assert.equal(copy, first, "one seed, one commit");
  for (const dir of ["first", "copy"]) {
    const repo = join(root, dir);
    // First, before anything that refreshes the index: plumbing reads the stat cache as it is,
    // so a copy whose cache still described the template's inodes would list every file here.
    // `git status` rewrites the index, and would hide that if it ran first.
    assert.equal(gitIn(repo, "diff-index", "--name-only", "HEAD"), "");
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), first);
    assert.equal(gitIn(repo, "symbolic-ref", "--short", "HEAD"), "main");
    assert.equal(gitIn(repo, "status", "--porcelain"), "");
    assert.equal(gitIn(repo, "config", "user.email"), "t@test");
  }
  const [base, second] = seedGitHistory(join(root, "history"), {
    files: { "f.txt": "one\n" },
    later: [{ files: { "f.txt": "two\n" }, message: "second" }],
  });
  assert.equal(gitIn(join(root, "history"), "rev-parse", "HEAD^"), base);
  assert.equal(gitIn(join(root, "history"), "rev-parse", "HEAD"), second);
});

test("an origin-and-clone copy fetches from its own origin, not the first one built", () => {
  const first = mkOriginAndClone("mission-git-fixture-pair-a-");
  const second = mkOriginAndClone("mission-git-fixture-pair-b-");
  try {
    assert.equal(gitIn(second.clone, "remote", "get-url", "origin"), second.origin);
    gitIn(second.origin, "commit", "--allow-empty", "-qm", "only in the second origin");
    gitIn(second.clone, "fetch", "-q", "origin");
    assert.equal(gitIn(second.clone, "rev-parse", "origin/main"), gitIn(second.origin, "rev-parse", "HEAD"));
    assert.notEqual(gitIn(first.origin, "rev-parse", "HEAD"), gitIn(second.origin, "rev-parse", "HEAD"));
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("a committed relative symlink in a cached tree stays relative in every copy", (t) => {
  const roots: string[] = [];
  t.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const build = () => {
    const root = tempDir("mission-git-fixture-symlink-");
    roots.push(root);
    return cachedGitTree("relative-symlink", root, (dir) => {
      const repo = join(dir, "repo");
      seedGitRepo(repo, { files: { "keep.txt": "kept\n" }, message: "symlink base" });
      symlinkSync("keep.txt", join(repo, "alias"));
      gitIn(repo, "add", "alias");
      gitIn(repo, "commit", "-qm", "alias");
      return { repo };
    });
  };
  const first = build();
  const copy = build();
  // The first build is gone; a copy whose link was resolved against it would now dangle.
  rmSync(roots[0]!, { recursive: true, force: true });
  assert.equal(readlinkSync(join(copy.repo, "alias")), "keep.txt");
  assert.equal(readFileSync(join(copy.repo, "alias"), "utf8"), "kept\n");
  assert.equal(gitIn(copy.repo, "status", "--porcelain"), "");
  assert.notEqual(copy.repo, first.repo);
});

test("a cached copy rewrites git's metadata only, never tracked files named like it", (t) => {
  const roots: string[] = [];
  t.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
  const build = () => {
    const root = tempDir("mission-git-fixture-metadata-");
    roots.push(root);
    return cachedGitTree("tracked-config-and-gitdir", root, (dir) => {
      const origin = join(dir, "origin");
      // Tracked content that happens to share git's file names and quote the build root.
      seedGitRepo(origin, { files: { "config": `${dir}\n`, "sub/gitdir": `${dir}\n` }, message: "metadata-like files" });
      const clone = join(dir, "clone");
      execFileSync("git", ["clone", "-q", origin, clone], { stdio: "pipe" });
      return { builtAt: dir, origin, clone };
    });
  };
  const first = build();
  const copy = build();
  for (const repo of [copy.origin, copy.clone]) {
    assert.equal(readFileSync(join(repo, "config"), "utf8"), `${first.builtAt}\n`, "tracked content is left as committed");
    assert.equal(readFileSync(join(repo, "sub/gitdir"), "utf8"), `${first.builtAt}\n`);
    assert.equal(gitIn(repo, "status", "--porcelain"), "");
  }
  // While git's own record of the remote is re-rooted onto this copy.
  assert.equal(gitIn(copy.clone, "remote", "get-url", "origin"), copy.origin);
});

test("fixtures still work when git defaults new repositories to reftable", { skip: !supportsReftable() }, (t) => {
  // A global `init.defaultRefFormat=reftable` leaves no loose branch ref to read the sha from.
  const root = tempDir("mission-git-fixture-reftable-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  withGitConfig("init.defaultRefFormat", "reftable", () => {
    const repo = join(root, "repo");
    const sha = seedGitRepo(repo, { branch: "main", files: { "keep.txt": "base\n" }, message: "unique reftable seed" });
    assert.equal(gitIn(repo, "rev-parse", "--show-ref-format"), "reftable");
    assert.equal(gitIn(repo, "rev-parse", "HEAD"), sha);
    const copy = join(root, "copy");
    assert.equal(seedGitRepo(copy, { branch: "main", files: { "keep.txt": "base\n" }, message: "unique reftable seed" }), sha);
    assert.equal(gitIn(copy, "rev-parse", "HEAD"), sha);
    assert.equal(gitIn(copy, "status", "--porcelain"), "");
  });
});
