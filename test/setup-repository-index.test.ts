import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Seeded before anything resolves the state home or the repository roots.
// Real path, so the repository the walk reports compares equal on macOS's /private/var temp dir.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-setup-repo-index-")));
process.env.HARNESS_HOME = home;
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.MISSION_WORKSPACE_DIRS = workspace;

const { invalidateReposCache, listRepos } = await import("../src/server/repos.ts");
const { defaultSetupDeps } = await import("../src/server/setup/index.ts");

// Every `/api/setup/checks` read carries the repository row, whichever Setup family is on
// screen. It must answer from the scan the daemon already holds rather than walking the
// indexed directories on each read.
test("the setup repository check reuses a positive scan and walks only without one", async (t) => {
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(workspace, "only-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  invalidateReposCache();
  assert.deepEqual(await listRepos(), [repo]);

  // The checkout disappears without anything dropping the cache. A read that walked the
  // directories would now find nothing; the cached answer still reports the one it found.
  rmSync(repo, { recursive: true, force: true });
  const deps = defaultSetupDeps();
  assert.deepEqual(await deps.repositoryIndex(), { repoCount: 1, directories: [] });

  // Once the cache is dropped (a root edit or Rescan now), the next read walks, and a failing
  // answer carries the per-directory breakdown the row explains itself with.
  invalidateReposCache();
  const fresh = await deps.repositoryIndex();
  assert.equal(fresh.repoCount, 0);
  assert.deepEqual(fresh.directories.map(({ status, repoCount }) => ({ status, repoCount })), [
    { status: "ok", repoCount: 0 },
  ]);
});
