import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  attachUtilityProcessOutput,
  openPrivateUtilityLog,
  utilityProcessStdio,
} from "../src/main/utility-log.ts";

test("utility logs and their directory are private", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-utility-log-"));
  const logPath = join(root, "state", "foreman.log");
  const log = openPrivateUtilityLog(logPath);
  log.end("[mission-control] mission-control-foreman stopped\n");
  await once(log, "close");

  assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("disabled child output cannot reach the lifecycle log", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-utility-log-"));
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
