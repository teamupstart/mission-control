import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicMigrationJson, MIGRATION_JOURNAL, prepareInPlaceInstall, withMigrationLock } from "../scripts/install-migration.mjs";
import { prepareStagedInstall } from "../scripts/install-staged-app.mjs";
import { processIdentity } from "../scripts/update-lock.mjs";
import { cleanupBinaryDownloads, cleanupSettledBinaryDownloads } from "../src/main/update-binary.ts";
import { createDefaultUpdaterPort, type UpdateDialogs } from "../src/main/updater.ts";

const dead = {pid: 99999999, identity: "departed fixture process"};

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "binary-cleanup-")));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const app = join(root, "Applications", "Agent Mission Control.app");
  const directory = join(root, "update-downloads", "attempt-candidate");
  const candidate = join(directory, "expanded", "Agent Mission Control.app");
  for (const [path, commit] of [[app, "a".repeat(40)], [candidate, "b".repeat(40)]] as const) {
    mkdirSync(join(path, "Contents/Resources/app"), {recursive: true});
    writeFileSync(join(path, "Contents/Info.plist"), "<key>CFBundleShortVersionString</key><string>1.26.0</string>");
    writeFileSync(join(path, "Contents/Resources/app/package.json"), JSON.stringify({missionCommit: commit,
      missionInstallMigration: {protocol: 1, automatic: true}, missionInstallTransaction: {protocol: 1, receiptSchemas: [1, 2]}}));
  }
  const oldReceipt = {schema: 1, repo: "teamupstart/mission-control", appPath: app, installedVersion: "1.26.0",
    installedCommit: "a".repeat(40), sourceClone: "/fixture-unused", releaseTag: "v1.26.0", installedAt: "2026-10-27T00:00:00.000Z"};
  const receiptPath = join(root, "install-receipt.json");
  writeFileSync(receiptPath, JSON.stringify(oldReceipt));
  const descriptor = prepareStagedInstall({bundle: candidate, receipt: {...oldReceipt, installedCommit: "b".repeat(40)}});
  const plan = prepareInPlaceInstall({descriptor, stateDirectory: root});
  const journal = {protocol: 2, plan, stage: "complete", owner: dead, ownerRole: "helper", targetProcess: null, repairs: []};
  atomicMigrationJson(join(root, MIGRATION_JOURNAL), journal);
  atomicMigrationJson(receiptPath, plan.intendedReceipt);
  const owner = {protocol: 1, path: directory, parent: dead, worker: dead};
  atomicMigrationJson(join(directory, "owner.json"), owner);
  atomicMigrationJson(join(directory, "handoff.json"), {nonce: plan.nonce});
  writeFileSync(join(directory, "app.zip"), "downloaded archive");
  const runtime = join(root, "update-runtimes", `attempt-${plan.nonce}`); mkdirSync(runtime, {recursive: true});
  const helperOwner = {protocol: 1, nonce: plan.nonce, transactionNonce: plan.nonce, path: runtime, helper: dead};
  atomicMigrationJson(join(runtime, "owner.json"), helperOwner);
  atomicMigrationJson(join(runtime, "finished.json"), {nonce: plan.nonce, ...dead});
  writeFileSync(join(root, "state-sentinel"), "settings and sessions");
  const outcome = {schema: 1, result: "success", targetVersion: "1.26.0", recordedAt: "2026-10-27T00:00:00.000Z"};
  atomicMigrationJson(join(root, "update-outcome.json"), outcome);
  const port = createDefaultUpdaterPort({packaged: true, currentVersion: () => "1.26.0", currentCommit: () => "b".repeat(40),
    installSnapshot: () => ({receipt: descriptor.receipt, problem: null}), helperSource: "/unused/apply-update.mjs",
    stateDirectory: root, requestQuit: () => {}, dialogs: {} as UpdateDialogs});
  // The default port owns the startup outcome read; no discovery or new download is requested.
  return {root, app, directory, candidate, plan, journal, owner, runtime, helperOwner, receiptPath, outcome, port};
}

test("startup reclaims a completed download without another update and preserves receipt, state and recovery records", async t => {
  const f = fixture(t);
  const preserved = [f.receiptPath, join(f.root, MIGRATION_JOURNAL), join(f.root, "state-sentinel"), join(f.root, "update-outcome.json"), join(f.runtime, "finished.json")];
  const before = preserved.map(path => readFileSync(path));
  assert.equal((await f.port.readOutcome())?.result, "success");
  assert.equal(existsSync(f.directory), false, "startup removes both the expanded app and its ZIP");
  assert.deepEqual(preserved.map(path => readFileSync(path)), before);
  assert.ok(existsSync(f.app));
  await f.port.readOutcome(); // Repeated startup cleanup is harmless.
});

