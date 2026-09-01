import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireHelperLock,
  claimEntryName,
  claimIsLive,
  claimPrecedes,
  HELPER_LOCK_DIR_NAME,
  parseClaimEntryName,
  parseStagingEntryName,
  processStartedAt,
  releaseHelperLock,
  stagingEntryName,
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

/**
 * An in-memory claims directory. Keyed by `<directory>/<entry name>`, so the ordering the real
 * implementation reads out of filenames is exactly what these tests exercise.
 */
function claimStore(
  store: Map<string, string>,
  options: {
    pid: number;
    now: () => number;
    live: (pid: number) => boolean;
    startedAt?: (pid: number) => string | null;
    onClaim?: (name: string) => void;
    onRelease?: (name: string) => void;
    onList?: () => void;
  },
) {
  const startedAt = options.startedAt ?? ((pid: number) => `start-${pid}`);
  const key = (directory: string, name: string) => `${directory}/${name}`;
  return {
    pid: options.pid,
    now: options.now,
    startedAt,
    // Delegates to the real predicate rather than reimplementing it. A fixture that decides
    // liveness itself would let the production rule regress to a bare `kill(pid, 0)` with every
    // one of these tests still green - which is exactly what a mutation run caught here.
    isLive: (entry: { pid: number; startedAt?: string | null }) =>
      claimIsLive(entry, { alive: options.live, startedAt }),
    ensureDirectory: () => {},
    list: (directory: string) => {
      options.onList?.();
      const prefix = `${directory}/`;
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
    writeEntry: (directory: string, name: string, body: string) => {
      store.set(key(directory, name), body);
      options.onClaim?.(name);
    },
    readEntry: (directory: string, name: string) => {
      const raw = store.get(key(directory, name));
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as { pid?: number; startedAt?: string | null };
      } catch {
        return null;
      }
    },
    removeEntry: (directory: string, name: string) => {
      if (store.delete(key(directory, name))) options.onRelease?.(name);
    },
  };
}

/** The entry the fixture helper writes, given its fixed pid and clock. */
const FIXTURE_ENTRY = claimEntryName({ createdAtMs: 1_000_000, pid: 4242 });

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
    lock: claimStore(locks, {
      pid: 4242,
      now: () => 1_000_000,
      live: (pid) => pid === options.lockHeldBy,
      onClaim: (name) => actions.push(`lock-claim:${name}`),
      onRelease: (name) => actions.push(`lock-release:${name}`),
    }),
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
    `lock-claim:${FIXTURE_ENTRY}`,
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
  // An earlier claim from a helper that is still running.
  f.locks.set(
    `${join(state, HELPER_LOCK_DIR_NAME)}/${claimEntryName({ createdAtMs: 500, pid: 9182 })}`,
    JSON.stringify({ pid: 9182, startedAt: "start-9182" }),
  );

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
  await assert.rejects(() => readFile(join(state, "update-outcome.json"), "utf8"));

  // The running helper's claim is untouched. The only entry this attempt removed is the one it
  // wrote itself, withdrawn on the way out so it does not look like a contender to the next
  // helper that reads the directory.
  const holder = claimEntryName({ createdAtMs: 500, pid: 9182 });
  assert.ok(f.locks.has(`${join(state, HELPER_LOCK_DIR_NAME)}/${holder}`), "holder's claim kept");
  assert.deepEqual(
    f.actions.filter((action) => action.startsWith("lock-release:")),
    [`lock-release:${FIXTURE_ENTRY}`],
  );
});

test("a lock left by a killed helper is reclaimed rather than waited out", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-lock-stale-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  // No `lockHeldBy`, so the recorded pid is not alive: the helper was killed mid-update.
  const f = operations();
  const abandoned = claimEntryName({ createdAtMs: 500, pid: 9182 });
  f.locks.set(
    `${join(state, HELPER_LOCK_DIR_NAME)}/${abandoned}`,
    JSON.stringify({ pid: 9182, startedAt: "start-9182" }),
  );

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(outcome.result, "success");
  assert.ok(f.actions.includes(`lock-claim:${FIXTURE_ENTRY}`));
  // The abandoned entry is cleared, which is safe because its filename says whose it was.
  assert.equal(f.locks.has(`${join(state, HELPER_LOCK_DIR_NAME)}/${abandoned}`), false);
});

