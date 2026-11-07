import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { withMigrationLock } from "../scripts/install-migration.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireHelperLock, releaseHelperLock, realHelperLockOperations, HELPER_LOCK_DIR_NAME } from "../scripts/update-lock.mjs";

import {
  clearUpdateOutcome, readSettledUpdateOutcome,
  consumeUpdateOutcome,
  readUpdateOutcome,
  UPDATE_OUTCOME_SCHEMA,
  writeUpdateOutcome,
} from "../src/main/update-outcome.js";

test("update outcome markers round-trip schema-1 failures and refuse unknown schemas", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-outcome-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const supportedPath = join(directory, "supported.json");
  const unsupportedPath = join(directory, "unsupported.json");
  const outcome = {
    result: "failure" as const,
    targetVersion: "2.0.0",
    recordedAt: "2026-08-19T12:00:00.000Z",
    message: "The update could not be installed.",
  };

  await writeUpdateOutcome(supportedPath, outcome);
  await writeFile(
    unsupportedPath,
    JSON.stringify({ schema: UPDATE_OUTCOME_SCHEMA + 1, ...outcome }),
  );

  assert.deepEqual(
    [await readUpdateOutcome(supportedPath), await readUpdateOutcome(unsupportedPath)],
    [outcome, null],
  );
});

test("a surfaced outcome is consumed exactly once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-consume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "outcome.json");
  const outcome = {
    result: "success" as const,
    targetVersion: "2.0.0",
    recordedAt: "2026-08-19T12:00:00.000Z",
  };
  writeUpdateOutcome(path, outcome);
  assert.deepEqual([consumeUpdateOutcome(path), consumeUpdateOutcome(path)], [outcome, null]);
});

test("consuming an absent outcome does not require a state directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-absent-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const stateDirectory = join(directory, "fresh-state");
  assert.equal(consumeUpdateOutcome(join(stateDirectory, "update-outcome.json")), null);
  assert.equal(fs.existsSync(stateDirectory), false);
});


