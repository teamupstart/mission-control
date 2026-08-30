import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  APP_BUNDLE_ID,
  durableWriteJson,
  parseArgs,
  readRecoveryLedger,
  runDatabaseRecovery,
} from "../scripts/recover-database.mjs";
import type { DurableWriteOperations } from "../scripts/recover-database.mjs";

function database(path: string, marker: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE recovery_fixture (marker TEXT NOT NULL)");
  db.prepare("INSERT INTO recovery_fixture (marker) VALUES (?)").run(marker);
  db.close();
}

function marker(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return String(
      (db.prepare("SELECT marker FROM recovery_fixture").get() as { marker: string }).marker,
    );
  } finally {
    db.close();
  }
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mission-recovery-test-"));
  const home = join(root, "state");
  const candidate = join(root, "candidate.db");
  const live = join(home, "harness.db");
  mkdirSync(home, { recursive: true });
  database(candidate, "candidate");
  database(live, "original");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, candidate, live };
}

function operations(
  options: { stopBlocked?: boolean; launchFails?: boolean; healthFails?: boolean } = {},
) {
  const actions: string[] = [];
  let appRunning = true;
  let daemonRunning = true;
  let recoveryLockHeld = false;
  let ledgerLockHeld = false;
  let now = 0;
  const ops = {
    verifyApp: (_home: string, bundleId: string) => actions.push(`verify:${bundleId}`),
    appIsRunning: async () => appRunning,
    quitApp: async (bundleId: string) => {
      actions.push(`quit:${bundleId}`);
      appRunning = false;
      if (!options.stopBlocked) daemonRunning = false;
    },
    identifyDaemon: async () => {
      actions.push("identify");
      if (!daemonRunning || options.healthFails) return null;
      return { pid: 4242, port: 7317, version: "test" };
    },
    signalDaemon: (pid: number) => actions.push(`signal:${pid}`),
    tryAcquireLock: () => {
      actions.push("acquire");
      if (options.stopBlocked && daemonRunning) return null;
      if (recoveryLockHeld) return null;
      recoveryLockHeld = true;
      return {
        release: () => {
          recoveryLockHeld = false;
          actions.push("release");
        },
      };
    },
    tryAcquireLedgerLock: () => {
      actions.push("ledger-acquire");
      if (ledgerLockHeld) {
        actions.push("ledger-acquire-blocked");
        return null;
      }
      ledgerLockHeld = true;
      return {
        release: () => {
          ledgerLockHeld = false;
          actions.push("ledger-release");
        },
      };
    },
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    launchApp: (bundleId: string) => {
      actions.push(`launch:${bundleId}`);
      if (options.launchFails) throw new Error("injected relaunch failure");
      appRunning = true;
      daemonRunning = !options.healthFails;
    },
    now: () => `2026-08-30T12:00:${String(now++).padStart(2, "0")}.000Z`,
  };
  return { ops, actions };
}

test("the command accepts one candidate or one explicit rollback id", () => {
  assert.deepEqual(parseArgs(["/tmp/candidate.db"]).args, {
    kind: "restore",
    candidatePath: "/tmp/candidate.db",
  });
  assert.deepEqual(parseArgs(["--rollback", "recovery-1"]).args, {
    kind: "rollback",
    recoveryId: "recovery-1",
  });
  assert.match(String(parseArgs([]).problem), /Usage/);
});

test("ledger publication fsyncs the containing directory after the atomic rename", () => {
  const target = "/state/database-recovery/ledger.json";
  const directory = dirname(target);
  const events: string[] = [];
  let temporary = "";
  const operations = {
    mkdir: (path) => events.push(`mkdir:${path}`),
    write: (path) => {
      temporary = path;
      events.push(`write:${path}`);
    },
    open: (path) => {
      events.push(`open:${path}`);
      return path === directory ? 22 : 11;
    },
    fsync: (fd) => events.push(`fsync:${fd}`),
    close: (fd) => events.push(`close:${fd}`),
    rename: (from, to) => {
      assert.equal(from, temporary);
      events.push(`rename:${to}`);
    },
    remove: (path) => events.push(`remove:${path}`),
  } satisfies DurableWriteOperations;

  durableWriteJson(target, { schema: 1, attempts: [] }, operations);

  assert.match(temporary, /^\/state\/database-recovery\/ledger\.json\..+\.tmp$/);
  assert.deepEqual(events, [
    `mkdir:${directory}`,
    `write:${temporary}`,
    `open:${temporary}`,
    "fsync:11",
    "close:11",
    `rename:${target}`,
    `open:${directory}`,
    "fsync:22",
    "close:22",
  ]);
});

