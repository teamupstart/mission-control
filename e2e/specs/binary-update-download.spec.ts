import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController, type UpdaterPort, type UpdateStageRequest } from "../../src/main/updater.ts";
import type { BinaryStageOutcome } from "../../src/main/update-binary.ts";
import { binaryOffer, binaryStaged } from "../../test/helpers/binary-update.ts";
import { connectUpdateController } from "../fixtures/update-controller.ts";
import { expect, test } from "../fixtures/test.ts";

for (const colorScheme of ["dark", "light"] as const) {
  test(`binary progress, cancellation, pending alpha and retry under ${colorScheme} OS preference`, async ({dashboard, daemon}) => {
    await dashboard.emulateMedia({colorScheme});
    let ready = false, attempts = 0, handoffs = 0, quits = 0;
    let request: UpdateStageRequest;
    let settle: (outcome: BinaryStageOutcome) => void;
    const receipt = {schema: 1 as const, repo: "teamupstart/mission-control", sourceClone: "/missing", appPath: "/Applications/Mission Control.app", installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-25T00:00:00Z"};
    const port: UpdaterPort = {
      packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => "a".repeat(40), readAlpha: () => true, writeAlpha: () => {}, installSnapshot: () => ({receipt, problem: null}),
      latestRelease: async () => null, latestMainCommit: async () => ({sha: "b".repeat(40), message: "Exact alpha", committedAt: "2026-10-25T00:00:00Z"}),
      binaryForCommit: async commit => ready ? binaryOffer(commit, "alpha") : null,
      stage: input => {request = input; attempts++; input.onStage("download", {received: 25, total: 100}); return new Promise(resolve => {settle = resolve;});},
      stagedBundleIdentity: () => ({version: "1.2.4", revision: "staged-1", commit: "b".repeat(40)}),
      launchPreflight: async () => {}, helperSource: () => "", stateDirectory: () => daemon.home,
      handoff: async args => {expect(args.descriptor?.receipt.installedCommit).toBe("b".repeat(40)); handoffs++;}, requestQuit: () => {quits++;},
      readOutcome: () => null, clearOutcome: () => {}, now: Date.now, random: () => 0, log: () => {},
      dialogs: {available: async () => "defer", ready: async () => "defer", preparing: async () => {}, applying: async () => {}, error: async () => {}, outcome: async () => {}, upToDate: async () => {}},
    };
    const controller = new UpdateController(port); await controller.start(); await controller.check(true);
    const unsubscribe = await connectUpdateController(dashboard, controller);
    const banner = dashboard.getByRole("status", {name: "Mission Control update"});
    const capture = async (name: string) => {
      if (process.env.MC_E2E_EVIDENCE !== "1") return;
      const dir = join(process.cwd(), "e2e/.artifacts/binary-update"); await mkdir(dir, {recursive: true});
      await dashboard.mouse.move(600, 650);
      await dashboard.screenshot({path: join(dir, `${colorScheme}-${name}.png`), fullPage: true});
    };
    try {
      await expect(banner).toContainText("pending or unavailable");
      await expect(banner.getByRole("button", {name: "Update Now"})).toBeDisabled();
      await capture("pending");
      ready = true; await banner.getByRole("button", {name: "Check again"}).click();
      await expect(banner.getByRole("button", {name: "Update Now"})).toBeEnabled();
      await banner.getByRole("button", {name: "Update Now"}).click();
      const bar = banner.getByRole("progressbar");
      await expect(bar).toHaveAttribute("aria-valuenow", "25");
      await expect(banner).toContainText("25% downloaded");
      await expect(dashboard.getByRole("button", {name: "Settings"})).toBeEnabled();
      await capture("download");
      await banner.getByRole("button", {name: "Cancel"}).click();
      await expect(banner).toContainText("Waiting for the download and verification to stop");
      expect(request!.signal.aborted).toBe(true); expect(attempts).toBe(1); expect(quits).toBe(0);
      await expect(banner.getByRole("button", {name: "Update Now"})).toHaveCount(0);
      await capture("cancelling");
      settle!({ok: false, reason: "cancelled", message: "cancelled"});
      await expect(banner.getByRole("button", {name: "Update Now"})).toBeEnabled();
      await banner.getByRole("button", {name: "Update Now"}).click();
      await expect.poll(() => attempts).toBe(2);
      request!.onStage("extract");
      await expect(banner).toContainText("Checking and unpacking the archive");
      await expect(bar).not.toHaveAttribute("aria-valuenow");
      request!.onStage("signature");
      await expect(banner).toContainText("Verifying publisher and build identity");
      await capture("verification");
      settle!({ok: false, reason: "failed", message: "The binary download was truncated or failed its SHA-256 check. The installed app is unchanged."});
      await expect(banner).toContainText("installed app is unchanged");
      await expect(banner.getByRole("button", {name: "Retry"})).toBeEnabled();
      expect(handoffs).toBe(0); expect(quits).toBe(0);
      await capture("failure");
      await banner.getByRole("button", {name: "Retry"}).click();
      await banner.getByRole("button", {name: "Update Now"}).click();
      await expect.poll(() => attempts).toBe(3);
      settle!(binaryStaged(request!, join(daemon.home, "candidate.app")));
      await expect(banner).toContainText("alpha bbbbbbb is ready to install");
      await capture("ready");
      await banner.getByRole("button", {name: "Restart and Install"}).click();
      await expect(banner).toContainText("Installing Mission Control alpha bbbbbbb");
      expect(handoffs).toBe(1); expect(quits).toBe(1);
    } finally {unsubscribe(); controller.stop();}
  });
}
