import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("the app menu and tray expose the same native update command seam", () => {
  // The menu's ITEMS live in `menu-template.ts` - `menu.ts` is now only the install, so the
  // Check for Updates item is looked for where it is declared. Splitting the template out is
  // what made the desktop menu's accelerators unit-testable (`app-menu-template.test.ts`);
  // this seam is unchanged by it, and reads the same handler through the same interface.
  const menu = source("../src/main/menu-template.ts");
  const tray = source("../src/main/tray.ts");
  const index = source("../src/main/index.ts");

  for (const nativeSurface of [menu, tray]) {
    assert.match(nativeSurface, /label: "Check for Updates…"/);
    assert.match(nativeSurface, /handlers\.onCheckForUpdates\(\)/);
  }
  assert.match(index, /const onCheckForUpdates = \(\) => void updater\?\.checkForUpdates\(\)/);
  assert.match(index, /installAppMenu\(\{ onOpenSettings: openSettings, onCheckForUpdates \}\)/);
  assert.match(index, /createTray[\s\S]*onCheckForUpdates/);
  // What the command opens is a Mission Control modal, drawn by the dashboard. The helper
  // that used to route these to `dialog.showMessageBox` - parented to the window when it was
  // visible, parentless when it was not - is gone with the platform sheet itself, so the
  // menu and tray reach the presenter instead. `showIntegrationResult` still owns the only
  // message box left in this file, and it is not an update surface.
  assert.doesNotMatch(index, /showNativeMessage/);
  assert.match(index, /const updateDialogPresenter = new UpdateDialogPresenter\(/);
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