test("a valid candidate stops by exact bundle id, restores, launches once, and reports dynamic health", async (t) => {
  const f = fixture(t);
  const fake = operations();

  const result = await runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    { home: f.home, ops: fake.ops },
  );

  assert.equal(result.kind, "applied");
  assert.equal(marker(f.live), "candidate");
  assert.deepEqual(result.health, { pid: 4242, port: 7317, version: "test" });
  assert.match(result.message, /PID 4242, port 7317, version test/);
  assert.equal(fake.actions.filter((action) => action === `launch:${APP_BUNDLE_ID}`).length, 1);
  assert.ok(fake.actions.includes(`verify:${APP_BUNDLE_ID}`));
  assert.ok(fake.actions.includes(`quit:${APP_BUNDLE_ID}`));
  assert.ok(fake.actions.indexOf("acquire") < fake.actions.indexOf(`launch:${APP_BUNDLE_ID}`));
});

test("interrupted stop times out before any database file is moved", async (t) => {
  const f = fixture(t);
  const fake = operations({ stopBlocked: true });

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: f.candidate },
      { home: f.home, ops: fake.ops, stopTimeoutMs: 8 },
    ),
    /did not release daemon\.lock/,
  );

  assert.equal(marker(f.live), "original");
  assert.deepEqual(readRecoveryLedger(f.home).attempts, []);
  assert.equal(fake.actions.filter((action) => action === "signal:4242").length, 1);
  assert.equal(fake.actions.some((action) => action.startsWith("launch:")), false);
});

test("an invalid candidate is rejected before stopping the app or daemon", async (t) => {
  const f = fixture(t);
  const invalid = join(f.root, "invalid.db");
  writeFileSync(invalid, "not sqlite");
  const fake = operations();

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: invalid },
      { home: f.home, ops: fake.ops },
    ),
  );

  assert.equal(marker(f.live), "original");
  assert.equal(fake.actions.some((action) => action.startsWith("quit:")), false);
  assert.equal(fake.actions.includes("acquire"), false);
});

test("relaunch failure restores the preserved rollback material without a second launch", async (t) => {
  const f = fixture(t);
  const fake = operations({ launchFails: true });

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: f.candidate },
      { home: f.home, ops: fake.ops },
    ),
    /launched exactly once/,
  );

  assert.equal(marker(f.live), "original");
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
  const [attempt] = readRecoveryLedger(f.home).attempts;
  assert.equal(attempt?.status, "rolled_back");
  assert.match(String(attempt?.message), /automatic rollback/);
  assert.equal(
    marker(join(String(attempt?.rollbackDirectory), "harness.db")),
    "original",
  );
});

test("post-health bookkeeping failure warns without reverting the applied database", async (t) => {
  const f = fixture(t);
  const fake = operations();

  const result = await runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    {
      home: f.home,
      ops: fake.ops,
      pruneRollbacks: () => {
        throw new Error("injected rollback-pruning failure");
      },
    },
  );

  assert.equal(result.kind, "applied");
  assert.deepEqual(result.health, { pid: 4242, port: 7317, version: "test" });
  assert.deepEqual(result.warnings, [
    "could not prune retained rollback material: injected rollback-pruning failure",
  ]);
  assert.match(result.message, /is healthy.*Warning:.*injected rollback-pruning failure/);
  assert.equal(marker(f.live), "candidate");
  assert.equal(readRecoveryLedger(f.home).attempts[0]?.status, "applied");
  assert.equal(fake.actions.filter((action) => action.startsWith("quit:")).length, 1);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
});

test("an identical candidate retries after an injected install failure was rolled back", async (t) => {
  const f = fixture(t);
  const fake = operations();
  const request = { kind: "restore", candidatePath: f.candidate } as const;

  await assert.rejects(
    runDatabaseRecovery(request, {
      home: f.home,
      ops: fake.ops,
      installDatabase: () => {
        throw new Error("injected transient install failure");
      },
    }),
    /injected transient install failure/,
  );

  assert.equal(marker(f.live), "original");
  assert.equal(readRecoveryLedger(f.home).attempts[0]?.status, "rolled_back");

  const retry = await runDatabaseRecovery(request, { home: f.home, ops: fake.ops });

  assert.equal(retry.kind, "applied");
  assert.equal(marker(f.live), "candidate");
  assert.deepEqual(
    readRecoveryLedger(f.home).attempts.map((attempt) => attempt.status),
    ["rolled_back", "applied"],
  );
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
});

test("repeat invocation is a no-op and never reapplies or relaunches", async (t) => {
  const f = fixture(t);
  const fake = operations();
  const request = { kind: "restore", candidatePath: f.candidate } as const;

  const first = await runDatabaseRecovery(request, { home: f.home, ops: fake.ops });
  const actionsAfterFirst = fake.actions.length;
  const second = await runDatabaseRecovery(request, { home: f.home, ops: fake.ops });

  assert.equal(first.kind, "applied");
  assert.equal(second.kind, "already-applied");
  assert.equal(second.recoveryId, first.recoveryId);
  assert.equal(fake.actions.slice(actionsAfterFirst).some((action) => action === "acquire"), false);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
  assert.equal(marker(f.live), "candidate");
});

