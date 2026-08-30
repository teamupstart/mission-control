#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readReceipt } from "../src/shared/install-receipt.mjs";
import { stateDir } from "../src/shared/harness-runtime.mjs";

export const APP_BUNDLE_ID = "com.mission-control.app";
export const DATABASE_FILE = "harness.db";
export const RECOVERY_DIRECTORY = "database-recovery";
export const RECOVERY_LEDGER = "ledger.json";
export const STOP_TIMEOUT_MS = 15_000;
export const HEALTH_TIMEOUT_MS = 20_000;
export const MAX_RECOVERY_ATTEMPTS = 100;
export const MAX_ROLLBACK_DIRECTORIES = 5;
export const LEDGER_LOCK_TIMEOUT_MS = 15_000;
export const RECOVERY_LOCK_TIMEOUT_MS = 60_000;

const SIDECAR_SUFFIXES = ["", "-wal", "-shm"];
const RECOVERY_LEDGER_LOCK = "ledger.lock";
const RECOVERY_OPERATION_LOCK = "recovery.lock";

const usage = `Usage:
  npm run recover:database -- /absolute/path/to/harness.db
  npm run recover:database -- --rollback <recovery-id>

The command validates a staged copy before stopping Mission Control. Set MISSION_HOME only
when recovering a non-default state home.`;

export function parseArgs(argv) {
  if (argv.length === 1 && argv[0] !== "--help" && argv[0] !== "-h") {
    return { args: { kind: "restore", candidatePath: argv[0] }, problem: null };
  }
  if (argv.length === 2 && argv[0] === "--rollback" && argv[1]) {
    return { args: { kind: "rollback", recoveryId: argv[1] }, problem: null };
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { args: null, problem: usage };
  }
  return { args: null, problem: `invalid recovery arguments\n\n${usage}` };
}

function recoveryRoot(home) {
  return join(home, RECOVERY_DIRECTORY);
}

function ledgerPath(home) {
  return join(recoveryRoot(home), RECOVERY_LEDGER);
}

function emptyLedger() {
  return { schema: 1, attempts: [] };
}

export function readRecoveryLedger(home) {
  const path = ledgerPath(home);
  if (!existsSync(path)) return emptyLedger();
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`recovery ledger is unreadable: ${error?.message ?? error}`);
  }
  if (
    value?.schema !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.some(
      (attempt) =>
        !attempt ||
        typeof attempt !== "object" ||
        typeof attempt.id !== "string" ||
        typeof attempt.digest !== "string" ||
        typeof attempt.status !== "string",
    )
  ) {
    throw new Error("recovery ledger has an unsupported or invalid shape");
  }
  return value;
}

const durableWriteOperations = {
  mkdir: mkdirSync,
  write: writeFileSync,
  open: openSync,
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  remove: rmSync,
};

const durableDatabaseOperations = {
  mkdir: mkdirSync,
  copy: copyFileSync,
  chmod: chmodSync,
  exists: existsSync,
  open: openSync,
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  remove: rmSync,
};

export function durableWriteJson(path, value, operations = durableWriteOperations) {
  const directory = dirname(path);
  operations.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    operations.write(temp, bytes, { mode: 0o600 });
    const fd = operations.open(temp, "r");
    try {
      operations.fsync(fd);
    } finally {
      operations.close(fd);
    }
    operations.rename(temp, path);
    const directoryFd = operations.open(directory, "r");
    try {
      operations.fsync(directoryFd);
    } finally {
      operations.close(directoryFd);
    }
  } catch (error) {
    operations.remove(temp, { force: true });
    throw error;
  }
}

function writeRecoveryLedger(home, ledger) {
  durableWriteJson(ledgerPath(home), ledger);
}

async function updateAttempt(home, ops, id, patch, afterRead = null) {
  return withLedgerLock(home, ops, async () => {
    const ledger = readRecoveryLedger(home);
    const attempt = ledger.attempts.find((entry) => entry.id === id);
    if (!attempt) throw new Error(`recovery attempt ${id} is missing from the ledger`);
    if (afterRead) await afterRead();
    Object.assign(attempt, patch);
    writeRecoveryLedger(home, ledger);
  });
}

