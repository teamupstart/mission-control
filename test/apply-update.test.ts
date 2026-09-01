import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireHelperLock,
  HELPER_LOCK_FILE_NAME,
  INSTALL_TIMEOUT_MS,
  installFailureSummary,
  parseArgs,
  processIsAlive,
  realApplyOperations,
  realHelperLockOperations,
  RETAINED_FAILURE_DIR_NAME,
  rollbackIsNeeded,
  runApplyUpdate,
  sanitizeDiagnostic,
} from "../scripts/apply-update.mjs";

function args(stateDirectory: string) {
  return {
    sourceClone: "/tmp/updater-owned-clone",
    targetTag: "v1.2.4",
    appPath: "/Applications/Mission Control.app",
    parentPid: 42,
    stateDirectory,
    logPath: join(stateDirectory, "update.log"),
  };
}

function operations(
  options: {
    installFails?: boolean;
    launchFails?: boolean;
    retainFails?: boolean;
    waitFails?: boolean;
    restoreFails?: boolean;
    /**
     * Bundle versions the rollback decision reads. Both default to null - "unknown" - which
     * restores, because a fixture that does not model `Info.plist` has not established that the
     * app survived and the helper treats an unreadable bundle as one worth restoring.
     */
    installedVersion?: string | null;
    backupVersion?: string | null;
    /** A live helper already holding the lock. */
    lockHeldBy?: number;
  } = {},
) {
  const actions: string[] = [];
  let firstLaunch = true;
  const locks = new Map<string, string>();
  const ops = {
    exists: (path: string) => !path.includes("rollback-") && !path.includes("failed-"),
    remove: (path: string) => actions.push(`remove:${path}`),
    move: (from: string, to: string) => actions.push(`move:${from}->${to}`),
    copy: (from: string, to: string) => {
      // A full or unwritable state directory is the realistic way durable retention fails.
      if (options.retainFails && to.endsWith(RETAINED_FAILURE_DIR_NAME)) {
        throw new Error("ENOSPC: no space left on device");
      }
      actions.push(`copy:${from}->${to}`);
    },
    nowIso: () => "2026-08-19T14:00:00.000Z",
    waitForParent: async (pid: number) => {
      actions.push(`wait:${pid}`);
      if (options.waitFails) throw new Error("the app did not quit before the update timeout");
    },
    install: (node: string, script: string, tag: string, appsDir: string) => {
      actions.push(`install:${node}:${script}:${tag}:${appsDir}`);
      if (options.installFails) throw new Error("deliberate build failure at /tmp/private");
    },
    restoreApp: (backupApp: string, appPath: string, pid: number) => {
      const failed = `${appPath.slice(0, appPath.lastIndexOf("/") + 1)}.Mission Control.app.failed-update`;
      actions.push(`restore:${backupApp}->${appPath}:failed=${failed}:pid=${pid}`);
      if (options.restoreFails) throw new Error("the rollback could not be authorized");
      return failed;
    },
    bundleVersion: (path: string) =>
      path.includes("previous-app.bundle")
        ? (options.backupVersion ?? null)
        : (options.installedVersion ?? null),
    lock: {
      open: (path: string) => {
        if (locks.has(path)) {
          const error: NodeJS.ErrnoException = new Error("EEXIST: file already exists");
          error.code = "EEXIST";
          throw error;
        }
        locks.set(path, "");
        actions.push(`lock-claim:${path}`);
        return 7;
      },
      write: (_fd: number, text: string) => {
        const [path] = [...locks.keys()].slice(-1);
        if (path !== undefined) locks.set(path, text);
      },
      close: () => {},
      read: (path: string) => {
        if (!locks.has(path)) {
          const error: NodeJS.ErrnoException = new Error("ENOENT: no such file");
          error.code = "ENOENT";
          throw error;
        }
        return locks.get(path) ?? "";
      },
      move: (from: string, to: string) => {
        if (!locks.has(from)) {
          const error: NodeJS.ErrnoException = new Error("ENOENT: no such file");
          error.code = "ENOENT";
          throw error;
        }
        locks.set(to, locks.get(from) ?? "");
        locks.delete(from);
      },
      remove: (path: string) => {
        locks.delete(path);
        // Only the lock itself is a release. Clearing a `.stale-` sidecar is reclamation
        // bookkeeping and would otherwise read as a second release in these assertions.
        if (!path.includes(".stale-")) actions.push(`lock-release:${path}`);
      },
      alive: (pid: number) => pid === options.lockHeldBy,
    },
    launch: (path: string) => {
      actions.push(`launch:${path}`);
      if (options.launchFails && firstLaunch) {
        firstLaunch = false;
        throw new Error("launch failed");
      }
    },
    log: (line: string) => actions.push(`log:${line}`),
  };
  // The helper backs up into its own directory, which under test is this repository's
  // `scripts/` - the module it imported apply-update.mjs from.
  const tempDirectory = join(process.cwd(), "scripts");
  return { ops, actions, tempDirectory, locks };
}

