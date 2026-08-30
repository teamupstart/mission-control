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
  assert.ok(
    index.indexOf("updater = new UpdateController") <
      index.indexOf("const background = await backgroundStart.ready"),
    "native update commands must remain available even when daemon startup fails",
  );
  assert.match(index, /before-quit[\s\S]*backgroundStart\?\.stop\(\)/);
});
