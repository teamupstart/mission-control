import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeReturnBlocker } from "../src/server/git/worktree-return-safety.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mission-return-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "repo");
  mkdirSync(path);
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(path, "tracked"), "base\n");
  git("add", "."); git("commit", "-m", "base");
  git("init", "--bare", join(root, "origin"));
  git("remote", "add", "origin", join(root, "origin"));
  git("push", "-u", "origin", "main");
  return { path, git };
}

test("a clean published checkout qualifies, including after a fresh origin fetch", async (t) => {
  const { path } = fixture(t);
  assert.equal(await worktreeReturnBlocker(path, { fetch: true }), null);
});

for (const kind of ["unstaged", "staged", "untracked", "unpublished"] as const) {
  test(`Kill preserves ${kind} work`, async (t) => {
    const { path, git } = fixture(t);
    writeFileSync(join(path, kind === "untracked" ? "notes" : "tracked"), "valuable work\n");
    if (kind === "staged" || kind === "unpublished") git("add", ".");
    if (kind === "unpublished") git("commit", "-m", "local only");
    assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /uncommitted|unpublished/);
  });
}

test("deleted upstream branches cannot vouch for local commits through stale refs", async (t) => {
  const { path, git } = fixture(t);
  git("checkout", "-b", "task");
  writeFileSync(join(path, "tracked"), "branch work\n");
  git("commit", "-am", "task"); git("push", "origin", "task");
  assert.equal(await worktreeReturnBlocker(path), null);
  execFileSync("git", ["--git-dir", join(path, "..", "origin"), "update-ref", "-d", "refs/heads/task"]);
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /unpublished/);
});

test("offline origin, missing checkout, nested path and malformed evidence fail closed", async (t) => {
  const { path, git } = fixture(t);
  git("remote", "set-url", "origin", join(path, "missing-origin"));
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /refreshed/);
  assert.ok(await worktreeReturnBlocker(join(path, "missing")));
  mkdirSync(join(path, "nested"));
  assert.match((await worktreeReturnBlocker(join(path, "nested")))!, /identity/);
  assert.match((await worktreeReturnBlocker(path, { execute: async (_cmd, args) => ({
    code: 0, stderr: "", outcomeUnknown: false, overflowed: false, stdout: args.includes("rev-parse") ? path : args.includes("rev-list") ? "not a count" : "",
  }) }))!, /compared/);
});