test("the helper waits, backs up, installs the exact tag, records success, and relaunches by path", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-success-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations();

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));

  assert.deepEqual(result, { ok: true, message: null });
  assert.equal(outcome.result, "success");
  assert.equal(outcome.targetVersion, "1.2.4");
  // The wait comes before every action that touches the installed app - which is what this
  // pinned, and is not the same as being literally first now that claiming the helper lock and
  // clearing the previous attempt's retained evidence both run ahead of it. Both touch only the
  // state directory.
  const waitIndex = f.actions.indexOf("wait:42");
  assert.ok(waitIndex >= 0);
  const beforeWait = [
    `lock-claim:${join(state, HELPER_LOCK_FILE_NAME)}`,
    `remove:${join(state, RETAINED_FAILURE_DIR_NAME)}`,
  ];
  assert.ok(
    f.actions.slice(0, waitIndex).every((action) => beforeWait.includes(action)),
    `something touched the app before the wait: ${f.actions.slice(0, waitIndex).join(", ")}`,
  );
  assert.ok(f.actions.some((action) => action.includes("previous-app.bundle")));
  assert.ok(
    f.actions.some(
      (action) =>
        action.startsWith(`install:${process.execPath}:`) &&
        action.endsWith("/scripts/install-app.mjs:v1.2.4:/Applications"),
    ),
  );
  assert.ok(f.actions.includes("launch:/Applications/Mission Control.app"));
});

test("the rebuild targets the directory the receipt names, not /Applications by default", async (t) => {
  // The backup, the rollback, and the relaunch all read `appPath` from the receipt, but the
  // rebuild used to be spawned without `--apps-dir` and so always landed in `/Applications`.
  // An install made anywhere else therefore reported success while the app that relaunched
  // was still the old one - the exact shape that makes a verification run lie about itself.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-appsdir-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations();

  const result = await runApplyUpdate(
    { ...args(state), appPath: "/Users/someone/phase4-sandbox/Applications/Mission Control.app" },
    f.ops,
  );

  assert.deepEqual(result, { ok: true, message: null });
  assert.ok(
    f.actions.some((action) =>
      action.endsWith(
        "/scripts/install-app.mjs:v1.2.4:/Users/someone/phase4-sandbox/Applications",
      ),
    ),
    `no install action carried the receipt's apps dir: ${f.actions.join(", ")}`,
  );
  assert.ok(
    f.actions.includes("launch:/Users/someone/phase4-sandbox/Applications/Mission Control.app"),
  );
});

test("a deliberate build failure restores both app and receipt before relaunching", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-failure-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));
  const launchIndex = f.actions.indexOf("launch:/Applications/Mission Control.app");
  const appRestoreIndex = f.actions.findIndex((action) =>
    action.startsWith("restore:") && action.includes("->/Applications/Mission Control.app:"),
  );
  const receiptRestoreIndex = f.actions.findIndex((action) => action.endsWith(`->${join(state, "install-receipt.json")}`));

  assert.equal(result.ok, false);
  assert.equal(outcome.result, "failure");
  assert.doesNotMatch(outcome.message, /\/tmp\/private/);
  assert.ok(appRestoreIndex >= 0 && appRestoreIndex < launchIndex);
  assert.ok(receiptRestoreIndex >= 0 && receiptRestoreIndex < launchIndex);
});

