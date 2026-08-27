import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  invalidateReposCache,
  listRepos,
  scanRepos,
  workspaceRoots,
} from "../src/server/repos.ts";
import {
  canonicalize,
  expandHome,
  getRepoIndexConfig,
  indexedDirectories,
  setRepoIndexConfig,
} from "../src/server/repo-index.ts";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";
import { DEFAULT_INDEXED_DIRECTORIES } from "../src/shared/repo-index.ts";
import { openDb, setAppConfig } from "../src/server/db.ts";

const WORKSPACE_ENV_NAMES = [
  "MISSION_WORKSPACE_DIRS",
  "FLEET_WORKSPACE_DIRS",
  "HARNESS_WORKSPACE_DIRS",
  "MISSION_WORKSPACE_DIR",
  "FLEET_WORKSPACE_DIR",
  "HARNESS_WORKSPACE_DIR",
] as const;
const originalWorkspaceEnv = new Map(
  WORKSPACE_ENV_NAMES.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of WORKSPACE_ENV_NAMES) delete process.env[name];
  openDb().exec("DELETE FROM app_config WHERE key = 'repoIndex'");
  invalidateReposCache();
});

after(() => {
  for (const name of WORKSPACE_ENV_NAMES) {
    const value = originalWorkspaceEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Lay out a throwaway workspace tree and return its (realpath'd) root. */
function makeWorkspace(build: (root: string) => void): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mission-repos-")));
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
  assert.deepEqual(await scanRepos(["/no/such/path/mission-test"]), []);
});

test("an absent config key yields the four removable defaults", () => {
  assert.deepEqual(
    getRepoIndexConfig().directories.map((row) => row.path),
    DEFAULT_INDEXED_DIRECTORIES,
  );
  assert.deepEqual(
    workspaceRoots(),
    [...new Set(DEFAULT_INDEXED_DIRECTORIES.map((path) => canonicalize(path)))],
  );
});

test("configured directories are scanned", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "configured")));
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(workspaceRoots(), [root]);
    assert.deepEqual(await listRepos(), [join(root, "configured")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MISSION_WORKSPACE_DIRS wins over the configured list", async () => {
  const configured = makeWorkspace((r) => makeRepo(join(r, "configured")));
  const overridden = makeWorkspace((r) => makeRepo(join(r, "overridden")));
  try {
    setRepoIndexConfig({ directories: [{ path: configured }] });
    process.env.MISSION_WORKSPACE_DIRS = overridden;
    assert.deepEqual(workspaceRoots(), [overridden]);
    assert.deepEqual(await listRepos(), [join(overridden, "overridden")]);
  } finally {
    rmSync(configured, { recursive: true, force: true });
    rmSync(overridden, { recursive: true, force: true });
  }
});

test("a set but empty MISSION_WORKSPACE_DIRS indexes nothing", async () => {
  setRepoIndexConfig({ directories: [{ path: join(tmpdir(), "configured") }] });
  process.env.MISSION_WORKSPACE_DIRS = "";
  assert.deepEqual(workspaceRoots(), []);
  assert.deepEqual(await listRepos(), []);
});

test("a leading tilde expands against the daemon home", () => {
  assert.equal(expandHome("~/projects"), join(homedir(), "projects"));
});

test("configured aliases collapse after realpath", () => {
  const root = makeWorkspace(() => {});
  const alias = `${root}-alias`;
  symlinkSync(root, alias);
  try {
    // Semantic writes refuse this pair. Seed the schema-valid stored shape directly to pin
    // the read-side defense too, including settings restored from an older snapshot.
    setAppConfig(APP_CONFIG_ENTRIES.repoIndex, {
      directories: [{ path: root }, { path: alias }],
    });
    assert.deepEqual(indexedDirectories(), [root]);
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a saved missing directory is skipped if it later resolves at or above home", () => {
  const root = makeWorkspace(() => {});
  const deferred = join(root, "future-code");
  try {
    setRepoIndexConfig({ directories: [{ path: deferred }] });
    assert.deepEqual(indexedDirectories(), [deferred]);

    symlinkSync(homedir(), deferred);
    assert.deepEqual(indexedDirectories(), []);
  } finally {
    rmSync(deferred, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("an intentionally empty configured list scans nothing", async () => {
  setRepoIndexConfig({ directories: [] });
  assert.deepEqual(workspaceRoots(), []);
  assert.deepEqual(await listRepos(), []);
});
