import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController } from "../../src/main/updater.ts";
import { readUpdatePreferences, writeUpdatePreferences } from "../../src/main/update-preferences.ts";
import {
  classifyInstallIdentity,
  identityUpdateBlock,
  systemAppPath,
  userAppPath,
} from "../../src/main/install-identity.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * What a person sees when the app they are looking at is not the app the receipt describes.
 *
 * Two visible consequences, both of which only a browser can confirm: the update copy no longer
 * promises everyone a `/Applications` install, and a mismatched copy says so where the update
 * setting lives instead of silently doing nothing. The reason travels the real route - a real
 * `UpdateController` over the real classifier - rather than being typed into the spec, because
 * the failure worth catching is a reason that never reaches the renderer at all.
 */
test("a copy that is not the installed app says so, and update copy names no fixed folder", async ({
  dashboard,
  daemon,
}) => {
  const preferences = join(daemon.home, "update-preferences.json");
  const home = "/Users/e2e-operator";
  const commit = "a".repeat(40);
  const receipt = {
    schema: 1,
    repo: "teamupstart/mission-control",
    releaseTag: "v1.2.3",
    installedVersion: "1.2.3",
    installedCommit: commit,
    sourceClone: daemon.home,
    appPath: userAppPath(home),
    installedAt: "2026-09-14T00:00:00.000Z",
  } as const;
  // The retained shared copy, launched from a stale Dock entry, whose receipt names this
  // account's personal app. It may not update anything, because the only bundle it could
  // update is somebody else's.
  const identity = classifyInstallIdentity({
    runningBundle: systemAppPath(),
    runningCommit: commit,
    receipt,
    home,
    exists: () => true,
    bundleCommit: () => commit,
    bundleVersion: () => "1.2.3",
  });
  expect(identity.state).toBe("redirect");

  const controller = new UpdateController({
    packaged: true,
    arch: "arm64",
    currentVersion: () => "1.2.3",
    currentCommit: () => commit,
    readAlpha: () => readUpdatePreferences(preferences).alpha,
    writeAlpha: (alpha) => {
      writeUpdatePreferences(preferences, { alpha });
    },
    installSnapshot: () => ({ receipt, problem: identityUpdateBlock(identity) }),
    latestRelease: async () => null,
    latestMainCommit: async () => ({
      sha: "b".repeat(40),
      message: "main",
      committedAt: "2026-09-14T00:00:00Z",
    }),
    runtime: async () => ({ ok: true, node: process.execPath }),
    stage: async () => ({ ok: false, reason: "failed", message: "not reachable" }),
    stagedBundleIdentity: () => ({ version: null, revision: null }),
    handoff: async () => {},
    requestQuit: () => {},
    helperSource: () => "",
    stateDirectory: () => daemon.home,
    readOutcome: () => null,
    clearOutcome: () => {},
    now: () => Date.now(),
    random: () => 0,
    log: () => {},
    dialogs: {
      available: async () => "defer",
      upToDate: async () => {},
      preparing: async () => {},
      ready: async () => "defer",
      applying: async () => {},
      error: async () => {},
      outcome: async () => {},
    },
  });
  await controller.start();

  await dashboard.exposeFunction("installIdentitySnapshot", async () => controller.getSnapshot());
  await dashboard.addInitScript(() => {
    let snapshot: UpdateSnapshot | null = null;
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const publish = (next: UpdateSnapshot): void => {
      snapshot = next;
      for (const listener of listeners) listener(next);
    };
    Object.defineProperty(window, "pushIdentitySnapshot", { configurable: true, value: publish });
    const load = async (): Promise<UpdateSnapshot> => {
      const value = await (
        window as unknown as { installIdentitySnapshot(): Promise<UpdateSnapshot> }
      ).installIdentitySnapshot();
      publish(value);
      return value;
    };
    Object.defineProperty(window, "missionDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        version: async () => "1.2.3",
        onOpenSettings: () => () => {},
        updates: {
          getState: async () => snapshot ?? (await load()),
          setAlpha: async () => snapshot ?? (await load()),
          check: () => load(),
          apply: async () => false,
          install: async () => false,
          defer: async () => {},
          onState: (listener: (value: UpdateSnapshot) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    });
  });
  await dashboard.reload();

  const capture = async (name: string): Promise<void> => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const dir = join(process.cwd(), "e2e/.artifacts/update-install-identity");
    await mkdir(dir, { recursive: true });
    await dashboard.mouse.move(1, 1);
    await dashboard.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  };

  // 1. The update setting explains the mismatch and offers no check that could not act.
  await dashboard.getByRole("button", { name: "Settings" }).click();
  await dashboard.getByRole("tab", { name: "Setup" }).click();
  const panel = dashboard.getByRole("region", { name: "Application updates" });
  await expect(panel).toContainText("Updates are disabled");
  await expect(panel).toContainText(userAppPath(home));
  await expect(panel.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  await capture("mismatched-installation");

  // 2. The prepared-update copy promises an install, a restart, and a possible administrator
  //    prompt - and names no folder, because the app now lives in one of three places.
  await dashboard.keyboard.press("Escape");
  await expect(dashboard.getByRole("region", { name: "Application updates" })).toHaveCount(0);
  const ready: UpdateSnapshot = {
    phase: "ready",
    currentVersion: "1.2.3",
    newVersion: "1.2.4",
    releaseTag: "v1.2.4",
    stagedAt: Date.now(),
    lastOutcome: null,
  };
  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as unknown as { pushIdentitySnapshot(value: UpdateSnapshot): void }).pushIdentitySnapshot(next);
  }, ready);
  const status = dashboard.getByRole("status", { name: "Mission Control update" });
  await expect(status).toContainText("Mission Control 1.2.4 is ready to install");
  await expect(status).toContainText("administrator permission");
  await expect(status).not.toContainText("/Applications");
  await capture("ready-copy");

  await dashboard.evaluate((next: UpdateSnapshot) => {
    (window as unknown as { pushIdentitySnapshot(value: UpdateSnapshot): void }).pushIdentitySnapshot(next);
  }, {
    phase: "applying",
    currentVersion: "1.2.3",
    newVersion: "1.2.4",
    stage: "handed-off",
    lastOutcome: null,
  } satisfies UpdateSnapshot);
  await expect(status).toContainText("Installing Mission Control 1.2.4");
  await expect(status).not.toContainText("/Applications");
  await capture("applying-copy");

  controller.stop();
});