function copySqliteSet(fromDatabase, toDatabase) {
  mkdirSync(dirname(toDatabase), { recursive: true, mode: 0o700 });
  for (const suffix of SIDECAR_SUFFIXES) {
    const from = `${fromDatabase}${suffix}`;
    const to = `${toDatabase}${suffix}`;
    if (!existsSync(from)) continue;
    copyFileSync(from, to);
    chmodSync(to, 0o600);
  }
}

function fsyncPath(path, operations) {
  const fd = operations.open(path, "r");
  try {
    operations.fsync(fd);
  } finally {
    operations.close(fd);
  }
}

/** Copy and fsync a SQLite set before any durable metadata can reference the snapshot. */
export function durableCopySqliteSet(
  sourceDatabase,
  targetDatabase,
  operations = durableDatabaseOperations,
) {
  const directory = dirname(targetDatabase);
  operations.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const suffix of SIDECAR_SUFFIXES) {
    const source = `${sourceDatabase}${suffix}`;
    if (!operations.exists(source)) continue;
    const target = `${targetDatabase}${suffix}`;
    operations.copy(source, target);
    operations.chmod(target, 0o600);
    fsyncPath(target, operations);
  }
  fsyncPath(directory, operations);
  fsyncPath(dirname(directory), operations);
}

/** Publish a complete SQLite file set and its directory entry durably while the daemon is stopped. */
export function durableReplaceSqliteSet(
  sourceDatabase,
  liveDatabase,
  databaseMode = 0o600,
  operations = durableDatabaseOperations,
) {
  const directory = dirname(liveDatabase);
  const temp = join(
    directory,
    `.${basename(liveDatabase)}.replacement-${process.pid}-${randomUUID()}`,
  );
  try {
    operations.copy(sourceDatabase, temp);
    operations.chmod(temp, databaseMode);
    fsyncPath(temp, operations);

    for (const suffix of SIDECAR_SUFFIXES.slice(1)) {
      operations.remove(`${liveDatabase}${suffix}`, { force: true });
    }
    operations.rename(temp, liveDatabase);

    for (const suffix of SIDECAR_SUFFIXES.slice(1)) {
      const source = `${sourceDatabase}${suffix}`;
      if (!operations.exists(source)) continue;
      const target = `${liveDatabase}${suffix}`;
      operations.copy(source, target);
      operations.chmod(target, 0o600);
      fsyncPath(target, operations);
    }

    fsyncPath(directory, operations);
  } catch (error) {
    operations.remove(temp, { force: true });
    throw error;
  }
}

function sqliteRows(db, pragma) {
  return db.prepare(pragma).all();
}

