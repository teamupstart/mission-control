import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo, mainRepoRoot, worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import {
  ensureWorktreePoolMarker,
  findWorktreePoolMarker,
} from "../src/server/worktrees/marker.ts";
import { gitIn, mkLinkedWorktree, mkOriginAndClone } from "./helpers/git-fixture.ts";

/**
 * Build a repo whose main checkout has a `.git` dir and a linked worktree whose
 * `.git` is a file - the treehouse/dispatch shape - and return both dirs.
 */
function makeRepoWithWorktree(): { main: string; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-wt-")));
  const main = join(root, "main");
  const gitDir = join(main, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "config"), "");

  // The linked worktree's own git dir under the main repo's .git/worktrees.
  const wtGitDir = join(gitDir, "worktrees", "wt1");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/mancej/dispatch-mission-report\n");
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");

  // The checked-out worktree dir, whose `.git` is a FILE pointing at wtGitDir.
  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

  return { main, worktree };
}

test("gitInfo reads a normal checkout's branch and roots", () => {
  const { main } = makeRepoWithWorktree();
  assert.deepEqual(gitInfo(main), { branch: "main", root: main, repoRoot: main });
});

test("gitInfo resolves a linked worktree's branch and own root", () => {
  const { main, worktree } = makeRepoWithWorktree();
  // Branch comes from the worktree's own HEAD. The root is the worktree itself, NOT the main checkout - they're
  // separate trees, and only one of them is touched by a reset.
  assert.deepEqual(gitInfo(worktree), {
    branch: "mancej/dispatch-mission-report",
    root: worktree,
    // The worktree's own root is itself, but the REPO it belongs to is the main
    // checkout - the distinction Foreman's allowlist turns on.
    repoRoot: main,
  });
  assert.notEqual(gitInfo(worktree).root, gitInfo(main).root);
  assert.equal(gitInfo(worktree).repoRoot, gitInfo(main).repoRoot, "same repo, different trees");
});

test("mainRepoRoot walks a linked worktree back to the repo that owns it", () => {
  const { main, worktree } = makeRepoWithWorktree();
  // The pool reaper's key move: a session in a pooled tree reports that tree as
  // its cwd, but treehouse keys the pool off the OWNING repo. `gitInfo().root`
  // stops at the worktree; this has to go one hop further, via commondir.
  assert.equal(mainRepoRoot(worktree), main);
  assert.equal(gitInfo(worktree).root, worktree);
});

test("mainRepoRoot is the checkout itself for a normal clone, and null outside a repo", () => {
  const { main } = makeRepoWithWorktree();
  assert.equal(mainRepoRoot(main), main);
  assert.equal(mainRepoRoot(join(main, "packages", "app")), main);
  assert.equal(mainRepoRoot(realpathSync(mkdtempSync(join(tmpdir(), "git-norepo-")))), null);
  assert.equal(mainRepoRoot(null), null);
});

test("gitInfo reports the worktree root from a nested subdir", () => {
  const { main } = makeRepoWithWorktree();
  // A pane sitting deep in the tree still resolves to the top, so "same checkout"
  // compares equal however deep the session's cwd is.
  const sub = join(main, "packages", "app");
  mkdirSync(sub, { recursive: true });
  assert.equal(gitInfo(sub).root, main);
});

test("gitInfo reports a detached HEAD as being on no branch, but still in its repo", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-det-")));
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "06a99e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f\n");
  writeFileSync(join(gitDir, "config"), "");
  // A detached HEAD is on NO branch - dressing the sha up as one made a dispatched session
  // provisioned at a bare commit look like it switched branches the instant the agent cut a
  // real one, which cancelled its task (see `branchFromHead`). `root` still resolves, so this
  // stays distinct from the not-a-repo case below.
  assert.deepEqual(gitInfo(root), { branch: null, root, repoRoot: root });
});

test("gitInfo returns nulls for a non-repo dir", () => {
  const root = mkdtempSync(join(tmpdir(), "git-none-"));
  assert.deepEqual(gitInfo(root), { branch: null, root: null, repoRoot: null });
});

/**
 * A worktree of a BARE repo: its commondir points at `/…/demo.git`, which is the repo
 * itself rather than some checkout's `.git`. Taking the parent there would report the
 * directory that merely CONTAINS the repo as the repo root - and since `repoRoot` feeds
 * Foreman's allowlist, that would silently clear every sibling repo sitting next to it.
 */
test("gitInfo reports a bare repo as its own root, never its parent directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-bare-")));
  const bare = join(root, "demo.git");
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(bare, "config"), "");

  const wtGitDir = join(bare, "worktrees", "wt1");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feature\n");
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");

  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

  const info = gitInfo(worktree);
  assert.equal(info.branch, "feature");
  assert.equal(info.repoRoot, bare, "the bare repo itself");
  assert.notEqual(info.repoRoot, root, "NOT the dir that merely contains it");
});

test("native identity joins a main checkout and linked worktree by physical common dir", () => {
  const { root, clone } = mkOriginAndClone("mission-native-identity-");
  const linked = mkLinkedWorktree(clone, "linked", join(root, "linked"));
  const pools = join(root, "pools");
  const main = worktreeRepositoryIdentity(clone, pools);
  const fromLinked = worktreeRepositoryIdentity(linked, pools);
  assert.ok(main);
  assert.deepEqual(fromLinked, main);
  assert.equal(main.gitCommonDirectory, realpathSync(join(clone, ".git")));
});

test("two clones of one remote never share native pool identity", () => {
  const { root, origin, clone } = mkOriginAndClone("mission-native-clones-");
  const second = join(root, "second");
  execFileSync("git", ["clone", "-q", origin, second]);
  const pools = join(root, "pools");
  const firstIdentity = worktreeRepositoryIdentity(clone, pools);
  const secondIdentity = worktreeRepositoryIdentity(second, pools);
  assert.ok(firstIdentity);
  assert.ok(secondIdentity);
  assert.notEqual(firstIdentity.gitCommonDirectory, secondIdentity.gitCommonDirectory);
  assert.notEqual(firstIdentity.poolPath, secondIdentity.poolPath);
  // The remote is identical, proving it did not participate in the key.
  assert.equal(gitIn(clone, "remote", "get-url", "origin"), gitIn(second, "remote", "get-url", "origin"));
});

test("native identity refuses a bare repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-native-bare-")));
  const bare = join(root, "repo.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  assert.equal(worktreeRepositoryIdentity(bare, join(root, "pools")), null);
});

test("the native pool marker is discoverable from a checkout path without SQLite", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-native-marker-")));
  const pool = join(root, "pool");
  const checkout = join(pool, "1", "repo", "packages", "app");
  mkdirSync(checkout, { recursive: true });
  await ensureWorktreePoolMarker(pool, "pool-identity-1");
  assert.deepEqual(await findWorktreePoolMarker(checkout), {
    poolPath: pool,
    marker: { schemaVersion: 1, poolId: "pool-identity-1" },
  });
  await assert.rejects(
    () => ensureWorktreePoolMarker(pool, "another-pool"),
    /belongs to another pool/,
  );
});

test("the native pool marker refuses a symlinked pool root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-native-marker-link-")));
  const target = join(root, "somebody-elses-directory");
  const pool = join(root, "pool");
  mkdirSync(target);
  symlinkSync(target, pool);
  await assert.rejects(
    () => ensureWorktreePoolMarker(pool, "pool-identity-1"),
    /not an exact physical directory/,
  );
});
