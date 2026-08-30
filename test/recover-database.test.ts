import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  APP_BUNDLE_ID,
  durableCopySqliteSet,
  durableReplaceSqliteSet,
  durableWriteJson,
  parseArgs,
  readRecoveryLedger,
  recoveryStateLockAddonPath,
  runDatabaseRecovery,
} from "../scripts/recover-database.mjs";
import type {
  DurableDatabaseOperations,
  DurableWriteOperations,
} from "../scripts/recover-database.mjs";

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
  options: {
    stopBlocked?: boolean;
    launchFails?: boolean;
    healthFails?: boolean;
    healthAmbiguousOnce?: boolean;
    appRunning?: boolean;
    daemonRunning?: boolean;
    runningAppPath?: string;
  } = {},
) {
  const actions: string[] = [];
  const verifiedAppPath = "/Applications/Mission Control.app";
  let appRunning = options.appRunning ?? true;
  let daemonRunning = options.daemonRunning ?? true;
  let recoveryLockHeld = false;
  let ledgerLockHeld = false;
  let recoveryOperationLockHeld = false;
  let launched = false;
  let healthAmbiguous = options.healthAmbiguousOnce ?? false;
  let now = 0;
  const ops = {
    verifyApp: (_home: string, bundleId: string) => {
      actions.push(`verify:${bundleId}:${verifiedAppPath}`);
      return verifiedAppPath;
    },
    appIsRunning: async (appPath: string, _bundleId: string) =>
      appRunning && (options.runningAppPath ?? verifiedAppPath) === appPath,
    quitApp: async (appPath: string, bundleId: string) => {
      actions.push(`quit:${bundleId}:${appPath}`);
      appRunning = false;
      if (!options.stopBlocked) daemonRunning = false;
    },
    identifyDaemon: async () => {
      actions.push("identify");
      if (launched && healthAmbiguous) {
        healthAmbiguous = false;
        actions.push("identify-ambiguous");
        throw Object.assign(new Error("injected daemon identity mismatch"), {
          code: "EDAEMONIDENTITY",
        });
      }
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
    tryAcquireRecoveryLock: () => {
      actions.push("recovery-acquire");
      if (recoveryOperationLockHeld) {
        actions.push("recovery-acquire-blocked");
        return null;
      }
      recoveryOperationLockHeld = true;
      return {
        release: () => {
          recoveryOperationLockHeld = false;
          actions.push("recovery-release");
        },
      };
    },
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    launchApp: (appPath: string, bundleId: string) => {
      actions.push(`launch:${bundleId}:${appPath}`);
      if (options.launchFails) throw new Error("injected relaunch failure");
      launched = true;
      appRunning = true;
      daemonRunning = !options.healthFails;
    },
    now: () => `2026-08-30T12:00:${String(now++).padStart(2, "0")}.000Z`,
  };
  return { ops, actions, verifiedAppPath };
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

test("database replacement fsyncs files before durably publishing the SQLite set", () => {
  const source = "/rollback/harness.db";
  const live = "/state/harness.db";
  const directory = dirname(live);
  const events: string[] = [];
  let temporary = "";
  let nextFd = 10;
  const descriptors = new Map<number, string>();
  const operations = {
    mkdir: (path) => events.push(`mkdir:${path}`),
    copy: (from, to) => {
      if (from === source) temporary = to;
      events.push(`copy:${from}:${to}`);
    },
    chmod: (path, mode) => events.push(`chmod:${path}:${mode.toString(8)}`),
    exists: (path) => path === `${source}-wal`,
    open: (path) => {
      const fd = nextFd++;
      descriptors.set(fd, path);
      events.push(`open:${path}`);
      return fd;
    },
    fsync: (fd) => events.push(`fsync:${descriptors.get(fd)}`),
    close: (fd) => events.push(`close:${descriptors.get(fd)}`),
    rename: (from, to) => events.push(`rename:${from}:${to}`),
    remove: (path) => events.push(`remove:${path}`),
  } satisfies DurableDatabaseOperations;

  durableReplaceSqliteSet(source, live, 0o640, operations);

  assert.match(temporary, /^\/state\/\.harness\.db\.replacement-.+$/);
  assert.ok(events.indexOf(`fsync:${temporary}`) < events.indexOf(`rename:${temporary}:${live}`));
  assert.ok(events.indexOf(`remove:${live}-wal`) < events.indexOf(`rename:${temporary}:${live}`));
  assert.ok(events.indexOf(`remove:${live}-shm`) < events.indexOf(`rename:${temporary}:${live}`));
  assert.ok(events.indexOf(`fsync:${live}-wal`) < events.indexOf(`fsync:${directory}`));
  assert.equal(events.at(-2), `fsync:${directory}`);
  assert.equal(events.at(-1), `close:${directory}`);
});

test("rollback snapshots fsync every copied file and both snapshot directory levels", () => {
  const source = "/state/harness.db";
  const target = "/state/database-recovery/recovery-1/rollback/harness.db";
  const directory = dirname(target);
  const parent = dirname(directory);
  const events: string[] = [];
  let nextFd = 30;
  const descriptors = new Map<number, string>();
  const operations = {
    mkdir: (path) => events.push(`mkdir:${path}`),
    copy: (from, to) => events.push(`copy:${from}:${to}`),
    chmod: (path, mode) => events.push(`chmod:${path}:${mode.toString(8)}`),
    exists: (path) => path === source || path === `${source}-wal`,
    open: (path) => {
      const fd = nextFd++;
      descriptors.set(fd, path);
      events.push(`open:${path}`);
      return fd;
    },
    fsync: (fd) => events.push(`fsync:${descriptors.get(fd)}`),
    close: (fd) => events.push(`close:${descriptors.get(fd)}`),
    rename: (from, to) => events.push(`rename:${from}:${to}`),
    remove: (path) => events.push(`remove:${path}`),
  } satisfies DurableDatabaseOperations;

  durableCopySqliteSet(source, target, operations);

  assert.ok(events.indexOf(`fsync:${target}`) < events.indexOf(`fsync:${directory}`));
  assert.ok(events.indexOf(`fsync:${target}-wal`) < events.indexOf(`fsync:${directory}`));
  assert.ok(events.indexOf(`fsync:${directory}`) < events.indexOf(`fsync:${parent}`));
  assert.equal(events.at(-2), `fsync:${parent}`);
  assert.equal(events.at(-1), `close:${parent}`);
});

test("the recovery addon path is anchored to the script rather than the caller's cwd", () => {
  assert.equal(
    recoveryStateLockAddonPath("file:///checkout/scripts/recover-database.mjs"),
    "/checkout/dist/native/state-lock.node",
  );
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
  assert.equal(
    fake.actions.filter(
      (action) => action === `launch:${APP_BUNDLE_ID}:${fake.verifiedAppPath}`,
    ).length,
    1,
  );
  assert.ok(fake.actions.includes(`verify:${APP_BUNDLE_ID}:${fake.verifiedAppPath}`));
  assert.ok(fake.actions.includes(`quit:${APP_BUNDLE_ID}:${fake.verifiedAppPath}`));
  assert.ok(
    fake.actions.indexOf("acquire") <
      fake.actions.indexOf(`launch:${APP_BUNDLE_ID}:${fake.verifiedAppPath}`),
  );
});

test("a daemon is never signaled unless the receipt-verified product app owned the stop", async (t) => {
  const f = fixture(t);
  const fake = operations({
    appRunning: true,
    daemonRunning: true,
    runningAppPath: "/Applications/Impostor.app",
  });

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: f.candidate },
      { home: f.home, ops: fake.ops },
    ),
    /refusing to signal an unproven process/,
  );

  assert.equal(marker(f.live), "original");
  assert.deepEqual(readRecoveryLedger(f.home).attempts, []);
  assert.equal(fake.actions.some((action) => action.startsWith("signal:")), false);
  assert.equal(fake.actions.some((action) => action.startsWith("quit:")), false);
  assert.equal(fake.actions.some((action) => action.startsWith("launch:")), false);
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

test("a prepared-ledger failure relaunches the stopped healthy app without changing the database", async (t) => {
  const f = fixture(t);
  const fake = operations();

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: f.candidate },
      {
        home: f.home,
        ops: fake.ops,
        beforePreparedLedgerWrite: () => {
          throw new Error("injected prepared-ledger publication failure");
        },
      },
    ),
    /injected prepared-ledger publication failure.*No database files were changed.*healthy/,
  );

  assert.equal(marker(f.live), "original");
  assert.deepEqual(readRecoveryLedger(f.home).attempts, []);
  assert.equal(fake.actions.filter((action) => action.startsWith("quit:")).length, 1);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
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

