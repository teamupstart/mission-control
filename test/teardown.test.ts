import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teardownWorktree } from "../src/server/dispatcher.ts";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-teardown-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
  writeFileSync(join(repo, "f"), "x");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  return repo;
}

function branchExists(repo: string, name: string): boolean {
  const out = execFileSync("git", ["branch", "--list", name], { cwd: repo, encoding: "utf8" });
  return out.trim() !== "";
}

test("teardownWorktree removes a git-fallback worktree AND its harness branch (so retry can recreate)", async () => {
  const repo = makeRepo();
  const wt = join(repo, "wt");
  execFileSync("git", ["worktree", "add", wt, "-b", "harness/demo", "HEAD"], { cwd: repo, stdio: "ignore" });
  assert.ok(existsSync(wt));
  assert.ok(branchExists(repo, "harness/demo"));

  await teardownWorktree({
    repoRoot: repo,
    worktreePath: wt,
    branch: "harness/demo",
    provider: "git",
    tmuxSession: null,
  });

  assert.equal(existsSync(wt), false, "worktree dir should be gone");
  assert.equal(branchExists(repo, "harness/demo"), false, "harness branch should be deleted");

  // The clincher: `git worktree add -b harness/demo` now works again (retry unblocked).
  execFileSync("git", ["worktree", "add", wt, "-b", "harness/demo", "HEAD"], { cwd: repo, stdio: "ignore" });
  assert.ok(existsSync(wt));

  rmSync(repo, { recursive: true, force: true });
});

test("teardownWorktree never deletes a non-harness branch", async () => {
  const repo = makeRepo();
  const wt = join(repo, "wt2");
  execFileSync("git", ["worktree", "add", wt, "-b", "feature/keep-me", "HEAD"], { cwd: repo, stdio: "ignore" });

  await teardownWorktree({
    repoRoot: repo,
    worktreePath: wt,
    branch: "feature/keep-me",
    provider: "git",
    tmuxSession: null,
  });

  assert.equal(existsSync(wt), false, "worktree dir should be gone");
  assert.ok(branchExists(repo, "feature/keep-me"), "a non-harness branch must be preserved");

  rmSync(repo, { recursive: true, force: true });
});
