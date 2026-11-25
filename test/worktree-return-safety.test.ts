import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/server/util/exec.ts";
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

test("publication fetch refreshes origin refs without applying a configured local branch mapping", async (t) => {
  const { path, git } = fixture(t);
  const pinned = git("rev-parse", "HEAD");
  git("branch", "local-pin");
  git("commit", "--allow-empty", "-m", "new origin head");
  git("push", "origin", "main");
  const published = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", pinned);
  git("config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/local-pin");

  assert.equal(await worktreeReturnBlocker(path, { fetch: true }), null);
  assert.equal(git("rev-parse", "refs/remotes/origin/main"), published);
  assert.equal(git("rev-parse", "refs/heads/local-pin"), pinned);
});

test("final safety preserves a linked checkout with a clean merge in progress", async (t) => {
  const { path, git } = fixture(t);
  git("switch", "-c", "merge-side");
  git("commit", "--allow-empty", "-m", "merge side");
  git("switch", "main");
  git("commit", "--allow-empty", "-m", "main side");
  git("push", "origin", "main");
  const linked = join(path, "..", "linked");
  git("worktree", "add", "-b", "task", linked, "main");

  const blocked = await worktreeReturnBlocker(linked, {
    strictIndex: true,
    expectedBranch: "task",
    execute: async (command, args, options) => {
      const result = await run(command, args, options);
      if (args.includes("rev-list")) git("-C", linked, "merge", "--no-commit", "merge-side");
      return result;
    },
  });
  assert.equal(git("-C", linked, "status", "--porcelain"), "");
  assert.ok(existsSync(git("-C", linked, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD")));
  assert.match(blocked ?? "", /Git operation is in progress/);
  git("-C", linked, "merge", "--abort");
  assert.equal(await worktreeReturnBlocker(linked, { strictIndex: true, expectedBranch: "task" }), null);
});

test("disposable checkout eligibility reports initialized submodules", async (t) => {
  const { path, git } = fixture(t);
  const submodule = fixture(t).path;
  git("-c", "protocol.file.allow=always", "submodule", "add", submodule, "dep with spaces");
  git("commit", "-m", "track a submodule");
  git("push", "origin", "main");
  const linked = join(path, "..", "linked");
  git("worktree", "add", "-b", "task", linked, "main");

  const options = { strictIndex: true, expectedBranch: "task" };
  assert.equal(await worktreeReturnBlocker(linked, options), null);
  git("-C", linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init");
  assert.equal(git("-C", linked, "status", "--porcelain"), "");
  assert.match(await worktreeReturnBlocker(linked, options) ?? "", /initialized submodule/);
  assert.match(await worktreeReturnBlocker(linked, { ...options, fetch: true }) ?? "", /initialized submodule/);
});

test("Kill preserves ignored local files even when ordinary Git status is clean", async (t) => {
  const { path, git } = fixture(t);
  writeFileSync(join(path, ".gitignore"), "private-notes/\n");
  git("add", ".gitignore"); git("commit", "-m", "ignore private notes");
  git("push", "origin", "main");
  mkdirSync(join(path, "private-notes"));
  writeFileSync(join(path, "private-notes", "draft.txt"), "keep this local work\n");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  assert.match((await worktreeReturnBlocker(path, { fetch: true }))!, /ignored/);
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
    code: 0, stderr: "", outcomeUnknown: false, overflowed: false, stdout: args.includes("--show-toplevel") ? path : args.includes("rev-parse") ? "a".repeat(40) :
      args.includes("rev-list") ? "not a count" : "",
  }) }))!, /compared/);
});

test("the final clean status must describe the commit checked for publication", async (t) => {
  const { path, git } = fixture(t);
  const published = git("rev-parse", "HEAD");
  const blocked = await worktreeReturnBlocker(path, {
    execute: async (command, args, options) => {
      const result = await run(command, args, options);
      if (args.includes("rev-list")) {
        assert.ok(args.includes(published));
        git("commit", "--allow-empty", "-m", "unpublished commit after reachability check");
      }
      return result;
    },
  });
  assert.equal(git("status", "--porcelain"), "");
  assert.match(blocked ?? "", /HEAD changed/);
});

test("publication of a different HEAD cannot satisfy the final activity check", async (t) => {
  const { path, git } = fixture(t);
  const expectedHead = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "new published commit");
  git("push", "origin", "main");
  assert.match(await worktreeReturnBlocker(path, { readActivity: async () => ({ head: expectedHead }) }) ?? "", /Git activity changed/);
});

for (const flag of ["assume-unchanged", "skip-worktree"] as const) {
  test(`final safety refuses ${flag} edits after publication has been checked`, async (t) => {
    const { path, git } = fixture(t);
    const blocked = await worktreeReturnBlocker(path, {
      strictIndex: true,
      execute: async (command, args, options) => {
        const result = await run(command, args, options);
        if (args.includes("rev-list")) {
          git("update-index", `--${flag}`, "tracked");
          writeFileSync(join(path, "tracked"), "keep this hidden edit");
        }
        return result;
      },
    });
    assert.equal(git("status", "--porcelain"), "");
    assert.match(blocked ?? "", /index has hidden changes/);
  });
}
