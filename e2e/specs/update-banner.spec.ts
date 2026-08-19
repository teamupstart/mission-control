import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

const available: UpdateSnapshot = {
  phase: "available",
  currentVersion: "0.1.0",
  newVersion: "0.2.0",
  releaseTag: "v0.2.0",
  releaseName: "Mission Control 0.2.0",
  releaseNotes: "A clearer dashboard and faster local sessions.",
  publishedAt: "2026-08-19T12:00:00.000Z",
  checkedAt: Date.parse("2026-08-19T12:00:00.000Z"),
  lastOutcome: null,
};

test("desktop update banner exposes the complete update flow while the browser stays unchanged", async ({
  dashboard,
  context,
  daemon,
}) => {
  await dashboard.addInitScript((initialSnapshot: UpdateSnapshot) => {
    let snapshot = initialSnapshot;
    const listeners = new Set<(next: UpdateSnapshot) => void>();
    const publish = (next: UpdateSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) listener(next);
    };

    Object.defineProperty(window, "__pushUpdateSnapshot", {
      configurable: true,
      value: publish,
    });
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        onOpenSettings: () => () => {},
        updates: {
          getState: async () => snapshot,
          check: async () => {
            publish(initialSnapshot);
            return initialSnapshot;
          },
          apply: async () => {
            publish({
              phase: "applying",
              newVersion: initialSnapshot.phase === "available" ? initialSnapshot.newVersion : "0.2.0",
              stage: "starting",
              lastOutcome: null,
            });
            return true;
          },
          defer: async () => {
            publish({
              phase: "idle",
              currentVersion: "0.1.0",
              lastCheckedAt: Date.now(),
              lastOutcome: null,
            });
          },
          onState: (listener: (next: UpdateSnapshot) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
  }, available);
  await dashboard.reload();

  const status = dashboard.getByRole("status");
  await expect(status).toContainText("0.2.0");
  await expect(status).toContainText("A clearer dashboard and faster local sessions.");
  expect(await status.evaluate((banner) => banner.closest("header"))).toBeNull();

  const evidenceDir = join(process.cwd(), "e2e/.artifacts/update-banner");
  const screenshot = async (name: string): Promise<void> => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    await mkdir(evidenceDir, { recursive: true });
    await dashboard.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  };

  await screenshot("available");
  await dashboard.getByRole("button", { name: "Update Now" }).click();
  await expect(status).toContainText("Preparing to update");
  await screenshot("applying");

  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as Window & { __pushUpdateSnapshot(next: UpdateSnapshot): void }).__pushUpdateSnapshot(next);
  }, available);
  await dashboard.getByRole("button", { name: "Later" }).click();
  await expect(status).toHaveCount(0);

  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as Window & { __pushUpdateSnapshot(next: UpdateSnapshot): void }).__pushUpdateSnapshot(next);
  }, {
    phase: "error",
    currentVersion: "0.1.0",
    message: "Could not check for updates.",
    manual: true,
    retryable: true,
    lastOutcome: null,
  } satisfies UpdateSnapshot);
  await expect(status).toContainText("update check failed");
  await screenshot("manual-error");
  await dashboard.getByRole("button", { name: "Retry" }).click();
  await expect(status).toContainText("0.2.0");

  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as Window & { __pushUpdateSnapshot(next: UpdateSnapshot): void }).__pushUpdateSnapshot(next);
  }, {
    phase: "idle",
    currentVersion: "0.1.0",
    lastCheckedAt: Date.now(),
    lastOutcome: {
      result: "failure",
      targetVersion: "0.2.0",
      recordedAt: "2026-08-19T12:05:00.000Z",
      message: "The installer did not complete.",
    },
  } satisfies UpdateSnapshot);
  await expect(status).toContainText("could not be installed");
  await screenshot("previous-failure");
  await dashboard.getByRole("button", { name: "Dismiss" }).click();
  await expect(status).toHaveCount(0);

  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as Window & { __pushUpdateSnapshot(next: UpdateSnapshot): void }).__pushUpdateSnapshot(next);
  }, {
    phase: "idle",
    currentVersion: "0.2.0",
    lastCheckedAt: Date.now(),
    lastOutcome: {
      result: "success",
      targetVersion: "0.2.0",
      recordedAt: "2026-08-19T12:10:00.000Z",
    },
  } satisfies UpdateSnapshot);
  await expect(status).toContainText("updated successfully");
  await screenshot("previous-success");
  await dashboard.getByRole("button", { name: "Dismiss" }).click();
  await expect(status).toHaveCount(0);

  const browser = await context.newPage();
  await browser.goto(`${daemon.baseURL}/#/fleet`);
  expect(await browser.evaluate(() => window.missionDesktop)).toBeUndefined();
  await expect(browser.getByRole("status")).toHaveCount(0);
  await expect(browser.locator(".app-banner")).toHaveCount(0);
});