test("startup retries a completed handoff until its exact helper exits", async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {stdio: ["ignore", "ignore", "ignore", "ipc"]});
  t.after(() => child.kill());
  await once(child, "message");
  const helper = {pid: child.pid!, identity: processIdentity(child.pid!)}; assert.ok(helper.identity);
  atomicMigrationJson(join(f.runtime, "owner.json"), {...f.helperOwner, helper});
  atomicMigrationJson(join(f.runtime, "finished.json"), {nonce: f.plan.nonce, ...helper});
  const reading = f.port.readOutcome();
  await delay(150);
  assert.ok(existsSync(f.directory), "a live helper still owns the candidate");
  const exited = once(child, "exit"); child.kill(); await exited;
  assert.equal((await reading)?.result, "success");
  assert.equal(existsSync(f.directory), false, "startup retries after helper exit without another download");
});

for (const scenario of ["parent-live", "worker-live", "worker-unknown", "helper-live", "journal-owner-live", "helper-unknown", "missing-finish", "wrong-finish", "wrong-runtime", "pending", "repair-required", "receipt-changed", "different-transaction", "runtime-symlink"] as const) {
  test(`download cleanup retains ${scenario} ownership or recovery obligations`, t => {
    const f = fixture(t);
    const live = {pid: process.pid, identity: processIdentity(process.pid)};
    if (scenario === "parent-live" || scenario === "worker-live") atomicMigrationJson(join(f.directory, "owner.json"), {...f.owner, [scenario === "parent-live" ? "parent" : "worker"]: live});
    if (scenario === "worker-unknown") atomicMigrationJson(join(f.directory, "owner.json"), {...f.owner, worker: {identity: "missing pid"}});
    if (scenario === "journal-owner-live") atomicMigrationJson(join(f.root, MIGRATION_JOURNAL), {...f.journal, owner: live});
    if (scenario === "helper-live" || scenario === "helper-unknown") {
      const helper = scenario === "helper-live" ? live : {pid: dead.pid, identity: null};
      atomicMigrationJson(join(f.runtime, "owner.json"), {...f.helperOwner, helper});
      atomicMigrationJson(join(f.runtime, "finished.json"), {nonce: f.plan.nonce, ...helper});
    }
    if (scenario === "missing-finish") rmSync(join(f.runtime, "finished.json"));
    if (scenario === "wrong-finish") atomicMigrationJson(join(f.runtime, "finished.json"), {nonce: f.plan.nonce, ...dead, identity: "another process"});
    if (scenario === "wrong-runtime") atomicMigrationJson(join(f.runtime, "owner.json"), {...f.helperOwner, path: join(f.root, "foreign")});
    if (scenario === "pending" || scenario === "repair-required") atomicMigrationJson(join(f.root, MIGRATION_JOURNAL), {...f.journal, stage: scenario === "pending" ? "target-staged" : "repair-required"});
    if (scenario === "receipt-changed") atomicMigrationJson(f.receiptPath, f.plan.oldReceipt);
    if (scenario === "different-transaction") atomicMigrationJson(join(f.directory, "handoff.json"), {nonce: "f".repeat(64)});
    if (scenario === "runtime-symlink") {
      const other = join(f.root, "other-runtime"); mkdirSync(other);
      atomicMigrationJson(join(other, "owner.json"), f.helperOwner);
      atomicMigrationJson(join(other, "finished.json"), {nonce: f.plan.nonce, ...dead});
      rmSync(f.runtime, {recursive: true}); symlinkSync(other, f.runtime);
    }
    cleanupBinaryDownloads(f.root);
    assert.equal(readFileSync(join(f.directory, "app.zip"), "utf8"), "downloaded archive");
    assert.ok(existsSync(f.candidate));
  });
}

test("startup retains pending repairs and reclaims the candidate after they settle", async t => {
  const f = fixture(t);
  atomicMigrationJson(join(f.root, MIGRATION_JOURNAL), {...f.journal, stage: "repair-required"});
  await f.port.readOutcome();
  assert.ok(existsSync(f.directory));
  atomicMigrationJson(join(f.root, MIGRATION_JOURNAL), f.journal);
  await f.port.readOutcome();
  assert.equal(existsSync(f.directory), false);
});

test("restored cleanup requires the prior receipt and preserves all recovery records", async t => {
  const f = fixture(t);
  atomicMigrationJson(join(f.root, MIGRATION_JOURNAL), {...f.journal, stage: "restored"});
  await f.port.readOutcome();
  assert.ok(existsSync(f.directory), "a restored journal with a different receipt is uncertain");
  writeFileSync(f.receiptPath, f.plan.oldReceiptText!);
  await f.port.readOutcome();
  assert.equal(existsSync(f.directory), false);
  assert.equal(readFileSync(f.receiptPath, "utf8"), f.plan.oldReceiptText);
  assert.ok(existsSync(join(f.runtime, "finished.json")));
});

test("unreadable recovery state cannot prevent startup from reporting its saved outcome", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, MIGRATION_JOURNAL), "unreadable");
  assert.equal((await f.port.readOutcome())?.result, "success");
  assert.ok(existsSync(f.directory));
});

test("startup cleanup cannot cross another install lock holder", async t => {
  const f = fixture(t);
  await withMigrationLock(f.root, async () => {
    await assert.rejects(cleanupSettledBinaryDownloads(f.root), /Another update or install is in progress/);
    assert.ok(existsSync(f.directory));
  });
  await f.port.readOutcome();
  assert.equal(existsSync(f.directory), false);
});
