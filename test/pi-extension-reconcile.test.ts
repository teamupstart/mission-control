import { writePiIntegration } from "./helpers/pi-integration.ts";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor } from "../src/shared/harness-capabilities.ts";
import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
import { mockSymlinkPublication } from "./helpers/symlink-publication.ts";

const home = mkdtempSync(join(tmpdir(), "mission-extension-reconcile-"));
process.env.MISSION_HOME = home;
delete process.env.PI_EXTENSIONS_DIR;
const target = join(home, "build", "extension.js");
process.env.MISSION_PI_EXTENSION = target;
const spec = capabilitiesFor("pi").extensions!;
const dir = join(home, spec.isolatedDirName);
const link = join(dir, spec.linkName);
const { extensionsDirFor, reconcileExtensionLink, uninstallExtensionLink } = await import("../src/server/skills/reconcile.ts");
const { PI_EXTENSION_OUTPUT, piExtensionPath } = await import("../src/server/config.ts");
const { applyPiExtensionConfig, getPiExtensionConfig, reconcilePiExtension } = await import("../src/server/extensions/config.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { closeDb, openDb } = await import("../src/server/db.ts");
ensureNativeStateLockAddon();
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => {
  delete process.env.PI_EXTENSIONS_DIR;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(home, "build"), { recursive: true });
  writePiIntegration(join(home, "build"));
});

