import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { VoiceHardware } from "../src/main/voice-hardware.ts";
import { tempDir } from "./temp-root.mjs";

test("native CoreAudio process query", { skip: process.platform !== "darwin" }, async t => {
  const [major, minor] = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).split(".").map(Number);
  if (major! < 14 || (major === 14 && minor! < 2)) return t.skip("Per-process input requires macOS 14.2");
  const dir = tempDir("voice-mic-activity-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const addon = join(dir, "mic-activity.node");
  execFileSync("xcrun", ["clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-I", resolve(process.execPath, "../../include/node"), "native/mic-activity/activity.mm",
    "test/fixtures/mic-activity-properties.cc", "-o", addon]);
  const activity: { running(pid: number): boolean } = createRequire(import.meta.url)(addon);
  const listenerPid = process.pid + 11; // The listener in the fixture process list.
  t.after(() => {
    delete process.env.MC_TEST_MIC_ACTIVITY;
    delete process.env.MC_TEST_MIC_OTHER_RUNNING;
  });

  await t.test("ignores running shell and listener inputs, then detects another running input", () => {
    delete process.env.MC_TEST_MIC_ACTIVITY;
    delete process.env.MC_TEST_MIC_OTHER_RUNNING;
    assert.equal(activity.running(listenerPid), false);
    assert.equal(activity.running(-1), true, "the capturing listener counts unless explicitly excluded");
    process.env.MC_TEST_MIC_OTHER_RUNNING = "1";
    assert.equal(activity.running(listenerPid), true);
  });

  for (const property of ["pid", "input"]) {
    await t.test(`continues to the next running process after a vanished object at ${property}`, () => {
      process.env.MC_TEST_MIC_ACTIVITY = "vanished-" + property;
      delete process.env.MC_TEST_MIC_OTHER_RUNNING;
      assert.equal(activity.running(listenerPid), false, "the vanished process alone is not contention");
      process.env.MC_TEST_MIC_OTHER_RUNNING = "1";
      assert.equal(activity.running(listenerPid), true);
    });
  }

  for (const scenario of ["pid-error", "input-error", "list-size-error", "list-read-error"]) {
    await t.test(`reports call detection unavailable for ${scenario}`, t => {
      process.env.MC_TEST_MIC_ACTIVITY = scenario;
      const hardware = new VoiceHardware({ reason: "Unused" }, { value: activity }, () => listenerPid,
        () => {}, () => {}, () => 0);
      t.after(() => hardware.stop());
      hardware.update(null, "listening");
      const report = hardware.report();
      assert.equal(report.callActive, false);
      // CoreAudio FourCCs: '!obj' at list level is fatal; 'nope' on an individual process is fatal.
      const status = Buffer.from(scenario.startsWith("list-") ? "!obj" : "nope").readUInt32BE();
      assert.deepEqual(report.capabilities["call-detection"], {
        available: false, reason: `Retrying microphone check. CoreAudio input query failed (${status}).`,
      });
    });
  }
});
