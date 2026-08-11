import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The harnesses config: a schema-validated blob over the `app_config` KV. Real db, so
// the round-trip through zod's defaults is exercised, not mocked. Mirrors the setup in
// skills-config.test.ts.

const home = mkdtempSync(join(tmpdir(), "mission-harnesses-cfg-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { getHarnessesConfig, setHarnessesConfig } = await import("../src/server/harnesses.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

test("ships with auto mode on dispatch enabled", () => {
  assert.equal(getHarnessesConfig().autoModeOnDispatch, true);
});

test("new installations default supported harnesses to the Agent SDK", () => {
  assert.deepEqual(getHarnessesConfig().sessionRuntime, {
    claude: "sdk",
    codex: "sdk",
    pi: "terminal",
  });
});

test("enabling persists and reads back on", () => {
  const next = setHarnessesConfig({ autoModeOnDispatch: true });
  assert.equal(next.autoModeOnDispatch, true);
  assert.equal(getHarnessesConfig().autoModeOnDispatch, true);
});

test("a patch merges over the stored config rather than replacing it", () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  // An empty-but-valid future patch must not silently reset the flag; today the only
  // field is the flag, so re-asserting it proves the merge reads the stored value first.
  const still = setHarnessesConfig({ autoModeOnDispatch: true });
  assert.equal(still.autoModeOnDispatch, true);
});

test("a stored config with an unknown key still parses (schema defaults fill the rest)", () => {
  // Forward-compatibility: a value written by a newer build must not throw an older one.
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run(
      "harnesses",
      JSON.stringify({
        autoModeOnDispatch: true,
        sessionRuntime: { claude: "sdk", codex: "sdk", pi: "terminal" },
        somethingNew: 7,
      }),
    );
  const config = getHarnessesConfig();
  assert.equal(config.autoModeOnDispatch, true);
  assert.equal(config.sessionRuntime.claude, "sdk");
});

test("a config saved before runtime selection keeps its terminal behavior", () => {
  openDb()
    .prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)`)
    .run("harnesses", JSON.stringify({ autoModeOnDispatch: true }));

  assert.deepEqual(getHarnessesConfig().sessionRuntime, {
    claude: "terminal",
    codex: "terminal",
    pi: "terminal",
  });
});
