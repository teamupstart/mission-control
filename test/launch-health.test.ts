import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeUpdateLaunch, observeUpdateLaunch, unmanagedLaunchMessage } from "../src/main/launch-health.ts";
import { processIdentity } from "../scripts/update-lock.mjs";
import { logMain } from "../src/main/main-log.ts";
import { realMacAppOps, launchAckPath } from "../scripts/mac-app-lifecycle.mjs";

test("unmanaged startup reports the current process, with the same job remediation and no kill", async () => {
  const bundle = "/Applications/Mission Control.app";
  const ops = realMacAppOps();
  ops.uid = 501;
  ops.kill = () => { throw new Error("must not signal"); };
  ops.run = async (command, args) => ({code: 0, stdout: command.endsWith("ps") ? `42 1 S ${bundle}/Contents/MacOS/Mission Control\n`
    : command.endsWith("lsappinfo") ? "" : args[0] === "list" ? "PID\tStatus\tLabel\n42 0 recovery-job\n"
      : `program = ${bundle}/Contents/MacOS/Mission Control\n`});
  assert.match((await unmanagedLaunchMessage(bundle, 42, ops))!, /launchctl bootout 'gui\/501\/recovery-job'/);
  assert.equal(await unmanagedLaunchMessage(bundle, 99, ops), null);
});

test("renderer acknowledgment retries on the next load after a failed write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-launch-ack-retry-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const directory = join(root, "state");
  writeFileSync(directory, "block mkdir");
  const nonce = "a".repeat(32);
  const contents = Object.assign(new EventEmitter(), {executeJavaScript: async () => true});
  const execute = t.mock.method(contents, "executeJavaScript");
  observeUpdateLaunch(contents as unknown as Parameters<typeof observeUpdateLaunch>[0], "/Example.app", directory, ["--mission-update-launch", nonce]);
  contents.emit("did-finish-load");
  await setImmediate();
  assert.equal(existsSync(launchAckPath(directory, nonce)), false);
  rmSync(directory);
  contents.emit("did-finish-load");
  await setImmediate();
  assert.equal(existsSync(launchAckPath(directory, nonce)), true);
  contents.emit("did-finish-load");
  await setImmediate();
  assert.equal(execute.mock.callCount(), 2, "only a successful write retires the probe");
});

test("unwritable main log falls back to sanitized stderr without preventing startup", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mission-main-log-fallback-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const stderr = t.mock.method(console, "error", () => {});
  assert.doesNotThrow(() => logMain("renderer unresponsive Authorization: Bearer private-token /Users/private/path", directory));
  assert.equal(stderr.mock.callCount(), 1);
  const line = stderr.mock.calls[0]!.arguments[0] as string;
  assert.match(line, /Could not append to daemon.log: .*renderer unresponsive/);
  assert.doesNotMatch(line, /private-token|Users\/private|mission-main-log-fallback/);
  stderr.mock.mockImplementation(() => { throw new Error("stderr unavailable"); });
  assert.doesNotThrow(() => logMain("renderer unresponsive", directory));
});

test("main log is durable and sanitized; only a valid launch nonce can publish renderer readiness", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mission-main-log-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "daemon.log");
  logMain("renderer unresponsive Authorization: Bearer private-token /Users/private/path", path);
  const line = readFileSync(path, "utf8");
  assert.match(line, /\[main pid=\d+\] renderer unresponsive/);
  assert.doesNotMatch(line, /private-token|Users\/private/);
  acknowledgeUpdateLaunch("/Example.app", directory, ["--mission-update-launch", "../escape"]);
  const nonce = "a".repeat(32);
  assert.equal(existsSync(launchAckPath(directory, nonce)), false);
  acknowledgeUpdateLaunch("/Example.app", directory, ["--mission-update-launch", nonce]);
  assert.deepEqual(JSON.parse(readFileSync(launchAckPath(directory, nonce), "utf8")), {nonce, pid: process.pid, bundle: "/Example.app", identity: processIdentity(process.pid)});
});