test("the lock is released on the way out so the next attempt can start at once", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-lock-release-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations({ installFails: true });

  await runApplyUpdate(args(state), f.ops);

  assert.ok(f.actions.includes(`lock-release:${FIXTURE_ENTRY}`));
  // The claim is released last, in the `finally`, so it covers every action this helper takes -
  // including the relaunch that `fail()` issues and the temp-directory cleanup after it. The
  // relaunched app can therefore be told an update is still in progress for a moment, which is
  // the intended trade: the next attempt refuses rather than overlapping with this one.
  assert.ok(
    f.actions.indexOf(`lock-release:${FIXTURE_ENTRY}`) >
      f.actions.indexOf("launch:/Applications/Mission Control.app"),
    "the release happens after the relaunch is issued",
  );
  assert.ok(
    f.actions.indexOf(`lock-release:${FIXTURE_ENTRY}`) >
      f.actions.indexOf(`remove:${f.tempDirectory}`),
    "and after the temp directory is cleaned up, so the claim covers all of it",
  );
  assert.equal(f.locks.size, 0, "no claim entry is left behind");
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

function claimDir(
  entries: Record<string, { pid: number; startedAt?: string | null }>,
  live: number[],
  self: { pid: number; now: number; startedAt?: string | null },
  hooks: { onList?: () => void } = {},
) {
  const DIR = "/state/update-helper.lock.d";
  const store = new Map<string, string>(
    Object.entries(entries).map(([name, body]) => [`${DIR}/${name}`, JSON.stringify(body)]),
  );
  const ops = claimStore(store, {
    pid: self.pid,
    now: () => self.now,
    live: (pid) => live.includes(pid),
    startedAt: (pid) => (pid === self.pid ? (self.startedAt ?? `start-${pid}`) : `start-${pid}`),
    onList: hooks.onList,
  });
  const names = () =>
    [...store.keys()].map((k) => k.slice(DIR.length + 1)).sort();
  return { DIR, store, ops, names };
}

test("a live claim by anyone else makes this helper withdraw", () => {
  // The whole decision is a read of the directory. No contender mutates a name another live
  // helper owns, which is the property the two single-shared-file designs could not provide.
  const other = claimEntryName({ createdAtMs: 500, pid: 9182 });
  const c = claimDir({ [other]: { pid: 9182, startedAt: "start-9182" } }, [9182, 4242], {
    pid: 4242,
    now: 1000,
  });

  const result = acquireHelperLock(c.DIR, c.ops);

  assert.equal(result.ok, false);
  assert.equal(result.heldBy, 9182);
  assert.equal(result.entryName, null);
  // Ours was withdrawn; theirs was never touched.
  assert.deepEqual(c.names(), [other]);
});

test("a helper alone in the directory holds the lock", () => {
  const c = claimDir({}, [4242], { pid: 4242, now: 1000 });
  const result = acquireHelperLock(c.DIR, c.ops);

  assert.equal(result.ok, true);
  assert.equal(result.heldBy, null);
  assert.equal(result.entryName, claimEntryName({ createdAtMs: 1000, pid: 4242 }));
  assert.deepEqual(c.names(), [claimEntryName({ createdAtMs: 1000, pid: 4242 })]);
});

test("an earlier timestamp cannot displace a helper that is already holding the lock", () => {
  // The bug an exhaustive pass over this caught in the FIRST version of this directory design,
  // which ranked entries by (createdAtMs, pid) and let the earliest live claim win. A contender
  // arriving later could then take the lock from a helper already running, just by stamping its
  // entry earlier - and a key the arriving process chooses cannot decide who was there first.
  // Hence the rule that needs no ordering at all: hold it only when alone.
  const running = claimEntryName({ createdAtMs: 9000, pid: 9182 });
  const c = claimDir({ [running]: { pid: 9182, startedAt: "start-9182" } }, [9182, 4242], {
    pid: 4242,
    // Earlier than the live holder's entry, which under the old rule would have won.
    now: 1000,
  });

  const result = acquireHelperLock(c.DIR, c.ops);

  assert.equal(result.ok, false, "an earlier stamp must not take a running helper's lock");
  assert.equal(result.heldBy, 9182);
  assert.deepEqual(c.names(), [running], "the running helper's entry is untouched");
});

test("two contenders over one directory never both hold it, on any interleaving", () => {
  // The invariant every earlier design broke. Both schedules that matter are replayed for every
  // combination of timestamps, including a later arrival stamped earlier and an exact tie.
  const DIR = "/state/update-helper.lock.d";
  const mk = (store: Map<string, string>, pid: number, now: number) =>
    claimStore(store, {
      pid,
      now: () => now,
      live: () => true,
      startedAt: (p) => `start-${p}`,
    });

  for (const [aTime, bTime] of [[500, 900], [900, 500], [700, 700]] as const) {
    // Schedule 1 - sequential: A completes, then B arrives. Exactly one holder, and it is A.
    {
      const store = new Map<string, string>();
      const a = acquireHelperLock(DIR, mk(store, 100, aTime));
      const b = acquireHelperLock(DIR, mk(store, 200, bTime));
      assert.equal(a.ok, true, `A should hold with times ${aTime}/${bTime}`);
      assert.equal(b.ok, false, `B must not also hold with times ${aTime}/${bTime}`);
      assert.equal(b.heldBy, 100);
    }

    // Schedule 2 - overlapping: each helper's entry is already present when the other lists, so
    // each sees a live rival. Both stand down. Deferred, never doubled.
    {
      const store = new Map<string, string>();
      store.set(
        `${DIR}/${claimEntryName({ createdAtMs: bTime, pid: 200 })}`,
        JSON.stringify({ pid: 200, startedAt: "start-200" }),
      );
      const a = acquireHelperLock(DIR, mk(store, 100, aTime));
      assert.equal(a.ok, false, `overlapping A must stand down with times ${aTime}/${bTime}`);
      // A withdrew its own entry, so only B's remains for B to find itself alone with.
      assert.deepEqual(
        [...store.keys()],
        [`${DIR}/${claimEntryName({ createdAtMs: bTime, pid: 200 })}`],
      );
    }
  }
});

test("a claim whose writer is gone is cleared, and the clearing helper proceeds", () => {
  const abandoned = claimEntryName({ createdAtMs: 500, pid: 9182 });
  // 9182 is not in `live`: the helper was killed mid-update.
  const c = claimDir({ [abandoned]: { pid: 9182, startedAt: "start-9182" } }, [4242], {
    pid: 4242,
    now: 1000,
  });

  const result = acquireHelperLock(c.DIR, c.ops);

  assert.equal(result.ok, true);
  assert.deepEqual(c.names(), [claimEntryName({ createdAtMs: 1000, pid: 4242 })]);
});

test("a reused pid does not keep a dead helper's claim alive", () => {
  // GitHub Inspector's second finding. A helper killed while holding the lock leaves its pid
  // behind; macOS is free to hand that number to something unrelated and long-lived, after which
  // `kill(pid, 0)` answers "alive" forever and every future update reports one already in
  // progress with no updater anywhere near the clone. The recorded start time is what tells the
  // two apart.
  const abandoned = claimEntryName({ createdAtMs: 500, pid: 9182 });
  const store = new Map<string, string>([
    [
      `/state/update-helper.lock.d/${abandoned}`,
      JSON.stringify({ pid: 9182, startedAt: "Mon Sep  1 07:00:00 2026" }),
    ],
  ]);
  const ops = claimStore(store, {
    pid: 4242,
    now: () => 1000,
    // The pid answers to a signal - but it is a different process now.
    live: () => true,
    startedAt: (pid) =>
      pid === 9182 ? "Mon Sep  1 09:30:00 2026" : `start-${pid}`,
  });

  const result = acquireHelperLock("/state/update-helper.lock.d", ops);

  assert.equal(result.ok, true, "a reused pid must not block updates forever");
  assert.equal(
    store.has(`/state/update-helper.lock.d/${abandoned}`),
    false,
    "the dead helper's claim was cleared",
  );
});

test("a staging file left by a killed helper is swept, and a live helper's is not", () => {
  // A helper killed between writing its staging file and renaming it into place leaves that file
  // behind. It can never be mistaken for a claim - the name cannot match the claim pattern - but
  // without a sweep it would sit in the state directory forever, one per killed helper.
  const deadStaging = stagingEntryName(9182, 500);
  const liveStaging = stagingEntryName(7788, 600);
  const c = claimDir({}, [7788, 4242], { pid: 4242, now: 1000 });
  c.store.set(`${c.DIR}/${deadStaging}`, "half-written");
  c.store.set(`${c.DIR}/${liveStaging}`, "half-written");

  const result = acquireHelperLock(c.DIR, c.ops);

  assert.equal(result.ok, true, "staging files are not claims and do not block");
  assert.deepEqual(c.names().sort(), [
    claimEntryName({ createdAtMs: 1000, pid: 4242 }),
    liveStaging,
  ].sort());
  // 7788 is still running, so its rename is still coming and its staging file is left alone.
  assert.ok(c.names().includes(liveStaging));
  assert.ok(!c.names().includes(deadStaging));
});

test("a staging file whose pid was reused is still swept", () => {
  // The same reuse trap as claims, one level down. Sweeping on the pid alone meant a staging file
  // whose number macOS had since handed to an unrelated long-lived process was retained forever.
  // A staging file holds the entry body, so the recorded start time is right there to compare.
  const stale = stagingEntryName(9182, 500);
  const store = new Map<string, string>([
    [
      `/state/update-helper.lock.d/${stale}`,
      JSON.stringify({ pid: 9182, startedAt: "Mon Sep  1 07:00:00 2026" }),
    ],
  ]);
  const ops = claimStore(store, {
    pid: 4242,
    now: () => 1000,
    // The pid answers a signal, but it is a different process now.
    live: () => true,
    startedAt: (pid) => (pid === 9182 ? "Mon Sep  1 09:30:00 2026" : `start-${pid}`),
  });

  const result = acquireHelperLock("/state/update-helper.lock.d", ops);

  assert.equal(result.ok, true);
  assert.equal(
    store.has(`/state/update-helper.lock.d/${stale}`),
    false,
    "a reused pid must not keep a staging file alive forever",
  );
});

test("an unreadable staging file is retained while its pid still answers", () => {
  // Conservative direction: without a readable identity there is no proof of reuse, so a staging
  // file whose pid answers is left alone rather than deleted out from under a pending rename.
  const halfWritten = stagingEntryName(7788, 600);
  const store = new Map<string, string>([
    [`/state/update-helper.lock.d/${halfWritten}`, "{ truncated"],
  ]);
  const ops = claimStore(store, {
    pid: 4242,
    now: () => 1000,
    live: (pid) => pid === 7788,
  });

  assert.equal(acquireHelperLock("/state/update-helper.lock.d", ops).ok, true);
  assert.ok(store.has(`/state/update-helper.lock.d/${halfWritten}`));
});

test("a staging name is never read as a claim, and vice versa", () => {
  const staging = stagingEntryName(4242, 1_756_720_000_000);
  assert.equal(parseClaimEntryName(staging), null);
  assert.deepEqual(parseStagingEntryName(staging), { pid: 4242, name: staging });
  const claim = claimEntryName({ createdAtMs: 1_756_720_000_000, pid: 4242 });
  assert.equal(parseStagingEntryName(claim), null);
  assert.ok(parseClaimEntryName(claim));
  // Neither pattern claims an unrelated file.
  assert.equal(parseStagingEntryName("README"), null);
  assert.equal(parseClaimEntryName("README"), null);
});

test("liveness is conservative when a process cannot be identified", () => {
  // Anything short of proof that the writer is gone counts as live: a wrongly-kept claim defers
  // one update, a wrongly-removed one puts two helpers in one clone.
  const live = { alive: () => true, startedAt: () => "same" };
  assert.equal(claimIsLive({ pid: 10, startedAt: "same" }, live), true);
  assert.equal(claimIsLive({ pid: 10, startedAt: "different" }, live), false);
  // No recorded start time (an older entry), or none readable now: cannot prove reuse, so live.
  assert.equal(claimIsLive({ pid: 10, startedAt: null }, live), true);
  assert.equal(
    claimIsLive({ pid: 10, startedAt: "same" }, { alive: () => true, startedAt: () => null }),
    true,
  );
  // Only a dead pid is proof.
  assert.equal(
    claimIsLive({ pid: 10, startedAt: "same" }, { alive: () => false, startedAt: () => "same" }),
    false,
  );
});

test("a failed directory read withdraws this helper's entry instead of leaving it behind", () => {
  // An entry left behind by a helper that never went on to hold the lock would make it look like
  // a live contender to everyone reading the directory next.
  const c = claimDir({}, [4242], { pid: 4242, now: 1000 }, {
    onList: () => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    },
  });

  assert.throws(() => acquireHelperLock(c.DIR, c.ops), /EIO/);
  assert.deepEqual(c.names(), []);
});