test("extension resolver uses the shared override, isolated home, real home order", () => {
  assert.ok(spec.linkName.endsWith(".js"));
  assert.equal(capabilitiesFor("claude").extensions, null);
  assert.equal(capabilitiesFor("codex").extensions, null);
  process.env.PI_EXTENSIONS_DIR = join(home, "explicit");
  assert.equal(extensionsDirFor(spec), process.env.PI_EXTENSIONS_DIR);
  delete process.env.PI_EXTENSIONS_DIR;
  assert.equal(extensionsDirFor(spec), dir);
  const saved = ["MISSION_HOME", "FLEET_HOME", "HARNESS_HOME"].map((key) => [key, process.env[key]] as const);
  try {
    for (const [key] of saved) delete process.env[key];
    assert.equal(extensionsDirFor(spec), join(homedir(), ...spec.homeDir));
  } finally {
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
});

test("off on a new install writes nothing; install, repoint and uninstall are idempotent", () => {
  assert.equal(reconcileExtensionLink(false).changed, false);
  assert.equal(existsSync(dir), false);
  assert.equal(reconcileExtensionLink(true).changed, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(reconcileExtensionLink(true).changed, false);
  const prior = join(home, "previous.js");
  writeFileSync(prior, "export const missionControlBuild = {};\n");
  rmSync(link); symlinkSync(prior, link);
  assert.equal(reconcileExtensionLink(true).changed, true);
  assert.equal(readlinkSync(link), target);
  assert.equal(reconcileExtensionLink(true).changed, false);
  writeFileSync(join(dir, "operator.js"), "operator");
  assert.equal(uninstallExtensionLink().changed, true);
  assert.deepEqual(readdirSync(dir), ["operator.js"]);
  assert.equal(uninstallExtensionLink().changed, false);
});

for (const operation of ["symlinkSync", "exchangePaths"] as const) {
  test(`failed replacement ${operation} preserves the working link and enabled intent`, (t) => {
    const prior = join(home, "previous.js");
    const contents = "export const missionControlBuild = { previous: true };\n";
    writeFileSync(prior, contents);
    mkdirSync(dir);
    symlinkSync(prior, link);
    const before = lstatSync(link);
    const fail = () => {
      // The old implementation had already unlinked here when symlink creation failed.
      throw Object.assign(new Error("injected replacement I/O failure"), { code: "EIO" });
    };
    const fault = operation === "symlinkSync" ? t.mock.method(fs, operation, fail) : mockSymlinkPublication(t, operation, fail);
    syncBuiltinESMExports();
    try {
      // Persist intent before injecting rename failure into link publication only.
      writeFileSync(join(home, "pi-extension.json"), '{"enabled":true}\n');
      const result = reconcileExtensionLink(true);
      assert.equal(fault.mock.callCount(), 1, "the replacement reached the failing operation");
      assert.equal(result.changed, false);
      assert.deepEqual(result.linked, []);
      assert.deepEqual(result.unlinked, []);
      assert.deepEqual(result.blocked, [spec.linkName]);
      assert.deepEqual(result.problems, [`${link}: injected replacement I/O failure`]);
      assert.equal(lstatSync(link).ino, before.ino);
      assert.equal(readlinkSync(link), prior);
      assert.equal(readFileSync(link, "utf8"), contents);
      assert.deepEqual(readdirSync(dir), [spec.linkName], "staging leaves no residue");
      assert.deepEqual(getPiExtensionConfig(), { enabled: true });
    } finally {
      if (operation === "symlinkSync") t.mock.restoreAll(); else (fault as ReturnType<typeof mockSymlinkPublication>).restore();
      syncBuiltinESMExports();
    }
    const retried = reconcileExtensionLink(true);
    assert.deepEqual(retried.blocked, []);
    assert.equal(retried.changed, true);
    assert.equal(readlinkSync(link), target);
  });
}

test("real files, directories, foreign links and unknown dangling links are never modified", () => {
  mkdirSync(dir);
  const foreign = join(home, "foreign.js"); writeFileSync(foreign, "operator code");
  // Near misses for the moved-installation repair below. A dangling link is adopted only
  // when it points at our exact build output path, so each of these stays somebody else's.
  const unknownDangling = [
    join(home, "missing.js"),
    join(home, "pi-extension", "index.js"),
    join(home, "dist", "pi-extension", "other.js"),
    join(home, "dist", "pi-extensions", "index.js"),
    join(home, "dist", "index.js"),
  ];
  for (const kind of ["file", "directory", "link", ...unknownDangling]) {
    if (kind === "file") writeFileSync(link, "operator code");
    else if (kind === "directory") mkdirSync(link);
    else symlinkSync(kind === "link" ? foreign : kind, link);
    const before = lstatSync(link);
    for (const call of [() => reconcileExtensionLink(true), uninstallExtensionLink]) {
      const result = call();
      assert.equal(result.changed, false);
      assert.deepEqual(result.blocked, [spec.linkName]);
      assert.match(result.problems[0]!, /isn't ours/);
      assert.equal(lstatSync(link).ino, before.ino);
    }
    if (kind === "file") assert.equal(readFileSync(link, "utf8"), "operator code");
    rmSync(link, { recursive: kind === "directory" });
  }
});

test("fresh publication refuses an entry arriving while its link is still private", (t) => {
  const symlink = fs.symlinkSync;
  let arrival: fs.Stats | undefined;
  const fault = t.mock.method(fs, "symlinkSync", (...args: Parameters<typeof fs.symlinkSync>) => {
    symlink(...args);
    if (String(args[1]).includes("/.mission-extension-")) {
      writeFileSync(link, "concurrent operator file");
      arrival = lstatSync(link);
    }
  });
  syncBuiltinESMExports();
  const commit = t.mock.fn();
  try {
    const result = reconcileExtensionLink(true, target, commit);
    assert.ok(arrival);
    assert.deepEqual(result.blocked, [spec.linkName]);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(lstatSync(link).ino, arrival.ino);
    assert.equal(readFileSync(link, "utf8"), "concurrent operator file");
    assert.deepEqual(readdirSync(dir), [spec.linkName]);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
});

for (const replacement of ["file", "directory", "foreign-link", "same-target-link"] as const) {
  test(`replacement publication preserves a concurrent ${replacement} after its last identity read`, (t) => {
    mkdirSync(dir);
    const prior = join(home, "previous.js");
    writeFileSync(prior, "export const missionControlBuild = {};\n");
    symlinkSync(prior, link);
    const foreign = join(home, "foreign.js"); writeFileSync(foreign, "operator bytes");
    let concurrent: fs.Stats | undefined;
    const fault = mockSymlinkPublication(t, "exchangePaths", (exchange, from, to) => {
      fs.renameSync(link, join(dir, "displaced.js"));
      if (replacement === "file") writeFileSync(link, "operator bytes");
      else if (replacement === "directory") { mkdirSync(link); writeFileSync(join(link, "keep"), "directory bytes"); }
      else symlinkSync(replacement === "same-target-link" ? target : foreign, link);
      concurrent = lstatSync(link);
      exchange(from, to);
    });
    const commit = t.mock.fn();
    try {
      const result = reconcileExtensionLink(true, target, commit);
      assert.ok(concurrent);
      assert.equal(result.changed, false);
      assert.deepEqual(result.blocked, [spec.linkName]);
      assert.equal(commit.mock.callCount(), 0);
      assert.equal(lstatSync(link).ino, concurrent.ino);
      if (replacement === "file") assert.equal(readFileSync(link, "utf8"), "operator bytes");
      if (replacement.endsWith("link")) assert.equal(readlinkSync(link), replacement === "same-target-link" ? target : foreign);
      if (replacement === "directory") assert.equal(readFileSync(join(link, "keep"), "utf8"), "directory bytes");
      assert.equal(readdirSync(dir).some(name => name.startsWith(".mission-extension-")), false);
    } finally { fault.restore(); }
  });
}

for (const replacement of ["file", "directory", "foreign-link", "same-target-link", "missing"] as const) {
  test(`replacement publication retains the prior owned link when ${replacement} arrives after exchange`, (t) => {
    mkdirSync(dir);
    const prior = join(home, "previous.js"); writeFileSync(prior, "export const missionControlBuild = {};\n");
    symlinkSync(prior, link);
    const owned = lstatSync(link);
    const foreign = join(home, "foreign.js"); writeFileSync(foreign, "operator bytes");
    let concurrent: fs.Stats | undefined;
    const fault = mockSymlinkPublication(t, "exchangePaths", (exchange, from, to) => {
      exchange(from, to);
      fs.renameSync(link, join(dir, "displaced.js"));
      if (replacement === "file") writeFileSync(link, "operator bytes");
      else if (replacement === "directory") { mkdirSync(link); writeFileSync(join(link, "keep"), "directory bytes"); }
      else if (replacement !== "missing") symlinkSync(replacement === "same-target-link" ? target : foreign, link);
      concurrent = lstatSync(link, { throwIfNoEntry: false });
    });
    const commit = t.mock.fn();
    try {
      const result = reconcileExtensionLink(true, target, commit);
      assert.equal(commit.mock.callCount(), 0, "provenance fails before the first intent write");
      assert.equal(result.changed, false);
      assert.deepEqual(result.blocked, [spec.linkName]);
      const stages = readdirSync(dir).filter(name => name.startsWith(".mission-extension-"));
      if (replacement === "missing") {
        assert.equal(lstatSync(link).ino, owned.ino, "the exact prior link is restored when the path is free");
        assert.equal(readlinkSync(link), prior);
        assert.deepEqual(stages, []);
      } else {
        assert.ok(concurrent);
        assert.equal(lstatSync(link).ino, concurrent.ino);
        assert.equal(stages.length, 1);
        const recovery = join(dir, stages[0]!);
        assert.ok(result.problems[0]!.includes(recovery));
        assert.equal(lstatSync(join(recovery, "candidate")).ino, owned.ino);
        assert.equal(readlinkSync(join(recovery, "candidate")), prior);
        if (replacement === "file") assert.equal(readFileSync(link, "utf8"), "operator bytes");
        else if (replacement === "directory") assert.equal(readFileSync(join(link, "keep"), "utf8"), "directory bytes");
        else assert.equal(readlinkSync(link), replacement === "same-target-link" ? target : foreign);
      }
    } finally { fault.restore(); }
  });
}

for (const replacement of ["file", "foreign-link", "same-target-link"] as const) {
  for (const commitFails of [false, true]) {
    test(`fresh publication does not adopt a concurrent ${replacement} before ${commitFails ? "failing" : "successful"} intent commit`, (t) => {
      mkdirSync(dir);
      const foreign = join(home, "foreign.js"); writeFileSync(foreign, "operator code");
      const stat = fs.lstatSync;
      let concurrent: fs.Stats | undefined;
      const fault = t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
        if (String(args[0]) === link && !concurrent && stat(link, { throwIfNoEntry: false })) {
          fs.renameSync(link, join(dir, "displaced.js"));
          if (replacement === "file") writeFileSync(link, "operator code");
          else symlinkSync(replacement === "same-target-link" ? target : foreign, link);
          concurrent = stat(link);
        }
        return Reflect.apply(stat, fs, args);
      });
      syncBuiltinESMExports();
      const commit = t.mock.fn(() => { if (commitFails) throw new Error("intent commit failed"); });
      try {
        const result = reconcileExtensionLink(true, target, commit);
        assert.ok(concurrent, "replacement arrived before the first public-path identity read");
        assert.equal(commit.mock.callCount(), 0, "a replacement cannot authorize enabled intent");
        assert.deepEqual(result.blocked, [spec.linkName]);
        assert.equal(result.changed, false);
        assert.equal(stat(link).ino, concurrent.ino, "the replacement is not removed or overwritten");
        if (replacement === "file") assert.equal(readFileSync(link, "utf8"), "operator code");
        else assert.equal(readlinkSync(link), replacement === "same-target-link" ? target : foreign);
        assert.equal(readdirSync(dir).some(name => name.startsWith(".mission-extension-")), false);
      } finally { fault.mock.restore(); syncBuiltinESMExports(); }
    });
  }
}

for (const previous of [false, true]) {
  for (const conflict of ["withdrawal", "restoration"] as const) {
    test(`${previous ? "replacement" : "fresh"} rollback preserves arrivals during ${conflict}`, (t) => {
      mkdirSync(dir);
      const prior = join(home, "previous.js"); writeFileSync(prior, "export const missionControlBuild = {};\n");
      if (previous) symlinkSync(prior, link);
      const owned = lstatSync(link, { throwIfNoEntry: false });
      let arrival: fs.Stats | undefined;
      const fault = mockSymlinkPublication(t, "renameNoReplace", (rename, from, to) => {
        if (from === link) {
          fs.renameSync(link, join(dir, "displaced.js"));
          writeFileSync(link, "first concurrent bytes");
          arrival = lstatSync(link);
        } else if (conflict === "restoration" && to === link) {
          mkdirSync(link); writeFileSync(join(link, "keep"), "latest concurrent bytes");
        }
        rename(from, to);
      });
      try {
        const result = reconcileExtensionLink(true, target, () => { throw new Error("intent commit failed"); });
        assert.ok(arrival);
        assert.equal(result.changed, false);
        assert.equal(result.blocked.length, 1);
        const stages = readdirSync(dir).filter(name => name.startsWith(".mission-extension-"));
        if (conflict === "withdrawal") {
          assert.equal(lstatSync(link).ino, arrival.ino);
          assert.equal(readFileSync(link, "utf8"), "first concurrent bytes");
          assert.equal(stages.length, previous ? 1 : 0);
        } else {
          assert.equal(stages.length, 1);
          const recovery = join(dir, stages[0]!);
          assert.ok(result.problems[0]!.includes(recovery));
          assert.equal(lstatSync(join(recovery, "withdrawn")).ino, arrival.ino);
          assert.equal(readFileSync(join(recovery, "withdrawn"), "utf8"), "first concurrent bytes");
          assert.equal(readFileSync(join(link, "keep"), "utf8"), "latest concurrent bytes");
        }
        if (previous) {
          const recovery = join(dir, stages[0]!);
          assert.ok(result.problems[0]!.includes(recovery));
          assert.equal(lstatSync(join(recovery, "candidate")).ino, owned!.ino);
          assert.equal(readlinkSync(join(recovery, "candidate")), prior);
        }
      } finally { fault.restore(); }
    });
  }
}

test("a second arrival blocks restoration of a foreign swap victim without deleting either entry", (t) => {
  mkdirSync(dir);
  const prior = join(home, "previous.js"); writeFileSync(prior, "export const missionControlBuild = {};\n");
  symlinkSync(prior, link);
  let first: fs.Stats | undefined;
  let latest: fs.Stats | undefined;
  const swap = mockSymlinkPublication(t, "exchangePaths", (exchange, from, to) => {
    fs.renameSync(link, join(dir, "displaced.js"));
    mkdirSync(link); writeFileSync(join(link, "keep"), "first operator directory");
    first = lstatSync(link);
    exchange(from, to);
  });
  const restore = mockSymlinkPublication(t, "renameNoReplace", (rename, from, to) => {
    if (to === link) { writeFileSync(link, "latest operator file"); latest = lstatSync(link); }
    rename(from, to);
  });
  const commit = t.mock.fn();
  try {
    const result = reconcileExtensionLink(true, target, commit);
    assert.ok(first); assert.ok(latest);
    assert.equal(commit.mock.callCount(), 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(lstatSync(link).ino, latest.ino);
    assert.equal(readFileSync(link, "utf8"), "latest operator file");
    const stages = readdirSync(dir).filter(name => name.startsWith(".mission-extension-"));
    assert.equal(stages.length, 1);
    const recovery = join(dir, stages[0]!);
    assert.ok(result.problems[0]!.includes(recovery));
    assert.equal(lstatSync(join(recovery, "candidate")).ino, first.ino);
    assert.equal(readFileSync(join(recovery, "candidate", "keep"), "utf8"), "first operator directory");
  } finally { restore.restore(); swap.restore(); }
});

for (const previous of [false, true]) {
  for (const replacement of ["file", "directory", "foreign-link", "same-target-link", "missing"] as const) {
    test(`failed ${previous ? "replacement" : "fresh"} publication preserves a concurrent ${replacement}`, () => {
      mkdirSync(dir);
      const prior = join(home, "previous.js");
      writeFileSync(prior, "export const missionControlBuild = {};\n");
      if (previous) symlinkSync(prior, link);
      const owned = lstatSync(link, { throwIfNoEntry: false });
      const foreign = join(home, "foreign.js");
      writeFileSync(foreign, "operator code");
      let concurrent: fs.Stats | undefined;
      const result = reconcileExtensionLink(true, target, () => {
        assert.equal(readlinkSync(link), target);
        // Keep the published inode alive so even a replacement with the same target
        // has a distinct identity on filesystems that promptly reuse freed inodes.
        fs.renameSync(link, join(dir, "displaced.js"));
        if (replacement === "file") writeFileSync(link, "operator code");
        else if (replacement === "directory") mkdirSync(link);
        else if (replacement !== "missing") symlinkSync(replacement === "foreign-link" ? foreign : target, link);
        concurrent = lstatSync(link, { throwIfNoEntry: false });
        throw new Error("intent commit failed");
      });
      assert.deepEqual(result.blocked, [spec.linkName]);
      const after = lstatSync(link, { throwIfNoEntry: false });
      const expected = previous && replacement === "missing" ? owned : concurrent;
      assert.equal(after?.ino, expected?.ino, "rollback preserves a concurrent entry or restores the prior link into a free path");
      assert.equal(after?.dev, expected?.dev);
      if (replacement === "file") assert.equal(readFileSync(link, "utf8"), "operator code");
      if (replacement === "foreign-link") assert.equal(readlinkSync(link), foreign);
      if (replacement === "same-target-link") assert.equal(readlinkSync(link), target);
      const stages = readdirSync(dir).filter(name => name.startsWith(".mission-extension-"));
      if (previous && replacement !== "missing") {
        assert.equal(stages.length, 1);
        const recovery = join(dir, stages[0]!);
        assert.ok(result.problems[0]!.includes(recovery));
        assert.equal(lstatSync(join(recovery, "candidate")).ino, owned!.ino);
        assert.equal(readlinkSync(join(recovery, "candidate")), prior);
      } else {
        assert.deepEqual(result.problems, [`${link}: intent commit failed`]);
        assert.deepEqual(stages, []);
        if (previous) assert.equal(readlinkSync(link), prior);
      }
    });
  }
  test(`failed ${previous ? "replacement" : "fresh"} publication rolls back its own unchanged link`, () => {
    mkdirSync(dir);
    const prior = join(home, "previous.js");
    writeFileSync(prior, "export const missionControlBuild = {};\n");
    if (previous) symlinkSync(prior, link);
    const result = reconcileExtensionLink(true, target, () => { throw new Error("intent commit failed"); });
    assert.deepEqual(result.problems, [`${link}: intent commit failed`]);
    if (previous) assert.equal(readlinkSync(link), prior);
    else assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined);
    assert.equal(readdirSync(dir).some(name => name.startsWith(".mission-extension-")), false);
  });
}

test("the build output layout the reconciler recognizes is the one this build writes", () => {
  // piExtensionPath keeps its specifier literal so the bundle smoke check can read it,
  // so nothing but this stops the two drifting apart.
  const previous = process.env.MISSION_PI_EXTENSION;
  delete process.env.MISSION_PI_EXTENSION;
  try {
    assert.equal(piExtensionPath().endsWith("/dist/pi-integration/extension.js"), true, piExtensionPath());
    // Assigning an absent value back would restore it as the string "undefined", which
    // every later test in this worker would then resolve as a real override.
  } finally { if (previous === undefined) delete process.env.MISSION_PI_EXTENSION; else process.env.MISSION_PI_EXTENSION = previous; }
});

test("a moved or deleted installation's dangling link is repaired instead of refused", () => {
  // Reported from a real machine: the app bundle moved from /Applications to
  // ~/Applications, so the machine-wide link pointed at a target that no longer existed.
  // Startup reconciliation refused it as "not ours", Pi silently loaded no extension, and
  // the warning's own remedy - npm run install-pi-extension - hit the same refusal.
  const moved = join(home, "gone", "Mission Control.app", "Contents", "Resources", "app", ...PI_EXTENSION_OUTPUT);
  mkdirSync(dir, { recursive: true });
  symlinkSync(moved, link);
  assert.equal(existsSync(moved), false, "the previous installation is gone, as on the reported machine");
  const result = reconcileExtensionLink(true);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, true);
  assert.deepEqual(result.linked, [spec.linkName]);
  assert.equal(readlinkSync(link), target);
  // Off has to clear the orphan too, so neither direction leaves an operator wedged.
  rmSync(link); symlinkSync(moved, link);
  assert.equal(uninstallExtensionLink().changed, true);
  assert.equal(existsSync(link), false);
});

test("missing build cannot replace a working link, and off removes our dangling link", () => {
  reconcileExtensionLink(true);
  rmSync(target);
  assert.equal(reconcileExtensionLink(true).blocked.length, 1);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  // An arbitrary deleted output is no longer provenance; only the legacy layout or
  // the managed generation namespace can authorize dangling-link removal.
  assert.equal(uninstallExtensionLink().changed, false);
  rmSync(link); symlinkSync(join(home, "deleted", ...PI_EXTENSION_OUTPUT), link);
  assert.equal(uninstallExtensionLink().changed, true);
});

test("reconciliation reports a filesystem error without mutating the installed link", () => {
  reconcileExtensionLink(true);
  const before = lstatSync(link);
  const contents = readFileSync(target, "utf8");
  const loop = join(home, "loop.js");
  // Unlike chmod-based failures, ELOOP also fails when the test runs as root.
  symlinkSync(loop, loop);
  process.env.MISSION_PI_EXTENSION = loop;
  try {
    const result = reconcileExtensionLink(true);
    assert.equal(result.changed, false);
    assert.deepEqual(result.linked, []);
    assert.deepEqual(result.unlinked, []);
    assert.deepEqual(result.blocked, [spec.linkName]);
    assert.equal(result.problems.length, 1);
    assert.ok(result.problems[0]!.startsWith(`${link}: `));
    assert.match(result.problems[0]!, /ELOOP/);
    assert.equal(lstatSync(link).ino, before.ino);
    assert.equal(readlinkSync(link), target);
    assert.equal(readFileSync(target, "utf8"), contents);
    assert.deepEqual(readdirSync(dir), [spec.linkName]);
  } finally {
    process.env.MISSION_PI_EXTENSION = target;
    rmSync(loop);
  }
});

for (const operation of ["writeFileSync", "renameSync"] as const) {
  test(`failed intent publication ${operation} preserves persisted intent and cleans staging`, async (t) => {
    await applyPiExtensionConfig({ enabled: true });
    const intentFile = join(home, "pi-extension.json");
    const priorIntent = readFileSync(intentFile, "utf8");
    const priorIntentInode = lstatSync(intentFile).ino;
    const priorLinkInode = lstatSync(link).ino;
    const priorEntries = readdirSync(home).sort();
    const failure = Object.assign(new Error("injected intent publication failure"), { code: "EIO" });
    const originalWrite = fs.writeFileSync;
    const originalOperation = fs[operation];
    const fault = t.mock.method(fs, operation, (...args: unknown[]) => {
      const staged = String(args[0]);
      if (!staged.endsWith("/intent.json")) return Reflect.apply(originalOperation, fs, args);
      assert.ok(staged.startsWith(join(home, ".pi-extension-")), "fault targets private staging");
      assert.ok(staged.endsWith("/intent.json"));
      if (operation === "writeFileSync") {
        // Leave a partial staged file, as a real disk write failure may do.
        originalWrite(staged, '{"enabled":');
      } else {
        assert.equal(args[1], intentFile);
        assert.equal(readFileSync(staged, "utf8"), '{"enabled":false}\n');
      }
      throw failure;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(applyPiExtensionConfig({ enabled: false }), (error) => error === failure);
      assert.ok(fault.mock.callCount() >= 1);
      assert.equal(readFileSync(intentFile, "utf8"), priorIntent);
      assert.equal(lstatSync(intentFile).ino, priorIntentInode);
      assert.deepEqual(getPiExtensionConfig(), { enabled: true });
      assert.deepEqual(readdirSync(home).sort(), priorEntries, "staged files and directory are removed");
      assert.equal(lstatSync(link).ino, priorLinkInode, "failed persistence never reaches link teardown");
      assert.ok(readlinkSync(link).startsWith(join(home, "integrations", "pi")));
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual((await applyPiExtensionConfig({ enabled: false })).config, { enabled: false });
    assert.deepEqual(getPiExtensionConfig(), { enabled: false });
    assert.equal(existsSync(link), false, "retry publishes intent and reconciles normally");
  });
}

test("API GET returns default and persisted intent; PUT validates and reports foreign-file conflicts", async () => {
  const intentFile = join(home, "pi-extension.json");
  rmSync(intentFile, { force: true });
  const app = buildApp({ registry: {} as never, reviews: {} as never, tasks: {} as never, queues: {} as never });
  const url = "/api/extensions/pi/config";
  const get = () => app.request(url, { headers: { host: "127.0.0.1:7317" } });
  const put = (body: unknown) => app.request(url, { method: "PUT", headers: { host: "127.0.0.1:7317", "content-type": "application/json" }, body: JSON.stringify(body) });
  const initial = await get();
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { enabled: false });
  assert.equal(existsSync(intentFile), false, "GET leaves never-installed intent absent");
  assert.equal((await put({ enabled: "true" })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ enabled: true })).status, 200);
  const enabled = await get();
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: true });
  assert.equal(getPiExtensionConfig().enabled, true);
  assert.equal((await put({ enabled: false })).status, 200);
  const disabled = await get();
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { enabled: false });
  closeDb();
  assert.equal(getPiExtensionConfig().enabled, false);
  assert.equal((await reconcilePiExtension()).changed, false);
  assert.equal(existsSync(link), false);
  writeFileSync(link, "operator");
  assert.equal((await put({ enabled: true })).status, 409);
  assert.equal(getPiExtensionConfig().enabled, false, "failed publication never enables intent");
  assert.equal(readFileSync(link, "utf8"), "operator");
  assert.equal((await put({ enabled: false })).status, 409);
  assert.equal(getPiExtensionConfig().enabled, false, "blocked removal cannot resurrect on restart");
});

