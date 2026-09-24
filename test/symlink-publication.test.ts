import assert from "node:assert/strict";
import test from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSymlinkNoReplace, validateNativeSymlinkPublicationBinding } from "../src/server/symlink-publication.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";

ensureNativeStateLockAddon();

test("native publication preserves the private symlink inode, including dangling targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-publication-"));
  try {
    for (const present of [true, false]) {
      const target = join(root, `target-${present}`);
      if (present) writeFileSync(target, "extension");
      const staged = join(root, `staged-${present}`);
      const published = join(root, `published-${present}`);
      symlinkSync(target, staged);
      const before = lstatSync(staged);
      publishSymlinkNoReplace(staged, published);
      assert.equal(lstatSync(published).isSymbolicLink(), true);
      assert.equal(lstatSync(published).ino, before.ino);
      assert.equal(lstatSync(published).dev, before.dev);
      assert.equal(readlinkSync(published), target);
      rmSync(staged);
      assert.equal(readlinkSync(published), target, "private staging cleanup preserves the published link");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native publication refuses occupied files, directories and symlinks without touching them", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-refusal-"));
  try {
    const staged = join(root, "staged"); symlinkSync(join(root, "absent"), staged);
    for (const kind of ["file", "directory", "symlink"]) {
      const destination = join(root, kind);
      if (kind === "file") writeFileSync(destination, "operator bytes");
      else if (kind === "directory") mkdirSync(destination);
      else symlinkSync(join(root, "foreign"), destination);
      const before = lstatSync(destination);
      assert.throws(() => publishSymlinkNoReplace(staged, destination), { code: "EEXIST" });
      assert.equal(lstatSync(destination).ino, before.ino);
      if (kind === "directory") assert.deepEqual(readdirSync(destination), []);
      else if (kind === "file") assert.equal(readFileSync(destination, "utf8"), "operator bytes");
      else assert.equal(readlinkSync(destination), join(root, "foreign"));
    }
    const regular = join(root, "regular"); writeFileSync(regular, "not a symlink");
    assert.throws(() => publishSymlinkNoReplace(regular, join(root, "new")), /source must be a symlink/);
    assert.equal(lstatSync(join(root, "new"), { throwIfNoEntry: false }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an outdated native addon fails closed instead of falling back to unsafe publication", () => {
  assert.throws(() => validateNativeSymlinkPublicationBinding({}), /must export linkSymlinkNoReplace/);
});