test("a relaunch failure also rolls back and tries the restored app", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-launch-failure-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ launchFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const launches = f.actions.filter((action) => action === "launch:/Applications/Mission Control.app");
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(launches.length, 2);
  assert.equal(outcome.result, "failure");
  assert.match(outcome.message, /launch failed/);
});

test("helper argv is explicit and complete", () => {
  assert.deepEqual(
    parseArgs([
      "--source-clone", "/clone",
      "--target-tag", "v1.2.4",
      "--app-path", "/Applications/Mission Control.app",
      "--parent-pid", "42",
      "--state-dir", "/state",
      "--log-path", "/state/update.log",
    ]),
    {
      args: {
        sourceClone: "/clone",
        targetTag: "v1.2.4",
        appPath: "/Applications/Mission Control.app",
        parentPid: 42,
        stateDirectory: "/state",
        logPath: "/state/update.log",
      },
      problem: null,
    },
  );
  assert.match(String(parseArgs(["--target-tag", "v1.2.4"]).problem), /missing/);
});

test("helper diagnostics redact absolute paths including file URLs", () => {
  const diagnostic = sanitizeDiagnostic(
    "failed at /Users/person/clone and file:///private/tmp/install-app.mjs:13 token=hush",
  );
  assert.doesNotMatch(diagnostic, /\/Users\/person|\/private\/tmp|hush/);
  assert.match(diagnostic, /<path>/);
});

test("a failed install surfaces the decisive child-process tail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-apply-detail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const failing = join(root, "failing.mjs");
  await writeFile(
    failing,
    "process.stderr.write(\"error: unable to unlink old 'src/server/setup/index.ts': Permission denied\\n\"); process.exit(1);\n",
  );
  const logPath = join(root, "update.log");
  const ops = realApplyOperations(logPath, 5_000);

  assert.equal(
    installFailureSummary("heading\n\u001b[31merror: permission denied\u001b[0m\n"),
    "heading | error: permission denied",
  );
  assert.throws(
    () => ops.install(process.execPath, failing, "v1.2.4", "/Applications"),
    /exited 1: error: unable to unlink old 'src\/server\/setup\/index\.ts': Permission denied/,
  );
  assert.match(await readFile(logPath, "utf8"), /unable to unlink old/);
});

test("the copied helper recognizes an aliased direct-execution path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-apply-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realHelper = join(root, "apply-update.mjs");
  const aliasHelper = join(root, "helper-alias.mjs");
  await writeFile(realHelper, await readFile(join(process.cwd(), "scripts", "apply-update.mjs")));
  await writeFile(
    join(root, "app-bundle-swap.mjs"),
    await readFile(join(process.cwd(), "scripts", "app-bundle-swap.mjs")),
  );
  await symlink(realHelper, aliasHelper);

  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [aliasHelper, "--target-tag", "v1.2.4"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing/);
});

