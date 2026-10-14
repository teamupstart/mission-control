import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runApplyUpdate, realHelperLockOperations, type ApplyOperations } from "../../scripts/apply-update.mjs";
import { assertSafeAppLaunch, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
import { readUpdateOutcome, updateOutcomePath, writeUpdateOutcome } from "../../src/main/update-outcome.ts";
import { updateOutcomeHost } from "../fixtures/update-relaunch.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

const job = "com.mission-control.recovery-20260918";
const bundle = "/fixture/Mission Control.app";

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
