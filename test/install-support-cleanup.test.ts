import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markRetainedInstaller, removeSupersededInstaller } from "../scripts/install-app.mjs";
import { writeReceipt } from "../src/shared/install-receipt.mjs";
import { CANONICAL_REPO } from "../src/shared/install-receipt-schema.mjs";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "mission-installer-cleanup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, "state");
  const installers = join(stateDirectory, "installers");
  mkdirSync(installers, { recursive: true });
  const previousSource = mkdtempSync(join(installers, "installer-"));
  const replacementSource = mkdtempSync(join(installers, "installer-"));
  markRetainedInstaller(previousSource);
  markRetainedInstaller(replacementSource);
  writeFileSync(join(previousSource, "keep"), "old installer");
  const receiptPath = join(stateDirectory, "install-receipt.json");
  const record = (sourceClone: string) => writeReceipt({
    schema: 1, repo: CANONICAL_REPO, releaseTag: "v1.2.3", installedVersion: "1.2.3",
    sourceClone, appPath: join(directory, "Mission Control.app"), installedAt: new Date().toISOString(),
  }, receiptPath);
  record(replacementSource);
  const cleanup = (previous = previousSource, replacement = replacementSource) => removeSupersededInstaller({
    previousSource: previous, replacementSource: replacement, stateDirectory,
  });
  return { directory, installers, previousSource, replacementSource, receiptPath, record, cleanup };
}

for (const receiptState of ["still referenced", "alias still referenced", "missing", "invalid", "changed"]) {
  test(`retained installer survives when the receipt is ${receiptState}`, (t) => {
    const f = fixture(t);
    let replacement = f.replacementSource;
    if (receiptState === "still referenced") f.record(f.previousSource);
    else if (receiptState === "alias still referenced") {
      replacement = join(f.directory, "current-alias");
      symlinkSync(f.previousSource, replacement, "dir");
      f.record(replacement);
    } else if (receiptState === "missing") rmSync(f.receiptPath);
    else if (receiptState === "invalid") writeFileSync(f.receiptPath, "{}");
    else f.record(join(f.directory, "another-installer"));
    assert.equal(f.cleanup(f.previousSource, replacement), null);
    assert.equal(readFileSync(join(f.previousSource, "keep"), "utf8"), "old installer");
  });
}

for (const sourceType of ["external", "unmarked", "copied marker", "symlink", "symlink parent", "nested"]) {
  test(`retained installer cleanup preserves an arbitrary ${sourceType} source`, (t) => {
    const f = fixture(t);
    let previous = f.previousSource;
    let preserved = f.previousSource;
    if (sourceType === "external" || sourceType === "nested") {
      const parent = sourceType === "external" ? f.directory : f.previousSource;
      previous = mkdtempSync(join(parent, "installer-"));
      preserved = previous;
      markRetainedInstaller(previous);
      writeFileSync(join(previous, "keep"), "old installer");
    } else if (sourceType === "unmarked") {
      rmSync(join(previous, ".mission-control-installer"));
    } else if (sourceType === "copied marker") {
      writeFileSync(join(previous, ".mission-control-installer"), readFileSync(join(f.replacementSource, ".mission-control-installer")));
    } else if (sourceType === "symlink") {
      previous = join(f.installers, "installer-ALIAS1");
      symlinkSync(f.previousSource, previous, "dir");
    } else {
      const moved = join(f.directory, "relocated-installers");
      renameSync(f.installers, moved);
      symlinkSync(moved, f.installers, "dir");
    }
    assert.equal(f.cleanup(previous), null);
    assert.equal(readFileSync(join(preserved, "keep"), "utf8"), "old installer");
    assert.ok(existsSync(f.replacementSource));
  });
}

test("a cleanup permission failure reports a warning without undoing the new receipt", (t) => {
  if (process.getuid?.() === 0) return t.skip("root can remove a read-only directory");
  const f = fixture(t);
  const receipt = readFileSync(f.receiptPath, "utf8");
  chmodSync(f.previousSource, 0o500);
  try {
    assert.match(f.cleanup()!, /could not remove superseded updater installer/);
    assert.equal(readFileSync(f.receiptPath, "utf8"), receipt);
    assert.ok(existsSync(f.replacementSource));
  } finally {
    chmodSync(f.previousSource, 0o700);
  }
});