test("a hung build is bounded, and says so in its own words", async (t) => {
  // Asserted on realApplyOperations, not the injected seam: the timeout lives inside the real
  // spawnSync call, so a fixture that supplies its own `install` cannot see it at all.
  const root = await mkdtemp(join(tmpdir(), "mission-apply-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wedged = join(root, "wedged.mjs");
  await writeFile(wedged, "setTimeout(() => {}, 60_000);\n");
  const logPath = join(root, "update.log");

  const ops = realApplyOperations(logPath, 300);
  assert.throws(
    () => ops.install(process.execPath, wedged, "v1.2.4", "/Applications"),
    /did not finish within .* minutes and was stopped/,
  );
  // Not the message the app-did-not-quit timeout uses; these are different failures.
  assert.throws(() => ops.install(process.execPath, wedged, "v1.2.4", "/Applications"), (error: unknown) => {
    assert.doesNotMatch(String((error as Error).message), /did not quit/);
    return true;
  });
  assert.equal(INSTALL_TIMEOUT_MS, 45 * 60 * 1000);
});

test("a failed update leaves the previous app and the broken one behind to inspect", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-retain-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const retained = join(state, RETAINED_FAILURE_DIR_NAME);

  assert.equal(result.ok, false);
  // The whole backup directory - previous bundle AND previous receipt - is copied out before
  // the `finally` removes it, so a second rollback by hand is still possible.
  assert.ok(f.actions.includes(`copy:${f.tempDirectory}->${retained}`));
  const retainIndex = f.actions.indexOf(`copy:${f.tempDirectory}->${retained}`);
  const removeIndex = f.actions.lastIndexOf(`remove:${f.tempDirectory}`);
  assert.ok(retainIndex >= 0 && retainIndex < removeIndex);
  // The failed bundle is retained at the fixed privileged sibling path. The next bundle
  // transaction replaces that one path, so failures cannot accumulate hidden app copies.
  assert.ok(
    f.actions.some((action) =>
      action.includes("failed=/Applications/.Mission Control.app.failed-update"),
    ),
  );
});

test("a failure before there is any backup still clears the last attempt's evidence", async (t) => {
  // `fail()` only retains when `backupReady` is true, so a failure that happens BEFORE the
  // backup exists - the app never quitting, or the app being gone already - retains nothing.
  // If clearing lived beside the outcomes, an older attempt's evidence would survive underneath
  // it and the documented one-attempt lifetime would be false for exactly these cases.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-early-failure-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations({ waitFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));
  const clearIndex = f.actions.indexOf(`remove:${join(state, RETAINED_FAILURE_DIR_NAME)}`);

  assert.equal(result.ok, false);
  assert.equal(outcome.result, "failure");
  // Cleared, and cleared BEFORE the operation that failed - not after it, which never runs.
  assert.ok(clearIndex >= 0);
  assert.ok(clearIndex < f.actions.indexOf("wait:42"));
  // Nothing was backed up, so nothing is retained in its place and nothing was rolled back.
  assert.ok(!f.actions.some((action) => action.endsWith(`->${join(state, RETAINED_FAILURE_DIR_NAME)}`)));
  assert.ok(!f.actions.some((action) => action.startsWith("restore:")));
});

test("a successful update clears what the last failed one retained", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-retain-clear-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations();

  const result = await runApplyUpdate(args(state), f.ops);

  assert.equal(result.ok, true);
  // Retention is one attempt's worth: it cannot accumulate across updates. Cleared as the
  // attempt starts, so this holds however the attempt ends.
  const clearIndex = f.actions.indexOf(`remove:${join(state, RETAINED_FAILURE_DIR_NAME)}`);
  assert.ok(clearIndex >= 0 && clearIndex < f.actions.indexOf("wait:42"));
  assert.ok(!f.actions.some((action) => action.startsWith(`copy:`) && action.endsWith(RETAINED_FAILURE_DIR_NAME)));
});

test("when there is nowhere durable to retain it, the backup is kept rather than destroyed", async (t) => {
  // The regression this pins: retention used to be best-effort in a way that made a failed copy
  // WORSE than no retention at all. The rollback deleted the broken bundle, and the
  // unconditional `finally` then removed the temp directory holding the only
  // backup - so the exact operator whose state directory was too broken to hold a second copy
  // lost the first one too.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-retain-fails-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true, retainFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));
  const restore = f.actions.find((action) => action.startsWith("restore:"));

  // The rollback itself still succeeded and the working app still came back.
  assert.equal(result.ok, false);
  assert.equal(outcome.result, "failure");
  assert.ok(
    restore?.includes("->/Applications/Mission Control.app:") ?? false,
  );
  assert.ok(f.actions.includes("launch:/Applications/Mission Control.app"));

  // And nothing was thrown away. The temp directory holding previous-app.bundle survives the
  // `finally`, and the broken bundle stays where it is instead of being deleted.
  assert.ok(!f.actions.includes(`remove:${f.tempDirectory}`));
  assert.ok(restore?.includes("failed=/Applications/.Mission Control.app.failed-update"));
  assert.ok(f.actions.some((action) => action.startsWith("log:durable retention was unavailable")));
});

