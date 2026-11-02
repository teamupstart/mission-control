import { join } from "node:path";
import { UpdateController, type UpdaterPort } from "../../src/main/updater.ts";
import { binaryOffer, binaryReceipt, binaryStaged } from "../../test/helpers/binary-update.ts";
import { connectUpdateController } from "../fixtures/update-controller.ts";
import { expect, test } from "../fixtures/test.ts";

for (const kind of ["legacy source", "binary"] as const) {
  test(`${kind} installed app downloads and restarts without a Node preflight`, async ({dashboard, daemon}) => {
    const previous = {schema: 1 as const, repo: "teamupstart/mission-control", sourceClone: "/missing/source", appPath: "/Applications/Mission Control.app", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"};
    const receipt = kind === "binary" ? binaryReceipt(binaryOffer("a".repeat(40), "stable", "1.2.3"), previous) : previous;
    let handoffs = 0, quits = 0;
    const port: UpdaterPort = {
      readSnoozes: () => ({}), writeSnoozes: () => {},
      packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => "a".repeat(40), readAlpha: () => false, writeAlpha: () => {},
      installSnapshot: () => ({receipt, problem: null}),
      latestRelease: async () => ({tagName: "v1.2.4", name: "1.2.4", body: "Signed binary update.", publishedAt: "2026-10-25T00:00:00Z", isDraft: false, isPrerelease: false, binary: binaryOffer()}),
      latestMainCommit: async () => ({sha: "b".repeat(40), message: "Main build", committedAt: "2026-10-25T00:00:00Z"}),
      binaryForCommit: async commit => binaryOffer(commit, "alpha"),
      stage: async request => binaryStaged(request, join(daemon.home, "candidate.app")),
      stagedBundleIdentity: () => ({version: "1.2.4", revision: "staged-1", commit: "b".repeat(40)}),
      helperSource: () => "", stateDirectory: () => daemon.home, launchPreflight: async () => {},
      handoff: async args => {expect(args.descriptor?.receipt.kind).toBe("binary"); expect(args.node).toBeUndefined(); expect(args.sourceClone).toBeUndefined(); handoffs++;}, requestQuit: () => {quits++;},
      readOutcome: () => null, clearOutcome: () => {}, now: Date.now, random: () => 0, log: () => {},
      dialogs: {error: async () => {}, available: async () => "defer", upToDate: async () => {}, preparing: async () => {}, ready: async () => "defer", applying: async () => {}, outcome: async () => {}},
    };
    // An old/missing host runtime is deliberately poisonous if the controller ever
    // reaches the removed API again. Source-development runtime tests remain separate.
    Object.assign(port, {runtime: () => {throw new Error("Host Node 18 / npm missing: must never probe");}});
    const controller = new UpdateController(port); await controller.start(); await controller.check(true);
    const unsubscribe = await connectUpdateController(dashboard, controller, kind === "binary");
    try {
      const banner = dashboard.getByRole("status", {name: "Mission Control update"});
      await expect(banner.getByRole("button", {name: "Update Now"})).toBeEnabled();
      await dashboard.getByRole("button", {name: "Settings"}).click();
      await dashboard.getByRole("tab", {name: "Setup"}).click();
      await expect(dashboard.getByRole("checkbox", {name: "Alpha updates"})).toBeEnabled();
      await expect(dashboard.getByRole("region", {name: "Application updates"})).toContainText("Signed binaries download while you work");
      await banner.getByRole("button", {name: "Update Now"}).click();
      await expect(banner).toContainText("1.2.4 is ready to install");
      await banner.getByRole("button", {name: "Restart and Install"}).click();
      await expect(banner).toContainText("Installing Mission Control 1.2.4");
      expect(handoffs).toBe(1); expect(quits).toBe(1);
    } finally {unsubscribe(); controller.stop();}
  });
}
