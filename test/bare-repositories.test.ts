import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
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
    for (const section of ["include", `includeIf "gitdir:${bare}"`]) {
      writeFileSync(join(bare, "included"), "[core]\n bare = true\n");
      writeFileSync(join(bare, "config"), `[${section}]\n path = included\n`);
      assert.equal(mainRepoRoot(bare), bare, section);
      writeFileSync(join(bare, "included"), "[core]\n bare = false\n");
      assert.equal(isBareRepository(bare), false, `${section} changed without changing the parent config`);
    }
    writeFileSync(join(bare, "config"), "[core]\n bare = invalid\n");
    assert.equal(mainRepoRoot(bare), null);
    assert.equal(gitInfo(bare).repoRoot, null, "unknown bare state must not grant the container");
    assert.equal(worktreeRepositoryIdentity(bare), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rescanning more than 256 ordinary checkouts never starts synchronous Git config processes", async (t) => {
  const { root, clone } = mkOriginAndClone("mission-bare-scan-cost-");
  const indexed = join(root, "indexed");
  const config = readFileSync(join(clone, ".git", "config"), "utf8");
  const repos = Array.from({ length: 257 }, (_, i) => join(indexed, `repo-${i}`)).sort();
  for (const repo of repos) {
    const metadata = join(repo, ".git");
    mkdirSync(join(metadata, "objects"), { recursive: true });
    mkdirSync(join(metadata, "refs"));
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(metadata, "config"), config);
  }
  const spawned = t.mock.method(childProcess, "spawnSync");
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await scanRepos([indexed]), repos);
    assert.deepEqual(await scanRepos([indexed]), repos);
    const configCalls = spawned.mock.calls.filter(call => call.arguments[1]?.includes("core.bare"));
    assert.equal(configCalls.length, 0, "ordinary Git-generated configs must not block scans on child processes");
  } finally {
    spawned.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare config detection agrees with Git on literals, overrides, unsupported syntax, and malformed input", () => {
  const { root } = mkOriginAndClone("mission-bare-config-parity-");
  const bare = join(root, "container", ".git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const cases = [
    "", "# only a comment\n", "[core]\n filemode = true\n",
    "[core]\n bare = true\n", "[core]\n bare = false\n",
    "[CORE]\n BARE = TRUE ; comment\n",
    "[core]\n bare = true\n bare = false\n", "[core]\n bare = false\n bare = true\n",
    '[core]\n bare = "yes"\n', "[core]\n bare = 1\n", "[core]\n bare\n", "[core]\n bare =\n",
    '[core]\n bare = true\n[core "other"]\n bare = false\n',
    "[core]\n bare = false\n[other]\n bare = true\n",
    "[core]\n bare = tr\\\nue\n",
    "[core]\n bare = true\n[broken\n", "bare = true\n",
    "[core]\n bare = invalid\n", '[core]\n bare = false\n other = "bad\\q"\n',
  ];
  try {
    for (const source of cases) {
      writeFileSync(join(bare, "config"), source);
      const parsed = spawnSync("git", ["config", "--file", join(bare, "config"), "--type=bool", "--get", "core.bare"], { encoding: "utf8" });
      const expected = parsed.status === 0 ? parsed.stdout.trim() === "true" : parsed.status === 1 ? false : null;
      assert.equal(isBareRepository(bare), expected === true, source);
      assert.equal(gitInfo(bare).repoRoot, expected === null ? null : expected ? bare : join(root, "container"), source);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown nested bare metadata never inherits the enclosing checkout's identity", () => {
  const { root, clone, origin } = mkOriginAndClone("mission-bare-unknown-boundary-");
  try {
    for (const leaf of ["repo.git", ".bare", ".git"]) {
      const bare = join(clone, "nested", leaf);
      execFileSync("git", ["clone", "--bare", "-q", origin, bare]);
      const linked = join(root, `linked-${leaf}`);
      gitIn(bare, "worktree", "add", "--detach", linked, "HEAD");
      const paths = [bare, join(bare, "objects"), linked];
      for (const path of paths) assert.equal(gitInfo(path).repoRoot, bare);
      writeFileSync(join(bare, "config"), "[core]\n bare = invalid\n");
      for (const reason of ["invalid config", "unreadable config"]) {
        if (reason === "unreadable config") {
          rmSync(join(bare, "config"));
          mkdirSync(join(bare, "config"));
        }
        for (const path of paths) {
          assert.equal(mainRepoRoot(path), null, `${leaf}: ${reason}`);
          assert.equal(gitInfo(path).repoRoot, null, `${leaf}: ${reason}`);
          assert.equal(worktreeRepositoryIdentity(path), null, `${leaf}: ${reason}`);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery skips unknown bare boundaries without offering their containers or metadata contents", async () => {
  const { root, origin } = mkOriginAndClone("mission-bare-unknown-discovery-");
  try {
    for (const leaf of [".git", ".bare", "repo.git"]) {
      const indexed = join(root, `indexed-${leaf}`);
      const bare = join(indexed, "container", leaf);
      execFileSync("git", ["init", "--bare", "-q", bare]);
      const visible = join(indexed, "ordinary");
      execFileSync("git", ["clone", "-q", origin, visible]);
      assert.deepEqual(await scanRepos([indexed]), [bare, visible].sort());
      mkdirSync(join(bare, "objects", "nested", ".git"), { recursive: true });
      writeFileSync(join(bare, "config"), "[core]\n bare = invalid\n");
      for (const reason of ["invalid config", "unreadable config"]) {
        if (reason === "unreadable config") {
          rmSync(join(bare, "config"));
          mkdirSync(join(bare, "config"));
        }
        assert.deepEqual(await scanRepos([indexed]), [visible], `${leaf}: ${reason}`);
        assert.deepEqual(await scanRepos([bare]), [], `${leaf}: ${reason}, indexed directly`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [cloneOption, layout] of [["--bare", "repo.git"], ["--mirror", "repo.git"], ["--bare", "container/.bare"], ["--bare", "container/.git"]] as const) {
  test(`${cloneOption} clone at ${layout} provisions and returns worktrees without rewriting local branches`, async () => {
    const { root, origin } = mkOriginAndClone("mission-bare-provision-");
    gitIn(origin, "branch", "-m", "release/next");
    const bare = join(root, layout);
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
      assert.deepEqual(await scanRepos([join(root, "pools")]), [acquired.lease.path], "a native checkout must not look like hidden Git metadata");
      assert.equal(basename(acquired.lease.path), layout.startsWith("container/") ? "container" : "repo.git");
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