test("a second helper refuses to run while the first still holds the lock", async (t) => {
  // The cascade this closes. `UpdateController.applyPromise` only ever guarded one app PROCESS,
  // and the helper outlives that process by design: it waits for the app to quit, works, and
  // relaunches it. The relaunched app reads the outcome, offers Retry, and a second helper
  // starts against the same updater-owned clone. The failing update log records both halves of
  // the collision - `npm error ENOTEMPTY: directory not empty, rmdir` from two `npm ci` runs in
  // one clone, and four administrator panels inside a minute, of which one person could answer
  // at most one.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-lock-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations({ lockHeldBy: 9182 });
  f.locks.set(join(state, HELPER_LOCK_FILE_NAME), "9182\n");

  const result = await runApplyUpdate(args(state), f.ops);

  assert.equal(result.ok, false);
  assert.match(String(result.message), /another update is already in progress \(helper 9182\)/);
  // Nothing that belongs to the running helper was touched: no build, no backup, no relaunch,
  // and above all no outcome. A second helper writing its own `in-progress` over the first
  // helper's finished outcome is what turned a reported failure back into "the previous update
  // did not finish".
  assert.ok(!f.actions.some((action) => action.startsWith("install:")));
  assert.ok(!f.actions.some((action) => action.startsWith("wait:")));
  assert.ok(!f.actions.some((action) => action.startsWith("launch:")));
  assert.ok(!f.actions.some((action) => action.startsWith("lock-release:")));
  await assert.rejects(() => readFile(join(state, "update-outcome.json"), "utf8"));
});

test("a lock left by a killed helper is reclaimed rather than waited out", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-lock-stale-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  // No `lockHeldBy`, so the recorded pid is not alive: the helper was killed mid-update.
  const f = operations();
  f.locks.set(join(state, HELPER_LOCK_FILE_NAME), "9182\n");

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(outcome.result, "success");
  assert.ok(f.actions.includes(`lock-claim:${join(state, HELPER_LOCK_FILE_NAME)}`));
});

test("the lock is released on the way out so the next attempt can start at once", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-lock-release-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations({ installFails: true });

  await runApplyUpdate(args(state), f.ops);

  const lockPath = join(state, HELPER_LOCK_FILE_NAME);
  assert.ok(f.actions.includes(`lock-release:${lockPath}`));
  // Released before the relaunch, so the app that comes back can retry immediately.
  assert.ok(
    f.actions.indexOf(`lock-release:${lockPath}`) >
      f.actions.indexOf("launch:/Applications/Mission Control.app"),
    "the release happens in the finally, after the relaunch is issued",
  );
  assert.equal(f.locks.size, 0);
});

test("an install that never reached the app is not rolled back", async (t) => {
  // A cancelled or refused authorization fails the install without touching the app. Restoring
  // over it buys nothing and costs a second administrator panel - and that second panel is how
  // the person ended up authorizing an undo while the upgrade they asked for stayed unapplied.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-no-rollback-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true, installedVersion: "1.3.3", backupVersion: "1.3.3" });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(outcome.result, "failure");
  assert.ok(!f.actions.some((action) => action.startsWith("restore:")), "no rollback was run");
  assert.ok(f.actions.some((action) => action.includes("no rollback was needed")));
  // The failure is still reported and the working app still comes back.
  assert.ok(f.actions.includes("launch:/Applications/Mission Control.app"));
});

test("an install that did replace the app is rolled back", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-rollback-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true, installedVersion: "1.2.4", backupVersion: "1.3.3" });

  const result = await runApplyUpdate(args(state), f.ops);

  assert.equal(result.ok, false);
  assert.ok(f.actions.some((action) => action.startsWith("restore:")), "the rollback ran");
});

