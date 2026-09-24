import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import childProcess, { spawnSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdPiGeneration, removeIdlePiGeneration } from "../src/pi/generation-lease.ts";

const root = mkdtempSync(join(tmpdir(), "pi-generation-lease-"));
const buildId = "a".repeat(64);
const generation = join(root, buildId);
beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(generation, { recursive: true });
  writeFileSync(join(generation, "mcp-server.mjs"), "bridge");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("lease identity uses the catalog-selected process utility and its child environment", t => {
  const previous = process.env.MISSION_PS_BIN;
  const executable = join(root, "configured-ps");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  process.env.MISSION_PS_BIN = executable;
  const probe = t.mock.method(childProcess, "execFileSync", (command: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => {
    assert.equal(command, executable);
    assert.deepEqual(args, ["-o", "lstart=", "-p", String(process.pid)]);
    assert.equal(options.env?.MISSION_PS_BIN, executable);
    assert.equal(options.timeout, 1000);
    return "Thu Sep 24 12:00:00 2026";
  }); syncBuiltinESMExports();
  try {
    holdPiGeneration(generation, buildId);
    assert.equal(removeIdlePiGeneration(generation), false);
    assert.ok(probe.mock.callCount() >= 2, "both lease creation and cleanup resolve the utility");
  } finally {
    if (previous === undefined) delete process.env.MISSION_PS_BIN; else process.env.MISSION_PS_BIN = previous;
    probe.mock.restore(); syncBuiltinESMExports();
  }
});

test("collection preserves a live lease and fails closed on an unknown or linked lease directory", () => {
  holdPiGeneration(generation, buildId);
  holdPiGeneration(generation, buildId);
  assert.equal(readdirSync(join(generation, ".leases")).length, 1, "one lease per process, including repeated loads");
  assert.equal(removeIdlePiGeneration(generation), false);
  const leases = join(generation, ".leases");
  rmSync(leases, { recursive: true }); mkdirSync(leases);
  writeFileSync(join(leases, "unknown"), "unreadable identity");
  assert.equal(removeIdlePiGeneration(generation), false);
  rmSync(leases, { recursive: true });
  const foreign = join(root, "foreign"); mkdirSync(foreign);
  symlinkSync(foreign, leases);
  assert.equal(removeIdlePiGeneration(generation), false);
  assert.equal(existsSync(join(generation, "mcp-server.mjs")), true);
});

test("a process killed during lease writing cannot pin a generation forever", () => {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(child.status, 0);
  const leases = join(generation, ".leases"); mkdirSync(leases);
  writeFileSync(join(leases, `${child.pid}-abcd.json`), '{"pid":');
  assert.equal(removeIdlePiGeneration(generation), true);
  assert.equal(existsSync(generation), false);
});

test("a lease arriving between collection scans protects the generation", t => {
  const open = fs.openSync;
  const fault = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    // This is the last point before the collector excludes new users. An import
    // completing now must be observed by its second scan.
    if (String(args[0]) === join(generation, ".retiring")) holdPiGeneration(generation, buildId);
    return open(...args);
  }); syncBuiltinESMExports();
  try {
    assert.equal(removeIdlePiGeneration(generation), false);
    assert.equal(existsSync(join(generation, ".retiring")), false);
    assert.equal(readdirSync(join(generation, ".leases")).length, 1);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

test("an import after collection claims a generation refuses use without recreating it", t => {
  const remove = fs.rmSync;
  const fault = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]) === generation) assert.throws(() => holdPiGeneration(generation, buildId), /being retired/);
    return remove(...args);
  }); syncBuiltinESMExports();
  try {
    assert.equal(removeIdlePiGeneration(generation), true);
    assert.throws(() => holdPiGeneration(generation, buildId), /ENOENT/);
    assert.equal(existsSync(generation), false);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});
