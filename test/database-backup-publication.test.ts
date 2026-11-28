import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs, { fstatSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import { onlineDatabaseBackup } from "../src/server/database-backups/online.ts";
import { DatabaseBackupService, validateDatabaseBackupForRestore } from "../src/server/database-backups/service.ts";
import { tempDir } from "./temp-root.mjs";

test("ordinary HTTP requests and heartbeat timers run during real backup publication", async (t) => {
  const home = tempDir("backup-publication-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE payload (value BLOB);
    INSERT INTO payload VALUES (randomblob(16777216));
    PRAGMA secure_delete=OFF;
    CREATE TABLE resident_mcp_secrets (value TEXT);
    INSERT INTO resident_mcp_secrets VALUES (replace(hex(zeroblob(8192)), '00', 'freed-marker-'));
    DELETE FROM resident_mcp_secrets;
    INSERT INTO resident_mcp_secrets VALUES ('secret-marker-in-cell');
    CREATE TABLE resident_run_mcp_servers (source TEXT, definition_json TEXT);
    INSERT INTO resident_run_mcp_servers VALUES ('global', '{"transport":{"token":"definition-marker-in-cell"}}');
  `);
  let publishing = false;
  let ticks = 0;
  let requests = 0;
  const server = createServer((_request, response) => {
    if (publishing) requests++;
    response.end("ready");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/heartbeat`;
  const root = join(home, "backups");
  let started = 0;
  let request: Promise<string> | undefined;
  const service = new DatabaseBackupService(db, { root,
    onlineBackup: async (source, path) => {
      await onlineDatabaseBackup(source, path);
      assert.ok(readFileSync(path).includes("freed-marker-"), "staging contains remnants of the previously deleted row");
      started = performance.now();
      publishing = true;
      request = fetch(url).then(r => r.text());
    },
  });
  const heartbeat = setInterval(() => { if (publishing) ticks++; }, 5);
  t.after(() => clearInterval(heartbeat));
  const backup = await service.captureScheduled();
  publishing = false;
  t.diagnostic(`Publication ${Math.round(performance.now() - started)}ms, heartbeat ticks ${ticks}, HTTP requests served during publication ${requests}`);
  assert.equal(await request, "ready");
  assert.deepEqual(readdirSync(root), [backup.filename]);
  assert.equal(statSync(backup.path).mode & 0o777, 0o600);
  const bytes = readFileSync(backup.path);
  for (const marker of ["secret-marker-in-cell", "definition-marker-in-cell", "freed-marker-"]) assert.ok(!bytes.includes(marker));
  const copy = new DatabaseSync(backup.path, { readOnly: true });
  t.after(() => copy.close());
  assert.equal(copy.prepare("SELECT length(value) AS size FROM payload").get()?.size, 16777216);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM resident_mcp_secrets").get()?.n, 0);
  assert.equal(copy.prepare("SELECT definition_json FROM resident_run_mcp_servers").get()?.definition_json,
    '{"transport":{"type":"redacted"}}');
  assert.equal(copy.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
  assert.equal(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.ok(ticks > 0 && requests > 0, "the daemon must keep servicing requests after the online copy completes");
});

test("capacity refusals preserve recovery points, free staging files and persist scheduled backoff", async (t) => {
  const home = tempDir("backup-capacity-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE resident_mcp_secrets (value BLOB);
    INSERT INTO resident_mcp_secrets VALUES (randomblob(1048576))`);
  const root = join(home, "backups");
  const service = new DatabaseBackupService(db, { root });
  const retained = await service.captureManual();
  const original = readFileSync(retained.path);

  for (const stage of ["snapshot", "online copy", "secret redaction", "VACUUM INTO"] as const) {
    await t.test(stage, async () => {
      let readings = 0;
      // For the publication checks, keep the real online copy but isolate its
      // independent progress checks from the two simulated destination readings.
      const stopAt = { snapshot: 1, "online copy": 2, "secret redaction": 2, "VACUUM INTO": 3 }[stage];
      const limited = new DatabaseBackupService(db, {
        root,
        onlineBackup: stage === "online copy" ? undefined : onlineDatabaseBackup,
        availableBytes: () => ++readings === stopAt ? 0n : 2n ** 40n,
      });
      const same = limited.captureScheduled();
      assert.equal(same, limited.captureScheduled());
      await assert.rejects(same, new RegExp(`Insufficient backup workspace for ${stage}`));
      assert.equal(readings, stopAt);
      assert.deepEqual(readdirSync(root), [retained.filename]);
      assert.deepEqual(readFileSync(retained.path), original);
      const restarted = new DatabaseBackupService(db, { root });
      assert.equal(restarted.scheduledDue(), false);
      assert.match(restarted.status().scheduled.lastFailure!.message, new RegExp(stage));
      assert.ok(restarted.status().manual.lastSuccessAt);
    });
  }
  const refusedStartup = new DatabaseBackupService(db, { root, availableBytes: () => 0n });
  assert.throws(() => refusedStartup.capturePreMigration(), /Insufficient backup workspace for snapshot/);
  assert.deepEqual(readdirSync(root), [retained.filename]);
  await service.captureManual();
  assert.equal(service.status().scheduled.consecutiveFailures, 0);
});

test("snapshot admission accepts the exact workspace requirement and refuses one byte less", async (t) => {
  const home = tempDir("backup-workspace-threshold-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(1048576))");
  const root = join(home, "backups");
  const old = await new DatabaseBackupService(db, { root }).captureManual();
  const original = readFileSync(old.path);
  const pages = BigInt(db.prepare("PRAGMA page_count").get()!.page_count as number);
  const pageSize = BigInt(db.prepare("PRAGMA page_size").get()!.page_size as number);
  const required = 3n * pages * pageSize + 65536n;

  const short = new DatabaseBackupService(db, { root, availableBytes: () => required - 1n });
  await assert.rejects(short.captureScheduled(), {
    message: `Scheduled database backup failed: Insufficient backup workspace for snapshot: need ${required} bytes, ${required - 1n} available`,
  });
  assert.deepEqual(readdirSync(root), [old.filename]);
  assert.deepEqual(readFileSync(old.path), original);

  const exact = new DatabaseBackupService(db, { root, availableBytes: () => required });
  const published = await exact.captureScheduled();
  assert.equal(validateDatabaseBackupForRestore(published.path).integrity, "ok");
  assert.deepEqual(readdirSync(root).sort(), [old.filename, published.filename].sort());
  assert.deepEqual(readFileSync(old.path), original);
  t.diagnostic(`Rejected ${required - 1n} bytes and accepted ${required} bytes with the prior copy intact`);
});

test("a later online progress check stops a growing copy when available space drops", async (t) => {
  const home = tempDir("backup-online-space-drop-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE payload(value BLOB)");
  const root = join(home, "backups");
  const old = await new DatabaseBackupService(db, { root }).captureManual();
  const original = readFileSync(old.path);
  db.exec("INSERT INTO payload VALUES (randomblob(25165824))");

  const stagedSizes: number[] = [];
  const service = new DatabaseBackupService(db, {
    root,
    availableBytes: () => {
      const temporary = readdirSync(root).find(filename => filename.endsWith(".tmp"));
      if (!temporary) return 128n * 1024n * 1024n; // Admission, before SQLite opens the destination.
      stagedSizes.push(statSync(join(root, temporary)).size);
      // A competing writer consumes the available bytes after the first progress check passed.
      return stagedSizes.length === 1 ? 128n * 1024n * 1024n : 0n;
    },
  });
  await assert.rejects(service.captureScheduled(), /Insufficient backup workspace for online copy/);
  assert.equal(stagedSizes.length, 2);
  const [first, later] = stagedSizes as [number, number];
  assert.ok(later > first && later < 25165824, "the partial staging file grew between progress checks");
  assert.deepEqual(readdirSync(root), [old.filename]);
  assert.deepEqual(readFileSync(old.path), original);
  t.diagnostic(`Staging grew from ${first} to ${later} bytes between progress checks, then was removed`);
});

test("a real worker scrub failure leaves the previous valid copy and reports the failed stage", async (t) => {
  const home = tempDir("backup-worker-failure-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE resident_run_mcp_servers(source TEXT, definition_json TEXT)");
  const root = join(home, "backups");
  const service = new DatabaseBackupService(db, { root });
  const old = await service.captureManual();
  db.exec("INSERT INTO resident_run_mcp_servers VALUES ('global', 'malformed private definition')");
  await assert.rejects(service.captureManual(), /secret redaction failed: malformed JSON/i);
  assert.deepEqual(readdirSync(root), [old.filename]);
});

test("a publication worker that exits cleanly without reporting completion fails the capture", { timeout: 10_000 }, async (t) => {
  const home = tempDir("backup-worker-early-exit-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE payload(value TEXT)");
  const root = join(home, "backups");
  const service = new DatabaseBackupService(db, { root });
  const old = await service.captureManual();
  const original = readFileSync(old.path);
  const previousSuccess = service.status().manual.lastSuccessAt;
  assert.notEqual(previousSuccess, null);

  const NativeWorker = workerThreads.Worker;
  const earlyExit = t.mock.method(workerThreads, "Worker", class extends NativeWorker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      assert.ok(filename instanceof URL && filename.pathname.endsWith("/publication-worker.mjs"));
      // Leave the source snapshot and partial rebuild files, then exit without sending a message.
      super(`
        const assert = require("node:assert/strict");
        const { statSync, writeFileSync } = require("node:fs");
        const { workerData: { temporary } } = require("node:worker_threads");
        assert.ok(statSync(temporary).size > 0);
        writeFileSync(temporary + ".vacuum", "partial rebuild");
        writeFileSync(temporary + ".vacuum-journal", "partial journal");
      `, { ...options, eval: true });
    }
  });
  syncBuiltinESMExports();
  const workerFailure = "Backup publication worker stopped before completion (code 0)";
  try {
    await assert.rejects(service.captureScheduled(), {
      message: `Scheduled database backup failed: ${workerFailure}`,
    });
  } finally {
    earlyExit.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(readdirSync(root), [old.filename]);
  assert.deepEqual(readFileSync(old.path), original);
  const status = new DatabaseBackupService(db, { root }).status();
  assert.equal(status.scheduled.consecutiveFailures, 1);
  assert.equal(status.scheduled.lastFailure?.kind, "scheduled");
  assert.equal(status.scheduled.lastFailure?.message, workerFailure);
  assert.equal(status.scheduled.lastSuccessAt, null);
  assert.equal(status.manual.lastSuccessAt, previousSuccess);
});

test("file sync, rename and directory sync failures preserve the last durable point", async (t) => {
  const home = tempDir("backup-publish-fsync-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE resident_mcp_secrets(value TEXT); INSERT INTO resident_mcp_secrets VALUES ('private-marker')");
  for (const stage of ["file sync", "rename", "directory sync"]) {
    await t.test(stage, async (subtest) => {
      const root = join(home, stage);
      const service = new DatabaseBackupService(db, { root, validate: validateDatabaseBackupForRestore });
      const old = await service.captureManual();
      const original = readFileSync(old.path);
      const failure = () => { throw new Error("injected I/O failure"); };
      if (stage === "rename") {
        subtest.mock.method(fs, "renameSync", failure);
      } else {
        const sync = fs.fsyncSync;
        subtest.mock.method(fs, "fsyncSync", (fd: number) => {
          if (fstatSync(fd).isDirectory() === (stage === "directory sync")) failure();
          sync(fd);
        });
      }
      syncBuiltinESMExports();
      try {
        await assert.rejects(service.captureManual(), new RegExp(`Backup ${stage} failed: injected I/O failure`));
      } finally {
        subtest.mock.restoreAll();
        syncBuiltinESMExports();
      }
      assert.deepEqual(readFileSync(old.path), original);
      const names = readdirSync(root);
      assert.equal(names.length, stage === "directory sync" ? 2 : 1, "only the directory sync follows atomic rename");
      for (const name of names) {
        assert.ok(name.endsWith(".sqlite3"));
        assert.equal(validateDatabaseBackupForRestore(join(root, name)).integrity, "ok");
        assert.ok(!readFileSync(join(root, name)).includes("private-marker"));
      }
    });
  }
});

test("publication refuses linked staging files before opening or scrubbing their target", async (t) => {
  const home = tempDir("backup-staging-link-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourcePath = join(home, "source.db");
  const db = new DatabaseSync(sourcePath);
  t.after(() => db.close());
  db.exec("CREATE TABLE resident_mcp_secrets(value TEXT); INSERT INTO resident_mcp_secrets VALUES ('untouched')");
  for (const link of [fs.symlinkSync, fs.linkSync]) {
    const root = join(home, link.name);
    const service = new DatabaseBackupService(db, {
      root,
      onlineBackup: async (_source, destination) => { link(sourcePath, destination); },
    });
    await assert.rejects(service.captureManual(), /staging file check failed/);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(db.prepare("SELECT value FROM resident_mcp_secrets").get()?.value, "untouched");
  }
});

test("publication refuses a regular staging file owned by another user before journal conversion", { skip: !process.getuid }, async (t) => {
  const home = tempDir("backup-staging-owner-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, "source.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE resident_mcp_secrets(value TEXT); INSERT INTO resident_mcp_secrets VALUES ('synthetic-private-marker')");
  const root = join(home, "backups");
  const old = await new DatabaseBackupService(db, { root }).captureManual();
  const original = readFileSync(old.path);
  const lstat = fs.lstatSync;
  let stagingPath: string | undefined;
  const journalConversion = t.mock.fn();
  const service = new DatabaseBackupService(db, {
    root,
    onlineBackup: async (source, destination) => {
      await onlineDatabaseBackup(source, destination);
      assert.ok(readFileSync(destination).includes("synthetic-private-marker"));
      stagingPath = destination;
    },
    selfContain: journalConversion,
  });

  // Supply only the foreign UID via the stat result, without requiring privileged chown.
  const foreignOwner = t.mock.method(fs, "lstatSync", (path: fs.PathLike) => {
    const info = lstat(path);
    if (path === stagingPath) {
      assert.ok(info.isFile());
      assert.equal(info.nlink, 1);
      assert.equal(info.uid, process.getuid!());
      info.uid += 1;
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(service.captureScheduled(), {
      message: "Scheduled database backup failed: Backup staging file check failed: candidate must be a privately owned regular file",
    });
  } finally {
    foreignOwner.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(journalConversion.mock.callCount(), 0, "rejection happens before SQLite opens the staging file");
  assert.deepEqual(readdirSync(root), [old.filename]);
  assert.deepEqual(readFileSync(old.path), original);
});
