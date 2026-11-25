import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { _electron, type ElectronApplication } from "playwright";
import { expect, test } from "../fixtures/test.ts";
import { say, enableVoice } from "../fixtures/voice.ts";
import { captureCard, setupCards } from "../fixtures/voice-cards.ts";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";

test.skip(process.platform !== "darwin", "the voice tray uses the macOS desktop shell");

test("the voice tray reports a daemon restart and restores the standard click when Voice is disabled", async ({ daemon }) => {
  assertElectronGuiLaunchAllowed();
  const entry = join(daemon.home, "voice-tray.cjs");
  buildSync({ stdin: { resolveDir: resolve("."), loader: "ts", contents: `
    import { app } from "electron";
    import { createTray, destroyTray, setTrayVoice } from "./src/main/tray.ts";
    import { startShellVoice } from "./src/main/voice-state.ts";
    app.whenReady().then(() => {
      let opens = 0;
      let menu;
      const tray = createTray(${JSON.stringify(resolve("build/trayTemplate.png"))}, ${JSON.stringify(resolve("build"))}, {
        onOpen: () => opens++, setMuted: muted => voice.mute(muted),
      });
      tray.popUpContextMenu = next => { menu = next; };
      const voice = startShellVoice(${JSON.stringify(join(daemon.home, "missing-listener"))}, setTrayVoice);
      globalThis.voiceTrayFixture = {
        menu() { menu = undefined; tray.emit("right-click"); return menu?.items.map(item => item.label) ?? []; },
        click() { tray.emit("click"); return opens; },
      };
      app.on("before-quit", () => { voice.stop(); destroyTray(); });
    });
  ` }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry });
  const app = await _electron.launch({ args: [entry, "--user-data-dir=" + join(daemon.home, "chromium")],
    env: { ...process.env, MISSION_HOME: daemon.home, MISSION_PORT: new URL(daemon.baseURL).port } });
  type Fixture = { voiceTrayFixture?: { menu(): string[]; click(): number } };
  const menu = () => app.evaluate(() => (globalThis as unknown as Fixture).voiceTrayFixture?.menu() ?? []);
  const click = () => app.evaluate(() => (globalThis as unknown as Fixture).voiceTrayFixture!.click());
  try {
    await enableVoice(daemon);
    await expect.poll(menu).toContain("Voice: not listening");
    await daemon.shutdown();
    await expect.poll(menu).toContain("Voice: reconnecting");
    expect(await menu()).toContain("Mute Voice");
    expect(await click()).toBe(0);
    await daemon.restart();
    await expect.poll(menu).toContain("Voice: not listening");
    const disabled = await fetch(daemon.baseURL + "/api/feature-flags", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "flag", id: "voice", enabled: false }),
    });
    expect(disabled.ok).toBe(true);
    await expect.poll(menu).toEqual([]);
    expect(await click()).toBe(1);
  } finally { await app.close(); }
});

// Select the actual MenuItem on the tray's next refresh so the production click
// callback opens history through the shell and dashboard.
async function selectRecentlyHeard(app: ElectronApplication) {
  await app.evaluate(({ Tray }) => new Promise<void>((done, reject) => {
    const setMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function(menu) {
      setMenu.call(this, menu);
      if (menu !== null) return;
      Tray.prototype.setContextMenu = setMenu;
      const popUp = this.popUpContextMenu;
      this.popUpContextMenu = nativeMenu => {
        const item = nativeMenu?.items.find(row => row.label === "Recently Heard");
        if (!item?.enabled) { reject(new Error("Recently Heard is unavailable")); return; }
        item.click();
        done();
      };
      try { this.emit("right-click"); } finally { this.popUpContextMenu = popUp; }
    };
  }));
}

test("Recently Heard from the tray shows history alone and returns to the live popover countdown", async ({ daemon, page: reference }) => {
  assertElectronGuiLaunchAllowed();
  await reference.goto(new URL("../../docs/plans/voice-addressing-for-agents/mockup-recently-heard.html", import.meta.url).href);
  const design = reference.locator("#b .rh-pop").first();
  const app = await _electron.launch({
    args: [resolve("."), "--user-data-dir=" + join(daemon.home, "chromium")],
    env: { ...process.env, HOME: daemon.home, MISSION_HOME: daemon.home,
      MISSION_PORT: new URL(daemon.baseURL).port, MISSION_DEV_SERVER_URL: daemon.baseURL },
  });
  try {
    const dashboard = await app.firstWindow();
    await expect(dashboard.locator(".app")).toBeVisible();
    await setupCards(dashboard, daemon);
    expect((await dashboard.request.post(daemon.baseURL + "/api/residents/profiles", { data: { settings: {
      identity: { name: "Steve", description: "Builds" }, persona: { personaId: "builtin:code-risk-reviewer" },
    } } })).ok()).toBe(true);
    expect((await dashboard.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: "popover" } })).ok()).toBe(true);
    await expect.poll(() => app.windows().some(win => win.url().endsWith("#/voice/popover"))).toBe(true);
    const popover = app.windows().find(win => win.url().endsWith("#/voice/popover"))!;
    const words = "check the release notes";
    expect((await say(daemon, "Steve, " + words)).ok).toBe(true);
    const card = popover.getByRole("status");
    await expect(card).toContainText(words);
    const countdown = card.getByRole("button", { name: "Send now" });
    await expect(countdown).toHaveText(/^\d+s$/);
    const initialSeconds = parseInt(await countdown.innerText(), 10);

    await selectRecentlyHeard(app);
    const history = popover.getByRole("region", { name: "Recently heard" });
    const row = history.getByRole("listitem");
    await expect(row).toContainText("Steve, " + words);
    await expect(card).toBeHidden();
    await expect(popover.getByRole("button", { name: "Cancel" })).toBeHidden();
    await expect(dashboard.locator(".voice-card")).toHaveCount(0);
    await expect(history.locator("header")).toContainText("Listening");
    await expect(history.locator("footer")).toContainText("In memory only. Cleared on quit. Audio is never stored.");
    for (const property of ["width", "border-radius"]) {
      await expect(history).toHaveCSS(property, await design.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property));
    }
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some(win => win.webContents.getURL().endsWith("#/voice/popover") && win.isVisible()))).toBe(true);
    await captureCard(popover, "tray-history-during-confirmation");
    const age = await row.locator("time").innerText();
    await expect(row.locator("time")).not.toHaveText(age);
    await popover.keyboard.press("Escape");
    await expect(history).toBeHidden();
    await expect(card).toContainText(words);
    expect(parseInt(await countdown.innerText(), 10)).toBeLessThan(initialSeconds);
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(card).toContainText("Cancelled");

    // History also opens from a cold popover when the card placement is elsewhere.
    expect((await dashboard.request.put(daemon.baseURL + "/api/voice/confirmation", { data: { confirmation: "toast" } })).ok()).toBe(true);
    await expect.poll(() => popover.isClosed()).toBe(true);
    const opened = app.waitForEvent("window");
    await selectRecentlyHeard(app);
    const reopened = (await opened).getByRole("region", { name: "Recently heard" });
    await expect(reopened.getByRole("listitem")).toContainText(words);
    await expect(reopened.getByRole("listitem")).toContainText("Cancelled");
    await reopened.getByRole("button", { name: "Clear" }).click();
    await expect(reopened).toContainText("Nothing heard yet.");
    await expect(reopened.getByRole("button", { name: "Clear" })).toBeDisabled();
  } finally { await app.close(); }
});