test("standalone install persists the same intent without opening SQLite", async () => {
  const run = (args: string[] = []) => execFileSync(process.execPath,
    ["--import", "tsx", "scripts/install-pi-extension.ts", ...args],
    { env: process.env, encoding: "utf8" });
  const isolated = join(home, "standalone-only");
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url === "node:sqlite" || resolved.url.endsWith("/src/server/db.ts")) {
        throw new Error("standalone installer must not load the database: " + resolved.url);
      }
      return resolved;
    } });
    await import("./scripts/install-pi-extension.ts");
  `], { env: { ...process.env, MISSION_HOME: isolated }, stdio: "pipe" });
  assert.equal(existsSync(join(isolated, "harness.db")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(isolated, "pi-extension.json"), "utf8")), { enabled: true });
  run();
  assert.equal(getPiExtensionConfig().enabled, true);
  assert.ok(readlinkSync(link).startsWith(join(home, "integrations", "pi")));
  assert.equal((await reconcilePiExtension()).changed, false);
  run(["--uninstall"]);
  assert.equal(getPiExtensionConfig().enabled, false);
  assert.equal(existsSync(link), false);
  assert.equal((await reconcilePiExtension()).changed, false);
  assert.throws(() => run(["--invalid"]));
});

test("standalone install fails closed on a malformed inherited isolation capture", () => {
  const isolated = join(home, "malformed-capture");
  assert.throws(() => execFileSync(process.execPath,
    ["--import", "tsx", "scripts/install-pi-extension.ts"],
    { env: { ...process.env, MISSION_HOME: isolated, MISSION_TEST_STATE: "not json" }, stdio: "pipe" }),
  /loaded no test\/setup-state.mjs and inherited no capture/);
  assert.equal(existsSync(isolated), false, "refusal happens before any state or link write");
});

test("intent writer reuses the state guard before touching an operator state home", () => {
  const previous = process.env.MISSION_HOME;
  process.env.MISSION_HOME = join(homedir(), ".mission-control");
  try {
    assert.throws(() => applyPiExtensionConfig({ enabled: false }), /refusing to open/);
  } finally { process.env.MISSION_HOME = previous; }
});

test("an accepted intent write cannot exempt a frozen database path from isolation", async () => {
  const previous = process.env.MISSION_HOME;
  process.env.MISSION_HOME = join(home, "other-state");
  try {
    assert.deepEqual((await applyPiExtensionConfig({ enabled: false })).config, { enabled: false });
    assert.throws(openDb, /refusing to open .*frozen against a different state dir/);
  } finally { process.env.MISSION_HOME = previous; }
});

test("malformed installation intent is never overwritten or interpreted as off", async () => {
  const file = join(home, "pi-extension.json");
  const prior = readFileSync(file, "utf8");
  writeFileSync(file, "operator data");
  try {
    assert.throws(getPiExtensionConfig);
    await assert.rejects(reconcilePiExtension());
    assert.throws(() => execFileSync(process.execPath,
      ["--import", "tsx", "scripts/install-pi-extension.ts"], { env: process.env, stdio: "pipe" }));
    assert.equal(readFileSync(file, "utf8"), "operator data");
  } finally { writeFileSync(file, prior); }
});

test("uninstall-hooks tears down extension even when no Claude hooks remain, without enabling it", () => {
  const settings = join(home, "settings.json"); writeFileSync(settings, "{}\n");
  reconcileExtensionLink(true);
  const args = ["--import", "tsx", "hooks/install.mjs", "--uninstall"];
  const env = { ...process.env, CLAUDE_SETTINGS_PATH: settings };
  const output = execFileSync(process.execPath, args, { env, encoding: "utf8" });
  assert.match(output, /removed extension link/);
  assert.equal(existsSync(link), false);
  execFileSync(process.execPath, ["--import", "tsx", "hooks/install.mjs", "--force"], { env });
  assert.equal(existsSync(link), false, "Claude hook install never opts Pi in");
});

// Exercise destructive calls against a disposable operator home, so a broken guard
// fails the test without harming the actual operator. Preserve inherited test signals.
test("isolation guard refuses exact, dot-dot and symlinked live paths on install and teardown", () => {
  const fake = join(home, "operator"); mkdirSync(fake, { recursive: true });
  const script = `
    import assert from 'node:assert/strict';
    import {mkdirSync,symlinkSync,lstatSync,readlinkSync} from 'node:fs';
    import {join} from 'node:path';
    const {reconcileExtensionLink,uninstallExtensionLink} = await import('./src/server/skills/reconcile.ts');
    const live = join(process.env.HOME,'.pi','agent','extensions');
    mkdirSync(live,{recursive:true});
    const link = join(live,'mission-control.js'); symlinkSync(process.env.MISSION_PI_EXTENSION,link);
    const alias = join(process.env.HOME,'alias'); symlinkSync(join(process.env.HOME,'.pi'),alias);
    for (const path of [live,live+'/../extensions',join(alias,'agent','extensions')]) {
      process.env.PI_EXTENSIONS_DIR = path;
      const inode = lstatSync(link).ino;
      for (const call of [()=>reconcileExtensionLink(true),()=>reconcileExtensionLink(false),uninstallExtensionLink]) {
        assert.throws(call,/refusing to reconcile/);
        assert.equal(lstatSync(link).ino,inode);
        assert.equal(readlinkSync(link),process.env.MISSION_PI_EXTENSION);
      }
    }
    console.log('all three live-path spellings refused; link unchanged');`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, HOME: fake }, encoding: "utf8" });
  assert.match(output, /link unchanged/);
});

test("real operator paths stay unchanged through a scratch symlink and dot-dot spelling", () => {
  const real = join(homedir(), ...spec.homeDir);
  const snapshot = () => existsSync(real) ? readdirSync(real).sort().map((name) => {
    const path = join(real, name); const stat = lstatSync(path);
    return [name, stat.ino, stat.mtimeMs, stat.size, stat.isSymbolicLink() ? readlinkSync(path) : null];
  }) : null;
  const before = snapshot();
  const alias = join(home, "real-pi-alias");
  // Alias an existing ancestor: fresh CI homes have no .pi directory yet.
  symlinkSync(homedir(), alias, "dir");
  // Inert even if the guard regresses: an absent desired build prevents every write.
  // Never exercise destructive off/teardown against real data; the fake-home test does.
  process.env.MISSION_PI_EXTENSION = join(home, "not-built.js");
  try {
    for (const path of [real, real + "/../extensions", join(alias, ...spec.homeDir)]) {
      process.env.PI_EXTENSIONS_DIR = path;
      assert.throws(() => reconcileExtensionLink(true), /refusing to reconcile/);
      assert.deepEqual(snapshot(), before);
    }
  } finally {
    process.env.MISSION_PI_EXTENSION = target;
    delete process.env.PI_EXTENSIONS_DIR;
  }
});

async function waitForListening(child: ChildProcess, output: () => string): Promise<void> {
  // Count polling opportunities rather than wall time: host sleep must not spend the
  // daemon's startup budget before either process gets another turn. Normally 25 seconds.
  for (let attempt = 0; attempt < 500; attempt++) {
    if (output().includes("[mission-control] listening on")
      || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("an actual isolated daemon leaves the operator's real extension directory unchanged", async () => {
  const real = join(homedir(), ...spec.homeDir);
  const snapshot = () => existsSync(real) ? readdirSync(real).sort().map((name) => {
    const path = join(real, name); const stat = lstatSync(path);
    return { name, ino: stat.ino, mtime: stat.mtimeMs, size: stat.size, target: stat.isSymbolicLink() ? readlinkSync(path) : null };
  }) : null;
  const before = snapshot();
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((done) => server.close(() => done()));
  const isolated = join(home, "second-daemon");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, MISSION_HOME: isolated, MISSION_PORT: String(address.port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", (c) => output += c); child.stderr.on("data", (c) => output += c);
  try {
    await waitForListening(child, () => output);
    assert.match(output, /\[mission-control\] listening on/);
    assert.deepEqual(snapshot(), before);
    assert.equal(existsSync(join(isolated, spec.isolatedDirName)), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
  assert.deepEqual(snapshot(), before);
});

for (const clockAdvanceMs of [0, 17 * 60_000]) {
  test(`daemon startup logs failed extension reconciliation and remains available${clockAdvanceMs ? " across a wall-clock jump" : ""}`, async (t) => {
    const isolated = join(home, `failed-startup-reconcile-${clockAdvanceMs}`);
    const extensions = join(isolated, spec.isolatedDirName);
    mkdirSync(extensions, { recursive: true });
    const installed = join(extensions, spec.linkName);
    symlinkSync(target, installed);
    const inode = lstatSync(installed).ino;
    const intentFile = join(isolated, "pi-extension.json");
    const malformed = "{ broken installation intent";
    writeFileSync(intentFile, malformed);
    const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await new Promise<void>((done) => server.close(() => done()));
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
      env: { ...process.env, MISSION_HOME: isolated, MISSION_PORT: String(address.port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; child.stdout.on("data", (c) => output += c); child.stderr.on("data", (c) => output += c);
    if (clockAdvanceMs) {
      const now = Date.now();
      t.mock.timers.enable({ apis: ["Date"], now });
      const jump = setTimeout(() => t.mock.timers.setTime(now + clockAdvanceMs), 10);
      t.after(() => clearTimeout(jump));
    }
    try {
      await waitForListening(child, () => output);
      assert.match(output, /\[extensions\] could not reconcile: SyntaxError/);
      assert.match(output, /\[mission-control\] listening on/);
      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200);
      const health = await response.json();
      assert.equal(health.ok, true);
      assert.equal(health.service, "mission-control");
      assert.equal(health.pid, child.pid);
      assert.equal(child.exitCode, null, "reconciliation failure must not stop the daemon");
      assert.equal(lstatSync(installed).ino, inode);
      assert.equal(readlinkSync(installed), target);
      assert.equal(readFileSync(intentFile, "utf8"), malformed);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
      }
    }
  });
}

test("daemon startup upgrades an enabled legacy link to its bundled generation and retains the old files", async () => {
  const isolated = join(home, "startup-upgrade");
  const extensions = join(isolated, spec.isolatedDirName);
  mkdirSync(extensions, { recursive: true });
  const old = join(isolated, "legacy", "extension.js");
  writePiIntegration(join(isolated, "legacy"));
  const installed = join(extensions, spec.linkName); symlinkSync(old, installed);
  writeFileSync(join(isolated, "pi-extension.json"), '{"enabled":true}');
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(done => server.close(() => done()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, MISSION_HOME: isolated, MISSION_PORT: String(address.port), MISSION_POLL_MS: "0", MISSION_SCOUT_RECONCILE_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
  try {
    await waitForListening(child, () => output);
    const published = readlinkSync(installed);
    assert.ok(published.startsWith(join(isolated, "integrations", "pi")), output);
    assert.notEqual(published, old); assert.ok(existsSync(old));
    assert.ok(existsSync(join(isolated, "legacy", "mcp-server.mjs")));
    assert.deepEqual(JSON.parse(readFileSync(join(isolated, "pi-extension.json"), "utf8")), { enabled: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, "exit"); child.kill("SIGTERM"); await done; }
  }
});
