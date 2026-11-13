import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

// Seeded before anything resolves the state home, the repository roots, or the scan cache's
// window. Real path, so the repository the walk reports compares equal on macOS's
// /private/var temp dir.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-setup-repo-index-")));
process.env.HARNESS_HOME = home;
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.MISSION_WORKSPACE_DIRS = workspace;
const CACHE_MS = 1_000;
process.env.MISSION_REPOS_CACHE_MS = String(CACHE_MS);

const { invalidateReposCache } = await import("../src/server/repos.ts");
const { defaultSetupDeps } = await import("../src/server/setup/index.ts");

// Every `/api/setup/checks` read carries the repository row, whichever Setup family is on
// screen. It answers from the shared scan cache, so reads inside one cache window do not walk
// the indexed directories again, and it still honours that window's expiry, so a repository
// deleted behind Mission Control's back cannot keep the required check Ready forever.
test("the setup repository check shares the scan cache and honours its expiry", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(workspace, "only-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  invalidateReposCache();
  const deps = defaultSetupDeps();
  assert.deepEqual(await deps.repositoryIndex(), { repoCount: 1, directories: [] });

  // Inside the window: the checkout is gone, and an answer of 1 proves this read did not walk.
  rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(await deps.repositoryIndex(), { repoCount: 1, directories: [] });

  // Past the window: the next read walks, sees nothing, and carries the per-directory
  // breakdown the failing row explains itself with.
  await delay(CACHE_MS + 100);
  const expired = await deps.repositoryIndex();
  assert.equal(expired.repoCount, 0);
  assert.deepEqual(expired.directories.map(({ status, repoCount }) => ({ status, repoCount })), [
    { status: "ok", repoCount: 0 },
  ]);
});
