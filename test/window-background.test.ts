import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOW_BACKGROUND_FALLBACK,
  parseWindowBackground,
  registerWindowBackgroundIpc,
  rememberWindowBackground,
  windowSchemeFor,
  readWindowBackground,
  windowBackgroundPath,
  writeWindowBackground,
} from "../src/server/window-background.ts";
import { toHexColor } from "../src/web/lib/skin.ts";
import { startupPage } from "../src/main/startup-page.ts";
import { SKINS } from "../src/shared/skins.ts";

// What is at stake: the desktop window paints before the dashboard has loaded. Under a light
// skin that first frame has to be the skin's background, or every launch opens on a dark
// flash. The renderer reports the colour; this is what remembers it, and what refuses a value
// that is not a colour before it reaches `BrowserWindow`.

const dir = mkdtempSync(join(tmpdir(), "mission-window-background-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a launch with nothing remembered opens in the pre-skin colour", () => {
  assert.equal(readWindowBackground(windowBackgroundPath(join(dir, "missing"))), WINDOW_BACKGROUND_FALLBACK);
  assert.equal(WINDOW_BACKGROUND_FALLBACK, "#0e1116");
});

test("the last applied background is what the next launch opens in", () => {
  const path = windowBackgroundPath(join(dir, "state"));
  assert.equal(writeWindowBackground(path, "#F5F7FA"), "#f5f7fa");
  assert.equal(readWindowBackground(path), "#f5f7fa");
  writeWindowBackground(path, "#0a0c0f");
  assert.equal(readWindowBackground(path), "#0a0c0f");
  assert.equal(readFileSync(path, "utf8"), '{"color":"#0a0c0f"}\n');
});

test("anything but #rrggbb is refused, and a corrupt file reads as the fallback", () => {
  for (const bad of ["#fff", "white", "rgb(0, 0, 0)", "#0a0c0f; x", 42, null]) {
    assert.equal(parseWindowBackground(bad), null, `${String(bad)} was accepted`);
    assert.throws(() => writeWindowBackground(join(dir, "bad.json"), bad));
  }
  const path = join(dir, "corrupt.json");
  writeFileSync(path, '{"color":"url(evil)"}');
  assert.equal(readWindowBackground(path), WINDOW_BACKGROUND_FALLBACK);
  writeFileSync(path, "not json");
  assert.equal(readWindowBackground(path), WINDOW_BACKGROUND_FALLBACK);
});

test("the renderer converts a computed token to the #rrggbb main accepts", () => {
  assert.equal(toHexColor(" #F5F7FA "), "#f5f7fa");
  assert.equal(toHexColor("#fff"), "#ffffff");
  assert.equal(toHexColor("rgb(10, 12, 15)"), "#0a0c0f");
  assert.equal(toHexColor("rgba(245, 247, 250, 1)"), "#f5f7fa");
  assert.equal(toHexColor("var(--bg)"), null);
  assert.equal(toHexColor("rgb(300, 0, 0)"), null);
});

test("the main-process handler repaints and remembers only the dashboard's own valid colour", async () => {
  // The handler `index.ts` registers, driven with stand-ins for ipcMain and the window.
  type Listener = (event: { sender: unknown }, color: unknown) => unknown;
  let listener: Listener | undefined;
  const ipc = { handle: (channel: string, fn: Listener) => { assert.equal(channel, "mission:set-window-background"); listener = fn; } };
  const contents = { id: "dashboard" };
  const painted: string[] = [];
  let window: { webContents: unknown; setBackgroundColor(c: string): void } | null = {
    webContents: contents,
    setBackgroundColor: (c) => void painted.push(c),
  };
  const path = windowBackgroundPath(join(dir, "ipc"));
  registerWindowBackgroundIpc(ipc, () => window, () => path);
  assert.ok(listener, "nothing was registered on the channel");
  const send = (sender: unknown, color: unknown) => listener!({ sender }, color);

  // The dashboard reports Daylight: the live window repaints and the next launch will open in it.
  await send(contents, "#F5F7FA");
  assert.deepEqual(painted, ["#f5f7fa"]);
  assert.equal(readWindowBackground(path), "#f5f7fa");

  // The same colour again repaints but does not rewrite the file.
  writeFileSync(path, '{"color":"#123456"}');
  await send(contents, "#f5f7fa");
  assert.deepEqual(painted, ["#f5f7fa", "#f5f7fa"]);
  assert.equal(readWindowBackground(path), "#123456", "an unchanged colour was written again");
  writeWindowBackground(path, "#f5f7fa");

  // Anything but #rrggbb is refused before it reaches the window or the file.
  assert.throws(() => send(contents, "url(evil)"), /#rrggbb/);
  assert.throws(() => send(contents, "#fff"), /#rrggbb/);
  assert.deepEqual(painted, ["#f5f7fa", "#f5f7fa"]);

  // Another sender - a second window, a preview, an iframe's contents - changes nothing.
  assert.equal(await send({ id: "someone-else" }, "#0a0c0f"), undefined);
  assert.deepEqual(painted, ["#f5f7fa", "#f5f7fa"]);
  assert.equal(readWindowBackground(path), "#f5f7fa");

  // And with no main window there is nothing to repaint or remember.
  window = null;
  await send(contents, "#0a0c0f");
  assert.equal(readWindowBackground(path), "#f5f7fa");
});

test("a colour is remembered only when it changed", () => {
  const path = windowBackgroundPath(join(dir, "remember"));
  assert.equal(rememberWindowBackground(path, "#f5f7fa"), true);
  assert.equal(rememberWindowBackground(path, "#F5F7FA"), false, "an unchanged colour was rewritten");
  assert.equal(rememberWindowBackground(path, "#0a0c0f"), true);
  assert.throws(() => rememberWindowBackground(path, "white"));
  assert.equal(readWindowBackground(path), "#0a0c0f");
});

test("the startup page the shell shows first paints on the remembered background", () => {
  // Every launch shows this page before the dashboard answers. Dark under a light skin, it is
  // the dark flash the window's own background exists to prevent.
  for (const skin of SKINS) assert.equal(windowSchemeFor(skin.swatches.bg), skin.colorScheme, `${skin.id}'s background reads as the wrong scheme`);
  const light = startupPage("starting", null, "#f5f7fa");
  assert.match(light, /:root\{color-scheme:light;color:#141a22;background:#f5f7fa\}/);
  const dark = startupPage("starting", null, "#0a0c0f");
  assert.match(dark, /:root\{background:#0a0c0f\}/);
  assert.doesNotMatch(dark, /color-scheme:light/);
  // Nothing but a #rrggbb colour reaches the page's CSS.
  const hostile = startupPage("starting", null, "red;}</style><script>x</script>");
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /:root\{background:#0e1116\}/);
  assert.match(startupPage("starting"), /:root\{background:#0e1116\}/, "no colour means the original dark page");
});
