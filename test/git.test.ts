import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "../src/server/util/git.ts";

const NM_CONFIG = '[remote "no-mistakes"]\n\turl = /Users/x/.no-mistakes/repos/demo\n';

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
  writeFileSync(join(gitDir, "config"), NM_CONFIG);

  // The linked worktree's own git dir under the main repo's .git/worktrees.
  const wtGitDir = join(gitDir, "worktrees", "wt1");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/mancej/dispatch-fleet-report\n");
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");

  // The checked-out worktree dir, whose `.git` is a FILE pointing at wtGitDir.
  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);

  return { main, worktree };
}

test("gitInfo reads a normal checkout's branch, root, and no-mistakes gating", () => {
  const { main } = makeRepoWithWorktree();
  assert.deepEqual(gitInfo(main), { branch: "main", root: main, repoRoot: main, nomistakesGated: true });
});

test("gitInfo resolves a linked worktree's branch, own root, and shared gating", () => {
  const { main, worktree } = makeRepoWithWorktree();
  // Branch comes from the worktree's own HEAD; gating from the shared commondir
  // config. The root is the worktree itself, NOT the main checkout - they're
  // separate trees, and only one of them is touched by a reset.
  assert.deepEqual(gitInfo(worktree), {
    branch: "mancej/dispatch-fleet-report",
    root: worktree,
    // The worktree's own root is itself, but the REPO it belongs to is the main
    // checkout - the distinction Foreman's allowlist turns on.
    repoRoot: main,
    nomistakesGated: true,
  });
  assert.notEqual(gitInfo(worktree).root, gitInfo(main).root);
  assert.equal(gitInfo(worktree).repoRoot, gitInfo(main).repoRoot, "same repo, different trees");
});

test("gitInfo reports the worktree root from a nested subdir", () => {
  const { main } = makeRepoWithWorktree();
  // A pane sitting deep in the tree still resolves to the top, so "same checkout"
  // compares equal however deep the session's cwd is.
  const sub = join(main, "packages", "app");
  mkdirSync(sub, { recursive: true });
  assert.equal(gitInfo(sub).root, main);
});

test("gitInfo returns a short sha for a detached HEAD", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "git-det-")));
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "06a99e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f\n");
  writeFileSync(join(gitDir, "config"), "");
  assert.deepEqual(gitInfo(root), { branch: "06a99e5b", root, repoRoot: root, nomistakesGated: false });
});

test("gitInfo returns nulls for a non-repo dir", () => {
  const root = mkdtempSync(join(tmpdir(), "git-none-"));
  assert.deepEqual(gitInfo(root), { branch: null, root: null, repoRoot: null, nomistakesGated: false });
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
