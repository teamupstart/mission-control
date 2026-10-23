import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController, type UpdaterPort } from "../../src/main/updater.ts";
import { inspectUpdateRuntime } from "../../src/main/update-runtime.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

test("Node incompatibility blocks preparation and Check again recovers after remediation", async ({ dashboard, daemon }) => {
  let compatible = false;
  let builds = 0;
  let probes = 0;
  let handoffs = 0;
  let quits = 0;
  const node = join(daemon.home, "update-node");
  const npm = join(daemon.home, "update-npm");
  await writeFile(npm, `#!/usr/bin/env node\nconsole.log(JSON.stringify({npm:"11.0.0",node:process.versions.node}));\n`, { mode: 0o755 });
  const message = "This update requires Node.js 24 or newer (found 22.0.0). Install or select Node.js 24+, then choose Check again. Mission Control will keep running.";
  const port: UpdaterPort = {
    launchPreflight: async () => {},
    packaged: true,
    arch: "arm64",
    currentVersion: () => "1.2.3",
    currentCommit: () => null,
    readAlpha: () => false,
    writeAlpha: () => {},
    latestMainCommit: async () => { throw new Error("Stable mode must not query main"); },
    installSnapshot: () => ({ receipt: { schema: 1, repo: "teamupstart/mission-control", sourceClone: daemon.home, appPath: "/tmp/update-fixture.app", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-09-09T00:00:00Z" }, problem: null }),
    runtime: async () => {
      probes++;
      const version = compatible ? process.versions.node : "22.0.0";
      await writeFile(node, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ version, execPath: process.execPath }))});\n`, { mode: 0o755 });
      return inspectUpdateRuntime({ path: node, env: process.env }, { path: npm }, daemon.home);
    },
    latestRelease: async () => ({ tagName: "v1.2.4", name: "1.2.4", body: "Update available.", publishedAt: "2026-09-09T00:00:00Z", isDraft: false, isPrerelease: false }),
    stage: async () => {
      builds++;
      return { ok: true, staged: { version: "1.2.4", bundlePath: "/tmp/staged.app", revision: "fixture" } };
    },
    stagedBundleIdentity: () => ({ version: "1.2.4", revision: "fixture" }),
    readOutcome: () => null,
    now: () => Date.now(), random: () => 0, log: () => {},
    dialogs: { error: async () => {}, available: async () => "defer", upToDate: async () => {}, preparing: async () => {}, ready: async () => "defer", applying: async () => {}, outcome: async () => {} },
    helperSource: () => "", stateDirectory: () => daemon.home,
    handoff: async () => { handoffs++; },
    requestQuit: () => { quits++; },
    clearOutcome: () => {},
  };
  let controller = new UpdateController(port);
  await controller.start();
  await controller.check(false);
  await dashboard.exposeFunction("fixtureUpdateCommand", async (command: string, alpha?: boolean) => {
    if (command === "check") await controller.check(true);
    if (command === "apply") await controller.apply();
    if (command === "install") await controller.install();
    if (command === "alpha") controller.setAlpha(alpha!);
    return controller.getSnapshot();
  });
  await dashboard.addInitScript(() => {
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const command = async (name: string, alpha?: boolean) => {
      const snapshot = await (window as unknown as { fixtureUpdateCommand(name: string, alpha?: boolean): Promise<UpdateSnapshot> }).fixtureUpdateCommand(name, alpha);
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    };
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, onOpenSettings: () => () => {},
      updates: {
        getState: () => command("state"), setAlpha: (alpha: boolean) => command("alpha", alpha),
        check: () => command("check"), apply: () => command("apply"), install: () => command("install"),
        onState: (listener: (value: UpdateSnapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    } });
  });
  try {
    await dashboard.reload();
    const status = dashboard.getByRole("status", { name: "Mission Control update" });
    const update = status.getByRole("button", { name: "Update Now" });
    await expect(status).toContainText(message);
    await expect(update).toBeDisabled();
    expect(builds).toBe(0);
    await status.getByRole("button", { name: "Check again" }).hover();
    await expect(dashboard.locator(".tooltip")).toHaveText("Check Node.js compatibility and the update again");
    await expect(dashboard.locator(".tooltip")).toBeVisible();
    await expect(status.getByRole("button", { name: "Check again" })).toHaveAccessibleDescription("Check Node.js compatibility and the update again");
    const evidence = join(process.cwd(), "e2e/.artifacts/update-node-preflight");
    const capture = async (name: string) => {
      if (process.env.MC_E2E_EVIDENCE !== "1") return;
      await mkdir(evidence, { recursive: true });
      await dashboard.screenshot({ path: join(evidence, name), fullPage: true });
    };
    await capture("retry-tooltip.png");
    await dashboard.mouse.move(1, 1);
    await capture("blocked.png");
    /**
     * Press Check again, and wait for the check to FINISH rather than to start.
     *
     * `probes` rises at the top of the runtime port, before the three subprocess probes
     * `inspectUpdateRuntime` runs have returned - so a wait on the counter alone leaves the
     * check in flight. `UpdateController.check` coalesces onto `this.checkPromise` while one
     * is running, which means a second press during that window is answered by the probe the
     * FIRST one already took. On a quiet machine the probes finish inside the gap between two
     * statements; on a busy one the fixture flips `compatible` for a check that never re-reads
     * it.
     *
     * `available` rather than merely "not checking": both presses here end on a release offer
     * - the first with a blocker, the second without - so naming the terminal phase says what
     * settling MEANS instead of only that it happened.
     */
    const checkAgain = async (): Promise<void> => {
      const before = probes;
      await status.getByRole("button", { name: "Check again" }).click();
      await expect.poll(() => probes).toBeGreaterThan(before);
      await expect.poll(() => controller.getSnapshot().phase).toBe("available");
    };
    await checkAgain();
    await expect(update).toBeDisabled();
    await expect(status).toContainText("If this warning persists after changing Node in another terminal, restart Mission Control with the corrected Node.js environment.");
    expect(builds).toBe(0);
    await capture("retry-still-blocked.png");
    compatible = true;
    await checkAgain();
    await expect(update).toBeEnabled();
    await expect(status).not.toContainText("found 22.0.0");
    await capture("compatible.png");
    await update.click();
    await expect(status).toContainText("1.2.4 is ready to install");
    expect(builds).toBe(1);
    await capture("retry-ready.png");
    compatible = false;
    const beforeInstall = probes;
    await status.getByRole("button", {name: "Restart and Install"}).click();
    await expect(status).toContainText("Installing Mission Control 1.2.4");
    expect(probes).toBe(beforeInstall);
    expect(handoffs).toBe(1);
    expect(quits).toBe(1);
    expect(builds).toBe(1);
    await capture("prepared-without-host-node.png");
    controller.stop();
    const prior = port.installSnapshot().receipt!;
    const {sourceClone: _clone, ...base} = prior;
    port.installSnapshot = () => ({problem: null, receipt: {...base, schema: 2, kind: "binary", installedCommit: "a".repeat(40),
      provenance: {manifestSha256: "b".repeat(64), assetId: "123", manifest: {
        protocol: 1, repo: "teamupstart/mission-control", channel: "stable", releaseTag: "v1.2.3", version: "1.2.3",
        commit: "a".repeat(40), platform: "darwin", arch: "arm64", bundleId: "com.mission-control.app", minimumSystemVersion: "12.0",
        helperProtocol: {min: 1, max: 1}, assets: [{kind: "app-zip", id: "123", name: "app.zip", bytes: 123, sha256: "c".repeat(64)}],
      }}}});
    controller = new UpdateController(port);
    await controller.start();
    await controller.check(false);
    await dashboard.reload();
    await dashboard.getByRole("button", {name: "Settings"}).click();
    await dashboard.getByRole("tab", {name: "Setup"}).click();
    const updates = dashboard.getByRole("region", {name: "Application updates"});
    await expect(updates).toContainText("Automatic binary updates are not available in this build.");
    await expect(updates.getByRole("link", {name: "Signed installer and recovery instructions"})).toBeVisible();
    await expect(status).toHaveCount(0);
    expect(builds).toBe(1);
    expect(handoffs).toBe(1);
    await dashboard.mouse.move(1, 1);
    await expect(dashboard.locator(".tooltip")).toHaveCount(0);
    await capture("binary-source-fallback-refused.png");
    for (const kind of ["source", "unmanaged"] as const) {
      controller.stop();
      port.installSnapshot = () => ({problem: null, receipt: kind === "source" ? {...prior, repo: "fixture/source-fork"} : null});
      controller = new UpdateController(port);
      await controller.start();
      await dashboard.goto(`${daemon.baseURL}/#/fleet`);
      await dashboard.getByRole("button", {name: "Settings"}).click();
      await dashboard.getByRole("tab", {name: "Setup"}).click();
      await expect(updates).toContainText(kind === "source"
        ? "Updates are disabled because this app was installed from fixture/source-fork."
        : "This app was not installed with the managed install command.");
      await expect(updates.getByRole("button", {name: "Check for updates"})).toBeDisabled();
      await expect(updates.getByRole("link", {name: "Signed installer and recovery instructions"})).toHaveCount(0);
      await dashboard.mouse.move(1, 1);
      await expect(dashboard.locator(".tooltip")).toHaveCount(0);
      await capture(`${kind}-without-binary-recovery.png`);
    }
  } finally {
    controller.stop();
  }
});
