import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs, runApplyUpdate } from "../scripts/apply-update.mjs";

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

function operations(options: { installFails?: boolean; launchFails?: boolean } = {}) {
  const actions: string[] = [];
  let firstLaunch = true;
  const ops = {
    exists: (path: string) => !path.includes("rollback-") && !path.includes("failed-"),
    remove: (path: string) => actions.push(`remove:${path}`),
    move: (from: string, to: string) => actions.push(`move:${from}->${to}`),
    copy: (from: string, to: string) => actions.push(`copy:${from}->${to}`),
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
  return { ops, actions };
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
