import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureElectronFramework } from "../scripts/ensure-electron-framework.mjs";

const root = mkdtempSync(join(tmpdir(), "mission-electron-install-"));
after(() => rmSync(root, { recursive: true, force: true }));

const frameworkDir = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework",
);
const payload = join(frameworkDir, "Versions/Current/Electron Framework");
const link = join(frameworkDir, "Electron Framework");

test("the macOS pretest restores a missing Electron framework link", () => {
  mkdirSync(join(frameworkDir, "Versions/Current"), { recursive: true });
  writeFileSync(payload, "framework payload");

  assert.equal(ensureElectronFramework(root, "darwin"), "repaired");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "Versions/Current/Electron Framework");
  assert.equal(existsSync(link), true, "the restored link must resolve to the payload");
  assert.equal(ensureElectronFramework(root, "darwin"), "present");
});

test("the pretest does not invent a framework payload or change other platforms", () => {
  const incomplete = mkdtempSync(join(tmpdir(), "mission-electron-incomplete-"));
  try {
    assert.equal(ensureElectronFramework(incomplete, "linux"), "not-applicable");
    assert.throws(
      () => ensureElectronFramework(incomplete, "darwin"),
      /framework payload is incomplete.*npm install/i,
    );
  } finally {
    rmSync(incomplete, { recursive: true, force: true });
  }
});
