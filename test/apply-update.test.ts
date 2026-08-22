import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INSTALL_TIMEOUT_MS,
  parseArgs,
  realApplyOperations,
  RETAINED_FAILURE_DIR_NAME,
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
  options: { installFails?: boolean; launchFails?: boolean; retainFails?: boolean } = {},
) {
  const actions: string[] = [];
  let firstLaunch = true;
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
    },
    install: (node: string, script: string, tag: string) => {
      actions.push(`install:${node}:${script}:${tag}`);
      if (options.installFails) throw new Error("deliberate build failure at /tmp/private");
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
  return { ops, actions, tempDirectory };
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
  assert.ok(f.actions[0]?.startsWith("wait:42"));
  assert.ok(f.actions.some((action) => action.includes("previous-app.bundle")));
  assert.ok(
    f.actions.some(
      (action) =>
        action.startsWith(`install:${process.execPath}:`) &&
        action.endsWith("/scripts/install-app.mjs:v1.2.4"),
    ),
  );
  assert.ok(f.actions.includes("launch:/Applications/Mission Control.app"));
});

test("a deliberate build failure restores both app and receipt before relaunching", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-failure-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));
  const launchIndex = f.actions.indexOf("launch:/Applications/Mission Control.app");
  const appRestoreIndex = f.actions.findIndex((action) => action.includes("rollback-") && action.endsWith("->/Applications/Mission Control.app"));
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

test("the copied helper recognizes an aliased direct-execution path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-apply-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realHelper = join(root, "apply-update.mjs");
  const aliasHelper = join(root, "helper-alias.mjs");
  await writeFile(realHelper, await readFile(join(process.cwd(), "scripts", "apply-update.mjs")));
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
    () => ops.install(process.execPath, wedged, "v1.2.4"),
    /did not finish within .* minutes and was stopped/,
  );
  // Not the message the app-did-not-quit timeout uses; these are different failures.
  assert.throws(() => ops.install(process.execPath, wedged, "v1.2.4"), (error: unknown) => {
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
  // And the bundle that failed is filed rather than deleted.
  assert.ok(
    f.actions.some(
      (action) => action.includes("failed-") && action.endsWith(`->${join(retained, "failed-app.bundle")}`),
    ),
  );
});

test("a successful update clears what the last failed one retained", async (t) => {
  const state = await mkdtemp(join(tmpdir(), "mission-apply-retain-clear-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const f = operations();

  const result = await runApplyUpdate(args(state), f.ops);

  assert.equal(result.ok, true);
  // Retention is one attempt's worth: it cannot accumulate across updates.
  assert.ok(f.actions.includes(`remove:${join(state, RETAINED_FAILURE_DIR_NAME)}`));
  assert.ok(!f.actions.some((action) => action.startsWith(`copy:`) && action.endsWith(RETAINED_FAILURE_DIR_NAME)));
});

test("when there is nowhere durable to retain it, the backup is kept rather than destroyed", async (t) => {
  // The regression this pins: retention used to be best-effort in a way that made a failed copy
  // WORSE than no retention at all. `keepFailedAs` went null, restoreBundle deleted the broken
  // bundle, and the unconditional `finally` then removed the temp directory holding the only
  // backup - so the exact operator whose state directory was too broken to hold a second copy
  // lost the first one too.
  const state = await mkdtemp(join(tmpdir(), "mission-apply-retain-fails-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, "install-receipt.json"), "old receipt");
  const f = operations({ installFails: true, retainFails: true });

  const result = await runApplyUpdate(args(state), f.ops);
  const outcome = JSON.parse(await readFile(join(state, "update-outcome.json"), "utf8"));
  const failedBundle = f.actions
    .find((action) => action.endsWith(`->/Applications/.Mission Control.app.failed-${process.pid}`))
    ?.split("->")[1];

  // The rollback itself still succeeded and the working app still came back.
  assert.equal(result.ok, false);
  assert.equal(outcome.result, "failure");
  assert.ok(
    f.actions.some(
      (action) => action.includes("rollback-") && action.endsWith("->/Applications/Mission Control.app"),
    ),
  );
  assert.ok(f.actions.includes("launch:/Applications/Mission Control.app"));

  // And nothing was thrown away. The temp directory holding previous-app.bundle survives the
  // `finally`, and the broken bundle stays where it is instead of being deleted.
  assert.ok(!f.actions.includes(`remove:${f.tempDirectory}`));
  assert.ok(failedBundle);
  assert.equal(
    f.actions.filter((action) => action === `remove:${failedBundle}`).length,
    1, // the pre-clean at the top of restoreBundle, and no second removal after it
  );
  assert.ok(f.actions.some((action) => action.startsWith("log:durable retention was unavailable")));
});
