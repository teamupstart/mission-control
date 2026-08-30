import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mission-conductor-engineer-provider-"));
process.env.HARNESS_HOME = join(home, "state");
const fake = join(home, "conduct-ts");

writeFileSync(
  fake,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = process.env.FAKE_CONDUCTOR_MODE || "ok";
if (mode === "hang") { setTimeout(() => {}, 60_000); }
else if (mode === "malformed") { process.stdout.write("not-json\\n"); }
else if (mode === "nonzero-json") {
  process.stdout.write(JSON.stringify({schemaVersion:1, engineerLifecycleEventsV1:true}) + "\\n");
  process.stderr.write("provider refused\\n");
  process.exitCode = 7;
}
else {
  const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const command = args[1];
  const repoRoot = flag("--repo-root") || "/repo/demo";
  const correlationId = flag("--correlation-id") || "commission-1";
  const runId = flag("--run-id") || "run-1";
  const attemptKey = flag("--attempt-key") || "launch-1";
  const base = {
    schemaVersion: 1,
    capability: "engineerLifecycleEventsV1",
    engineerRunId: runId,
    correlationId,
    attemptKey,
    attempt: 1,
    previousEngineerRunId: null,
    repoRoot,
    idea: flag("--idea") || "Add widgets",
    eventRevision: 1,
    state: command === "run-cancel" ? "cancelled" : "created",
  };
  if (command === "capabilities") console.log(JSON.stringify({schemaVersion:1, engineerLifecycleEventsV1:true}));
  else if (command === "run-create" || command === "run-cancel") console.log(JSON.stringify(base));
  else if (command === "run-inspect") console.log(JSON.stringify({schemaVersion:1, capability:"engineerLifecycleEventsV1", repoRoot, correlationId, runs:[base]}));
  else if (command === "run-replay") {
    const afterRevision = Number(flag("--after-revision"));
    const event = {schemaVersion: mode === "future-schema" ? 2 : 1, engineerRunId:runId, correlationId, attemptKey, attempt:1, previousEngineerRunId:null, repoRoot, revision:1, ts:"2026-08-28T12:00:00.000Z", type:"engineer_run_created", idea:"Add widgets"};
    console.log(JSON.stringify({schemaVersion:1, engineerRunId:runId, afterRevision, events: afterRevision < 1 ? [event] : []}));
  } else process.exitCode = 2;
}
`,
  "utf8",
);
chmodSync(fake, 0o755);
process.env.MISSION_CONDUCTOR_BIN = fake;

const {
  CONDUCTOR_ENGINEER_LIFECYCLE,
  resetConductorEngineerCapabilityCache,
} = await import("../src/server/pipelines/conductor/engineer.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("capability, create, correlation inspect, replay, and cancel parse exact JSON", async () => {
  process.env.FAKE_CONDUCTOR_MODE = "ok";
  resetConductorEngineerCapabilityCache();
  assert.deepEqual(await CONDUCTOR_ENGINEER_LIFECYCLE.capability(), {
    ok: true,
    value: { supported: true },
  });
  const created = await CONDUCTOR_ENGINEER_LIFECYCLE.create({
    repoRoot: "/repo/demo",
    idea: "Add widgets",
    correlationId: "commission-1",
    attemptKey: "launch-1",
  });
  assert.equal(created.ok && created.value.engineerRunId, "run-1");
  const lineage = await CONDUCTOR_ENGINEER_LIFECYCLE.inspectCorrelation({
    repoRoot: "/repo/demo",
    correlationId: "commission-1",
  });
  assert.equal(lineage.ok && lineage.value.length, 1);
  const replay = await CONDUCTOR_ENGINEER_LIFECYCLE.replay({
    engineerRunId: "run-1",
    afterRevision: 0,
  });
  assert.equal(replay.ok && replay.value[0]?.type, "engineer_run_created");
  const cancelled = await CONDUCTOR_ENGINEER_LIFECYCLE.cancel({
    engineerRunId: "run-1",
    reason: "operator cancelled",
  });
  assert.equal(cancelled.ok && cancelled.value.state, "cancelled");
});

test("malformed output is refused even when the command exits successfully", async () => {
  process.env.FAKE_CONDUCTOR_MODE = "malformed";
  resetConductorEngineerCapabilityCache();
  const answer = await CONDUCTOR_ENGINEER_LIFECYCLE.capability();
  assert.equal(answer.ok, false);
  if (!answer.ok) {
    assert.equal(answer.outcomeUnknown, false);
    assert.match(answer.error, /expected JSON/);
  }
});

test("replay retains a structurally valid future-schema event for the shared reducer", async () => {
  process.env.FAKE_CONDUCTOR_MODE = "future-schema";
  const replay = await CONDUCTOR_ENGINEER_LIFECYCLE.replay({
    engineerRunId: "run-1",
    afterRevision: 0,
  });
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value[0]?.schemaVersion, 2);
    assert.equal(replay.value[0]?.revision, 1);
  }
});

test("valid-looking JSON cannot turn a non-zero provider exit into success", async () => {
  process.env.FAKE_CONDUCTOR_MODE = "nonzero-json";
  resetConductorEngineerCapabilityCache();
  const answer = await CONDUCTOR_ENGINEER_LIFECYCLE.capability();
  assert.equal(answer.ok, false);
  if (!answer.ok) {
    assert.equal(answer.outcomeUnknown, false);
    assert.match(answer.error, /provider refused/);
  }
});

test("a missing provider binary returns a bounded refusal", async () => {
  process.env.MISSION_CONDUCTOR_BIN = join(home, "missing-conduct-ts");
  process.env.FAKE_CONDUCTOR_MODE = "ok";
  resetConductorEngineerCapabilityCache();
  const answer = await CONDUCTOR_ENGINEER_LIFECYCLE.capability();
  assert.equal(answer.ok, false);
  if (!answer.ok) {
    assert.equal(answer.outcomeUnknown, false);
    assert.match(answer.error, /not on this daemon's PATH/);
  }
  process.env.MISSION_CONDUCTOR_BIN = fake;
});

test("a timed-out capability probe is outcome-unknown and never throws", async () => {
  process.env.FAKE_CONDUCTOR_MODE = "hang";
  resetConductorEngineerCapabilityCache();
  const answer = await CONDUCTOR_ENGINEER_LIFECYCLE.capability();
  assert.equal(answer.ok, false);
  if (!answer.ok) {
    assert.equal(answer.outcomeUnknown, true);
    assert.match(answer.error, /without a known outcome/);
  }
});
