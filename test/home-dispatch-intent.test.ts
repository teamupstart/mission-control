// F16: the run-now or schedule detector and the hook nudge (spec 7.20). Pure, no database.
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchIntentFor } from "../src/shared/home-dispatch.ts";
import { dispatchNudge, nudgeText } from "../src/server/home-dispatch/intent.ts";

test("F16 intent: it must name Mission Control, as `mission control`, `mission-control` or `MC`", () => {
  assert.equal(dispatchIntentFor("run this in Mission Control now"), "now");
  assert.equal(dispatchIntentFor("run this in mission-control now"), "now");
  assert.equal(dispatchIntentFor("start this in MC"), "now");
  assert.equal(dispatchIntentFor("start this in mc"), "now", "case-insensitive");
  assert.equal(dispatchIntentFor("run the tests now"), null, "a verb alone is not a dispatch");
  assert.equal(dispatchIntentFor("schedule the migration for tomorrow"), null, "a schedule word alone is not a dispatch");
});

test("F16 intent: MC is matched as a whole word only", () => {
  assert.equal(dispatchIntentFor("run the mcp server"), null);
  assert.equal(dispatchIntentFor("start the amcrest camera"), null);
  assert.equal(dispatchIntentFor("send it to MC."), "now");
});

test("F16 intent: a schedule word gives backlog, otherwise a run verb gives now, otherwise null", () => {
  assert.equal(dispatchIntentFor("schedule a task in Mission Control's backlog to add retries to the webhook client"), "backlog");
  assert.equal(dispatchIntentFor("park this in Mission Control"), "backlog");
  assert.equal(dispatchIntentFor("queue this for Mission Control"), "backlog");
  assert.equal(dispatchIntentFor("do it later in mission control"), "backlog");
  assert.equal(dispatchIntentFor("kick off a bugfix in Mission Control"), "now");
  assert.equal(dispatchIntentFor("dispatch that to Mission Control"), "now");
  assert.equal(dispatchIntentFor("delegate this to MC"), "now");
  assert.equal(dispatchIntentFor("hand this to Mission Control"), "now");
  assert.equal(dispatchIntentFor("what is Mission Control doing"), null);
});

test("F16 intent: a schedule word beats a run verb in the same prompt", () => {
  assert.equal(dispatchIntentFor("start this in Mission Control later"), "backlog");
  assert.equal(dispatchIntentFor("run this in MC from the backlog"), "backlog");
});

test("F16 intent: plain inflections count, and the detector keeps no state", () => {
  assert.equal(dispatchIntentFor("I'm scheduling this in Mission Control"), "backlog");
  assert.equal(dispatchIntentFor("we queued it in MC"), "backlog");
  assert.equal(dispatchIntentFor("starting this in Mission Control"), "now");
  // Different inputs in between must not change a later answer: interleave all three outcomes.
  assert.equal(dispatchIntentFor("run this in MC"), "now");
  assert.equal(dispatchIntentFor("schedule this in MC"), "backlog");
  assert.equal(dispatchIntentFor("fix the flaky test"), null);
  assert.equal(dispatchIntentFor("run this in MC"), "now");
  assert.equal(dispatchIntentFor("Do not run this in MC"), null);
  assert.equal(dispatchIntentFor("run this in MC"), "now");
  assert.equal(dispatchIntentFor(""), null);
});

test("F16 nudge: the hook says which skill entry and intent to use, and to return to the work", () => {
  assert.equal(
    nudgeText("now"),
    "The person asked to run this now in Mission Control. Use the mission-dispatch skill's conversation entry with intent now. Then return to what you were doing.",
  );
  assert.equal(
    nudgeText("backlog"),
    "The person asked to save this to the backlog in Mission Control. Use the mission-dispatch skill's conversation entry with intent backlog. Then return to what you were doing.",
  );
  assert.equal(dispatchNudge("run this in MC"), nudgeText("now"));
  assert.equal(dispatchNudge("fix the flaky test"), null);
});

test("F16 intent: a negated request is not a request", () => {
  assert.equal(dispatchIntentFor("Do not run this in Mission Control"), null);
  assert.equal(dispatchIntentFor("Do not schedule this in MC"), null);
  assert.equal(dispatchIntentFor("don\u2019t start this in mission-control"), null);
  assert.equal(dispatchIntentFor("never queue this for MC"), null);
  assert.equal(dispatchNudge("Do not run this in Mission Control"), null);
});

test("F16 intent: a negation in another clause does not cancel a request", () => {
  assert.equal(dispatchIntentFor("Don't wait, run this in Mission Control"), "now");
  assert.equal(dispatchIntentFor("Do not run it here. Schedule it in MC"), "backlog");
  assert.equal(dispatchIntentFor("run this in MC, not locally"), "now", "a negation after the verb is not a refusal of it");
});

test("F16 intent: an affirmative request after a negated action in the same sentence still counts", () => {
  assert.equal(dispatchIntentFor("Do not schedule this in MC but run it now in MC"), "now");
  assert.equal(dispatchIntentFor("Do not run this in MC but schedule it in MC"), "backlog");
});

test("F16 intent: the action must be in a clause that names Mission Control", () => {
  assert.equal(dispatchIntentFor("Do not run this in Mission Control. Start it locally"), null);
  assert.equal(dispatchIntentFor("Start it locally. Mission Control looks fine"), null);
  assert.equal(dispatchIntentFor("Do not run this in Mission Control. Start it in MC later"), "backlog");
});
