import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultUpdaterPort, UpdateController } from "../../src/main/updater.ts";
import { binaryOffer, binaryReceipt, binaryStaged } from "../../test/helpers/binary-update.ts";
import { connectUpdateController } from "../fixtures/update-controller.ts";
import { expect, test } from "../fixtures/test.ts";

test("Later keeps the same update quiet across checks and restart for 48 hours", async ({ dashboard, daemon, context }) => {
  let now = Date.parse("2026-10-28T12:00:00Z");
  let version = "1.2.4";
  const port = createDefaultUpdaterPort({
    packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => "a".repeat(40),
    stateDirectory: daemon.home, helperSource: "", requestQuit: () => {},
    installSnapshot: () => ({ receipt: binaryReceipt(binaryOffer("a".repeat(40), "stable", "1.2.3"), {
      schema: 1, repo: "teamupstart/mission-control", appPath: join(daemon.home, "fixture.app"), sourceClone: daemon.home,
      installedVersion: "1.2.3", releaseTag: "v1.2.3", installedAt: "2026-10-28T00:00:00Z",
    }), problem: null }),
    dialogs: { available: async () => "defer", ready: async () => "defer", error: async () => {},
      upToDate: async () => {}, preparing: async () => {}, applying: async () => {}, outcome: async () => {} },
  });
  // Run the real controller and preference storage. Release discovery, clock, and candidate
  // preparation are fixture boundaries; this spec never downloads or installs a real update.
  port.now = () => now;
  port.latestRelease = async () => ({ tagName: `v${version}`, name: version, body: "A quieter update experience.",
    publishedAt: "2026-10-28T00:00:00Z", isDraft: false, isPrerelease: false, binary: binaryOffer("b".repeat(40), "stable", version) });
  port.readOutcome = () => null;
  port.migrationStatus = () => undefined;
  port.stage = async request => binaryStaged(request, join(daemon.home, "candidate.app"));
  port.stagedBundleIdentity = () => ({ version, revision: "staged-1", commit: "b".repeat(40) });
  port.migrationPlan = () => null;
  let controller = new UpdateController(port);
  let page = dashboard;
  let disconnect = () => {};
  const banner = () => page.getByRole("status", { name: "Mission Control update" });
  const capture = async (name: string) => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const directory = join(process.cwd(), "e2e/.artifacts/update-snooze");
    await mkdir(directory, { recursive: true });
    await page.mouse.move(1, 1);
    await expect(page.locator(".tooltip")).toHaveCount(0);
    await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  };
  try {
    await controller.start();
    await controller.check(false);
    disconnect = await connectUpdateController(page, controller);
    await expect(banner()).toContainText("1.2.4 is available");
    await capture("available");
    await banner().getByRole("button", { name: "Later" }).click();
    await expect(banner()).toHaveCount(0);
    now += 6 * 60 * 60 * 1000;
    await controller.check(false);
    await page.reload();
    await expect(banner()).toHaveCount(0);

    disconnect();
    controller.stop();
    controller = new UpdateController(port);
    await controller.start();
    now = Date.parse("2026-10-30T11:59:59.999Z");
    await controller.check(false);
    page = await context.newPage();
    await page.goto(`${daemon.baseURL}/#/fleet`);
    disconnect = await connectUpdateController(page, controller);
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect(banner()).toHaveCount(0);
    await capture("still-hidden-before-48-hours-after-restart");

    version = "1.2.5";
    await controller.check(false);
    await expect(banner()).toContainText("1.2.5 is available");
    await capture("different-version");
    await banner().getByRole("button", { name: "Later" }).click();
    await expect(banner()).toHaveCount(0);
    version = "1.2.4";
    now += 1;
    await controller.check(false);
    await expect(banner()).toContainText("1.2.4 is available");
    await capture("eligible-after-48-hours");
    await banner().getByRole("button", { name: "Later" }).hover();
    await expect(page.locator(".tooltip")).toHaveText("Hide this version for 48 hours");
    await banner().getByRole("button", { name: "Later" }).click();
    await expect(banner()).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Setup" }).click();
    await page.getByRole("region", { name: "Application updates" }).getByRole("button", { name: "Check for updates" }).click();
    await expect(banner()).toContainText("1.2.4 is available");
    await banner().getByRole("button", { name: "Update Now" }).click();
    await expect(banner()).toContainText("1.2.4 is ready to install");
    await banner().getByRole("button", { name: "Later" }).hover();
    await expect(page.locator(".tooltip")).toHaveText("Keep the prepared update and hide this version for 48 hours");
    await banner().getByRole("button", { name: "Later" }).click();
    await expect(banner()).toHaveCount(0);
    await controller.check(false);
    await page.reload();
    await expect(banner()).toHaveCount(0);
  } finally {
    disconnect();
    controller.stop();
    if (page !== dashboard) await page.close();
  }
});
