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
    const version = initialSnapshot.phase === "available" ? initialSnapshot.newVersion : "0.2.0";
    const releaseTag = initialSnapshot.phase === "available" ? initialSnapshot.releaseTag : "v0.2.0";
    // Stands in for the main process's own stage reports. The real ones come from the install
    // script's marker lines; what this spec proves is that they reach the bar.
    let advance: (() => void) | null = null;
    // Hoisted out of `apply`, because `cancel` publishes the same preparing snapshot with
    // `cancelling` set - the state the real controller holds until the build's process group
    // is gone.
    let report: ((cancelling?: boolean) => void) | null = null;

    Object.defineProperty(window, "__pushUpdateSnapshot", {
      configurable: true,
      value: publish,
    });
    Object.defineProperty(window, "__advanceUpdateBuild", {
      configurable: true,
      value: () => advance?.(),
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
          // "Update Now" starts a build and the app stays open, which is the whole point of
          // this path: the person watches it instead of watching the app disappear.
          apply: async () => {
            const stages = ["starting", "dependencies", "build", "verify"] as const;
            let index = 0;
            report = (cancelling = false): void =>
              publish({
                phase: "preparing",
                currentVersion: "0.1.0",
                newVersion: version,
                releaseTag,
                stage: stages[index]!,
                cancelling,
                lastOutcome: null,
              });
            report();
            advance = () => {
              index += 1;
              if (index < stages.length) {
                report();
                return;
              }
              advance = null;
              publish({
                phase: "ready",
                currentVersion: "0.1.0",
                newVersion: version,
                releaseTag,
                stagedAt: Date.now(),
                lastOutcome: null,
              });
            };
            return true;
          },
          install: async () => {
            publish({
              phase: "applying",
              currentVersion: "0.1.0",
              newVersion: version,
              stage: "handed-off",
              lastOutcome: null,
            });
            return true;
          },
          cancel: async () => {
            // The real controller stays in `preparing` with `cancelling` set until the build's
            // process group is actually gone, then returns the offer.
            report?.(true);
            advance = null;
            (window as Window & { __finishCancel(): void }).__finishCancel = () => {
              publish(initialSnapshot);
            };
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
    await dashboard.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await dashboard.mouse.move(640, 600);
    await expect(dashboard.locator(".tooltip")).toHaveCount(0);
    // Let the progress fill finish its 320ms transition, so evidence shows the bar rather
    // than a frame of it moving.
    await dashboard.waitForTimeout(400);
    await mkdir(evidenceDir, { recursive: true });
    await dashboard.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  };

  await screenshot("available");

  // 1. The build runs with the app open, and says how far along it is.
  const advance = async (): Promise<void> => {
    await dashboard.evaluate(() => {
      (window as Window & { __advanceUpdateBuild(): void }).__advanceUpdateBuild();
    });
  };
  await dashboard.getByRole("button", { name: "Update Now" }).click();
  const bar = dashboard.getByRole("progressbar", { name: "Preparing Mission Control 0.2.0" });
  await expect(status).toContainText("Preparing Mission Control 0.2.0");
  await expect(status).toContainText("Mission Control keeps running");
  await expect(bar).toHaveAttribute("aria-valuenow", "2");
  await screenshot("preparing-start");

  await advance();
  await expect(status).toContainText("Installing dependencies");
  await expect(bar).toHaveAttribute("aria-valuenow", "30");
  // The bar is a value, not a decoration: the fill's LAID-OUT width tracks it. Measured in
  // pixels rather than read off the inline style, because a declared 30% that paints as 8% is
  // the failure a person would actually see.
  // Polled rather than read once: the fill animates to its new value over 320ms, so a single
  // read right after the stage arrives measures the transition rather than the bar.
  await expect
    .poll(async () =>
      bar.evaluate((rail) => {
        const fill = rail.firstElementChild as HTMLElement;
        const railWidth = rail.getBoundingClientRect().width;
        const fillWidth = fill.getBoundingClientRect().width;
        return Math.round((fillWidth / railWidth) * 100);
      }),
    )
    .toBe(30);
  expect(await bar.evaluate((rail) => rail.getBoundingClientRect().width)).toBeGreaterThan(200);
  await screenshot("preparing-dependencies");

  // The banner stacks below 640px, where the rail falls back to the copy's own width. It must
  // still be a bar a person can read, and Cancel must still be reachable.
  const original = dashboard.viewportSize() ?? { width: 1280, height: 720 };
  await dashboard.setViewportSize({ width: 620, height: 800 });
  await expect(dashboard.getByRole("button", { name: "Cancel" })).toBeVisible();
  expect(await bar.evaluate((rail) => rail.getBoundingClientRect().width)).toBeGreaterThan(200);
  await screenshot("preparing-narrow");
  await dashboard.setViewportSize(original);

  await advance();
  await expect(status).toContainText("Building the new version");
  await expect(bar).toHaveAttribute("aria-valuenow", "55");
  await screenshot("preparing-build");

  // 2. Cancelling says it is stopping first, and only then returns the offer - the build's
  // processes are still writing into the shared clone until they are gone.
  await dashboard.getByRole("button", { name: "Cancel" }).click();
  await expect(status).toContainText("Cancelling the Mission Control 0.2.0 update");
  await expect(status).toContainText("Waiting for the build to stop");
  await expect(dashboard.getByRole("progressbar")).toHaveCount(0);
  await expect(dashboard.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await screenshot("cancelling");

  await dashboard.evaluate(() => {
    (window as Window & { __finishCancel(): void }).__finishCancel();
  });
  await expect(status).toContainText("Mission Control 0.2.0 is available");
  await expect(dashboard.getByRole("progressbar")).toHaveCount(0);

  // 3. Building through to the end offers the restart that installs it.
  await dashboard.getByRole("button", { name: "Update Now" }).click();
  for (const stage of ["dependencies", "build", "verify", "done"]) {
    await advance();
    if (stage !== "done") await expect(dashboard.getByRole("progressbar")).toBeVisible();
  }
  await expect(status).toContainText("Mission Control 0.2.0 is ready to install");
  await expect(status).toContainText("takes a few seconds");
  await expect(status).toContainText("administrator permission");
  await expect(dashboard.getByRole("progressbar")).toHaveCount(0);
  await screenshot("ready");

  await dashboard.getByRole("button", { name: "Restart and Install" }).click();
  await expect(status).toContainText("Installing Mission Control 0.2.0");
  await expect(status).toContainText("reopen on the new version in a few seconds");
  await screenshot("installing");

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

  // A background check now surfaces a standing, user-actionable failure instead of returning
  // silently to idle, so a lapsed `gh` credential reaches a person who never ran a manual
  // check - and reaches them with the retry they need after running `gh auth login`.
  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as Window & { __pushUpdateSnapshot(next: UpdateSnapshot): void }).__pushUpdateSnapshot(next);
  }, {
    phase: "error",
    currentVersion: "0.1.0",
    message: "GitHub CLI is not authenticated. Run `gh auth login`, then check again.",
    manual: false,
    retryable: true,
    lastOutcome: null,
  } satisfies UpdateSnapshot);
  await expect(status).toContainText("update check failed");
  await expect(status).toContainText("gh auth login");
  await screenshot("background-auth-error");
  await expect(dashboard.getByRole("button", { name: "Retry" })).toBeVisible();
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
