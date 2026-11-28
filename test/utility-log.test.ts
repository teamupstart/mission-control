import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  attachUtilityProcessOutput,
  endUtilityProcessLog,
  openPathUtilityLog,
  openPrivateUtilityLog,
  openUtilityLog,
  utilityProcessStdio,
} from "../src/main/utility-log.ts";
import { tempDir } from "./temp-root.mjs";

test("utility logs and their directory are private", async () => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "state", "foreman.log");
  const log = openPrivateUtilityLog(logPath);
  log.end("[mission-control] mission-control-foreman stopped\n");
  await once(log, "close");

  assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("disabled child output cannot reach the lifecycle log", async () => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "foreman.log");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const log = openPrivateUtilityLog(logPath);

  attachUtilityProcessOutput({ stdout, stderr }, log, false);
  stdout.write("sensitive task title\n");
  stderr.write("secret model payload\n");
  log.end("[mission-control] mission-control-foreman stopped\n");
  await once(log, "close");

  const contents = readFileSync(logPath, "utf8");
  assert.equal(utilityProcessStdio(false), "ignore");
  assert.doesNotMatch(contents, /sensitive task title|secret model payload/);
  assert.match(contents, /mission-control-foreman stopped/);
});

test("output that drains after exit lands ahead of the stop marker instead of crashing main", async () => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "daemon.log");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const log = openPrivateUtilityLog(logPath);
  let uncaught: unknown = null;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on("uncaughtException", onUncaught);
  try {
    attachUtilityProcessOutput({ stdout, stderr }, log, true);
    // Electron emits "exit" first; the daemon's last lines are still in the pipes.
    endUtilityProcessLog({ stdout, stderr }, log, "[mission-control] mission-control-daemon stopped\n");
    stderr.write("daemon: closing sessions\n");
    stdout.end("daemon: shutdown complete\n");
    stderr.end();
    await once(log, "close");
  } finally {
    process.off("uncaughtException", onUncaught);
  }

  assert.equal(uncaught, null);
  assert.equal(
    readFileSync(logPath, "utf8"),
    "daemon: closing sessions\ndaemon: shutdown complete\n[mission-control] mission-control-daemon stopped\n",
  );
});

test("a pipe that never finishes cannot hold the log open, and later output is dropped", async () => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "daemon.log");
  const stdout = new PassThrough();
  const log = openPrivateUtilityLog(logPath);

  attachUtilityProcessOutput({ stdout, stderr: null }, log, true);
  endUtilityProcessLog({ stdout, stderr: null }, log, "[mission-control] mission-control-daemon stopped\n", 20);
  await once(log, "close");
  stdout.write("grandchild still holds the pipe\n");

  assert.equal(readFileSync(logPath, "utf8"), "[mission-control] mission-control-daemon stopped\n");
});

test("pipes that already finished before exit close the log without waiting out the drain bound", async () => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "daemon.log");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const log = openPrivateUtilityLog(logPath);

  attachUtilityProcessOutput({ stdout, stderr }, log, true);
  stdout.end("daemon: done\n");
  stderr.destroy();
  await once(stdout, "end");
  const started = Date.now();
  endUtilityProcessLog({ stdout, stderr }, log, "[mission-control] mission-control-daemon stopped\n", 60_000);
  await once(log, "close");

  assert.ok(Date.now() - started < 5_000);
  assert.equal(readFileSync(logPath, "utf8"), "daemon: done\n[mission-control] mission-control-daemon stopped\n");
});

test("a log stream failure is reported without its path instead of becoming an uncaught exception", async (t) => {
  const root = tempDir("mission-utility-log-");
  const log = openPrivateUtilityLog(join(root, "daemon.log"));
  const reported = t.mock.method(console, "error", () => {});
  let uncaught: unknown = null;
  const onUncaught = (err: unknown) => { uncaught = err; };
  process.on("uncaughtException", onUncaught);
  try {
    log.end();
    // Any writer outside attachUtilityProcessOutput's guard reaches the stream directly,
    // in the window between end() and close where the stream still emits "error".
    log.write("after end");
    // events.once rejects on "error" itself, which would mask what is under test.
    await new Promise<void>((resolve) => log.on("close", () => resolve()));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.equal(uncaught, null);
  assert.deepEqual(reported.mock.calls.map((call) => call.arguments), [["Could not write a utility log: ERR_STREAM_WRITE_AFTER_END"]]);
});

test("a log without captured output holds no handle, so a rotated file never takes its next line", () => {
  // Foreman's worker rotates foreman.log by rename. The supervisor's lifecycle log for it must
  // follow the PATH, not a handle opened at spawn, or its stop line lands in the renamed file.
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "state", "foreman.log");
  const log = openUtilityLog(logPath, false);
  assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);

  log.write("[mission-control] before rotation\n");
  renameSync(logPath, `${logPath}.1`);
  endUtilityProcessLog({ stdout: null, stderr: null }, log, "[mission-control] mission-control-foreman stopped\n");

  assert.equal(readFileSync(`${logPath}.1`, "utf8"), "[mission-control] before rotation\n");
  assert.equal(readFileSync(logPath, "utf8"), "[mission-control] mission-control-foreman stopped\n");
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  assert.equal(log.writableEnded, true);
  log.write("after end\n");
  assert.doesNotMatch(readFileSync(logPath, "utf8"), /after end/);
});

test("a path-only log reports a failed append by code and never throws", (t) => {
  const root = tempDir("mission-utility-log-");
  const logPath = join(root, "state", "foreman.log");
  const log = openPathUtilityLog(logPath);
  const reported = t.mock.method(console, "error", () => {});
  renameSync(join(root, "state"), join(root, "gone"));
  assert.doesNotThrow(() => log.end("[mission-control] mission-control-foreman stopped\n"));
  assert.deepEqual(reported.mock.calls.map((call) => call.arguments), [["Could not write a utility log: ENOENT"]]);
});

test("captured output keeps the streaming log", async () => {
  const root = tempDir("mission-utility-log-");
  const log = openUtilityLog(join(root, "daemon.log"), undefined);
  assert.equal(typeof (log as { on?: unknown }).on, "function", "the daemon still writes through a stream");
  log.end("[mission-control] mission-control-daemon stopped\n");
  await once(log as unknown as NodeJS.EventEmitter, "close");
});
