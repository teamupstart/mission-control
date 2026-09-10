import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController } from "../../src/main/updater.ts";
import { inspectUpdateRuntime } from "../../src/main/update-runtime.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

test("Node incompatibility blocks preparation and Check again recovers after remediation", async ({ dashboard, daemon }) => {
  let compatible = false;
  let builds = 0;
  let probes = 0;
  const node = join(daemon.home, "update-node");
  const npm = join(daemon.home, "update-npm");
  await writeFile(npm, `#!/usr/bin/env node\nconsole.log(JSON.stringify({npm:"11.0.0",node:process.versions.node}));\n`, { mode: 0o755 });
  const message = "This update requires Node.js 24 or newer (found 22.0.0). Install or select Node.js 24+, then choose Check again. Mission Control will keep running.";
  const controller = new UpdateController({
    packaged: true,
    arch: "arm64",
    currentVersion: () => "1.2.3",
    readReceipt: () => ({ schema: 1, repo: "teamupstart/mission-control", sourceClone: daemon.home, appPath: "/tmp/update-fixture.app", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-09-09T00:00:00Z" }),
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
    handoff: async () => { throw new Error("this test must never install an app"); },
    requestQuit: () => { throw new Error("this test must never quit the app"); },
    clearOutcome: () => {},
  });
  await controller.start();
  await controller.check(false);
  await dashboard.exposeFunction("fixtureUpdateCommand", async (command: string) => {
    if (command === "check") await controller.check(true);
    if (command === "apply") await controller.apply();
    return controller.getSnapshot();
  });
  await dashboard.addInitScript((initial: UpdateSnapshot) => {
    let snapshot = initial;
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const command = async (name: string) => {
      snapshot = await (window as unknown as { fixtureUpdateCommand(name: string): Promise<UpdateSnapshot> }).fixtureUpdateCommand(name);
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    };
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, onOpenSettings: () => () => {},
      updates: {
        getState: async () => snapshot,
        check: () => command("check"), apply: () => command("apply"),
        onState: (listener: (value: UpdateSnapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    } });
  }, controller.getSnapshot());
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
    const previousProbes = probes;
    await status.getByRole("button", { name: "Check again" }).click();
    await expect.poll(() => probes).toBeGreaterThan(previousProbes);
    await expect(update).toBeDisabled();
    await expect(status).toContainText("If this warning persists after changing Node in another terminal, restart Mission Control with the corrected Node.js environment.");
    expect(builds).toBe(0);
    await capture("retry-still-blocked.png");
    compatible = true;
    await status.getByRole("button", { name: "Check again" }).click();
    await expect(update).toBeEnabled();
    await expect(status).not.toContainText("found 22.0.0");
    await capture("compatible.png");
    await update.click();
    await expect(status).toContainText("1.2.4 is ready to install");
    expect(builds).toBe(1);
    await capture("retry-ready.png");
  } finally {
    controller.stop();
  }
});