/** Stage, fully read, check, and consolidate a candidate without mutating its source files. */
export function prepareCandidate(candidatePath, home) {
  if (!isAbsolute(candidatePath)) throw new Error("candidate database path must be absolute");
  if (!existsSync(candidatePath) || !statSync(candidatePath).isFile()) {
    throw new Error(`candidate database does not exist as a file: ${candidatePath}`);
  }
  const liveDatabase = join(home, DATABASE_FILE);
  if (existsSync(liveDatabase) && realpathSync(candidatePath) === realpathSync(liveDatabase)) {
    throw new Error("candidate database must not be the live Mission Control database");
  }

  const stagingDirectory = join(
    tmpdir(),
    `mission-control-recovery-${process.pid}-${randomUUID()}`,
  );
  const stagedDatabase = join(stagingDirectory, DATABASE_FILE);
  mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  try {
    copySqliteSet(candidatePath, stagedDatabase);
    const db = new DatabaseSync(stagedDatabase);
    try {
      const quickCheck = sqliteRows(db, "PRAGMA quick_check");
      if (
        quickCheck.length !== 1 ||
        !Object.values(quickCheck[0] ?? {}).some((value) => value === "ok")
      ) {
        throw new Error("candidate failed PRAGMA quick_check");
      }
      const foreignKeys = sqliteRows(db, "PRAGMA foreign_key_check");
      if (foreignKeys.length !== 0) {
        throw new Error(`candidate has ${foreignKeys.length} foreign-key violation(s)`);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("PRAGMA journal_mode = DELETE");
    } finally {
      db.close();
    }
    rmSync(`${stagedDatabase}-wal`, { force: true });
    rmSync(`${stagedDatabase}-shm`, { force: true });
    const digest = createHash("sha256").update(readFileSync(stagedDatabase)).digest("hex");
    return {
      digest,
      stagedDatabase,
      stagingDirectory,
      cleanup: () => rmSync(stagingDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readOwner(home) {
  try {
    const value = JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8"));
    if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
    if (!Number.isInteger(value?.port) || value.port <= 0 || value.port > 65_535) return null;
    return { pid: value.pid, port: value.port };
  } catch {
    return null;
  }
}

async function probeHealth(port, timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json();
    if (
      value?.service !== "mission-control" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0
    ) {
      return null;
    }
    return { pid: value.pid, port, version: typeof value.version === "string" ? value.version : "unknown" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A daemon identity is usable only when fresh lock metadata and fresh health agree. */
export async function identifyLiveDaemon(home) {
  const owner = readOwner(home);
  if (!owner) return null;
  const health = await probeHealth(owner.port);
  if (!health) return null;
  if (health.pid !== owner.pid) {
    throw Object.assign(
      new Error(
        `daemon identity is ambiguous: lock PID ${owner.pid} does not match health PID ${health.pid}`,
      ),
      { code: "EDAEMONIDENTITY" },
    );
  }
  return health;
}

export function recoveryStateLockAddonPath(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), "..", "dist", "native", "state-lock.node");
}

function loadStateLockBinding() {
  const require = createRequire(import.meta.url);
  const addon = require(recoveryStateLockAddonPath());
  if (typeof addon?.acquire !== "function" || typeof addon?.release !== "function") {
    throw new Error("native state lock addon does not export acquire and release");
  }
  return addon;
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${basename(bin)} exited ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function verifyProductApp(home) {
  const receipt = readReceipt(join(home, "install-receipt.json"));
  if (!receipt) {
    throw new Error("a valid managed-install receipt is required to recover the product app");
  }
  const appPath = realpathSync(receipt.appPath);
  const info = join(appPath, "Contents", "Info.plist");
  const actual = run("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleIdentifier", info]);
  if (actual !== APP_BUNDLE_ID) {
    throw new Error(`installed app bundle identifier is ${actual || "missing"}, expected ${APP_BUNDLE_ID}`);
  }
  return appPath;
}

const exactProductAppScript = `on run argv
  set requestedAction to item 1 of argv
  set expectedPath to item 2 of argv
  set expectedBundleId to item 3 of argv
  set expectedPathWithSlash to expectedPath
  if expectedPath does not end with "/" then set expectedPathWithSlash to expectedPath & "/"
  tell application "System Events"
    repeat with candidate in application processes
      try
        if (bundle identifier of candidate) is expectedBundleId then
          set candidatePath to POSIX path of (application file of candidate as alias)
          if candidatePath is expectedPath or candidatePath is expectedPathWithSlash then
            if requestedAction is "quit" then tell candidate to quit
            return true
          end if
        end if
      end try
    end repeat
  end tell
  return false
end run`;

function exactProductApp(action, appPath, bundleId) {
  return run("/usr/bin/osascript", ["-e", exactProductAppScript, action, appPath, bundleId])
    .toLowerCase() === "true";
}

function appIsRunning(appPath, bundleId) {
  return exactProductApp("running", appPath, bundleId);
}

function quitProductApp(appPath, bundleId) {
  if (!exactProductApp("quit", appPath, bundleId)) {
    throw new Error("the receipt-verified product app stopped before the quit request");
  }
}

function launchProductApp(appPath) {
  run("/usr/bin/open", [appPath]);
}

export function realRecoveryOperations() {
  const binding = loadStateLockBinding();
  const tryAcquireNativeLock = (path, purpose) => {
    try {
      const handle = binding.acquire(
        path,
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 0,
          startedAt: new Date().toISOString(),
          purpose,
        })}\n`,
      );
      return { release: () => binding.release(handle) };
    } catch (error) {
      if (error?.code === "ELOCKED") return null;
      throw error;
    }
  };
  return {
    verifyApp: verifyProductApp,
    appIsRunning,
    quitApp: quitProductApp,
    identifyDaemon: identifyLiveDaemon,
    signalDaemon: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        // The fresh health response and the signal are still separate syscalls. If the exact
        // process exits in that gap, the stop already succeeded; every other signal error is a
        // refusal because no substitute PID is ever inferred.
        if (error?.code !== "ESRCH") throw error;
      }
    },
    tryAcquireLock: (home) =>
      tryAcquireNativeLock(join(home, "daemon.lock"), "database-recovery"),
    tryAcquireLedgerLock: (home) =>
      tryAcquireNativeLock(
        join(recoveryRoot(home), RECOVERY_LEDGER_LOCK),
        "database-recovery-ledger",
      ),
    tryAcquireRecoveryLock: (home) =>
      tryAcquireNativeLock(
        join(recoveryRoot(home), RECOVERY_OPERATION_LOCK),
        "database-recovery-operation",
      ),
    sleep: delay,
    launchApp: launchProductApp,
    now: () => new Date().toISOString(),
  };
}

async function withLedgerLock(
  home,
  ops,
  mutate,
  timeoutMs = LEDGER_LOCK_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = ops.tryAcquireLedgerLock(home);
    if (lock) {
      try {
        return await mutate();
      } finally {
        lock.release();
      }
    }
    await ops.sleep(25);
  }
  throw new Error("recovery ledger lock was not released before the bounded timeout");
}

async function acquireRecoveryLock(home, ops, timeoutMs = RECOVERY_LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = ops.tryAcquireRecoveryLock(home);
    if (lock) return lock;
    await ops.sleep(25);
  }
  throw new Error("another database recovery did not finish before the bounded timeout");
}

async function stopAndAcquire(home, ops, verifiedAppPath, timeoutMs = STOP_TIMEOUT_MS) {
  // A daemon sharing this state home is not proof that it belongs to the managed product app.
  // Only a concurrently running, receipt-verified app authorizes this flow to signal a daemon.
  const initialDaemon = await ops.identifyDaemon(home);
  let quitRequested = false;
  if (await ops.appIsRunning(verifiedAppPath, APP_BUNDLE_ID)) {
    await ops.quitApp(verifiedAppPath, APP_BUNDLE_ID);
    quitRequested = true;
  } else if (initialDaemon) {
    throw new Error(
      "a live daemon owns this state home but the receipt-verified product app is not running; " +
        "refusing to signal an unproven process",
    );
  }
  const signaled = new Set();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = ops.tryAcquireLock(home);
    if (lock) {
      return {
        release: () => lock.release(),
        quitRequested,
      };
    }
    const daemon = await ops.identifyDaemon(home);
    if (daemon && !quitRequested) {
      throw new Error(
        "a live daemon owns this state home but the receipt-verified product app was not stopped by recovery; " +
          "refusing to signal an unproven process",
      );
    }
    if (daemon && !signaled.has(daemon.pid)) {
      // The identity came from a fresh lock read and a fresh health response immediately
      // above. Never retain it between loop iterations or signal the same numeric PID twice.
      ops.signalDaemon(daemon.pid);
      signaled.add(daemon.pid);
    }
    await ops.sleep(100);
  }
  throw new Error("Mission Control did not release daemon.lock before the bounded stop timeout");
}

function createRollbackSnapshot(home, attemptId) {
  const live = join(home, DATABASE_FILE);
  if (!existsSync(live)) throw new Error(`live database is missing: ${live}`);
  const directory = join(recoveryRoot(home), attemptId, "rollback");
  const target = join(directory, DATABASE_FILE);
  const databaseMode = statSync(live).mode & 0o777;
  durableCopySqliteSet(live, target);
  return { directory, database: target, databaseMode };
}

function installPreparedDatabase(home, stagedDatabase) {
  const live = join(home, DATABASE_FILE);
  const mode = existsSync(live) ? statSync(live).mode & 0o777 : 0o600;
  durableReplaceSqliteSet(stagedDatabase, live, mode);
}

function restoreRollbackSnapshot(home, rollbackDatabase, databaseMode = 0o600) {
  if (!existsSync(rollbackDatabase)) throw new Error("rollback database is missing");
  const live = join(home, DATABASE_FILE);
  durableReplaceSqliteSet(rollbackDatabase, live, databaseMode);
}

async function waitForHealthy(home, ops, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const daemon = await ops.identifyDaemon(home);
      if (daemon) return daemon;
    } catch (error) {
      if (error?.code !== "EDAEMONIDENTITY") throw error;
    }
    await ops.sleep(150);
  }
  return null;
}

async function pruneRollbackDirectories(home, keepId, ops) {
  return withLedgerLock(home, ops, () => {
    const ledger = readRecoveryLedger(home);
    const retained = ledger.attempts
      .filter((attempt) => attempt.rollbackDirectory && existsSync(attempt.rollbackDirectory))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    for (const attempt of retained.slice(MAX_ROLLBACK_DIRECTORIES)) {
      if (attempt.id === keepId) continue;
      rmSync(join(recoveryRoot(home), attempt.id), { recursive: true, force: true });
      attempt.rollbackDirectory = null;
    }
    writeRecoveryLedger(home, ledger);
  });
}

function candidateForRollback(home, recoveryId) {
  const ledger = readRecoveryLedger(home);
  assertRollbackSourceAvailable(ledger, recoveryId);
  const candidatePath = join(recoveryRoot(home), recoveryId, "rollback", DATABASE_FILE);
  if (!existsSync(candidatePath)) throw new Error(`rollback material for ${recoveryId} is no longer retained`);
  return { candidatePath, rollbackOf: recoveryId };
}

function assertRollbackSourceAvailable(ledger, recoveryId) {
  const attempt = ledger.attempts.find((entry) => entry.id === recoveryId);
  if (!attempt) throw new Error(`unknown recovery id: ${recoveryId}`);
  if (attempt.status === "rolled_back") throw new Error(`recovery ${recoveryId} is already rolled back`);
  return attempt;
}

function alreadyAppliedResult(attempt, health = null) {
  const processMessage = health
    ? `the app was relaunched once and is healthy on dynamically discovered PID ${health.pid}, ` +
      `port ${health.port}, version ${health.version}`
    : "the app was not relaunched";
  return {
    ok: true,
    kind: "already-applied",
    message:
      `candidate was already handled by recovery ${attempt.id}; no database files were changed and ` +
      processMessage,
    recoveryId: attempt.id,
    health,
    warnings: [],
  };
}

function appliedAttemptForDigest(ledger, digest) {
  return ledger.attempts.find(
    (attempt) => attempt.digest === digest && attempt.status === "applied",
  );
}

function unfinishedAttemptForDigest(ledger, digest) {
  return ledger.attempts.find(
    (attempt) =>
      attempt.digest === digest && ["prepared", "installed"].includes(attempt.status),
  );
}

/** Bounded, idempotent recovery orchestration. Filesystem effects stay behind the daemon lock. */
export async function runDatabaseRecovery(
  request,
  {
    home = stateDir(),
    ops = null,
    stopTimeoutMs = STOP_TIMEOUT_MS,
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
    installDatabase = installPreparedDatabase,
    pruneRollbacks = null,
    beforePreparedLedgerWrite = null,
    beforeInstalledLedgerWrite = null,
    beforeAppliedLedgerWrite = null,
  } = {},
) {
  if (process.platform !== "darwin" && ops === null) {
    throw new Error("product-app database recovery is supported only on macOS");
  }
  const recoveryOps = ops ?? realRecoveryOperations();
  const prune =
    pruneRollbacks ?? ((targetHome, keepId) =>
      pruneRollbackDirectories(targetHome, keepId, recoveryOps));
  mkdirSync(recoveryRoot(home), { recursive: true, mode: 0o700 });
  const verifiedAppPath = await recoveryOps.verifyApp(home, APP_BUNDLE_ID);

  const rollback = request.kind === "rollback" ? candidateForRollback(home, request.recoveryId) : null;
  const candidatePath = rollback?.candidatePath ?? request.candidatePath;
  const prepared = prepareCandidate(candidatePath, home);
  let recoveryLock = null;
  let lock = null;
  let attempt = null;
  let rollbackSnapshot = null;
  let databaseMayHaveChanged = false;
  let installationStarted = false;
  let appStoppedByRecovery = false;
  let launched = false;
  try {
    // Serialize the complete recovery lifecycle, including the health-confirmation interval in
    // which daemon.lock must be free for the relaunched app. Ledger writes retain their narrower
    // lock because they are also safe against older or external recovery processes.
    recoveryLock = await acquireRecoveryLock(home, recoveryOps);
    const ledger = readRecoveryLedger(home);
    if (rollback) assertRollbackSourceAvailable(ledger, rollback.rollbackOf);
    const duplicate = rollback ? null : appliedAttemptForDigest(ledger, prepared.digest);
    if (duplicate) return alreadyAppliedResult(duplicate);
    if (ledger.attempts.length >= MAX_RECOVERY_ATTEMPTS) {
      throw new Error(
        `recovery ledger reached its ${MAX_RECOVERY_ATTEMPTS}-attempt safety bound and refuses another restore`,
      );
    }

    lock = await stopAndAcquire(home, recoveryOps, verifiedAppPath, stopTimeoutMs);
    appStoppedByRecovery = lock.quitRequested;
    // Candidate preparation and the fast duplicate check intentionally happen before stopping
    // the app. Another recovery can win while this invocation waits for daemon.lock, so reserve
    // the attempt under the separate ledger lock before any database file moves. That lock also
    // serializes post-health writes after daemon.lock has been released for the relaunched app.
    const id = `${recoveryOps.now().replace(/[:.]/g, "-")}-${prepared.digest.slice(0, 12)}`;
    const serializedDuplicate = await withLedgerLock(home, recoveryOps, async () => {
      const currentLedger = readRecoveryLedger(home);
      if (rollback) assertRollbackSourceAvailable(currentLedger, rollback.rollbackOf);
      const duplicateUnderLock = rollback
        ? null
        : appliedAttemptForDigest(currentLedger, prepared.digest);
      if (duplicateUnderLock) return duplicateUnderLock;
      const unfinishedDuplicate = rollback
        ? null
        : unfinishedAttemptForDigest(currentLedger, prepared.digest);
      if (unfinishedDuplicate) {
        throw new Error(
          `recovery ${unfinishedDuplicate.id} for this candidate is unfinished (${unfinishedDuplicate.status}); ` +
            "refusing to apply the same restore concurrently",
        );
      }
      if (currentLedger.attempts.length >= MAX_RECOVERY_ATTEMPTS) {
        throw new Error(
          `recovery ledger reached its ${MAX_RECOVERY_ATTEMPTS}-attempt safety bound and refuses another restore`,
        );
      }

      rollbackSnapshot = createRollbackSnapshot(home, id);
      attempt = {
        id,
        digest: prepared.digest,
        status: "prepared",
        startedAt: recoveryOps.now(),
        finishedAt: null,
        rollbackDirectory: rollbackSnapshot.directory,
        databaseMode: rollbackSnapshot.databaseMode,
        rollbackOf: rollback?.rollbackOf ?? null,
        message: null,
      };
      currentLedger.attempts.push(attempt);
      if (beforePreparedLedgerWrite) await beforePreparedLedgerWrite();
      writeRecoveryLedger(home, currentLedger);
      return null;
    });
    if (serializedDuplicate) {
      const relaunchRequired = lock.quitRequested;
      lock.release();
      lock = null;
      if (!relaunchRequired) return alreadyAppliedResult(serializedDuplicate);

      launched = true;
      appStoppedByRecovery = false;
      recoveryOps.launchApp(verifiedAppPath, APP_BUNDLE_ID);
      const health = await waitForHealthy(home, recoveryOps, healthTimeoutMs);
      if (!health) {
        throw new Error("Mission Control relaunched but its daemon did not become healthy");
      }
      return alreadyAppliedResult(serializedDuplicate, health);
    }

    // Installation can partially change the SQLite set before throwing. Keep an in-memory
    // boundary so rollback does not depend on publishing the subsequent ledger transition.
    installationStarted = true;
    databaseMayHaveChanged = true;
    installDatabase(home, prepared.stagedDatabase);
    await updateAttempt(
      home,
      recoveryOps,
      id,
      { status: "installed" },
      beforeInstalledLedgerWrite,
    );

    lock.release();
    lock = null;
    launched = true;
    appStoppedByRecovery = false;
    recoveryOps.launchApp(verifiedAppPath, APP_BUNDLE_ID);
    const health = await waitForHealthy(home, recoveryOps, healthTimeoutMs);
    if (!health) throw new Error("Mission Control relaunched but its daemon did not become healthy");

    await updateAttempt(
      home,
      recoveryOps,
      id,
      { status: "applied", finishedAt: recoveryOps.now() },
      beforeAppliedLedgerWrite,
    );
    const warnings = [];
    if (rollback?.rollbackOf) {
      try {
        await updateAttempt(home, recoveryOps, rollback.rollbackOf, {
          status: "rolled_back",
          finishedAt: recoveryOps.now(),
          message: `rolled back by recovery ${id}`,
        });
      } catch (error) {
        warnings.push(
          `could not mark recovery ${rollback.rollbackOf} as rolled back: ${error?.message ?? error}`,
        );
      }
    }
    try {
      await prune(home, id);
    } catch (error) {
      warnings.push(`could not prune retained rollback material: ${error?.message ?? error}`);
    }
    const healthyMessage =
      `database recovery ${id} is healthy on dynamically discovered PID ${health.pid}, ` +
      `port ${health.port}, version ${health.version}`;
    return {
      ok: true,
      kind: rollback ? "rolled-back" : "applied",
      message:
        warnings.length === 0
          ? healthyMessage
          : `${healthyMessage}. Warning: ${warnings.join("; ")}`,
      recoveryId: id,
      health,
      warnings,
    };
  } catch (error) {
    if (attempt && databaseMayHaveChanged) {
      try {
        if (lock) {
          // already stopped
        } else {
          lock = await stopAndAcquire(home, recoveryOps, verifiedAppPath, stopTimeoutMs);
        }
        const rollbackDatabase = join(attempt.rollbackDirectory, DATABASE_FILE);
        restoreRollbackSnapshot(home, rollbackDatabase, attempt.databaseMode);
        databaseMayHaveChanged = false;
        await updateAttempt(home, recoveryOps, attempt.id, {
          status: "rolled_back",
          finishedAt: recoveryOps.now(),
          message: `automatic rollback after failure: ${error?.message ?? error}`,
        });
      } catch (rollbackError) {
        try {
          await updateAttempt(home, recoveryOps, attempt.id, {
            status: "rollback_failed",
            finishedAt: recoveryOps.now(),
            message:
              `automatic rollback failed after ${error?.message ?? error}: ` +
              `${rollbackError?.message ?? rollbackError}`,
          });
        } catch (ledgerError) {
          throw new AggregateError(
            [error, rollbackError, ledgerError],
            `database recovery failed, rollback failed, and the ledger could not record that failure; preserved material is at ${attempt.rollbackDirectory}`,
          );
        }
        throw new AggregateError(
          [error, rollbackError],
          `database recovery failed and rollback also failed; preserved material is at ${attempt.rollbackDirectory}`,
        );
      }
    }
    if (!installationStarted && appStoppedByRecovery && !launched) {
      lock?.release();
      lock = null;
      launched = true;
      appStoppedByRecovery = false;
      let health;
      try {
        recoveryOps.launchApp(verifiedAppPath, APP_BUNDLE_ID);
        health = await waitForHealthy(home, recoveryOps, healthTimeoutMs);
        if (!health) {
          throw new Error("Mission Control did not become healthy after the guarded relaunch");
        }
      } catch (relaunchError) {
        throw new AggregateError(
          [error, relaunchError],
          "database recovery failed before installation and Mission Control could not be restored to a healthy running state",
        );
      }
      throw new Error(
        `${error?.message ?? error}. No database files were changed; Mission Control was ` +
          `relaunched exactly once and is healthy on dynamically discovered PID ${health.pid}, ` +
          `port ${health.port}, version ${health.version}`,
      );
    }
    const launchNote = launched ? " The app was launched exactly once and was not launched again after rollback." : "";
    throw new Error(`${error?.message ?? error}.${launchNote}`);
  } finally {
    lock?.release();
    recoveryLock?.release();
    prepared.cleanup();
  }
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.args) {
    console.error(parsed.problem);
    return parsed.problem === usage ? 0 : 1;
  }
  try {
    const result = await runDatabaseRecovery(parsed.args);
    console.log(result.message);
    return 0;
  } catch (error) {
    console.error(`Database recovery failed: ${error?.message ?? error}`);
    return 1;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
