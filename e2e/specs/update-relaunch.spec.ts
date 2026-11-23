import {prepareStagedInstall} from "../../scripts/install-staged-app.mjs";
import {prepareInPlaceInstall, runMigration} from "../../scripts/install-migration.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runApplyUpdate, realHelperLockOperations, type ApplyOperations } from "../../scripts/apply-update.mjs";
import { acquireHelperLock, releaseHelperLock, HELPER_LOCK_DIR_NAME } from "../../scripts/update-lock.mjs";
import { assertSafeAppLaunch, waitForBundleExit, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
import { processFingerprint } from "../../scripts/update-process-owners.mjs";
import { readUpdateOutcome, updateOutcomePath, writeUpdateOutcome } from "../../src/main/update-outcome.ts";
import { updateOutcomeHost } from "../fixtures/update-relaunch.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

const job = "com.mission-control.recovery-20260918";
const bundle = "/fixture/Mission Control.app";

for (const result of ["success", "failure"] as const) {
  test(`a late helper ${result} reaches the running dashboard after its lock is released`, async ({dashboard, daemon}) => {
    const path = updateOutcomePath(daemon.home);
    const lockPath = join(daemon.home, HELPER_LOCK_DIR_NAME);
    const ops = realHelperLockOperations();
    const lock = acquireHelperLock(lockPath, ops);
    expect(lock.ok).toBe(true);
    writeUpdateOutcome(path, {result: "in-progress", targetVersion: "alpha e00afcc", recordedAt: "2026-10-13T13:27:40.000Z"});
    const host = await updateOutcomeHost(dashboard, daemon.home);
    try {
      await host.launch();
      await expect(dashboard.getByRole("button", {name: "Dispatch"}).first()).toBeVisible();
      const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
      await expect(dialog).toHaveCount(0);
      const outcome = {targetVersion: "alpha e00afcc", recordedAt: "2026-10-13T13:29:40.000Z"};
      writeUpdateOutcome(path, result === "success"
        ? {...outcome, result, launchVerified: true}
        : {...outcome, result, message: "Launch verification failed. The previous version was restored."});
      releaseHelperLock(lockPath, lock.entryName!, ops);
      await expect(dialog).toContainText(result === "success" ? "was updated to alpha e00afcc" : "The previous version was restored");
      await expectContentClearsBorder(dialog);
      expect(readUpdateOutcome(path)?.result).toBe(result);
      if (process.env.MC_E2E_EVIDENCE && result === "success") {
        await mkdir("e2e/.artifacts/update-relaunch", {recursive: true});
        await dashboard.screenshot({path: "e2e/.artifacts/update-relaunch/late-outcome.png"});
      }
      await dialog.getByRole("button", {name: "OK", exact: true}).click();
      await expect.poll(() => readUpdateOutcome(path)).toBeNull();
    } finally {
      releaseHelperLock(lockPath, lock.entryName!, ops);
      await host.stop();
    }
  });
}

test("an unanswered verified success replays after the renderer is lost, then stops replaying only after OK", async ({dashboard, daemon}) => {
  writeUpdateOutcome(updateOutcomePath(daemon.home), {
    result: "success", launchVerified: true, targetVersion: "alpha e00afcc", recordedAt: "2026-10-13T13:27:40.000Z",
  });
  const host = await updateOutcomeHost(dashboard, daemon.home);
  try {
    await host.launch();
    const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
    await expect(dialog).toContainText("was updated to alpha e00afcc");
    await expect.poll(() => host.messages.filter((line) => line.includes("dialog delivered")).length).toBe(1);
    expect(readUpdateOutcome(updateOutcomePath(daemon.home))?.result).toBe("success");
    await host.launch(); // new main controller and renderer, same durable state, no answer
    await expect(dialog).toContainText("was updated to alpha e00afcc");
    await expectContentClearsBorder(dialog);
    expect(readUpdateOutcome(updateOutcomePath(daemon.home))?.result).toBe("success");
    if (process.env.MC_E2E_EVIDENCE) {
      await mkdir("e2e/.artifacts/update-relaunch", {recursive: true});
      await dashboard.screenshot({path: "e2e/.artifacts/update-relaunch/unanswered-relaunch.png"});
    }
    await dialog.getByRole("button", {name: "OK", exact: true}).click();
    await expect.poll(() => readUpdateOutcome(updateOutcomePath(daemon.home))).toBeNull();
    await host.launch();
    await expect(dialog).toHaveCount(0);
  } finally { await host.stop(); }
});

test("the reported respawn job cannot race bundle replacement and open into a false success", async ({dashboard, daemon}) => {
  const events: string[] = [];
  // Script the incident's OS observations at the existing injected effects boundary.
  // Never install a respawner or wedge LaunchServices on the operator's machine.
  const mac: MacAppOps = {
    uid: 501, now: Date.now, sleep: async () => {}, identity: () => "fixture-start",
    kill: () => { throw new Error("preflight must not signal processes"); }, readAck: () => null,
    run: async (command, args) => ({code: 0, stdout:
      command.endsWith("lsappinfo") ? `1) Mission Control\n bundleID="com.mission-control.app"\n bundle path="${bundle}"\n pid = 42 type="Foreground"\n`
      : command.endsWith("ps") ? `42 1 S ${bundle}/Contents/MacOS/Mission Control\n`
      : args[0] === "list" ? `PID\tStatus\tLabel\n- 0 ${job}\n`
      : `program = /bin/sh\narguments = {\n /bin/sh\n -c\n sleep 8; exec "${bundle}/Contents/MacOS/Mission Control"\n}\n`}),
  };
  const ops: ApplyOperations = {
    preflight: (path) => assertSafeAppLaunch(path, mac),
    waitForBundle: async () => {}, prepareLaunch: async () => {},
    verifyLaunch: async () => { throw new Error("Unregistered respawn owns the window; LaunchServices copy is stopped at _dyld_start"); },
    stopLaunch: async () => { throw new Error("Unowned respawn cannot be signalled"); },
    lock: realHelperLockOperations(), exists: () => true, remove: () => {}, move: () => {}, copy: () => {},
    nowIso: () => "2026-10-13T13:27:40.000Z", bundleVersion: () => "1.26.0", restoreApp: () => null,
    waitForParent: async () => { events.push("old app exited"); },
    install: () => { events.push("bundle replaced", "launchd exec: unregistered window owner"); },
    launch: () => { events.push("open: second process stopped at _dyld_start"); },
    log: (line) => { events.push(line); },
  };
  // Baseline evidence can run the exact pre-fix helper copied from git, with every effect
  // still injected. Ordinary tests always use the current production helper.
  const apply: typeof runApplyUpdate = process.env.MC_E2E_BASELINE_UPDATE_HELPER
    ? (await import(pathToFileURL(process.env.MC_E2E_BASELINE_UPDATE_HELPER).href)).runApplyUpdate : runApplyUpdate;
  const result = await apply({
    sourceClone: daemon.home, targetTag: "v1.26.0", parentPid: 42, appPath: bundle,
    stateDirectory: daemon.home, logPath: join(daemon.home, "update.log"), stagedBundle: null, stagedRevision: null,
  }, ops);
  const outcome = JSON.parse(await readFile(updateOutcomePath(daemon.home), "utf8"));
  const host = await updateOutcomeHost(dashboard, daemon.home);
  try {
    await host.launch();
    const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
    await expect(dialog).toBeVisible();
    const baseline = Boolean(process.env.MC_E2E_BASELINE_UPDATE_HELPER);
    console.log(JSON.stringify({boundary: "injected macOS effects, real helper and outcome UI", baseline, result, events, outcome}));
    if (process.env.MC_E2E_EVIDENCE) {
      await mkdir("e2e/.artifacts/update-relaunch", {recursive: true});
      await dashboard.screenshot({path: `e2e/.artifacts/update-relaunch/race-${baseline ? "before" : "after"}.png`});
    }
    expect(result.ok, "a respawn job must refuse the swap, not publish a successful update").toBe(false);
    expect(events).not.toContain("bundle replaced");
    await expect(dialog).toContainText(`launchctl bootout 'gui/501/${job}'`);
    await expectContentClearsBorder(dialog);
    expect(outcome.result).toBe("failure");
    await dialog.getByRole("button", {name: "OK", exact: true}).click();
  } finally { await host.stop(); }
});

test('rollback shows the blocking bundle process and its owning workflow work', async ({dashboard, daemon}) => {
  const app = join(daemon.home, 'apps', 'Mission Control.app');
  const candidate = join(daemon.home, 'candidate.app');
  for (const [path, commit] of [[app, 'a'.repeat(40)], [candidate, 'b'.repeat(40)]]) {
    await mkdir(join(path, 'Contents/Resources/app'), {recursive:true});
    await mkdir(join(path, 'Contents/MacOS'), {recursive:true});
    await writeFile(join(path, 'Contents/MacOS/Mission Control'), '#!/bin/sh\nexit 0\n', {mode:0o755});
    await writeFile(join(path, 'Contents/Info.plist'), '<key>CFBundleShortVersionString</key><string>1.27.2</string>');
    await writeFile(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({missionCommit:commit,
      missionInstallMigration:{protocol:1,automatic:true},missionInstallTransaction:{protocol:1,receiptSchemas:[1,2]}}));
  }
  const receipt = {schema:1,repo:'teamupstart/mission-control',releaseTag:'v1.27.2',installedVersion:'1.27.2',
    installedCommit:'a'.repeat(40),sourceClone:'/unused-source',appPath:app,installedAt:new Date().toISOString()};
  await writeFile(join(daemon.home,'install-receipt.json'),JSON.stringify(receipt));
  const descriptor = prepareStagedInstall({bundle:candidate,receipt:{...receipt,installedCommit:'b'.repeat(40)}});
  const plan = prepareInPlaceInstall({descriptor,stateDirectory:daemon.home});
  const work = 'workflow check test, attempt check-123, run run-456, session sdk:789';
  const identity = 'fixture check process identity';
  // Feed the real diagnostic formatter into migration and the outcome renderer.
  // Process inspection and app launch are fixture ports; no live process is killed.
  const mac = {now: () => 0, sleep: async () => {}, identity: () => identity,
    run: async () => ({code: 0, stdout: `39896 1 S ${app}/Contents/MacOS/Mission Control\n`}),
  } as unknown as MacAppOps;
  const rollback = await runMigration(plan, {
    waitForParent: () => waitForBundleExit(app, mac, 0, undefined,
      [{pid: 39896, fingerprint: processFingerprint(identity)!, group: true, work}]),
    waitForDaemonExit:async()=>{},
    launchTarget:async()=>{throw new Error('must not launch target');},waitForReady:async()=>{},
    stopTarget:async()=>{},launchSource:async()=>{},
  });
  expect(rollback.committed).toBe(false);
  const host = await updateOutcomeHost(dashboard, daemon.home);
  try {
    await host.launch();
    const dialog = dashboard.getByRole('dialog', {name: 'Mission Control update'});
    await expect(dialog).toContainText('39896');
    await expect(dialog).toContainText(work);
    await expect(dialog).toContainText('previous app and exact installation receipt were preserved');
    await dashboard.mouse.move(0, 0);
    await expectContentClearsBorder(dialog);
    if (process.env.MC_E2E_EVIDENCE) {
      await mkdir('e2e/.artifacts/update-relaunch', {recursive:true});
      await dialog.screenshot({path:'e2e/.artifacts/update-relaunch/owned-process-blocker.png'});
    }
    await dialog.getByRole('button', {name:'OK', exact:true}).click();
    await expect(dialog).toHaveCount(0);
  } finally { await host.stop(); }
});
