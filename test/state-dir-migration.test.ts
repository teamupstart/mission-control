import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Renaming a state dir from an older name (~/.fleet-control, ~/.ai-harness) onto
// ~/.mission-control.
//
// Every test here runs the real module in a real child process with a real HOME, because
// the thing being tested IS a filesystem side effect at import time, and the bug this
// module already caused once was invisible to anything less: the rename originally sat in
// `config.ts`, which the test suite imports, so `npm test` moved the developer's live
// ~/.fleet-control out from under a running daemon. In-process mocks would have been
// perfectly happy with that arrangement.

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A HOME containing the given state dirs, each holding a marker file. */
function mkHome(dirs: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "mission-statedir-"));
  for (const [name, marker] of Object.entries(dirs)) {
    mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, name, "marker"), marker);
  }
  return home;
}

/** Run a node snippet with HOME set, and nothing else - no env override. */
function inHome(home: string, code: string): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "-e", code], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  }).trim();
}

const IMPORT_MIGRATE = `import("${join(repo, "src/server/migrate-state.ts")}")`;

test("the daemon's migrate module moves an old state dir onto the new name", async () => {
  const home = mkHome({ ".fleet-control": "REAL" });
  inHome(home, `await ${IMPORT_MIGRATE}`);
  assert.ok(!existsSync(join(home, ".fleet-control")), "the old dir is gone");
  assert.equal(readFileSync(join(home, ".mission-control", "marker"), "utf8"), "REAL", "with its contents");
});

test("it moves the LIVE dir and leaves an older, staler one alone", async () => {
  // Both exist on the machine this was written on. The newest is the one `stateDir`
  // resolves to and therefore the one in use; the older is a leftover from a rename
  // before that, and moving it would resurrect a stale db over a live one.
  const home = mkHome({ ".fleet-control": "LIVE", ".ai-harness": "STALE" });
  inHome(home, `await ${IMPORT_MIGRATE}`);
  assert.equal(readFileSync(join(home, ".mission-control", "marker"), "utf8"), "LIVE");
  assert.equal(readFileSync(join(home, ".ai-harness", "marker"), "utf8"), "STALE", "left where it lies");
});

test("it never overwrites a state dir that is already on the new name", async () => {
  const home = mkHome({ ".mission-control": "CURRENT", ".fleet-control": "OLD" });
  inHome(home, `await ${IMPORT_MIGRATE}`);
  assert.equal(readFileSync(join(home, ".mission-control", "marker"), "utf8"), "CURRENT", "untouched");
  assert.equal(readFileSync(join(home, ".fleet-control", "marker"), "utf8"), "OLD", "and the old one is left");
});

test("an explicit MISSION_HOME owns its path - nothing is renamed behind it", async () => {
  const home = mkHome({ ".fleet-control": "REAL" });
  execFileSync(process.execPath, ["--experimental-strip-types", "-e", `await ${IMPORT_MIGRATE}`], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: home, MISSION_HOME: join(home, "elsewhere") },
    encoding: "utf8",
  });
  assert.ok(existsSync(join(home, ".fleet-control")), "the override means hands off");
  assert.ok(!existsSync(join(home, ".mission-control")));
});

test("importing config.ts does NOT move anything - only the daemon's entry may", async () => {
  // The regression. `config.ts` is imported by most of src/server and so by nearly every
  // test file; when the rename lived in its body, running the suite renamed the real
  // ~/.fleet-control. A state dir must never move because someone imported a config.
  const home = mkHome({ ".fleet-control": "REAL" });
  inHome(home, `await import("${join(repo, "src/server/config.ts")}")`);
  assert.ok(existsSync(join(home, ".fleet-control")), "importing config left the dir alone");
  assert.ok(!existsSync(join(home, ".mission-control")), "and invented nothing");
});

test("the daemon imports the migration above config, or it would open a doomed path", () => {
  // The ordering IS the mechanism: ES modules evaluate imports in source order, and
  // `config.ts` resolves STATE_DIR (and DB_PATH off it) at module scope. Import the
  // migration after it and the daemon computes its db path, THEN renames the directory
  // it lives in - opening a fresh, empty database beside the real one. Nothing else
  // fails loudly if these two lines are swapped, so this is the check.
  const src = readFileSync(join(repo, "src/server/index.ts"), "utf8");
  const migrate = src.indexOf('import "./migrate-state.ts"');
  const config = src.indexOf('from "./config.ts"');
  assert.ok(migrate >= 0, "the daemon still imports the state-dir migration");
  assert.ok(config >= 0 && migrate < config, "and imports it BEFORE ./config.ts");
});
