import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// No test runner, tsx loader thread, or heartbeat in the child: they can accidentally
// flush the native backup promise. A distant timer keeps the loop open like the runner
// IPC channel does, without executing JS before the parent watchdog kills a stuck child.
test("online backups settle on an idle event loop and release their keepalive on success and failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-backup-idle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = new URL("../src/server/database-backups/online.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { join } from 'node:path';
    import { onlineDatabaseBackup } from ${JSON.stringify(helper)};
    const root = ${JSON.stringify(root)};
    const quietHandle = setTimeout(() => { throw new Error('unexpected wake'); }, 60_000);
    const source = new DatabaseSync(join(root, 'source.db'));
    source.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('committed')");
    for (let i = 0; i < 3; i++) {
      const path = join(root, i + '.db');
      await onlineDatabaseBackup(source, path);
      const copy = new DatabaseSync(path);
      assert.equal(copy.prepare('SELECT value FROM probe').get().value, 'committed');
      copy.close();
    }
    await assert.rejects(onlineDatabaseBackup(source, join(root, 'absent', 'copy.db')));
    source.close();
    await assert.rejects(onlineDatabaseBackup(source, join(root, 'closed.db')));
    clearTimeout(quietHandle);
    console.log('idle backups and rejection cleanup passed');
  `], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined, `child must exit without a leaked timer: ${result.error}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /idle backups and rejection cleanup passed/);
});