test("a bundle whose version cannot be read is rolled back", () => {
  // Unknown restores. A bundle whose identity cannot be established is the one worth restoring,
  // so a missing app, an unreadable plist, and a plist with no version all roll back.
  assert.equal(rollbackIsNeeded({ installedVersion: null, backupVersion: "1.3.3" }), true);
  assert.equal(rollbackIsNeeded({ installedVersion: "1.3.3", backupVersion: null }), true);
  assert.equal(rollbackIsNeeded({ installedVersion: null, backupVersion: null }), true);
  assert.equal(rollbackIsNeeded({ installedVersion: "1.3.3", backupVersion: "1.3.3" }), false);
  assert.equal(rollbackIsNeeded({ installedVersion: "1.3.4", backupVersion: "1.3.3" }), true);
});

test("a live process is distinguished from a departed one without guessing", () => {
  assert.equal(processIsAlive(process.pid), true);
  const esrch: NodeJS.ErrnoException = new Error("no such process");
  esrch.code = "ESRCH";
  assert.equal(processIsAlive(4242, () => { throw esrch; }), false);
  // EPERM means alive and owned by somebody else, which is still alive. Anything unexpected
  // reads as alive too: deferring one update is cheaper than stealing a live helper's lock.
  const eperm: NodeJS.ErrnoException = new Error("operation not permitted");
  eperm.code = "EPERM";
  assert.equal(processIsAlive(4242, () => { throw eperm; }), true);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(-1), false);
});

function lockOps(store: Map<string, string>, live: number[], hooks: {
  onMove?: (from: string, to: string) => void;
} = {}) {
  const enoent = () => {
    const error: NodeJS.ErrnoException = new Error("ENOENT: no such file");
    error.code = "ENOENT";
    return error;
  };
  return {
    open: (path: string) => {
      if (store.has(path)) {
        const error: NodeJS.ErrnoException = new Error("EEXIST: file already exists");
        error.code = "EEXIST";
        throw error;
      }
      store.set(path, "");
      return 1;
    },
    write: (_fd: number, text: string) => {
      // The claim writes immediately after its exclusive create, so the newest key is its file.
      const created = [...store.keys()].at(-1);
      if (created !== undefined) store.set(created, text);
    },
    close: () => {},
    read: (path: string) => {
      if (!store.has(path)) throw enoent();
      return store.get(path) ?? "";
    },
    move: (from: string, to: string) => {
      hooks.onMove?.(from, to);
      if (!store.has(from)) throw enoent();
      store.set(to, store.get(from) ?? "");
      store.delete(from);
    },
    remove: (path: string) => void store.delete(path),
    alive: (pid: number) => live.includes(pid),
  };
}

test("two helpers that both see the same dead lock cannot both claim it", () => {
  // The exact interleaving GitHub Inspector reported. Reclamation used to DELETE the lock it had
  // decided was stale, so helper B's delete removed helper A's freshly created lock and B claimed
  // it too - reinstating the collision the lock exists to prevent, now with a lock file to make
  // it look handled. Reclamation now takes the file with an atomic move and proves that what it
  // took is the file it decided about.
  const DEAD = 9182;
  const HELPER_A = 5150;
  const path = "/state/update-helper.lock";
  const store = new Map<string, string>([[path, `${DEAD}\n`]]);

  // B has already read DEAD and judged it stale. A claims the lock inside B's window - modelled
  // by landing A's claim exactly when B reaches its move, which is the decisive instant.
  const ops = lockOps(store, [HELPER_A], {
    onMove: (from) => {
      if (from === path && store.get(from) === `${DEAD}\n`) store.set(path, `${HELPER_A}\n`);
    },
  });

  const b = acquireHelperLock(path, ops);

  assert.equal(b.ok, false, "helper B must not claim a lock helper A already holds");
  assert.equal(b.heldBy, HELPER_A, "and it reports who actually holds it");
  // A's lock is intact and still A's. B put back what it should not have taken.
  assert.equal(store.get(path), `${HELPER_A}\n`);
  assert.deepEqual(
    [...store.keys()].filter((key) => key.includes(".stale-")),
    [],
    "no sidecar was left behind",
  );
});

