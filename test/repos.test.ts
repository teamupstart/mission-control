import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  invalidateReposCache,
  listRepos,
  listReposScan,
  repoIndexIdentity,
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
import { STATE_DIR } from "../src/server/config.ts";

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

test("scanRepos reaches deeply nested repositories while skipping noise dirs", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "node_modules", "pkg")); // skipped dir - never entered
    makeRepo(join(r, ...Array.from({ length: 20 }, (_, i) => `level-${i}`), "deep"));
    makeRepo(join(r, "shallow"));
  });
  try {
    const repos = await scanRepos([root]);
    assert.deepEqual(repos, [
      join(root, ...Array.from({ length: 20 }, (_, i) => `level-${i}`), "deep"),
      join(root, "shallow"),
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanRepos tolerates a missing root", async () => {
  assert.deepEqual(await scanRepos(["/no/such/path/mission-test"]), []);
});

test("an explicit depth limit is inclusive and invalid limits do not hide repositories", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "org", "repo"));
    makeRepo(join(r, "deeper", "team", "repo"));
    makeRepo(join(r, ".hidden", "repo"));
    symlinkSync(r, join(r, "loop"));
  });
  const previous = process.env.MISSION_REPOS_MAX_DEPTH;
  try {
    process.env.MISSION_REPOS_MAX_DEPTH = "2";
    assert.deepEqual(await scanRepos([root]), [join(root, "org", "repo")]);
    process.env.MISSION_REPOS_MAX_DEPTH = "0";
    assert.deepEqual(await scanRepos([root]), []);
    assert.deepEqual(await scanRepos([join(root, "org", "repo")]), [join(root, "org", "repo")]);
    process.env.MISSION_REPOS_MAX_DEPTH = "invalid";
    assert.deepEqual(await scanRepos([root]), [join(root, "deeper", "team", "repo"), join(root, "org", "repo")]);
  } finally {
    if (previous === undefined) delete process.env.MISSION_REPOS_MAX_DEPTH;
    else process.env.MISSION_REPOS_MAX_DEPTH = previous;
    rmSync(root, { recursive: true, force: true });
  }
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

const SNAPSHOT = join(STATE_DIR, "repo-index-cache.json");