test("startup waits for its live helper to publish verified success, and an old notice cannot clear a newer failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-settled-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, "update-outcome.json");
  const lockPath = join(directory, HELPER_LOCK_DIR_NAME);
  const ops = realHelperLockOperations();
  const lock = acquireHelperLock(lockPath, ops);
  assert.equal(lock.ok, true);
  t.after(() => releaseHelperLock(lockPath, lock.entryName!, ops));
  writeUpdateOutcome(path, {result: "in-progress", targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z"});
  let settled = false;
  const pending = readSettledUpdateOutcome(directory).then((value) => {settled = true; return value;});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  const success = {result: "success" as const, launchVerified: true, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:01.000Z"};
  writeUpdateOutcome(path, success);
  releaseHelperLock(lockPath, lock.entryName!, ops);
  assert.deepEqual(await pending, success);
  const failure = {result: "failure" as const, targetVersion: "2.1.0", recordedAt: "2026-08-20T12:00:00.000Z", message: "failed"};
  writeUpdateOutcome(path, failure);
  assert.equal(clearUpdateOutcome(path, success), false);
  assert.deepEqual(readUpdateOutcome(path), failure);
  assert.equal(clearUpdateOutcome(path, failure), true);
  assert.equal(readUpdateOutcome(path), null);
});

test("a helper finishing after 90 seconds still delivers its outcome in the running app", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-late-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, "update-outcome.json");
  const lockPath = join(directory, HELPER_LOCK_DIR_NAME);
  const ops = realHelperLockOperations();
  const lock = acquireHelperLock(lockPath, ops);
  assert.equal(lock.ok, true);
  t.after(() => releaseHelperLock(lockPath, lock.entryName!, ops));
  writeUpdateOutcome(path, {result: "in-progress", targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z"});
  t.mock.timers.enable({apis: ["Date"]});
  let settled = false;
  const pending = readSettledUpdateOutcome(directory).then((outcome) => { settled = true; return outcome; });
  t.mock.timers.tick(91_000);
  await delay(300);
  assert.equal(settled, false, "a live helper must not be mistaken for no outcome after the old deadline");
  const success = {result: "success" as const, launchVerified: true, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:02:00.000Z"};
  writeUpdateOutcome(path, success);
  releaseHelperLock(lockPath, lock.entryName!, ops);
  t.mock.timers.tick(250);
  assert.deepEqual(await pending, success);
});

test("persistent lock inspection errors expose the saved outcome and log a sanitized diagnostic", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-lock-error-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const failure = {result: "failure" as const, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z", message: "Launch verification failed"};
  writeUpdateOutcome(join(directory, "update-outcome.json"), failure);
  for (const code of ["EACCES", "ENOTDIR"]) {
    const lock = realHelperLockOperations();
    lock.list = () => { throw Object.assign(new Error("/Users/private/lock secret"), {code}); };
    assert.deepEqual(await readSettledUpdateOutcome(directory, lock), failure);
  }
  const log = await readFile(join(directory, "daemon.log"), "utf8");
  assert.match(log, /could not inspect helper lock; reading saved outcome/);
  assert.doesNotMatch(log, /Users\/private|secret/);
});

test("transient lock inspection errors retry before reading the helper's final result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-lock-transient-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const failure = {result: "failure" as const, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z", message: "Launch verification failed"};
  const lock = realHelperLockOperations();
  let reads = 0;
  lock.list = () => {
    const code = ["EBUSY", "EAGAIN"][reads++];
    if (code) throw Object.assign(new Error("transient"), {code});
    writeUpdateOutcome(join(directory, "update-outcome.json"), failure);
    return [];
  };
  assert.deepEqual(await readSettledUpdateOutcome(directory, lock), failure);
  assert.equal(reads, 3);
});


test("outcome retirement excludes a helper trying to replace the marker after comparison", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-retirement-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, "update-outcome.json");
  const expected = {result: "success" as const, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z"};
  const replacement = {result: "failure" as const, targetVersion: "2.1.0", recordedAt: "2026-08-20T12:00:00.000Z", message: "failed"};
  writeUpdateOutcome(path, expected);
  const contender = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {dirname, join} from "node:path";
    import {acquireHelperLock, releaseHelperLock, realHelperLockOperations, HELPER_LOCK_DIR_NAME} from "./scripts/update-lock.mjs";
    import {writeOutcome} from "./scripts/apply-update.mjs";
    const path = process.argv[2];
    const directory = join(dirname(path), HELPER_LOCK_DIR_NAME);
    const ops = realHelperLockOperations();
    const claim = acquireHelperLock(directory, ops);
    if (claim.ok) {
      try { writeOutcome(path, JSON.parse(process.argv[3])); }
      finally { releaseHelperLock(directory, claim.entryName, ops); }
    }
    process.stdout.write(JSON.stringify({ok: claim.ok}));
  `, directory, path, JSON.stringify(replacement)], {cwd: new URL("..", import.meta.url), encoding: "utf8"})) as {ok: boolean};

  // Pause at the exact vulnerable boundary: the matching bytes were read, but
  // the public marker has not yet been removed. The contender is another process.
  let attempted = false;
  let admitted: boolean | undefined;
  const read = fs.readFileSync;
  const interleave = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = read(...args);
    if (args[0] === path && !attempted) {
      attempted = true;
      admitted = contender().ok;
    }
    return bytes;
  });
  syncBuiltinESMExports();
  try { assert.equal(clearUpdateOutcome(path, expected), true); }
  finally { interleave.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempted, true);
  assert.equal(admitted, false, "the helper must not publish between comparison and removal");
  assert.equal(readUpdateOutcome(path), null);
  assert.equal(contender().ok, true, "retirement must release ownership for the next helper");
  assert.deepEqual(readUpdateOutcome(path), replacement);
  assert.equal(clearUpdateOutcome(path, expected), false);
  assert.deepEqual(readUpdateOutcome(path), replacement);
});

test("outcome retirement cannot overlap recovery in the same app process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-recovery-retirement-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, "update-outcome.json");
  const expected = {result: "success" as const, targetVersion: "2.0.0", recordedAt: "2026-08-19T12:00:00.000Z"};
  writeUpdateOutcome(path, expected);
  // Force identical pid/time claim names, which need the shared local-owner guard.
  t.mock.method(Date, "now", () => 123456789);
  await withMigrationLock(directory, async () => {
    await Promise.resolve();
    assert.throws(() => clearUpdateOutcome(path, expected), /Another update or install/);
    assert.throws(() => consumeUpdateOutcome(path), /Another update or install/);
    assert.deepEqual(readUpdateOutcome(path), expected);
  });
  assert.equal(clearUpdateOutcome(path, expected), true);
  assert.equal(readUpdateOutcome(path), null);
});
