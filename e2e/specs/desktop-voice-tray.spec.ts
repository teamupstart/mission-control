import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { _electron } from "playwright";
import { expect, test } from "../fixtures/test.ts";
import { enableVoice } from "../fixtures/voice.ts";
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