/** Wait until the persisted scan is the one of `root` - an earlier test's write may land late. */
async function waitForSnapshot(root: string): Promise<void> {
  const persisted = (): boolean => {
    try {
      const { key } = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { key?: string };
      return JSON.stringify((JSON.parse(key ?? "{}") as { roots?: string[] }).roots) === JSON.stringify([root]);
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 5_000;
  while (!persisted() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(persisted(), "a completed scan is persisted");
}

/** A fresh module instance is a fresh daemon: nothing in memory, the snapshot on disk. */
async function restartedRepos(label: string): Promise<typeof import("../src/server/repos.ts")> {
  return await import(`../src/server/repos.ts?${label}-${Date.now()}`) as typeof import("../src/server/repos.ts");
}

test("an ordinary read answers from the last scan and rescans behind it", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);

    makeRepo(join(root, "beta"));
    invalidateReposCache();
    // The dispatch form's read: the previous answer at once, never an empty wait.
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);
    // Settings' read waits for a scan that postdates the invalidation.
    assert.deepEqual(await listRepos({ fresh: true }), [join(root, "alpha"), join(root, "beta")]);
    assert.deepEqual(await listRepos(), [join(root, "alpha"), join(root, "beta")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent readers with no scan yet share one walk", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    const [first, second, third] = await Promise.all([
      listRepos(),
      listRepos(),
      listRepos({ fresh: true }),
    ]);
    assert.deepEqual(first, [join(root, "alpha")]);
    // One walk answered all three - the same array, not three equal ones.
    assert.equal(second, first);
    assert.equal(third, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restarted daemon answers from the persisted scan before it walks again", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  try {
    rmSync(SNAPSHOT, { force: true });
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(await listRepos({ fresh: true }), [join(root, "alpha")]);
    await waitForSnapshot(root);

    makeRepo(join(root, "beta"));
    const restarted = await restartedRepos("restart");
    assert.deepEqual(await restarted.listRepos(), [join(root, "alpha")]);
    assert.deepEqual(
      await restarted.listRepos({ fresh: true }),
      [join(root, "alpha"), join(root, "beta")],
    );
  } finally {
    rmSync(SNAPSHOT, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted scan of other roots is never served", async () => {
  const before = makeWorkspace((r) => makeRepo(join(r, "before")));
  const after = makeWorkspace((r) => makeRepo(join(r, "after")));
  try {
    rmSync(SNAPSHOT, { force: true });
    setRepoIndexConfig({ directories: [{ path: before }] });
    await listRepos({ fresh: true });
    await waitForSnapshot(before);

    setRepoIndexConfig({ directories: [{ path: after }] });
    const restarted = await restartedRepos("roots");
    assert.deepEqual(await restarted.listRepos(), [join(after, "after")]);
  } finally {
    rmSync(SNAPSHOT, { force: true });
    rmSync(before, { recursive: true, force: true });
    rmSync(after, { recursive: true, force: true });
  }
});

test("a HEAD without objects/ and refs/ is an ordinary directory the walk descends into", async () => {
  const root = makeWorkspace((r) => {
    mkdirSync(join(r, "looks-like-git"), { recursive: true });
    writeFileSync(join(r, "looks-like-git", "HEAD"), "ref: refs/heads/main\n");
    makeRepo(join(r, "looks-like-git", "inner"));
  });
  try {
    assert.deepEqual(await scanRepos([root]), [join(root, "looks-like-git", "inner")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ordinary first read with no scan anywhere waits for the walk, never answering empty", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  try {
    rmSync(SNAPSHOT, { force: true });
    setRepoIndexConfig({ directories: [{ path: root }] });
    // A fresh daemon with nothing in memory and nothing on disk: the only honest answer is
    // the walk's, so a stale-or-empty shortcut would show up here as [].
    const cold = await restartedRepos("cold");
    const scan = await cold.listReposScan();
    assert.deepEqual(scan.repos, [join(root, "alpha")]);
    assert.ok(scan.scannedAt > 0, "the answer names the scan behind it");
  } finally {
    rmSync(SNAPSHOT, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero TTL turns the cache off, so an ordinary read waits for a current walk", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  const previous = process.env.MISSION_REPOS_CACHE_MS;
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    // The TTL is read when the module loads, so a fresh instance sees the override.
    process.env.MISSION_REPOS_CACHE_MS = "0";
    const uncached = await restartedRepos("ttl0");
    assert.deepEqual(await uncached.listRepos(), [join(root, "alpha")]);

    makeRepo(join(root, "beta"));
    // No invalidation and no `fresh`: under the default 30s TTL this read would answer
    // [alpha] from the scan a moment ago. With caching off it must see beta.
    assert.deepEqual(await uncached.listRepos(), [join(root, "alpha"), join(root, "beta")]);
  } finally {
    if (previous === undefined) delete process.env.MISSION_REPOS_CACHE_MS;
    else process.env.MISSION_REPOS_CACHE_MS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rescan read sees a checkout cloned inside the TTL, where an ordinary read does not", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);

    // Cloned on disk a moment later: no config write, no Rescan now, well inside the TTL.
    makeRepo(join(root, "new-clone"));
    assert.deepEqual(await listRepos(), [join(root, "alpha")], "the ordinary read is the cached scan");
    assert.deepEqual(await listRepos({ fresh: true }), [join(root, "alpha")], "so is Settings' read");
    // The Dispatch form's second read: a scan that started after the request, so it walks
    // past the new directory rather than trusting a scan that may already have.
    assert.deepEqual(
      await listRepos({ rescan: true }),
      [join(root, "alpha"), join(root, "new-clone")],
    );
    assert.deepEqual(await listRepos(), [join(root, "alpha"), join(root, "new-clone")], "and it is cached");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted scan to another depth is never served", async () => {
  const root = makeWorkspace((r) => {
    makeRepo(join(r, "shallow"));
    makeRepo(join(r, "team", "nested", "deep"));
  });
  const previous = process.env.MISSION_REPOS_MAX_DEPTH;
  try {
    rmSync(SNAPSHOT, { force: true });
    delete process.env.MISSION_REPOS_MAX_DEPTH;
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(
      await listRepos({ fresh: true }),
      [join(root, "shallow"), join(root, "team", "nested", "deep")],
    );
    await waitForSnapshot(root);

    // Same roots, restarted with a depth limit: the unlimited scan does not answer it.
    process.env.MISSION_REPOS_MAX_DEPTH = "1";
    const restarted = await restartedRepos("depth");
    assert.deepEqual(await restarted.listRepos(), [join(root, "shallow")]);
  } finally {
    if (previous === undefined) delete process.env.MISSION_REPOS_MAX_DEPTH;
    else process.env.MISSION_REPOS_MAX_DEPTH = previous;
    rmSync(SNAPSHOT, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans started in the same millisecond are still ordered, and the later one is kept", async () => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  const realNow = Date.now;
  try {
    rmSync(SNAPSHOT, { force: true });
    setRepoIndexConfig({ directories: [{ path: root }] });
    const repos = await restartedRepos("same-ms");
    // A frozen clock: every scan below starts in one millisecond.
    const frozen = realNow.call(Date);
    Date.now = () => frozen;
    // Two walks, one after the other (walks never overlap), both inside that millisecond.
    const a = await repos.listReposScan({ rescan: true });
    const b = await repos.listReposScan({ rescan: true });
    assert.ok(b.scannedAt > a.scannedAt, `the later scan is stamped later (${a.scannedAt} < ${b.scannedAt})`);
    // The cache holds the later scan - and says so to the browser.
    assert.equal((await repos.listReposScan()).scannedAt, b.scannedAt);
    // Settings reports the wall clock, not the nudged ordering stamp: two scans in one
    // millisecond both read as that millisecond.
    assert.equal(repos.reposCacheScannedAt(), frozen);
  } finally {
    Date.now = realNow;
    rmSync(SNAPSHOT, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("rescans asked for during an earlier walk get the new checkout, and share one walk behind it", async (t) => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  // Hold the FIRST read of the root after it has listed the directory, so the walk in
  // progress has provably already passed the spot a clone is about to land in.
  const realReaddir = fsPromises.readdir;
  let rootReads = 0;
  let walksAtOnce = 0;
  let mostWalksAtOnce = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstListed!: () => void;
  const firstReadDone = new Promise<void>((resolve) => {
    firstListed = resolve;
  });
  t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof realReaddir>) => {
    if (String(args[0]) !== root) return await (realReaddir as (...a: unknown[]) => Promise<unknown>)(...args);
    rootReads += 1;
    walksAtOnce += 1;
    mostWalksAtOnce = Math.max(mostWalksAtOnce, walksAtOnce);
    try {
      const listing = await (realReaddir as (...a: unknown[]) => Promise<unknown>)(...args);
      if (rootReads === 1) {
        firstListed();
        await firstHeld;
      }
      return listing;
    } finally {
      walksAtOnce -= 1;
    }
  });
  syncBuiltinESMExports();
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    const earlier = listReposScan({ rescan: true });
    await firstReadDone;

    // Cloned while that walk is still running - after it read the root.
    makeRepo(join(root, "new-clone"));
    const opens = [
      listReposScan({ rescan: true }),
      listReposScan({ rescan: true }),
      listReposScan({ rescan: true }),
    ];
    const ordinary = listReposScan();
    releaseFirst();

    assert.deepEqual((await earlier).repos, [join(root, "alpha")], "the earlier walk missed it, as arranged");
    const answers = await Promise.all(opens);
    for (const answer of answers) {
      assert.deepEqual(answer.repos, [join(root, "alpha"), join(root, "new-clone")]);
    }
    // One walk queued behind the earlier one answered every rescan.
    assert.equal(new Set(answers.map((answer) => answer.scannedAt)).size, 1);
    assert.ok(answers[0]!.scannedAt > (await earlier).scannedAt);
    // The ordinary read joined the walk already running, and started nothing of its own.
    assert.equal((await ordinary).scannedAt, (await earlier).scannedAt);
    assert.equal(rootReads, 2, "three rescans and a read cost one walk beyond the running one");
    assert.equal(mostWalksAtOnce, 1, "walks never overlap");
  } finally {
    releaseFirst();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the index identity holds while nothing changes and moves with the roots or the depth", async () => {
  const first = makeWorkspace(() => {});
  const second = makeWorkspace(() => {});
  const previous = process.env.MISSION_REPOS_MAX_DEPTH;
  try {
    delete process.env.MISSION_REPOS_MAX_DEPTH;
    setRepoIndexConfig({ directories: [{ path: first }] });
    const identity = repoIndexIdentity();
    assert.match(identity, /^[0-9a-f]{16}$/);
    assert.equal(repoIndexIdentity(), identity, "stable, so a reconnect keeps a list that is still right");
    // A list read now carries the same identity the snapshot and the event announce.
    assert.equal((await listReposScan({ fresh: true })).identity, identity);

    setRepoIndexConfig({ directories: [{ path: first }, { path: second }] });
    assert.notEqual(repoIndexIdentity(), identity, "adding a directory changes it");
    setRepoIndexConfig({ directories: [{ path: first }] });
    assert.equal(repoIndexIdentity(), identity, "and putting it back restores it");

    process.env.MISSION_REPOS_MAX_DEPTH = "2";
    assert.notEqual(repoIndexIdentity(), identity, "a depth limit is part of it");
  } finally {
    if (previous === undefined) delete process.env.MISSION_REPOS_MAX_DEPTH;
    else process.env.MISSION_REPOS_MAX_DEPTH = previous;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a walk stuck on a stalled mount times out, pins no second walk, and recovers when it returns", async (t) => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  const elsewhere = makeWorkspace((r) => makeRepo(join(r, "beta")));
  const previous = process.env.MISSION_REPOS_SCAN_TIMEOUT_MS;
  // A `readdir` of the root that blocks until the "mount" recovers, as a stalled NFS read does.
  const realReaddir = fsPromises.readdir;
  let recover!: () => void;
  const recovered = new Promise<void>((resolve) => {
    recover = resolve;
  });
  let rootReads = 0;
  let stalled = true;
  t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof realReaddir>) => {
    if (String(args[0]) === root) {
      rootReads += 1;
      if (stalled) await recovered;
    }
    return await (realReaddir as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  syncBuiltinESMExports();
  const warned: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warned.push(String(message));
  });
  try {
    rmSync(SNAPSHOT, { force: true });
    setRepoIndexConfig({ directories: [{ path: root }] });
    process.env.MISSION_REPOS_SCAN_TIMEOUT_MS = "200";
    const repos = await restartedRepos("stuck-walk");

    // No scan anywhere, so this read waits on the walk - and is told it timed out.
    await assert.rejects(repos.listRepos({ rescan: true }), { name: "ReposScanTimeoutError" });
    assert.ok(warned.some((line) => /\[repos\] workspace scan of .* was abandoned.*; no new scan of these directories starts until it returns/.test(line)), "and it is logged");

    // Every later read of the same directories is refused at once, and none touches the disk:
    // the stalled mount costs exactly one pinned pool thread, however often Dispatch opens.
    const started = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(repos.listRepos({ rescan: true }), { name: "ReposScanStuckError" });
    }
    assert.ok(Date.now() - started < 200, "refused without waiting out another deadline");
    assert.equal(rootReads, 1, "no second walk was started on the stalled directory");
    assert.equal(warned.filter((line) => line.includes("[repos]")).length, 1, "the refusals are not logged");

    // Removing the stalled directory from the index recovers at once: another key walks.
    setRepoIndexConfig({ directories: [{ path: elsewhere }] });
    assert.deepEqual(await repos.listRepos({ rescan: true }), [join(elsewhere, "beta")]);

    // Back to the stalled directory: still refused until its walk returns. Then it walks again.
    setRepoIndexConfig({ directories: [{ path: root }] });
    await assert.rejects(repos.listRepos({ rescan: true }), { name: "ReposScanStuckError" });
    stalled = false;
    recover();
    // The abandoned walk finishes its remaining reads, and only then is the key released.
    const deadline = Date.now() + 5_000;
    let answer: string[] | null = null;
    while (answer === null) {
      try {
        answer = await repos.listRepos({ rescan: true });
      } catch (error) {
        if ((error as Error).name !== "ReposScanStuckError" || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.deepEqual(answer, [join(root, "alpha")]);
    assert.equal(rootReads, 2);
  } finally {
    recover();
    if (previous === undefined) delete process.env.MISSION_REPOS_SCAN_TIMEOUT_MS;
    else process.env.MISSION_REPOS_SCAN_TIMEOUT_MS = previous;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(SNAPSHOT, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a scan that cannot be saved is logged once with its reason, and again only if the reason changes", async (t) => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  const warned: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warned.push(String(message));
  });
  const saveWarnings = () => warned.filter((line) => line.includes("could not save the repository scan"));
  // Earlier tests' daemons save their snapshots fire-and-forget; let those land first, so the
  // only writer this test hears is its own.
  await new Promise((r) => setTimeout(r, 300));
  warned.length = 0;
  try {
    // A directory where the file should go: the rename onto it fails, as a read-only or full
    // state dir would.
    rmSync(SNAPSHOT, { recursive: true, force: true });
    mkdirSync(join(SNAPSHOT, "occupied"), { recursive: true });
    setRepoIndexConfig({ directories: [{ path: root }] });
    const repos = await restartedRepos("unsaveable");
    for (let i = 0; i < 3; i += 1) assert.deepEqual(await repos.listRepos({ rescan: true }), [join(root, "alpha")]);
    const deadline = Date.now() + 5_000;
    while (saveWarnings().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(saveWarnings().length, 1, `one line for a cause that persists across three scans: ${JSON.stringify(saveWarnings())}`);
    assert.match(saveWarnings()[0]!, /\[repos\] could not save the repository scan to .*repo-index-cache\.json, so a restart will walk the workspace before answering: /);

    // Writable again: the next scan saves, silently.
    rmSync(SNAPSHOT, { recursive: true, force: true });
    await repos.listRepos({ rescan: true });
    await waitForSnapshot(root);
    assert.equal(saveWarnings().length, 1);
  } finally {
    rmSync(SNAPSHOT, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a background rescan that fails is logged with its reason while the previous scan keeps answering", async (t) => {
  const root = makeWorkspace((r) => makeRepo(join(r, "alpha")));
  const warned: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => {
    warned.push(String(message));
  });
  const realReaddir = fsPromises.readdir;
  let broken = false;
  // Not an fs error the walk tolerates: an answer it cannot read, so the walk itself rejects.
  t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof realReaddir>) => {
    if (broken && String(args[0]) === root) return null as unknown as Awaited<ReturnType<typeof realReaddir>>;
    return await (realReaddir as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  syncBuiltinESMExports();
  const rescanWarnings = () => warned.filter((line) => line.includes("background workspace rescan failed"));
  try {
    setRepoIndexConfig({ directories: [{ path: root }] });
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);

    broken = true;
    invalidateReposCache();
    // The ordinary read answers from the previous scan and rescans behind it - which fails.
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);
    const deadline = Date.now() + 5_000;
    while (rescanWarnings().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal(rescanWarnings().length, 1, "the failure leaves a trace");
    assert.match(rescanWarnings()[0]!, /\[repos\] background workspace rescan failed; still serving the previous scan: /);

    // The same failure again is not a new line.
    assert.deepEqual(await listRepos(), [join(root, "alpha")]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rescanWarnings().length, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
