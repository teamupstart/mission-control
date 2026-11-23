import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
ensureNativeStateLockAddon();
const home = mkdtempSync(join(tmpdir(), "resident-state-"));
process.env.MISSION_HOME = home;
const { residentStateDir, ensureResidentState, removeResidentState, readResidentStateFile } = await import("../src/server/residents/state.ts");

test("profile state reuses identity, isolates profiles, and resets only owned contents", async () => {
  const first = ensureResidentState("profile-one");
  const second = ensureResidentState("profile-two");
  writeFileSync(join(first, "MEMORY.md"), "Remember the correction");
  writeFileSync(join(second, "ledger.txt"), "handled 42");
  assert.equal(ensureResidentState("profile-one"), first);
  assert.equal(readResidentStateFile("profile-one", "MEMORY.md"), "Remember the correction");
  assert.notEqual(first, second);
  symlinkSync(second, join(first, "outside"));
  assert.throws(() => readResidentStateFile("profile-one", "outside/ledger.txt"));
  for (const path of ["../profile-two/ledger.txt", "/etc/passwd", "", "x/../y"]) assert.throws(() => readResidentStateFile("profile-one", path));
  const exactLimit = "x".repeat(256 * 1024);
  writeFileSync(join(first, "exact-limit.txt"), exactLimit);
  assert.equal(readResidentStateFile("profile-one", "exact-limit.txt"), exactLimit, "a preview exactly 256 KiB long is returned intact");
  writeFileSync(join(first, "huge.txt"), "x".repeat(256 * 1024 + 1));
  assert.throws(() => readResidentStateFile("profile-one", "huge.txt"), /256 KiB/);
  await removeResidentState("profile-one", first);
  assert.equal(existsSync(first), false);
  assert.equal(ensureResidentState("profile-one"), first);
  assert.equal(readFileSync(join(second, "ledger.txt"), "utf8"), "handled 42");
  assert.ok(ensureResidentState("builtin:triage"));
});

test("profile state refuses symlink boundaries at every level", async () => {
  const foreign = mkdtempSync(join(home, "foreign-"));
  writeFileSync(join(foreign, "keep"), "safe");
  const parts = ["residents", "profiles", "boundary", "state"];
  for (let i = 0; i < parts.length; i++) {
    const boundary = join(home, ...parts.slice(0, i + 1));
    mkdirSync(dirname(boundary), { recursive: true });
    const existed = existsSync(boundary);
    if (existed) renameSync(boundary, boundary + "-saved");
    symlinkSync(foreign, boundary);
    try {
      assert.throws(() => ensureResidentState("boundary"), /owned directory/);
      await assert.rejects(() => removeResidentState("boundary", residentStateDir("boundary")), /owned directory/);
      assert.equal(readFileSync(join(foreign, "keep"), "utf8"), "safe");
    } finally {
      rmSync(boundary);
      if (existed) renameSync(boundary + "-saved", boundary);
    }
  }
});
