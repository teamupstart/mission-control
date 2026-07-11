import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "../src/server/util/git.ts";

const NM_CONFIG = '[remote "no-mistakes"]\n\turl = /Users/x/.no-mistakes/repos/demo\n';

/**
 * Build a repo whose main checkout has a `.git` dir and a linked worktree whose
 * `.git` is a file - the treehouse/dispatch shape - and return both dirs.
 */
function makeRepoWithWorktree(): { main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "git-wt-"));
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

test("gitInfo reads a normal checkout's branch and no-mistakes gating", () => {
  const { main } = makeRepoWithWorktree();
  assert.deepEqual(gitInfo(main), { branch: "main", nomistakesGated: true });
});

test("gitInfo resolves a linked worktree's branch and shared gating", () => {
  const { worktree } = makeRepoWithWorktree();
  // Branch comes from the worktree's own HEAD; gating from the shared commondir config.
  assert.deepEqual(gitInfo(worktree), {
    branch: "mancej/dispatch-fleet-report",
    nomistakesGated: true,
  });
});

test("gitInfo returns a short sha for a detached HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "git-det-"));
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "06a99e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f\n");
  writeFileSync(join(gitDir, "config"), "");
  assert.deepEqual(gitInfo(root), { branch: "06a99e5b", nomistakesGated: false });
});

test("gitInfo returns nulls for a non-repo dir", () => {
  const root = mkdtempSync(join(tmpdir(), "git-none-"));
  assert.deepEqual(gitInfo(root), { branch: null, nomistakesGated: false });
});
