import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { assertElectronGuiLaunchAllowed } from "../../test/helpers/electron-gui.ts";
import { artifactsDir } from "../fixtures/artifacts.ts";
import { expect, test } from "../fixtures/test.ts";
import { beListener, enableVoice } from "../fixtures/voice.ts";

test.skip(process.platform !== "darwin", "Exercises AppKit window hit testing");

test("native window clicks on the edge microphone mute and unmute", async ({ daemon }) => {
  assertElectronGuiLaunchAllowed();
  const addon = join(daemon.home, "window-click.node");
  execFileSync("xcrun", ["clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-framework", "AppKit", "-I", resolve(process.execPath, "../../include/node"),
    "e2e/fixtures/window-click.mm", "-o", addon]);
  await enableVoice(daemon);
  const app = await _electron.launch({ args: [resolve("."), "--user-data-dir=" + join(daemon.home, "chromium")],
    env: { ...process.env, HOME: daemon.home, MISSION_HOME: daemon.home,
      MISSION_PORT: new URL(daemon.baseURL).port, MISSION_DEV_SERVER_URL: daemon.baseURL } });
  let dragReleased: Promise<boolean> | undefined;
  let listener: Awaited<ReturnType<typeof beListener>> | undefined;
  try {
    listener = await beListener(daemon);
    const page = await app.firstWindow();
    // Real call detection on the host must not change the fixture microphone mode.
    expect((await page.request.put(daemon.baseURL + "/api/voice/config", { data: { autoMuteDuringCalls: false } })).ok()).toBe(true);
    for (const [id, enabled] of [["edge", true], ["status-line", false]] as const) {
      expect((await page.request.put(daemon.baseURL + "/api/voice/indicators", { data: { id, enabled } })).ok()).toBe(true);
    }
    const edge = page.locator("button.vi-edge");
    await expect(edge).toHaveAccessibleName("Voice: listening. Mute");
    await expect(page.locator("button.vi-status-line")).toHaveCount(0);
    const win = await app.browserWindow(page);
    await win.evaluate(win => win.show());
    for (const mode of ["muted", "listening"]) {
      await expect.poll(() => win.evaluate(win => {
        win.focus();
        return win.isFocused();
      }), { message: "AppKit needs a focused window for native edge-microphone clicks. Unlock the Mac desktop.", timeout: 5000 }).toBe(true);
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
    await test.step("Drag blank title-bar space below the edge tab", async step => {
      const header = page.locator("header.topbar");
      const point = await header.evaluate(bar => {
        const rect = bar.getBoundingClientRect();
        const y = rect.bottom - 3;
        for (let x = Math.floor(rect.width / 2); x > 90; x -= 4) {
          if (document.elementFromPoint(x, y) === bar) return { x, y };
        }
        throw new Error("No blank point below the edge microphone");
      });
      const before = await win.evaluate(win => win.getPosition());
      dragReleased = win.evaluate((win, { addon, point }) => {
        const binding = { exports: {} };
        process.dlopen(binding, addon);
        const drag = binding.exports as (handle: Buffer, x: number, y: number, drag: true) => false | Promise<true>;
        const zoom = win.webContents.getZoomFactor();
        // The native promise settles after the worker posts mouse-up.
        return drag(win.getNativeWindowHandle(), point.x * zoom, point.y * zoom, true);
      }, { addon, point });
      const posted = await dragReleased;
      if (!posted) {
        step.skip(!process.env.MC_E2E_MANUAL_WINDOW_DRAG, "Native hit test passed. Window movement requires desktop input permission or a manual drag.");
        await header.evaluate((bar, point) => {
          const rect = bar.getBoundingClientRect();
          bar.style.backgroundImage = `radial-gradient(circle at ${point.x - rect.left}px ${point.y - rect.top}px, lime 3px, transparent 4px)`;
        }, point);
        console.log("Drag the green point in the fixture title bar to move the window.");
      }
      const position = () => win.evaluate(win => win.getPosition());
      await expect.poll(position, { timeout: posted ? 5000 : 90000 }).not.toEqual(before);
      console.log("Native title-bar drag moved window", before, "to", await position());
    });
  } finally {
    listener?.stop();
    try {
      await dragReleased;
    } finally {
      await app.close();
    }
  }
});
