import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scanRepos, resolveRepoPath, resolveTaskRepoRoot } from "../src/server/repos.ts";
import { gitInfo, isBareRepository, mainRepoRoot, worktreeRepositoryIdentity } from "../src/server/util/git.ts";
import { repoAllowlisted } from "../src/shared/allowlist.ts";
import { resolveDispatchBase, provisionWorktree, teardownWorktree } from "../src/server/dispatcher.ts";
import { WorktreeManager } from "../src/server/worktrees/manager.ts";
import { NativeWorktreeGit } from "../src/server/worktrees/git.ts";
import { openDb } from "../src/server/db.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

for (const name of ["project.git", "project", "container/.bare", "container/.git"]) {
  test(`bare owner ${name} is discovered, trusted, and shared by linked worktrees`, async () => {
    const { root, origin } = mkOriginAndClone("mission-bare-identity-");
    try {
      const indexed = join(root, "indexed");
      const bare = join(indexed, name);
      mkdirSync(join(bare, ".."), { recursive: true });
      execFileSync("git", ["clone", "--bare", "-q", origin, bare]);
      const linked = join(indexed, "linked");
      gitIn(bare, "worktree", "add", "--detach", linked, "HEAD");
      const alias = join(root, "alias");
      symlinkSync(bare, alias);

      assert.deepEqual(await scanRepos([indexed, bare, alias]), [bare, linked].sort());
      const identity = worktreeRepositoryIdentity(bare, join(root, "pools"));
      assert.ok(identity);
      assert.equal(identity.mainCheckoutRoot, bare);
      assert.equal(identity.gitCommonDirectory, bare);
      for (const path of [bare, linked, alias]) {
        assert.equal(mainRepoRoot(path), bare);
        assert.deepEqual(await resolveRepoPath(path), { repoRoot: bare, path: bare });
        assert.deepEqual(await resolveTaskRepoRoot(path), { ok: true, repoRoot: bare });
        assert.deepEqual(worktreeRepositoryIdentity(path, join(root, "pools")), identity);
        assert.equal(gitInfo(path).repoRoot, bare);
      }
      assert.equal(gitInfo(bare).root, null, "bare metadata is not a working checkout");
      assert.equal(gitInfo(linked).root, linked);
      assert.equal(repoAllowlisted(linked, gitInfo(linked).repoRoot, [bare]), true);
      assert.equal(repoAllowlisted(origin, origin, [bare]), false, "consent must not widen to the parent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("bare identity follows Git boolean syntax and changes in included config, refusing unreadable identity", () => {
  const { root } = mkOriginAndClone("mission-bare-config-");
  try {
    const bare = join(root, "container", ".git");
    execFileSync("git", ["init", "--bare", "-q", bare]);
    assert.equal(mainRepoRoot(bare), bare);
    writeFileSync(join(bare, "config"), '[core]\n bare = "yes"\n');
    assert.equal(isBareRepository(bare), true);
    writeFileSync(join(bare, "included"), "[core]\n bare = true\n");
    writeFileSync(join(bare, "config"), "[include]\n path = included\n");
    assert.equal(mainRepoRoot(bare), bare);
    writeFileSync(join(bare, "included"), "[core]\n bare = false\n");
    assert.equal(isBareRepository(bare), false, "the include changed without changing the parent config");
    writeFileSync(join(bare, "config"), "[core]\n bare = invalid\n");
    assert.equal(mainRepoRoot(bare), null);
    assert.equal(gitInfo(bare).repoRoot, null, "unknown bare state must not grant the container");
    assert.equal(worktreeRepositoryIdentity(bare), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cloneOption of ["--bare", "--mirror"]) {
  test(`${cloneOption} clone provisions and returns worktrees without rewriting local branches`, async () => {
    const { root, origin } = mkOriginAndClone("mission-bare-provision-");
    gitIn(origin, "branch", "-m", "release/next");
    const bare = join(root, "repo.git");
    execFileSync("git", ["clone", cloneOption, "-q", origin, bare]);
    const originalHead = gitIn(bare, "rev-parse", "HEAD");
    writeFileSync(join(origin, "keep.txt"), "new default\n");
    gitIn(origin, "commit", "-qam", "advance origin");
    const expected = gitIn(origin, "rev-parse", "HEAD");
    const m = new WorktreeManager(openDb(), {
      poolsDirectory: join(root, "pools"),
      occupancy: async (paths) => new Map(paths.map(path => [path, { status: "known" as const, occupants: [] }])),
    });
    try {
      assert.equal(await resolveDispatchBase(bare), expected);
      const identity = worktreeRepositoryIdentity(bare);
      assert.ok(identity);
      assert.deepEqual(await new NativeWorktreeGit().observedDefaultSha(identity), { ok: true, value: expected });
      assert.equal(gitIn(bare, "rev-parse", "HEAD"), originalHead, "fetch must not rewrite local branches");
      const acquired = await m.acquire({ repositoryPath: bare, baseSha: expected, owner: { kind: "task", key: "bare-native:0" } });
      assert.equal(acquired.outcome, "acquired");
      if (acquired.outcome !== "acquired") return;
      assert.equal(gitIn(acquired.lease.path, "rev-parse", "HEAD"), expected);
      assert.equal(gitInfo(acquired.lease.path).repoRoot, bare);
      assert.equal((await m.release(acquired.lease, { ownerAuthorized: true })).outcome, "released");

      const fallback = await provisionWorktree(bare, "bare-fallback-test", "bare", "test", expected);
      assert.equal(fallback.provider, "git");
      assert.equal(gitInfo(fallback.path).repoRoot, bare);
      await teardownWorktree({
        repoRoot: bare, worktreePath: fallback.path, branch: fallback.branch,
        provider: "git", worktreeLeaseId: null, position: 0, homeName: null,
      });
    } finally {
      openDb().prepare("DELETE FROM worktree_slots WHERE pool_id IN (SELECT id FROM worktree_pools WHERE git_common_dir = ?)").run(bare);
      openDb().prepare("DELETE FROM worktree_pools WHERE git_common_dir = ?").run(bare);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