test("installed-state publication failure rolls back without relying on ledger status", async (t) => {
  const f = fixture(t);
  const fake = operations();

  await assert.rejects(
    runDatabaseRecovery(
      { kind: "restore", candidatePath: f.candidate },
      {
        home: f.home,
        ops: fake.ops,
        beforeInstalledLedgerWrite: () => {
          throw new Error("injected installed-state publication failure");
        },
      },
    ),
    /injected installed-state publication failure/,
  );

  assert.equal(marker(f.live), "original");
  const [attempt] = readRecoveryLedger(f.home).attempts;
  assert.equal(attempt?.status, "rolled_back");
  assert.match(String(attempt?.message), /automatic rollback/);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 0);
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
  assert.ok(
    fake.actions.includes("recovery-acquire-blocked"),
    "the second invocation must wait without touching the app",
  );
  assert.equal(duplicate.recoveryId, applied.recoveryId);
  assert.equal(readRecoveryLedger(f.home).attempts.length, 1);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 1);
  assert.equal(marker(f.live), "candidate");
});

test("a serialized duplicate relaunches once when it had to stop the healthy app", async (t) => {
  const f = fixture(t);
  const fake = operations();
  const originalAppIsRunning = fake.ops.appIsRunning;
  let appChecks = 0;
  let announceApplied!: () => void;
  let finishFirst!: () => void;
  const applied = new Promise<void>((resolve) => {
    announceApplied = resolve;
  });
  const finishGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  fake.ops.appIsRunning = async (appPath: string, bundleId: string) => {
    appChecks += 1;
    if (appChecks === 2) await applied;
    return originalAppIsRunning(appPath, bundleId);
  };
  const request = { kind: "restore", candidatePath: f.candidate } as const;

  const first = runDatabaseRecovery(request, {
    home: f.home,
    ops: fake.ops,
    pruneRollbacks: async () => {
      announceApplied();
      await finishGate;
    },
  });
  const legacyOps = {
    ...fake.ops,
    tryAcquireRecoveryLock: () => ({ release: () => undefined }),
  };
  const second = runDatabaseRecovery(request, { home: f.home, ops: legacyOps });
  const duplicate = await second;
  finishFirst();
  const winner = await first;

  assert.equal(winner.kind, "applied");
  assert.equal(duplicate.kind, "already-applied");
  assert.deepEqual(duplicate.health, { pid: 4242, port: 7317, version: "test" });
  assert.match(duplicate.message, /app was relaunched once and is healthy/);
  assert.equal(fake.actions.filter((action) => action.startsWith("quit:")).length, 2);
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 2);
  assert.equal(readRecoveryLedger(f.home).attempts.length, 1);
  assert.equal(marker(f.live), "candidate");
});