test("claim entry names round-trip and sort by time then pid", () => {
  const name = claimEntryName({ createdAtMs: 1_756_720_000_000, pid: 4242 });
  assert.deepEqual(parseClaimEntryName(name), {
    createdAtMs: 1_756_720_000_000,
    pid: 4242,
    name,
  });
  // Fixed width, so a lexical directory listing and the numeric order agree.
  assert.equal(name.split("-")[0]!.length, 15);
  assert.equal(parseClaimEntryName("not-a-claim"), null);
  assert.equal(parseClaimEntryName(".tmp-4242-1756720000000"), null);

  assert.equal(claimPrecedes({ createdAtMs: 1, pid: 9 }, { createdAtMs: 2, pid: 1 }), true);
  assert.equal(claimPrecedes({ createdAtMs: 2, pid: 1 }, { createdAtMs: 1, pid: 9 }), false);
  // Same millisecond: pid settles it, so both contenders reach the same answer.
  assert.equal(claimPrecedes({ createdAtMs: 1, pid: 1 }, { createdAtMs: 1, pid: 2 }), true);
  assert.equal(claimPrecedes({ createdAtMs: 1, pid: 2 }, { createdAtMs: 1, pid: 1 }), false);
});

test("a process start time is read for a real pid and refused for an impossible one", () => {
  assert.equal(processStartedAt(0), null);
  assert.equal(processStartedAt(-1), null);
  assert.equal(processStartedAt(4242, () => "  Mon Sep  1 07:00:00 2026  "), "Mon Sep  1 07:00:00 2026");
  assert.equal(processStartedAt(4242, () => ""), null);
  assert.equal(processStartedAt(4242, () => { throw new Error("no such process"); }), null);
  // This process exists, so the real query must produce something for it.
  assert.ok((processStartedAt(process.pid) ?? "").length > 0);
});

