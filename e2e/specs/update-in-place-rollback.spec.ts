import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStagedInstall } from "../../scripts/install-staged-app.mjs";
import { prepareInPlaceInstall, runMigration } from "../../scripts/install-migration.mjs";
import { waitForBundleExit, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
import { CHECK_SUPERVISOR_MARKER } from "../../src/shared/owned-runtime.mjs";
import { readUpdateOutcome, updateOutcomePath } from "../../src/main/update-outcome.ts";
import { updateOutcomeHost } from "../fixtures/update-relaunch.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

// The 2026-11-03 rollback, end to end: a workflow-check supervisor left running from inside the
// app bundle makes the real in-place transaction's bundle-exit wait time out, the real restore
// writes the outcome, and the real controller and presenter put it in front of the person.
// Only the macOS process table is scripted - this never touches a real app or process.

function bundles(root: string) {
  const app = join(root, "apps", "Mission Control.app");
  const candidate = join(root, "candidate.app");
  for (const [path, commit, version] of [[app, "a".repeat(40), "1.26.0"], [candidate, "b".repeat(40), "1.27.0"]] as const) {
    mkdirSync(join(path, "Contents/Resources/app"), {recursive: true});
    mkdirSync(join(path, "Contents/MacOS"), {recursive: true});
    writeFileSync(join(path, "Contents/MacOS/Mission Control"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(path, "Contents/MacOS/Mission Control"), 0o755);
    writeFileSync(join(path, "Contents/Info.plist"), `<key>CFBundleShortVersionString</key><string>${version}</string>`);
    writeFileSync(join(path, "Contents/Resources/app/package.json"), JSON.stringify({missionCommit: commit,
      missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, appNaming: 1, receiptSchemas: [1, 2]}}));
  }
  return {app, candidate};
}

/** `ps` after the daemon was reaped: one detached check supervisor still in the bundle. */
function lingeringCheck(bundle: string): MacAppOps {
  let now = 0;
  const helper = `${bundle}/Contents/Frameworks/Mission Control Helper.app/Contents/MacOS/Mission Control Helper`;
  return {
    uid: 501, now: () => now, sleep: async (ms) => { now += ms; },
    run: async (command, args) => {
      if (command === "/bin/ps" && args.includes("args=")) return {code: 0, stdout: `${helper} -e // ${CHECK_SUPERVISOR_MARKER}\nnpm test\n`};
      if (command === "/bin/ps") return {code: 0, stdout: `1 0 S /sbin/launchd\n4321 1 S ${helper}\n`};
      return {code: 0, stdout: ""};
    },
    identity: () => "start", kill: () => { throw new Error("diagnosis must not signal"); }, readAck: () => null,
  };
}

test("a rolled-back in-place update names the blocking check's pid and cause in the outcome dialog", async ({dashboard, daemon}) => {
  const state = realpathSync(daemon.home);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "in-place-rollback-")));
  try {
    const {app, candidate} = bundles(root);
    const receipt = {schema: 1, repo: "teamupstart/mission-control", releaseTag: "v1.26.0", installedVersion: "1.26.0",
      installedCommit: "a".repeat(40), sourceClone: "/source-that-must-not-be-executed", appPath: app, installedAt: "2026-10-14T00:00:00.000Z"};
    writeFileSync(join(state, "install-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...receipt, releaseTag: "v1.27.0", installedVersion: "1.27.0", installedCommit: "b".repeat(40)}});
    const plan = prepareInPlaceInstall({descriptor, stateDirectory: state});
    const mac = lingeringCheck(plan.source);
    const result = await runMigration(plan, {
      waitForParent: () => waitForBundleExit(plan.source, mac, 1_000), waitForDaemonExit: async () => {},
      launchTarget: async () => { throw new Error("the target must not launch while the bundle is busy"); },
      waitForReady: async () => {}, stopTarget: async () => {}, launchSource: async () => {},
    });
    expect(result.committed).toBe(false);
    expect(readUpdateOutcome(updateOutcomePath(state))?.result).toBe("failure");

    const host = await updateOutcomeHost(dashboard, state);
    try {
      await host.launch();
      const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
      await expect(dialog).toContainText("The update did not commit.");
      await expect(dialog).toContainText("pid 4321 (a workflow check whose parent already exited is still running)");
      await expect(dialog).toContainText("The previous app and exact installation receipt were preserved.");
      await expect(dialog).not.toContainText("npm test");
      await expectContentClearsBorder(dialog);
      if (process.env.MC_E2E_EVIDENCE) {
        await mkdir("e2e/.artifacts/in-place-update", {recursive: true});
        await dashboard.screenshot({path: "e2e/.artifacts/in-place-update/rollback-outcome.png"});
      }
      await dialog.getByRole("button", {name: "OK", exact: true}).click();
      await expect.poll(() => readUpdateOutcome(updateOutcomePath(state))).toBeNull();
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
