import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
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

test("both published Electron test commands run both preflights in order", () => {
  const packageJson = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const preflight =
    "node scripts/ensure-electron-framework.mjs && node scripts/ensure-electron-runtime.mjs";

  assert.equal(packageJson.scripts.pretest, preflight);
  assert.equal(packageJson.scripts["pretest:electron"], preflight);
});

test("the macOS pretest restores a missing Electron framework link", () => {
  mkdirSync(join(frameworkDir, "Versions/Current"), { recursive: true });
  writeFileSync(payload, "framework payload");

  assert.equal(ensureElectronFramework(root, "darwin"), "repaired");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), "Versions/Current/Electron Framework");
  assert.equal(existsSync(link), true, "the restored link must resolve to the payload");
  assert.equal(ensureElectronFramework(root, "darwin"), "present");
});

test("the macOS pretest repairs a missing framework payload before validating it", () => {
  const incomplete = mkdtempSync(join(tmpdir(), "mission-electron-incomplete-"));
  const incompletePayload = join(
    incomplete,
    "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current/Electron Framework",
  );
  const repairedPackageDirs: string[] = [];
  try {
    assert.equal(
      ensureElectronFramework(incomplete, "darwin", {
        repairRuntime(electronPackageDir) {
          repairedPackageDirs.push(electronPackageDir);
          mkdirSync(join(incompletePayload, ".."), { recursive: true });
          writeFileSync(incompletePayload, "reinstalled framework payload");
        },
      }),
      "repaired",
    );
    assert.deepEqual(repairedPackageDirs, [join(incomplete, "node_modules", "electron")]);
    assert.equal(existsSync(incompletePayload), true);
  } finally {
    rmSync(incomplete, { recursive: true, force: true });
  }
});

test("the pretest fails closed when runtime repair leaves the payload incomplete", () => {
  const incomplete = mkdtempSync(join(tmpdir(), "mission-electron-incomplete-"));
  try {
    assert.equal(ensureElectronFramework(incomplete, "linux"), "not-applicable");
    assert.throws(
      () =>
        ensureElectronFramework(incomplete, "darwin", {
          repairRuntime() {},
        }),
      /framework payload is incomplete.*runtime repair did not restore it/i,
    );
  } finally {
    rmSync(incomplete, { recursive: true, force: true });
  }
});

test("the pretest refuses every unexpected resolving framework entry", () => {
  for (const kind of ["file", "directory", "symlink"] as const) {
    const corruptRoot = mkdtempSync(join(tmpdir(), `mission-electron-${kind}-`));
    const corruptFramework = join(
      corruptRoot,
      "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework",
    );
    const corruptPayload = join(corruptFramework, "Versions/Current/Electron Framework");
    const corruptLink = join(corruptFramework, "Electron Framework");

    try {
      mkdirSync(join(corruptFramework, "Versions/Current"), { recursive: true });
      writeFileSync(corruptPayload, "framework payload");
      if (kind === "file") writeFileSync(corruptLink, "not a framework link");
      if (kind === "directory") mkdirSync(corruptLink);
      if (kind === "symlink") {
        writeFileSync(join(corruptFramework, "unrelated"), "unrelated payload");
        symlinkSync("unrelated", corruptLink);
      }

      assert.throws(
        () => ensureElectronFramework(corruptRoot, "darwin"),
        /refusing to replace unexpected Electron framework entry/i,
        kind,
      );
    } finally {
      rmSync(corruptRoot, { recursive: true, force: true });
    }
  }
});
