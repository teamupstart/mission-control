import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  databasePath,
  openDatabaseShell,
  sqliteShellArgs,
} from "../scripts/db-shell.mjs";

test("databasePath follows the shared MISSION_HOME resolution", () => {
  const before = process.env.MISSION_HOME;
  const home = mkdtempSync(join(tmpdir(), "mission-db-shell-"));
  process.env.MISSION_HOME = home;
  try {
    assert.equal(databasePath(), join(home, "harness.db"));
  } finally {
    if (before === undefined) delete process.env.MISSION_HOME;
    else process.env.MISSION_HOME = before;
  }
});

test("the operator database shell is read-only and enables query-only mode", () => {
  const home = mkdtempSync(join(tmpdir(), "mission-db-shell-"));
  const path = join(home, "harness.db");
  writeFileSync(path, "");
  let command: string | undefined;
  let args: readonly string[] | undefined;

  const status = openDatabaseShell({
    path,
    sqliteBin: "sqlite3-test",
    spawn(bin, shellArgs) {
      command = bin;
      args = shellArgs;
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(command, "sqlite3-test");
  assert.deepEqual(args, sqliteShellArgs(path));
  assert.ok(args?.includes("-readonly"));
  assert.ok(args?.includes("PRAGMA query_only = ON;"));
});

test("the HTML database guide catalogs every application table exactly once", () => {
  const schemaSource = readFileSync(new URL("../src/server/db.ts", import.meta.url), "utf8");
  const guide = readFileSync(new URL("../docs/sqlite-database.html", import.meta.url), "utf8");
  const schemaTables = [...schemaSource.matchAll(/^\s*CREATE TABLE IF NOT EXISTS\s+(\w+)/gm)]
    .map((match) => match[1]!)
    .sort();
  const documentedTables = [...guide.matchAll(/class="table-row"><code>(\w+)<\/code>/g)]
    .map((match) => match[1]!)
    .sort();

  assert.equal(schemaTables.length, 78);
  assert.deepEqual(documentedTables, schemaTables);
});

test("every database guide family reports the number of tables it catalogs", () => {
  const guide = readFileSync(new URL("../docs/sqlite-database.html", import.meta.url), "utf8");
  const familyOpenings = [...guide.matchAll(/<details class="family"[^>]*>/g)];
  assert.ok(familyOpenings.length > 0);

  for (const opening of familyOpenings) {
    assert.equal(typeof opening.index, "number");
    const end = guide.indexOf("</details>", opening.index);
    assert.notEqual(end, -1);
    const family = guide.slice(opening.index, end);
    const summary = family.match(
      /<summary><strong>([^<]+)<\/strong><span>(\d+) tables<\/span><\/summary>/,
    );
    assert.ok(summary);
    const cataloged = [...family.matchAll(/class="table-row"/g)].length;
    assert.equal(cataloged, Number(summary[2]), `${summary[1]} table count`);
  }
});
