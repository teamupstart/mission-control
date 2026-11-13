import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";

// Seeded before anything resolves the repository roots. A real path, so the repository the
// walk reports compares equal on macOS's /private/var temp dir.
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-task-repo-selector-")));
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.MISSION_WORKSPACE_DIRS = workspace;
// Short enough for the stalled-mount case to finish quickly; far beyond any walk of these trees.
process.env.MISSION_REPOS_SCAN_TIMEOUT_MS = "1000";

const { invalidateReposCache, listRepos } = await import("../src/server/repos.ts");
const { resolveTaskRepositorySelector } = await import("../src/server/task-repository-preparation.ts");

after(() => rmSync(home, { recursive: true, force: true }));

function cloneInto(name: string): string {
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  return repo;
}

/**
 * A task names its repo by short name, and that name is resolved once, when the task is filed.
 * The cache answers from a scan up to 30 s old, so a checkout cloned since it is not in the
 * cached list - and refusing it there would turn away exactly the repo the operator just made.
 */
test("a short name resolves a checkout cloned since the last scan, inside the cache window", async () => {
  invalidateReposCache();
  cloneInto("existing");
  // Prime the scan, so the next ordinary or fresh read answers from it without walking.
  assert.deepEqual(await listRepos({ fresh: true }), [join(workspace, "existing")]);

  const cloned = cloneInto("just-cloned");
  assert.deepEqual(await listRepos({ fresh: true }), [join(workspace, "existing")], "the cache has not seen it yet");

  assert.deepEqual(await resolveTaskRepositorySelector("just-cloned"), { ok: true, path: cloned });
  // A name that was already known is answered from the cache, as before.
  assert.deepEqual(await resolveTaskRepositorySelector("existing"), { ok: true, path: join(workspace, "existing") });
});

test("a short name no checkout has is still refused after the rescan", async () => {
  const result = await resolveTaskRepositorySelector("nowhere-to-be-found");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /no local repository named "nowhere-to-be-found"/);
});

test("a short name on a stalled mount with no scan held is refused with the reason, not thrown", async (t) => {
  // A new directory set: no scan of it is held, so the walk is the only answer.
  const stalled = join(home, "stalled-workspace");
  mkdirSync(stalled, { recursive: true });
  const previous = process.env.MISSION_WORKSPACE_DIRS;
  process.env.MISSION_WORKSPACE_DIRS = stalled;
  const realReaddir = fsPromises.readdir;
  let recover!: () => void;
  const recovered = new Promise<void>((resolve) => {
    recover = resolve;
  });
  t.mock.method(fsPromises, "readdir", async (...args: Parameters<typeof realReaddir>) => {
    if (String(args[0]) === stalled) await recovered;
    return await (realReaddir as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  syncBuiltinESMExports();
  t.mock.method(console, "warn", () => {});
  try {
    const result = await resolveTaskRepositorySelector("anything");
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.status, 409, "cannot look it up now - not 'no such repository'");
    assert.match(
      result.ok ? "" : result.error,
      /could not look up a repository named "anything": workspace scan unavailable: .*did not finish within 1 s/,
    );
  } finally {
    recover();
    process.env.MISSION_WORKSPACE_DIRS = previous;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
