import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { beListener, enableVoice } from "../fixtures/voice.ts";

test("native window clicks on the edge microphone mute and unmute", async ({ daemon }) => {
  test.skip(process.platform !== "darwin", "Exercises AppKit window hit testing");
  assertElectronGuiLaunchAllowed();
  const addon = join(daemon.home, "window-click.node");
  execFileSync("xcrun", ["clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-framework", "AppKit", "-I", resolve(process.execPath, "../../include/node"),
    "e2e/fixtures/window-click.mm", "-o", addon]);
  await enableVoice(daemon);
  const listener = await beListener(daemon);
  const app = await _electron.launch({ args: [resolve("."), "--user-data-dir=" + join(daemon.home, "chromium")],
    env: { ...process.env, HOME: daemon.home, MISSION_HOME: daemon.home,
      MISSION_PORT: new URL(daemon.baseURL).port, MISSION_DEV_SERVER_URL: daemon.baseURL } });
  try {
    const page = await app.firstWindow();
    for (const [id, enabled] of [["edge", true], ["status-line", false]] as const) {
      expect((await page.request.put(daemon.baseURL + "/api/voice/indicators", { data: { id, enabled } })).ok()).toBe(true);
    }
    const edge = page.locator("button.vi-edge");
    await expect(edge).toHaveAccessibleName("Voice: listening. Mute");
    await expect(page.locator("button.vi-status-line")).toHaveCount(0);
    const win = await app.browserWindow(page);
    await win.evaluate(win => { win.show(); win.focus(); });
    for (const mode of ["muted", "listening"]) {
      const rect = (await edge.boundingBox())!;
      const hit = await win.evaluate((win, { addon, rect }) => {
        const binding = { exports: {} };
        process.dlopen(binding as NodeJS.Module, addon);
        const click = binding.exports as (handle: Buffer, x: number, y: number) => string;
        const zoom = win.webContents.getZoomFactor();
        return click(win.getNativeWindowHandle(), (rect.x + rect.width / 2) * zoom, (rect.y + rect.height / 2) * zoom);
      }, { addon, rect });
      console.log(`AppKit edge click hit ${hit}, expecting ${mode}`);
      await expect(edge).toHaveAccessibleName(mode === "muted" ? "Voice: muted. Unmute" : "Voice: listening. Mute", { timeout: 5000 });
      if (process.env.MC_E2E_EVIDENCE) {
        const dir = artifactsDir("native-voice-edge");
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, mode + ".png"), clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 900, height: 90 } });
      }
    }
  } finally {
    listener.stop();
    await app.close();
  }
});