test("relaunch health retries one transient daemon identity mismatch", async (t) => {
  const f = fixture(t);
  const fake = operations({ healthAmbiguousOnce: true });

  const result = await runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    { home: f.home, ops: fake.ops },
  );

  assert.equal(result.kind, "applied");
  assert.equal(fake.actions.filter((action) => action === "identify-ambiguous").length, 1);
  assert.equal(readRecoveryLedger(f.home).attempts[0]?.status, "applied");
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
    {
      home: f.home,
      ops: {
        ...fake.ops,
        tryAcquireRecoveryLock: () => ({ release: () => undefined }),
      },
    },
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

test("explicit rollback is scoped to its recovery id rather than historical content digest", async (t) => {
  const f = fixture(t);
  const originalCandidate = join(f.root, "original.db");
  const latestCandidate = join(f.root, "latest.db");
  database(originalCandidate, "original");
  database(latestCandidate, "latest");
  const fake = operations();

  const first = await runDatabaseRecovery(
    { kind: "restore", candidatePath: f.candidate },
    { home: f.home, ops: fake.ops },
  );
  await runDatabaseRecovery(
    { kind: "restore", candidatePath: originalCandidate },
    { home: f.home, ops: fake.ops },
  );
  await runDatabaseRecovery(
    { kind: "restore", candidatePath: latestCandidate },
    { home: f.home, ops: fake.ops },
  );

  const rollback = await runDatabaseRecovery(
    { kind: "rollback", recoveryId: first.recoveryId },
    { home: f.home, ops: fake.ops },
  );

  assert.equal(rollback.kind, "rolled-back");
  assert.equal(marker(f.live), "original");
  assert.equal(fake.actions.filter((action) => action.startsWith("launch:")).length, 4);
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
  assert.equal(fake.actions.some((action) => action.startsWith("quit:")), false);
  assert.equal(fake.actions.includes("acquire"), false);
});
