import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, test } from "node:test";
import { inspectorPosture } from "../src/shared/inspector.ts";
import { tempDir } from "./temp-root.mjs";

const root = tempDir("mission-inspector-install-");
const home = join(root, "state");
const path = join(home, "harness.db");
process.env.MISSION_HOME = home;
const { closeDb, openDb } = await import("../src/server/db.ts");
const { getInspectorConfig } = await import("../src/server/inspector/config.ts");

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home);
});
after(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

test("a new installation starts live without repository grants and keeps that default on restart", () => {
  const fresh = getInspectorConfig();
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.mode, "live");
  assert.deepEqual(fresh.repoAllowlist, []);
  assert.equal(inspectorPosture(fresh, "/repo", "/repo"), "not-allowlisted");

  closeDb();
  assert.deepEqual(getInspectorConfig(), fresh);
});

test("a crash after creating app_config still lets a new installation start in Live mode", () => {
  // The child inherits the test's isolated state directory and opens the same database.
  // Kill it before the insert so SQLite recovery runs without the daemon's catch block.
  const interrupted = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { writeSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";

    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("INSERT INTO app_config")) {
        assert.equal(prepare.call(this, "SELECT 1 FROM app_config WHERE key = 'inspector'").get(), undefined);
        writeSync(1, "app_config created before the Inspector insert\\n");
        process.kill(process.pid, "SIGKILL");
      }
      return statement;
    };

    const { openDb } = await import("./src/server/db.ts");
    openDb();
  `], { encoding: "utf8", timeout: 30_000 });

  assert.ifError(interrupted.error);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
  assert.match(interrupted.stdout, /app_config created before the Inspector insert/);

  const recovered = getInspectorConfig();
  assert.equal(recovered.enabled, true);
  assert.equal(recovered.mode, "live");
});

for (const version of [35, 0]) {
  test(`an existing database at schema ${version} without saved Inspector settings stays off in Dry run`, () => {
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = ${version};`);
    legacy.close();

    const config = getInspectorConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.mode, "dry-run");
    assert.equal(openDb().prepare("SELECT value FROM app_config WHERE key = 'inspector'").get(), undefined);
    closeDb();
    assert.deepEqual(getInspectorConfig(), config);
  });
}

test("unreadable saved Inspector settings fall back to off and Dry run", () => {
  const update = openDb().prepare("UPDATE app_config SET value = ? WHERE key = 'inspector'");
  for (const value of ['{"enabled":', '{"enabled":true,"mode":"unknown"}']) {
    assert.equal(update.run(value).changes, 1);
    const config = getInspectorConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.mode, "dry-run");
    assert.deepEqual(config.repoAllowlist, []);
  }
});
