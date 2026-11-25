import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";
import { _electron, expect } from "@playwright/test";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

test("native voice windows follow content, the pointer display and tray anchor with the dashboard minimized", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async t => {
  assertElectronGuiLaunchAllowed();
  const dir = mkdtempSync(join(tmpdir(), "voice-windows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "surface.cjs");
  const entry = join(dir, "fixture.cjs");
  buildSync({ entryPoints: ["src/preload/voice-surface.ts"], bundle: true, platform: "node", external: ["electron"], outfile: preload });
  buildSync({ stdin: { resolveDir: resolve("."), contents: `
    import { app, screen, BrowserWindow } from "electron";
    import { attachVoiceWindow, voiceWindowOptions } from "./src/main/voice-windows.ts";
    import {createServer} from "node:http";
    app.whenReady().then(async () => {
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("<title>" + req.url.slice(1) + "</title><style>*{margin:0}</style><div id=root></div>");
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = "http://127.0.0.1:" + server.address().port;
      const main = new BrowserWindow();
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const tray = { x: area.x + 420, y: area.y - 24, width: 24, height: 24 };
      globalThis.fixtureTray = tray;
      main.webContents.setWindowOpenHandler(({frameName}) => ({action: "allow",
        overrideBrowserWindowOptions: voiceWindowOptions(frameName, ${JSON.stringify(preload)})}));
      main.webContents.on("did-create-window", (win, details) => {
        // Keep the request as well as the result: macOS can constrain a window itself.
        const setBounds = win.setBounds.bind(win);
        win.setBounds = (bounds, animate) => {
          win.requestedBounds = bounds;
          setBounds(bounds, animate);
        };
        const ignore = win.setIgnoreMouseEvents.bind(win);
        win.hitTests = [];
        win.setIgnoreMouseEvents = (ignored, options) => {
          win.hitTests.push(ignored);
          ignore(ignored, options);
        };
        attachVoiceWindow(win, details.frameName, () => tray, details.url);
      });
      await main.loadURL(origin + "/Dashboard");
      main.minimize();
      for (const surface of ["pill","popover"]) {
        await main.webContents.executeJavaScript("void window.open('/" + surface + "', '" + surface + "')");
      }
    });` }, bundle: true, platform: "node", external: ["electron"], outfile: entry });
  const app = await _electron.launch({ args: [entry, "--user-data-dir=" + dir] });
  t.after(() => app.close());
  for (const surface of ["pill", "popover"]) {
    const read = () => app.evaluate(({ BrowserWindow, screen }, title) => {
      const wins = BrowserWindow.getAllWindows();
      const win = wins.find(w => w.getTitle() === title);
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      return win && { minimized: wins.find(w => w.getTitle() === "Dashboard")?.isMinimized(),
        area, bounds: win.getBounds(), visible: win.isVisible(), top: win.isAlwaysOnTop(), focusable: win.isFocusable(),
        hitTests: (win as Electron.BrowserWindow & { hitTests: boolean[] }).hitTests,
        requestedBounds: (win as Electron.BrowserWindow & { requestedBounds?: Electron.Rectangle }).requestedBounds,
        contentBounds: win.getContentBounds() };
    }, surface);
    await expect.poll(async () => (await read())?.visible).toBe(false);
    await expect.poll(async () => Promise.all(app.windows().map(page => page.title()))).toContain(surface);
    const found = app.windows().find(page => page.url().endsWith("/" + surface));
    assert.ok(found);
    await found.locator("#root").evaluate(el => { el.innerHTML = '<article class="voice-standalone voice-card" style="height:81px;width:120px">Cancel</article>'; });
    await expect.poll(async () => (await read())?.visible).toBe(true);
    const shown = (await read())!;
    assert.ok(shown.minimized);
    assert.deepEqual(shown.bounds, shown.contentBounds, "a frameless window has no title bar inset");
    assert.ok(shown.top);
    assert.equal(shown.focusable, surface === "popover");
    assert.equal(shown.bounds.height, 81);
    assert.equal(shown.bounds.y, shown.area.y);
    assert.equal(shown.bounds.x, surface === "pill" ? Math.round(shown.area.x + (shown.area.width - shown.bounds.width) / 2)
      : shown.area.x + 432 - shown.bounds.width + 48);
    await expect.poll(() => found.evaluate(() => document.elementFromPoint(10, 10)?.className)).toContain("voice-card");
    // CDP mouse.move does not move the physical pointer used by the main-process
    // stationary-pointer check. Feed the coordinates of forwarded mouse moves.
    const move = (x: number) => found.evaluate(x => document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: x, clientY: 10 })), x);
    const before = (await read())!.hitTests.length;
    await move(10);
    await expect.poll(async () => (await read())?.hitTests.slice(before)).toContain(false);
    await move(150);
    await expect.poll(async () => (await read())?.hitTests.at(-1)).toBe(true);
    if (surface === "popover") {
      const { area, bounds } = shown;
      for (const edge of ["left", "right"] as const) {
        await t.test(`oversized popover fits the work area at the ${edge} tray edge`, async () => {
          await app.evaluate((_, { area, edge }) => {
            const tray = (globalThis as unknown as { fixtureTray: Electron.Rectangle }).fixtureTray;
            tray.x = edge === "left" ? area.x : area.x + area.width - tray.width;
            tray.y = area.y;
          }, { area, edge });
          // Different heights trigger a fresh renderer measurement at each edge.
          const height = area.height + (edge === "left" ? 100 : 200);
          await found.locator(".voice-card").evaluate((el, px) => { el.style.height = px + "px"; }, height);
          const expected = {
            x: edge === "left" ? area.x : area.x + area.width - bounds.width,
            y: area.y + 24, width: bounds.width, height: area.height - 24,
          };
          await expect.poll(async () => (await read())?.requestedBounds).toEqual(expected);
          const visible = (await read())!;
          assert.ok(visible.visible);
          assert.deepEqual(visible.bounds, expected);
        });
      }
    }
    await found.locator("#root").evaluate(el => el.replaceChildren());
    await expect.poll(async () => (await read())?.visible).toBe(false);
  }
});
