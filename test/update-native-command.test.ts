import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("the app menu and tray expose the same native update command seam", () => {
  const menu = source("../src/main/menu.ts");
  const tray = source("../src/main/tray.ts");
  const index = source("../src/main/index.ts");

  for (const nativeSurface of [menu, tray]) {
    assert.match(nativeSurface, /label: "Check for Updates…"/);
    assert.match(nativeSurface, /handlers\.onCheckForUpdates\(\)/);
  }
  assert.match(index, /const onCheckForUpdates = \(\) => void updater\?\.checkForUpdates\(\)/);
  assert.match(index, /installAppMenu\(\{ onOpenSettings: openSettings, onCheckForUpdates \}\)/);
  assert.match(index, /createTray[\s\S]*onCheckForUpdates/);
  assert.match(
    index,
    /win\?\.isVisible\(\) \? dialog\.showMessageBox\(win, options\) : dialog\.showMessageBox\(options\)/,
  );
  const updaterStart = index.indexOf("updater = new UpdateController");
  const backgroundReady = index.indexOf("const background = await backgroundStart.ready");
  assert.notEqual(updaterStart, -1, "the native updater must be constructed");
  assert.notEqual(backgroundReady, -1, "background startup must expose its readiness boundary");
  assert.ok(
    updaterStart < backgroundReady,
    "native update commands must remain available even when daemon startup fails",
  );
  assert.match(index, /before-quit[\s\S]*backgroundStart\?\.stop\(\)/);
});
