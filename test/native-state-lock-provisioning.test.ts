import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = join(REPO_ROOT, "test");

// A spawned argument list, not a `readFileSync`/`new URL` reference: several specs read
// `index.ts` as text to assert startup ordering, and those never load the addon.
const SPAWNS_THE_DAEMON = /\[[^\]]*"src\/server\/index\.ts"/;
const HELPER_IMPORT = /from "\.\/helpers\/native-state-lock\.ts"/;

// Recursive because `npm test` globs `test/**/*.test.ts`: a spec in a new subdirectory is run
// by the suite, so it has to be scanned by this guard too.
function testFiles(): string[] {
  return readdirSync(TEST_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => name.endsWith(".test.ts"));
}

// `src/server/index.ts` acquires state ownership through `dist/native/state-lock.node` before
// it serves anything, and `npm test` runs before `npm run build` in CI. When the artifact was
// a side effect of one spec's own rebuild, every other daemon spec passed only while Node's
// per-file `--test-shard` split happened to deal them together - so adding two unrelated test
// files moved `settings-backup-daemon.test.ts` into shard 6 alone and broke both Node releases
// on `main`. Provisioning is a property of the file that spawns a daemon, not of its shard.
test("every spec that spawns the real daemon provisions the native state lock itself", () => {
  const spawning: string[] = [];
  const unprovisioned: string[] = [];
  for (const name of testFiles()) {
    const source = readFileSync(join(TEST_DIR, name), "utf8");
    if (!SPAWNS_THE_DAEMON.test(source)) continue;
    spawning.push(name);
    if (!HELPER_IMPORT.test(source)) unprovisioned.push(name);
  }

  assert.ok(
    spawning.includes("daemon-state-ownership.test.ts") &&
      spawning.includes("settings-backup-daemon.test.ts"),
    `the daemon-spawning detector matched ${spawning.length} files: ${spawning.join(", ")}`,
  );
  assert.deepEqual(
    unprovisioned,
    [],
    "these specs spawn src/server/index.ts without calling ensureNativeStateLockAddon(), so " +
      "they pass only when another file in the same shard built dist/native/state-lock.node",
  );
});

// A cold checkout hands every daemon spec the same missing addon, and those specs run in
// parallel workers, so several builds land at once. `node-gyp rebuild` deletes and recreates
// `build/` in the directory it is given, so builders that shared `native/state-lock` used to
// tear down each other's configure step and fail. Nothing is deleted first here: the addon is
// what other workers are loading right now, and surviving a rebuild underneath them is the
// other half of the contract.
test("concurrent builders provisioning the addon all succeed", async () => {
  const run = promisify(execFile);
  const build = () =>
    run(process.execPath, ["scripts/build-state-lock-native.mjs"], { cwd: REPO_ROOT });

  const results = await Promise.allSettled([build(), build(), build()]);
  const failed = results.flatMap((result, index) =>
    result.status === "rejected" ? [`builder ${index}: ${String(result.reason)}`] : [],
  );
  assert.deepEqual(failed, [], "concurrent builders must not collide in one build directory");
  assert.equal(ensureNativeStateLockAddon(), join(REPO_ROOT, "dist/native/state-lock.node"));
});

// The helper skips a rebuild when the addon already loads, so the suite still has to arrive
// with one built rather than leaving every daemon spec to compile it.
test("npm test builds the native state lock before any worker starts", () => {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const scripts = (manifest as { scripts?: Record<string, unknown> }).scripts ?? {};
  assert.equal(typeof scripts.pretest, "string");
  assert.match(String(scripts.pretest), /scripts\/build-state-lock-native\.mjs/);
});
