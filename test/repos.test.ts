import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { scanRepos, workspaceRoots } from "../src/server/repos.ts";

/** Lay out a throwaway workspace tree and return its (realpath'd) root. */
function makeWorkspace(build: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-repos-")));
  build(root);
  return root;
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), "gitdir: /wherever\n"); // a `.git` file (like a worktree) counts too
}

test("scanRepos finds repos directly under a root and nested a couple levels down", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "alpha"));
    makeRepo(join(r, "org", "beta"));
    mkdirSync(join(r, "not-a-repo"), { recursive: true });
  });
  try {
    const repos = await scanRepos([root]);
    assert.deepEqual(repos, [join(root, "alpha"), join(root, "org", "beta")].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepos never descends into a repo (nested worktrees/vendored checkouts are ignored)", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "alpha"));
    // A nested checkout inside a repo must NOT surface as its own entry.
    makeRepo(join(r, "alpha", "vendor", "inner"));
  });
  try {
    const repos = await scanRepos([root]);
    assert.deepEqual(repos, [join(root, "alpha")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepos skips noise dirs and is depth-bounded", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "node_modules", "pkg")); // skipped dir - never entered
    makeRepo(join(r, "a", "b", "c", "d", "deep")); // beyond MAX_DEPTH (3)
    makeRepo(join(r, "shallow"));
  });
  try {
    const repos = await scanRepos([root]);
    assert.deepEqual(repos, [join(root, "shallow")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepos tolerates a missing root", async () => {
  assert.deepEqual(await scanRepos(["/no/such/path/fleet-test"]), []);
});

test("workspaceRoots defaults to ~/workspace and honors FLEET_WORKSPACE_DIRS", () => {
  const prev = process.env.FLEET_WORKSPACE_DIRS;
  try {
    delete process.env.FLEET_WORKSPACE_DIRS;
    assert.equal(workspaceRoots().length, 1);
    assert.ok(workspaceRoots()[0]?.endsWith("/workspace"));

    process.env.FLEET_WORKSPACE_DIRS = "/one:/two";
    assert.deepEqual(workspaceRoots(), ["/one", "/two"]);
  } finally {
    if (prev === undefined) delete process.env.FLEET_WORKSPACE_DIRS;
    else process.env.FLEET_WORKSPACE_DIRS = prev;
  }
});
