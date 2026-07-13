import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir before importing routes (which pulls in config).
process.env.FLEET_HOME = mkdtempSync(join(tmpdir(), "fleet-reporoot-"));
const { resolveRepoRoot } = await import("../src/server/routes.ts");

/**
 * A main checkout (`.git` DIR) plus a linked worktree whose `.git` is a FILE
 * pointing at `.git/worktrees/wt1` with a `commondir` back to the main `.git` -
 * the treehouse/dispatch shape resolveRepoRoot must collapse to the main root.
 */
function makeRepoWithWorktree(): { main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "reporoot-"));
  const main = join(root, "main");
  const gitDir = join(main, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitDir, "config"), "");

  const wtGitDir = join(gitDir, "worktrees", "wt1");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/feat/x\n");
  writeFileSync(join(wtGitDir, "commondir"), "../..\n");

  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`);
  return { main, worktree };
}

test("resolveRepoRoot maps a linked worktree path to the main repo root", async () => {
  const { main, worktree } = makeRepoWithWorktree();
  assert.equal(await resolveRepoRoot(worktree), realpathSync(main));
});

test("resolveRepoRoot returns the main checkout unchanged", async () => {
  const { main } = makeRepoWithWorktree();
  assert.equal(await resolveRepoRoot(main), realpathSync(main));
});

test("resolveRepoRoot rejects a path that does not exist", async () => {
  assert.equal(await resolveRepoRoot(join(tmpdir(), "definitely-not-here-1234567")), null);
});

test("resolveRepoRoot rejects a real dir that is not a git repo", async () => {
  const plain = mkdtempSync(join(tmpdir(), "reporoot-plain-"));
  assert.equal(await resolveRepoRoot(plain), null);
});
