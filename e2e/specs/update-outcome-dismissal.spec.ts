import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController, type UpdaterPort } from "../../src/main/updater.ts";
import { clearUpdateOutcome, readUpdateOutcome, writeUpdateOutcome } from "../../src/main/update-outcome.ts";
import type { UpdateApplyOutcome } from "../../src/shared/update.ts";
import { binaryOffer, binaryReceipt } from "../../test/helpers/binary-update.ts";
import { connectUpdateController } from "../fixtures/update-controller.ts";
import { expect, test } from "../fixtures/test.ts";

for (const result of ["success", "failure"] as const) {
  test(`dismissed update ${result} stays retired through background checks, reload and restart`, async ({ dashboard, daemon }) => {
    const path = join(daemon.home, "update-outcome.json");
    const outcome: UpdateApplyOutcome = {
      result, targetVersion: "1.2.4", recordedAt: "2026-11-03T14:27:34.000Z",
      ...(result === "failure" ? { message: "The installer did not complete." } : {}),
    } as UpdateApplyOutcome;
    writeUpdateOutcome(path, outcome);
    let notices = 0;
    const port: UpdaterPort = {
      packaged: true, arch: "arm64", currentVersion: () => "1.2.4", currentCommit: () => null,
      readAlpha: () => false, writeAlpha: () => {}, readSnoozes: () => ({}), writeSnoozes: () => {},
      installSnapshot: () => ({ receipt: binaryReceipt(binaryOffer(), {
        schema: 1, repo: "teamupstart/mission-control", sourceClone: "/missing/source",
        appPath: "/Applications/Mission Control.app", installedVersion: "1.2.4",
        releaseTag: "v1.2.4", installedAt: "2026-11-03T14:00:00Z",
      }), problem: null }),
      // A transient background failure returns to idle, the observed resurrection path.
      latestRelease: async () => { throw new Error("Temporary network failure"); },
      latestMainCommit: async () => { throw new Error("Unexpected alpha check"); },
      binaryForCommit: async () => null,
      stage: async () => { throw new Error("No installation expected"); },
      helperSource: () => "", stateDirectory: () => daemon.home,
      handoff: async () => { throw new Error("No handoff expected"); }, requestQuit: () => {},
      readOutcome: () => readUpdateOutcome(path), clearOutcome: expected => clearUpdateOutcome(path, expected),
      now: Date.now, random: () => 0, log: () => {},
      dialogs: {
        available: async () => "defer", ready: async () => "defer", upToDate: async () => {},
        preparing: async () => {}, applying: async () => {}, error: async () => {},
        outcome: async () => { notices++; }, // No modal answer: only the banner acknowledges.
      },
    };
    const controller = new UpdateController(port);
    await controller.start();
    const unsubscribe = await connectUpdateController(dashboard, controller);
    try {
      const banner = dashboard.getByRole("status", { name: "Mission Control update" });
      await expect(banner).toContainText(result === "success" ? "updated successfully" : "could not be installed");
      const capture = async (name: string) => {
        if (process.env.MC_E2E_EVIDENCE !== "1") return;
        const directory = join(process.cwd(), "e2e/.artifacts/update-outcome-dismissal");
        await mkdir(directory, { recursive: true });
        await dashboard.screenshot({ path: join(directory, `${result}-${name}.png`), fullPage: true });
      };
      await capture("before");
      await banner.getByRole("button", { name: "Dismiss" }).click();
      await expect(banner).toHaveCount(0);
      await expect.poll(() => readUpdateOutcome(path)).toBeNull();
      await controller.check(false);
      expect(controller.getSnapshot().phase).toBe("idle");
      expect(controller.getSnapshot().lastOutcome).toBeNull();
      await dashboard.reload();
      await expect(dashboard.getByRole("button", { name: "Dispatch", exact: true })).toBeVisible();
      await expect(banner).toHaveCount(0);
      controller.stop();
      const successor = new UpdateController(port);
      try {
        await successor.start();
        expect(successor.getSnapshot().lastOutcome).toBeNull();
        expect(notices).toBe(1);
      } finally { successor.stop(); }
      await expect(banner).toHaveCount(0);
      await capture("after-restart");

      // A later attempt at the same version is a new notice, not permanently suppressed.
      writeUpdateOutcome(path, { ...outcome, recordedAt: "2026-11-03T15:27:34.000Z" });
      await controller.start();
      await expect(banner).toContainText("1.2.4");
      expect(notices).toBe(2);
    } finally { unsubscribe(); controller.stop(); }
  });
}
