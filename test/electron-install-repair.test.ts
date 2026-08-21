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

import {
  electronPayloadPresent,
  ensureElectronFramework,
  restoreElectronPayload,
} from "../scripts/ensure-electron-framework.mjs";

const root = mkdtempSync(join(tmpdir(), "mission-electron-install-"));
after(() => rmSync(root, { recursive: true, force: true }));

const frameworkDir = join(
  root,
  "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework",
);
const payload = join(frameworkDir, "Versions/Current/Electron Framework");
const link = join(frameworkDir, "Electron Framework");

test("both published Electron test commands run both preflights in repair order", () => {
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

test("the macOS pretest restores a missing current-version link", () => {
  const copiedRoot = mkdtempSync(join(tmpdir(), "mission-electron-current-"));
  const copiedFramework = join(
    copiedRoot,
    "node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework",
  );
  const copiedPayload = join(copiedFramework, "Versions/A/Electron Framework");
  const copiedCurrent = join(copiedFramework, "Versions/Current");
  const copiedLink = join(copiedFramework, "Electron Framework");

  try {
    mkdirSync(join(copiedFramework, "Versions/A"), { recursive: true });
    writeFileSync(copiedPayload, "framework payload");
    symlinkSync("Versions/Current/Electron Framework", copiedLink);

    assert.equal(ensureElectronFramework(copiedRoot, "darwin"), "repaired");
    assert.equal(lstatSync(copiedCurrent).isSymbolicLink(), true);
    assert.equal(readlinkSync(copiedCurrent), "A");
    assert.equal(existsSync(copiedLink), true, "both framework links must resolve to the payload");
    assert.equal(ensureElectronFramework(copiedRoot, "darwin"), "present");
  } finally {
    rmSync(copiedRoot, { recursive: true, force: true });
  }
});

test("the pretest does not invent a framework payload or change other platforms", () => {
  const incomplete = mkdtempSync(join(tmpdir(), "mission-electron-incomplete-"));
  try {
    assert.equal(ensureElectronFramework(incomplete, "linux"), "not-applicable");
    assert.throws(
      () => ensureElectronFramework(incomplete, "darwin"),
      /framework payload is incomplete/i,
    );
  } finally {
    rmSync(incomplete, { recursive: true, force: true });
  }
});

/**
 * What is at stake: the advice this preflight used to print could not clear the state it
 * diagnosed. `npm install` resolves `electron` against the lockfile, finds the package
 * directory present and matching, and skips the postinstall that downloads the 192 MB
 * payload - so a checkout missing only `dist/` stayed broken through any number of installs,
 * while the error confidently told the reader to run one. A fresh worktree-pool slot reaches
 * that state routinely, which is how the same failure arrived from a different slot twice.
 */
test("the incomplete-payload error names a repair that actually works", () => {
  const incomplete = mkdtempSync(join(tmpdir(), "mission-electron-advice-"));
  try {
    assert.throws(() => ensureElectronFramework(incomplete, "darwin"), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // The one repair that clears this: Electron's own installer, which is what npm's
      // postinstall would have run and which extracts from the local cache when it can.
      assert.match(message, /node_modules\/electron\/install\.js/);
      // And it must not send the reader back to the command that demonstrably does nothing
      // here. Pinned as a negative because the wrong advice is what the incident was.
      assert.doesNotMatch(
        message,
        /run npm install again/i,
        "npm install does not restore a missing dist/ - the error must not claim it does",
      );
      return true;
    });
  } finally {
    rmSync(incomplete, { recursive: true, force: true });
  }
});

test("payload presence is reported per platform, and healing is refused without a package", () => {
  const empty = mkdtempSync(join(tmpdir(), "mission-electron-empty-"));
  try {
    // Non-darwin has no framework to guard, so it is vacuously present and nothing is spawned.
    assert.equal(electronPayloadPresent(empty, "linux"), true);
    assert.equal(electronPayloadPresent(empty, "darwin"), false);
    assert.equal(restoreElectronPayload(empty, "linux"), "not-applicable");

    // No `electron` package at all is a DIFFERENT fault from one missing its payload, and
    // running an installer that is not there is not the answer to it. It must say so rather
    // than fail as a spawn error the reader has to decode.
    assert.throws(
      () => restoreElectronPayload(empty, "darwin"),
      /Electron is not installed.*run npm install/is,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a complete payload is reported present and needs no healing", () => {
  // `root` was given a real payload by the restore test above, so this also pins that the
  // presence probe and the framework check agree about the same tree.
  assert.equal(electronPayloadPresent(root, "darwin"), true);
  assert.equal(ensureElectronFramework(root, "darwin"), "present");
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
