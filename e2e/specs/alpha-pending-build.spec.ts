import { binaryOffer, binaryStaged } from "../../test/helpers/binary-update.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateController } from "../../src/main/updater.ts";
import type { ReadyAlpha } from "../../src/main/update-binary-release.ts";
import { writeUpdatePreferences, readUpdatePreferences } from "../../src/main/update-preferences.ts";
import { UPDATE_DIALOGS, type UpdateDialogRequest } from "../../src/shared/update-dialog.ts";
import type { UpdateSnapshot } from "../../src/shared/update.ts";
import { expectContentClearsBorder } from "../fixtures/modal-inset.ts";
import { expect, test } from "../fixtures/test.ts";

/**
 * Every merge to main starts a signed alpha build that takes a while. A check during that
 * window used to answer with "The update could not be completed" - even when an earlier,
 * complete build was still newer than the installation. This drives the real controller
 * through the dashboard's bridge: the Settings check, and the menu check whose answer is a
 * modal.
 */
test("a check while main's signed build is running offers the newest complete alpha, or says it is up to date", async ({ dashboard, daemon }) => {
  const preferences = join(daemon.home, "update-preferences.json");
  writeUpdatePreferences(preferences, { alpha: true });
  const installed = "a".repeat(40);
  const prior = "c".repeat(40);
  const head = "d".repeat(40);
  let ready: ReadyAlpha | null = null;
  let stagedCommit: string | null = null;
  const lookups: string[] = [];
  const dialogAnswers = new Map<string, () => void>();
  let dialogs = 0;
  const ask = (content: Omit<UpdateDialogRequest, "id">) => new Promise<void>((resolve) => {
    const id = `dialog-${++dialogs}`;
    dialogAnswers.set(id, resolve);
    void dashboard.evaluate((request) => {
      (window as unknown as { pushUpdateDialog(request: UpdateDialogRequest): void }).pushUpdateDialog(request);
    }, { ...content, id });
  });
  const controller = new UpdateController({
    launchPreflight: async () => {},
    packaged: true, arch: "arm64", currentVersion: () => "1.2.3", currentCommit: () => installed,
    readSnoozes: () => ({}), writeSnoozes: () => {},
    readAlpha: () => readUpdatePreferences(preferences).alpha,
    writeAlpha: (alpha) => { writeUpdatePreferences(preferences, { alpha }); },
    installSnapshot: () => ({ receipt: { schema: 1, repo: "teamupstart/mission-control", sourceClone: daemon.home, appPath: join(daemon.home, "fixture.app"), installedVersion: "1.2.3", installedCommit: installed, releaseTag: "v1.2.3", installedAt: "2026-11-07T00:00:00.000Z" }, problem: null }),
    latestRelease: async () => null,
    latestMainCommit: async () => ({ sha: head, message: "Merged moments ago.", committedAt: "2026-11-07T18:40:00Z" }),
    // The tip's signed build is still running: its exact alpha is not published yet.
    binaryForCommit: async () => null,
    latestReadyAlpha: async (from, to) => { lookups.push(`${from}..${to}`); return ready; },
    stage: async (request) => {
      stagedCommit = request.targetTag;
      return binaryStaged(request, join(daemon.home, "staged.app"), "fixture");
    },
    stagedBundleIdentity: () => ({ version: "1.2.3", revision: "fixture", commit: stagedCommit }),
    handoff: async () => {},
    requestQuit: () => {},
    helperSource: () => "", stateDirectory: () => daemon.home, readOutcome: () => null, clearOutcome: () => false,
    now: () => Date.now(), random: () => 0, log: () => {},
    dialogs: {
      available: async () => "defer",
      upToDate: (version, pendingVersion) => ask(UPDATE_DIALOGS.upToDate(version, pendingVersion)),
      preparing: async () => {}, ready: async () => "defer", applying: async () => {},
      error: (message) => ask(UPDATE_DIALOGS.error(message)),
      outcome: async () => {},
    },
  });
  await controller.start();
  await dashboard.exposeFunction("alphaPendingCommand", async (command: string) => {
    if (command === "check") await controller.check(true);
    if (command === "apply") await controller.apply();
    if (command === "defer") controller.defer();
    return controller.getSnapshot();
  });
  await dashboard.exposeFunction("alphaPendingAnswer", (id: string) => { dialogAnswers.get(id)?.(); });
  await dashboard.addInitScript(() => {
    let snapshot: UpdateSnapshot | null = null;
    const listeners = new Set<(value: UpdateSnapshot) => void>();
    const dialogListeners = new Set<(request: UpdateDialogRequest) => void>();
    const publish = (next: UpdateSnapshot) => { snapshot = next; for (const listener of listeners) listener(next); };
    const host = window as unknown as { alphaPendingCommand(name: string): Promise<UpdateSnapshot>; alphaPendingAnswer(id: string): Promise<void> };
    const command = async (name: string) => { const value = await host.alphaPendingCommand(name); publish(value); return value; };
    Object.defineProperty(window, "pushAlphaPendingSnapshot", { value: publish });
    Object.defineProperty(window, "pushUpdateDialog", { value: (request: UpdateDialogRequest) => { for (const listener of dialogListeners) listener(request); } });
    Object.defineProperty(window, "missionDesktop", { value: {
      isDesktop: true, version: async () => "1.2.3", onOpenSettings: () => () => {},
      updates: {
        getState: async () => snapshot ?? command("state"), setAlpha: async () => snapshot,
        check: () => command("check"), apply: () => command("apply"), install: () => command("state"), defer: () => command("defer"),
        onState: (listener: (value: UpdateSnapshot) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        onDialog: (listener: (request: UpdateDialogRequest) => void) => { dialogListeners.add(listener); return () => dialogListeners.delete(listener); },
        receivedDialog: () => {},
        answerDialog: (id: string) => { void host.alphaPendingAnswer(id); },
      },
    } });
  });
  const unsubscribe = controller.subscribe((snapshot) => {
    void dashboard.evaluate((value) => {
      (window as unknown as { pushAlphaPendingSnapshot?(value: UpdateSnapshot): void }).pushAlphaPendingSnapshot?.(value);
    }, snapshot).catch(() => {});
  });
  const capture = async (name: string) => {
    if (process.env.MC_E2E_EVIDENCE !== "1") return;
    const dir = join(process.cwd(), "e2e/.artifacts/alpha-pending-build");
    await mkdir(dir, { recursive: true });
    await dashboard.mouse.move(1, 1);
    await dashboard.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  };
  try {
    await dashboard.reload();
    await dashboard.getByRole("button", { name: "Settings" }).click();
    await dashboard.getByRole("tab", { name: "Setup" }).click();
    const panel = dashboard.getByRole("region", { name: "Application updates" });
    await expect(panel.getByRole("checkbox", { name: "Alpha updates" })).toBeChecked();
    const banner = dashboard.getByRole("status", { name: "Mission Control update" });

    // Nothing complete is newer than the installation: up to date, naming the build in flight.
    await panel.getByRole("button", { name: "Check for updates" }).click();
    await expect(panel).toContainText("You are running the newest signed main build. 1.2.3 (alpha aaaaaaa)");
    await expect(panel).toContainText("Mission Control alpha ddddddd is still being built and signed. It will be offered once it is ready to install.");
    await expect(banner).toHaveCount(0);
    expect(lookups).toEqual([`${installed}..${head}`]);
    await capture("settings-up-to-date-pending");

    // The menu check answers with a success notice, never "The update could not be completed".
    const menu = controller.checkForUpdates();
    const modal = dashboard.getByRole("dialog", { name: "Mission Control update" });
    await expect(modal).toContainText("Mission Control 1.2.3 (alpha aaaaaaa) is up to date");
    await expect(modal).toContainText("Mission Control alpha ddddddd is still being built and signed.");
    await expect(modal).not.toContainText("could not be completed");
    await expect(modal).toHaveClass(/update-dialog-success/);
    await expectContentClearsBorder(modal);
    await capture("menu-up-to-date-pending");
    await modal.getByRole("button", { name: "OK", exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect((await menu).phase).toBe("up-to-date");

    // An earlier merge's build is complete and newer than the installation: offer it now.
    ready = { commit: { sha: prior, message: "Earlier merged improvements.", committedAt: "2026-11-07T17:00:00Z" }, binary: binaryOffer(prior, "alpha", "1.2.3") };
    await panel.getByRole("button", { name: "Check for updates" }).click();
    await expect(banner).toContainText("Mission Control alpha ccccccc is available");
    await expect(banner).toContainText("Main commit ccccccc is the newest signed build. Mission Control alpha ddddddd is still being built and signed.");
    await expect(banner.getByRole("button", { name: "Update Now" })).toBeEnabled();
    await expect(banner.getByRole("button", { name: "Check again" })).toHaveCount(0);
    await expect(panel).not.toContainText("You are running");
    await capture("banner-offers-prior-build");
    await banner.getByRole("button", { name: "Update Now" }).click();
    await expect(banner).toContainText("alpha ccccccc is ready to install");
    expect(stagedCommit).toBe(prior);
  } finally {
    unsubscribe();
    controller.stop();
  }
});
