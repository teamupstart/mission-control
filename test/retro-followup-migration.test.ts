import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-retro-followup-migration-"));

after(() => rmSync(home, { recursive: true, force: true }));

function run(script: string): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, RETRO_MIGRATION_HOME: home },
      encoding: "utf8",
    },
  ).trim();
}

test("opening a pre-feature database adds the retro follow-up table idempotently", () => {
  run(`
    process.env.HARNESS_HOME = process.env.RETRO_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    db.exec("DROP TABLE retro_followups");
    db.close();
  `);

  const inspect = `
    process.env.HARNESS_HOME = process.env.RETRO_MIGRATION_HOME;
    const { openDb } = await import("./src/server/db.ts");
    const db = openDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retro_followups'"
    ).get();
    process.stdout.write(row?.name ?? "missing");
    db.close();
  `;
  assert.equal(run(inspect), "retro_followups");
  assert.equal(run(inspect), "retro_followups", "a second migration pass keeps the table");
});
