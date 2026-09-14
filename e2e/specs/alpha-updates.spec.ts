import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController, ALPHA_RECHECK_MS } from "../../src/main/updater.ts";
import { readUpdatePreferences, writeUpdatePreferences } from "../../src/main/update-preferences.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expect, test } from "../fixtures/test.ts";

test("alpha opt-in persists and automatic and manual checks offer exact main commits through the install flow", async ({ dashboard, daemon }) => {
  const preferences = join(daemon.home, "update-preferences.json");
  let head = "b".repeat(40);
  let installedCommit = "a".repeat(40);
  let stagedCommit: string | null = null;
  let acceptedCommit: string | null = null;
  let now = Date.now();
  let mainQueries = 0;
  const controller = new UpdateController({
    packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => installedCommit,
    readAlpha: () => readUpdatePreferences(preferences).alpha,
    writeAlpha: (alpha) => { writeUpdatePreferences(preferences, { alpha }); },
    readReceipt: () => ({ schema: 1, repo: "teamupstart/mission-control", sourceClone: daemon.home, appPath: join(daemon.home, "fixture.app"), installedVersion: "1.2.3", installedCommit, releaseTag: "v1.2.3", installedAt: "2026-09-14T00:00:00.000Z" }),
    latestRelease: async () => ({ tagName: "v1.2.4", name: "1.2.4", body: "Stable release improvements.", publishedAt: "2026-09-14T00:00:00Z", isDraft: false, isPrerelease: false }),
    latestMainCommit: async () => { mainQueries++; return { sha: head, message: "New main improvements.", committedAt: "2026-09-14T00:00:00Z" }; },
    runtime: async () => ({ ok: true, node: process.execPath }),
    stage: async ({ targetTag }) => {
      stagedCommit = targetTag;
      return { ok: true, staged: { version: "1.2.3", bundlePath: join(daemon.home, "staged.app"), revision: "fixture" } };
    },
    stagedBundleIdentity: () => ({ version: "1.2.3", revision: "fixture", commit: stagedCommit }),
    handoff: async ({ targetTag }) => { acceptedCommit = targetTag; },
    requestQuit: () => {},
    helperSource: () => "", stateDirectory: () => daemon.home, readOutcome: () => null, clearOutcome: () => {},
    now: () => now, random: () => 0, log: () => {},
    dialogs: { available: async () => "defer", upToDate: async () => {}, preparing: async () => {}, ready: async () => "defer", applying: async () => {}, error: async () => {}, outcome: async () => {} },
  });
  await controller.start();
  await dashboard.exposeFunction("alphaUpdateCommand", async (command: string, alpha?: boolean) => {
    if (command === "alpha") controller.setAlpha(alpha!);
    if (command === "check") await controller.check(true);
    if (command === "apply") await controller.apply();
    if (command === "install") await controller.install();
    if (command === "defer") controller.defer();
    return controller.getSnapshot();
  });
  await dashboard.addInitScript(() => {
    let snapshot: UpdateSnapshot | null = null;
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const publish = (next: UpdateSnapshot) => { snapshot = next; for (const listener of listeners) listener(next); };
    Object.defineProperty(window, "pushAlphaSnapshot", { value: publish });
    const command = async (name: string, alpha?: boolean) => {
      const value = await (window as unknown as { alphaUpdateCommand(name: string, alpha?: boolean): Promise<UpdateSnapshot> }).alphaUpdateCommand(name, alpha);
      publish(value);
      return value;
    };
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
      updates: {
        getState: async () => snapshot ?? command("state"), setAlpha: (alpha: boolean) => command("alpha", alpha),
        check: () => command("check"), apply: () => command("apply"), install: () => command("install"), defer: () => command("defer"),
        onState: (listener: (value: UpdateSnapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    } });
  });
  const unsubscribe = controller.subscribe((snapshot) => {
    void dashboard.evaluate((value) => {
      (window as unknown as { pushAlphaSnapshot?(value: UpdateSnapshot): void }).pushAlphaSnapshot?.(value);
    }, snapshot).catch(() => {});
  });
  const capture = async (name: string) => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const dir = join(process.cwd(), "e2e/.artifacts/alpha-updates");
    await mkdir(dir, { recursive: true });
    await dashboard.mouse.move(1, 1);
    await dashboard.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  };
  try {
    await dashboard.reload();
    await dashboard.getByRole("button", { name: "Settings" }).click();
    await dashboard.getByRole("tab", { name: "Setup" }).click();
    await expect(dashboard.getByRole("tabpanel")).toContainText("This installation");
    const panel = dashboard.getByRole("region", { name: "Application updates" });
    const alpha = panel.getByRole("checkbox", { name: "Alpha updates" });
    await expect(alpha).not.toBeChecked();
    await expect(alpha).toBeEnabled();
    await capture("default-off");
    await panel.getByRole("button", { name: "Check for updates" }).click();
    const banner = dashboard.getByRole("status", { name: "Mission Control update" });
    await expect(banner).toContainText("Mission Control 1.2.4 is available");
    expect(mainQueries).toBe(0);
    await alpha.click();
    await expect(alpha).toBeChecked();
    await expect(banner).toContainText("alpha bbbbbbb is available");
    await expect(banner).toContainText("Stable release v1.2.4 is also available");
    expect(readUpdatePreferences(preferences).alpha).toBe(true);
    await capture("alpha-offer");
    await dashboard.reload();
    await expect(dashboard.getByRole("checkbox", { name: "Alpha updates" })).toBeChecked();
    await banner.getByRole("button", { name: "Later" }).click();
    head = "c".repeat(40);
    now += ALPHA_RECHECK_MS;
    controller.onActivate();
    await expect(banner).toContainText("alpha ccccccc is available");
    await capture("next-main-commit");
    installedCommit = head;
    await panel.getByRole("button", { name: "Check for updates" }).click();
    await expect(panel).toContainText("You are running the latest main commit.");
    head = "d".repeat(40);
    await panel.getByRole("button", { name: "Check for updates" }).click();
    await expect(banner).toContainText("alpha ddddddd is available");
    await alpha.click();
    await expect(alpha).not.toBeChecked();
    await expect(banner).toContainText("Mission Control 1.2.4 is available");
    expect(readUpdatePreferences(preferences).alpha).toBe(false);
    await alpha.click();
    await expect(alpha).toBeChecked();
    await expect(banner).toContainText("alpha ddddddd is available");
    head = "e".repeat(40);
    await banner.getByRole("button", { name: "Update Now" }).click();
    await expect(banner).toContainText("alpha ddddddd is ready to install");
    expect(stagedCommit).toBe("d".repeat(40));
    await expect(alpha).toBeDisabled();
    await capture("ready-pinned-commit");
    await banner.getByRole("button", { name: "Restart and Install" }).click();
    await expect.poll(() => acceptedCommit).toBe("d".repeat(40));
    await expect(banner).toContainText("Installing Mission Control alpha ddddddd");
  } finally {
    unsubscribe();
    controller.stop();
  }
});

test("the browser settings remain usable without a desktop update bridge", async ({ dashboard }) => {
  await dashboard.getByRole("button", { name: "Settings" }).click();
  await dashboard.getByRole("tab", { name: "Setup" }).click();
  await expect(dashboard.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  await expect(dashboard.getByRole("checkbox", { name: "Alpha updates" })).toHaveCount(0);
});