test("the loser of a stale-lock race is told no rather than given a turn", () => {
  // Both contenders see the same dead pid and both reach reclamation. The move is the atomic
  // step, so exactly one can take the file; the other gets ENOENT and stands down.
  const DEAD = 9182;
  const path = "/state/update-helper.lock";
  const store = new Map<string, string>([[path, `${DEAD}\n`]]);
  const ops = lockOps(store, []);

  const first = acquireHelperLock(path, ops);
  assert.equal(first.ok, true, "the first contender reclaims the dead lock");
  assert.equal(store.get(path), `${process.pid}\n`);

  // A second contender now finds a live holder on the fast path and never reaches reclamation.
  const live = lockOps(store, [process.pid]);
  const second = acquireHelperLock(path, live);
  assert.equal(second.ok, false);
  assert.equal(second.heldBy, process.pid);
});

test("a contender that loses the move stands down instead of claiming", () => {
  // The other side of the race: another helper took the stale lock first, so the file is simply
  // gone when this contender reaches for it. A lost move is a refusal - never a fall-through to
  // a claim, which is what would put two helpers back in the same clone.
  const DEAD = 9182;
  const path = "/state/update-helper.lock";
  const store = new Map<string, string>([[path, `${DEAD}\n`]]);
  const ops = lockOps(store, [], {
    // The winner has moved it aside and has not created its own lock yet, which is exactly the
    // instant a real `rename` reports ENOENT.
    onMove: (from) => void (from === path && store.delete(path)),
  });
  let opens = 0;
  const counted = { ...ops, open: (p: string) => { opens += 1; return ops.open(p); } };

  const result = acquireHelperLock(path, counted);

  assert.equal(result.ok, false);
  assert.equal(result.heldBy, null, "there is no identified holder mid-handover");
  // One open only: the opening EEXIST probe. Losing the move must not lead to a second attempt,
  // which would create a lock beside the winner's and put two helpers in the same clone.
  assert.equal(opens, 1);
  assert.equal(store.has(path), false, "the winner's handover was left alone");
});

test("an empty or unreadable lock file is reclaimable rather than permanently blocking", () => {
  // A helper killed between the exclusive create and the write leaves a lock naming nobody.
  // Treating that as a live holder would block every future update.
  const path = "/state/update-helper.lock";
  const store = new Map<string, string>([[path, ""]]);
  const result = acquireHelperLock(path, lockOps(store, []));
  assert.equal(result.ok, true);
  assert.equal(store.get(path), `${process.pid}\n`);
});

test("the real lock ops claim exclusively, reclaim a dead pid, and create the state dir", async (t) => {
  // The lock tests above inject their ops, so none of them can notice the real implementation
  // losing its exclusivity: `openSync(path, "w")` in place of `"wx"` would satisfy every one of
  // them and still let two helpers run. Real files, real flags.
  const root = await mkdtemp(join(tmpdir(), "mission-apply-real-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = realHelperLockOperations();
  // A state directory that does not exist yet. The claim now runs before the first outcome is
  // written, and writing that outcome used to be what created the directory.
  const lockPath = join(root, "not-created-yet", HELPER_LOCK_FILE_NAME);

  assert.deepEqual(acquireHelperLock(lockPath, ops), { ok: true, heldBy: null });
  assert.equal((await readFile(lockPath, "utf8")).trim(), String(process.pid));

  // This process is alive, so a second claim is refused rather than granted.
  const second = acquireHelperLock(lockPath, ops);
  assert.equal(second.ok, false);
  assert.equal(second.heldBy, process.pid);

  // A helper killed mid-update is reclaimed by pid, with no timeout to wait out.
  let departed = 4_194_304;
  while (processIsAlive(departed)) departed -= 1;
  await writeFile(lockPath, String(departed));
  assert.deepEqual(acquireHelperLock(lockPath, ops), { ok: true, heldBy: null });
  assert.equal((await readFile(lockPath, "utf8")).trim(), String(process.pid));

  ops.remove(lockPath);
  assert.deepEqual(acquireHelperLock(lockPath, ops), { ok: true, heldBy: null });
});