test("the real lock ops claim, refuse, and reclaim against a real directory", async (t) => {
  // The tests above inject their ops, so none of them exercises the real filesystem
  // implementation - a `writeEntry` that is not atomic, or a `list` that misses entries, would
  // satisfy every one of them. Real directories, real files, real `ps`.
  const root = await mkdtemp(join(tmpdir(), "mission-apply-real-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ops = realHelperLockOperations();
  // A state directory that does not exist yet. The claim runs before the first outcome is
  // written, and writing that outcome used to be what created the directory.
  const directory = join(root, "not-created-yet", HELPER_LOCK_DIR_NAME);

  const first = acquireHelperLock(directory, ops);
  assert.equal(first.ok, true);
  assert.equal(first.heldBy, null);
  assert.ok(first.entryName);
  // The entry records this process's identity, start time included.
  const body = JSON.parse(await readFile(join(directory, first.entryName!), "utf8"));
  assert.equal(body.pid, process.pid);
  assert.equal(body.startedAt, processStartedAt(process.pid));

  // This process is alive, so a second claim is refused rather than granted, and the refusal
  // leaves only the original entry behind.
  const second = acquireHelperLock(directory, ops);
  assert.equal(second.ok, false);
  assert.equal(second.heldBy, process.pid);
  assert.equal(second.entryName, null);
  assert.deepEqual(await readdir(directory), [first.entryName]);

  // A helper killed mid-update leaves an entry naming a process that no longer exists. Reclaimed
  // with no timeout to wait out.
  releaseHelperLock(directory, first.entryName!, ops);
  let departed = 4_194_304;
  while (processIsAlive(departed)) departed -= 1;
  const abandoned = claimEntryName({ createdAtMs: 1, pid: departed });
  await writeFile(
    join(directory, abandoned),
    JSON.stringify({ pid: departed, startedAt: "Mon Sep  1 07:00:00 2026" }),
  );

  const third = acquireHelperLock(directory, ops);
  assert.equal(third.ok, true, "an abandoned entry does not block a new helper");
  assert.deepEqual(await readdir(directory), [third.entryName]);

  releaseHelperLock(directory, third.entryName!, ops);
  assert.deepEqual(await readdir(directory), []);
});
