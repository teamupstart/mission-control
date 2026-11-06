import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStagedInstall } from "../../scripts/install-staged-app.mjs";
import { prepareInPlaceInstall, recoverMigration, runMigration } from "../../scripts/install-migration.mjs";
import { assertSafeAppLaunch, waitForBundleExit, type MacAppOps } from "../../scripts/mac-app-lifecycle.mjs";
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

/**
 * `ps` while a terminal `claude` (pid 24941) runs our MCP server on the app's main binary as Node
 * (25186) and, unless `otherScript` is false, some other script on that runtime (25188).
 * `processArguments` answers with each process's kernel argv and environment entries, as the
 * shipped addon does. LaunchServices lists nothing, so every main-binary process is a candidate.
 */
function terminalNodeProcesses(bundle: string, otherScript = true): MacAppOps {
  let now = 0;
  const main = `${bundle}/Contents/MacOS/Mission Control`;
  const records = new Map([
    [25186, {argv: [main, `${bundle}/Contents/Resources/app/dist/mcp/server.mjs`], env: ["MISSION_TOKEN=secret-bearer", "ELECTRON_RUN_AS_NODE=1"]}],
    [25188, {argv: [main, "/Users/operator/tools/sync-notes.mjs"], env: ["ELECTRON_RUN_AS_NODE=1"]}],
  ]);
  return {
    uid: 501, now: () => now, sleep: async (ms) => { now += ms; },
    processArguments: (pid) => records.get(pid),
    run: async (command, args) => {
      if (command === "/bin/ps") return {code: 0, stdout: `1 0 S /sbin/launchd\n24941 24900 S /opt/homebrew/bin/claude\n25186 24941 S ${main}\n${otherScript ? `25188 24941 S ${main}\n` : ""}`};
      // No respawn job: an unreadable dump sends the sweep to an empty `launchctl list`.
      if (command === "/bin/launchctl") return args[0] === "list" ? {code: 0, stdout: "PID\tStatus\tLabel\n"} : {code: 1, stdout: ""};
      return {code: 0, stdout: ""};
    },
    identity: () => "start", kill: () => { throw new Error("diagnosis must not signal"); }, readAck: () => null,
  };
}

test("an in-place update commits and opens the new build while a terminal session's MCP server keeps running", async ({dashboard, daemon}) => {
  const state = realpathSync(daemon.home);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "in-place-node-mode-success-")));
  try {
    const {app, candidate} = bundles(root);
    const receipt = {schema: 1, repo: "teamupstart/mission-control", releaseTag: "v1.26.0", installedVersion: "1.26.0",
      installedCommit: "a".repeat(40), sourceClone: "/source-that-must-not-be-executed", appPath: app, installedAt: "2026-10-14T00:00:00.000Z"};
    writeFileSync(join(state, "install-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...receipt, releaseTag: "v1.27.0", installedVersion: "1.27.0", installedCommit: "b".repeat(40)}});
    const plan = prepareInPlaceInstall({descriptor, stateDirectory: state});
    // Only the terminal `claude`'s MCP server is in the bundle; the reported refusal named it.
    const mac = terminalNodeProcesses(plan.source, false);
    const launched: string[] = [];
    const result = await runMigration(plan, {
      // The helper's own order at the parent-exit checkpoint: launch-conflict preflight, then the
      // bundle-exit wait, then the preflight again (`scripts/apply-update.mjs`).
      waitForParent: async () => {
        await assertSafeAppLaunch(plan.source, mac);
        await waitForBundleExit(plan.source, mac, 1_000);
        await assertSafeAppLaunch(plan.source, mac);
      },
      waitForDaemonExit: async () => {},
      launchTarget: async (target: {target: string}) => { launched.push(target.target); return null; },
      waitForReady: async () => {}, stopTarget: async () => {},
      launchSource: async () => { throw new Error("the previous build must not reopen"); },
    });
    expect(result.error ?? null).toBeNull();
    expect(result.committed).toBe(true);
    expect(launched).toEqual([plan.target]);
    // The installed bundle is now the new build, and the committed receipt names it.
    expect(readFileSync(join(plan.target, "Contents/Info.plist"), "utf8")).toContain("<string>1.27.0</string>");
    expect(JSON.parse(readFileSync(join(state, "install-receipt.json"), "utf8")).installedVersion).toBe("1.27.0");
    // The new build's startup finishes the transaction and records the outcome a person sees.
    expect((await recoverMigration(state, {}))?.stage).toBe("complete");
    expect(readUpdateOutcome(updateOutcomePath(state))?.result).toBe("success");

    const host = await updateOutcomeHost(dashboard, state);
    try {
      await host.launch();
      const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
      await expect(dialog).toContainText("Mission Control was updated to 1.27.0");
      await expect(dialog).not.toContainText("not registered as a Foreground app");
      await expect(dialog).not.toContainText("did not commit");
      await expectContentClearsBorder(dialog);
      if (process.env.MC_E2E_EVIDENCE) {
        await mkdir("e2e/.artifacts/in-place-update", {recursive: true});
        await dashboard.screenshot({path: "e2e/.artifacts/in-place-update/node-mode-update-success.png"});
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

test("a terminal session's MCP server never blocks the update; another script it runs on the app's Node is named as that, not as the app", async ({dashboard, daemon}) => {
  const state = realpathSync(daemon.home);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "in-place-node-mode-")));
  try {
    const {app, candidate} = bundles(root);
    const receipt = {schema: 1, repo: "teamupstart/mission-control", releaseTag: "v1.26.0", installedVersion: "1.26.0",
      installedCommit: "a".repeat(40), sourceClone: "/source-that-must-not-be-executed", appPath: app, installedAt: "2026-10-14T00:00:00.000Z"};
    writeFileSync(join(state, "install-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...receipt, releaseTag: "v1.27.0", installedVersion: "1.27.0", installedCommit: "b".repeat(40)}});
    const plan = prepareInPlaceInstall({descriptor, stateDirectory: state});
    const mac = terminalNodeProcesses(plan.source);
    const result = await runMigration(plan, {
      waitForParent: () => waitForBundleExit(plan.source, mac, 1_000), waitForDaemonExit: async () => {},
      launchTarget: async () => { throw new Error("the target must not launch while the bundle is busy"); },
      waitForReady: async () => {}, stopTarget: async () => {}, launchSource: async () => {},
    });
    expect(result.committed).toBe(false);

    const host = await updateOutcomeHost(dashboard, state);
    try {
      await host.launch();
      const dialog = dashboard.getByRole("dialog", {name: "Mission Control update"});
      await expect(dialog).toContainText("The update did not commit.");
      await expect(dialog).toContainText("pid 25188 (a script claude runs on Mission Control's bundled Node is still running)");
      await expect(dialog).not.toContainText("25186");
      await expect(dialog).not.toContainText("the Mission Control app is still running");
      await expect(dialog).not.toContainText("not registered as a Foreground app");
      await expect(dialog).not.toContainText("sync-notes");
      await expect(dialog).not.toContainText("secret-bearer");
      await expectContentClearsBorder(dialog);
      if (process.env.MC_E2E_EVIDENCE) {
        await mkdir("e2e/.artifacts/in-place-update", {recursive: true});
        await dashboard.screenshot({path: "e2e/.artifacts/in-place-update/node-mode-holder-outcome.png"});
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