test("concurrent identical invocations serialize to one install and one relaunch", async (t) => {
  const f = fixture(t);
  const fake = operations();
  const request = { kind: "restore", candidatePath: f.candidate } as const;

  const results = await Promise.all([
    runDatabaseRecovery(request, { home: f.home, ops: fake.ops }),
    runDatabaseRecovery(request, { home: f.home, ops: fake.ops }),
  ]);
  const applied = results.find((result) => result.kind === "applied");
  const duplicate = results.find((result) => result.kind === "already-applied");

  assert.ok(applied, "one invocation must win the serialized install");
  assert.ok(duplicate, "the concurrent loser must observe the winner under the lock");
  const firstRelease = fake.actions.indexOf("release");
  assert.ok(firstRelease > 0);
  assert.ok(
    fake.actions.slice(0, firstRelease).filter((action) => action === "acquire").length >= 2,
    "both invocations must clear the fast check and contend for the same lock",
  );
  assert.equal(duplicate.recoveryId, applied.recoveryId);
  assert.equal(readRecoveryLedger(f.home).attempts.length, 1);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
  assert.equal(marker(f.live), "candidate");
});

test("different recoveries cannot lose an applied transition after daemon lock release", async (t) => {
  const f = fixture(t);
  const candidateB = join(f.root, "candidate-b.db");
  database(candidateB, "candidate-b");
  const fake = operations();
  let announceAppliedRead!: () => void;
  let resumeAppliedWrite!: () => void;
  const appliedRead = new Promise<void>((resolve) => {
    announceAppliedRead = resolve;
  });
  const appliedWriteGate = new Promise<void>((resolve) => {
    resumeAppliedWrite = resolve;
  });

  const recoveryA = runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    {
      home: f.home,
      ops: fake.ops,
      beforeAppliedLedgerWrite: async () => {
        announceAppliedRead();
        await appliedWriteGate;
      },
    },
  );
  await appliedRead;

  const recoveryB = runDatabaseRecovery(
    { kind: "restore", candidatePath: candidateB },
    { home: f.home, ops: fake.ops },
  );
  const deadline = Date.now() + 1_000;
  while (!fake.actions.includes("ledger-acquire-blocked") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const bWaitedForA = fake.actions.includes("ledger-acquire-blocked");
  resumeAppliedWrite();

  const [resultA, resultB] = await Promise.all([recoveryA, recoveryB]);
  const ledger = readRecoveryLedger(f.home);
  const attemptA = ledger.attempts.find((attempt) => attempt.id === resultA.recoveryId);
  const attemptB = ledger.attempts.find((attempt) => attempt.id === resultB.recoveryId);

  assert.equal(bWaitedForA, true, "recovery B must reach the ledger while A holds its lock");
  assert.equal(resultA.kind, "applied");
  assert.equal(resultB.kind, "applied");
  assert.equal(attemptA?.status, "applied");
  assert.equal(attemptB?.status, "applied");
  assert.equal(ledger.attempts.length, 2);
  assert.ok(attemptA?.rollbackDirectory);
  assert.equal(existsSync(join(attemptA.rollbackDirectory, "harness.db")), true);
  assert.equal(marker(f.live), "candidate-b");
});

test("an explicit rollback uses preserved material through the same guarded flow", async (t) => {
  const f = fixture(t);
  const fake = operations();
  const applied = await runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    { home: f.home, ops: fake.ops },
  );

  const rolledBack = await runDatabaseRecovery(
    { kind: "rollback", recoveryId: applied.recoveryId },
    { home: f.home, ops: fake.ops },
  );

  assert.equal(rolledBack.kind, "rolled-back");
  assert.equal(marker(f.live), "original");
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 2);
  const originalAttempt = readRecoveryLedger(f.home).attempts.find(
    (attempt) => attempt.id === applied.recoveryId,
  );
  assert.equal(originalAttempt?.status, "rolled_back");
  assert.match(String(originalAttempt?.message), /rolled back by recovery/);
});

test("candidate validation rejects foreign-key corruption before stop", async (t) => {
  const f = fixture(t);
  const walCandidate = join(f.root, "wal-candidate.db");
  const db = new DatabaseSync(walCandidate);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("INSERT INTO child (parent_id) VALUES (99)");
  db.close();
  const fake = operations();

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: walCandidate },
      { home: f.home, ops: fake.ops },
    ),
    /foreign-key violation/,
  );
  assert.equal(readFileSync(f.live).length > 0, true);
});
