import { test } from "node:test";
import assert from "node:assert/strict";
import { BacklogPlannerCircuit } from "../src/server/foreman/planner-circuit.ts";

const options = {
  failureCap: 3,
  retryMs: 600_000,
  storeBackoffMs: 15_000,
  storeBackoffMaxMs: 600_000,
};

function circuit(): BacklogPlannerCircuit {
  const value = new BacklogPlannerCircuit(options);
  assert.equal(value.setIdentity({ runner: "codex", model: "gpt-5.6-terra" }), "initial");
  return value;
}

test("three genuine planner failures degrade to serial with a bounded retry", () => {
  const value = circuit();
  value.onPlanningFailure("first", 1_000);
  value.onPlanningFailure("second", 2_000);
  assert.equal(value.serial(), false, "the existing three-strike budget was shortened");

  value.onPlanningFailure("provider unavailable\nwith detail", 3_000);
  assert.equal(value.serial(), true);
  assert.deepEqual(value.health(4_000), {
    state: "degraded",
    runner: "codex",
    model: "gpt-5.6-terra",
    failureCount: 3,
    lastError: "provider unavailable with detail",
    nextRetryAt: 603_000,
  });
});

test("an effective provider or model change drops old strikes and forces an immediate probe", () => {
  const value = circuit();
  for (let i = 0; i < 3; i++) value.onPlanningFailure("old provider failed", 1_000 + i);
  assert.equal(value.serial(), true);

  assert.equal(
    value.setIdentity({ runner: "claude", model: "claude-sonnet-5" }),
    "changed",
  );
  assert.equal(value.serial(), false, "the old provider's circuit remained latched");
  assert.equal(value.shouldProbe(), true, "a covering old plan would suppress the probe");
  assert.deepEqual(value.health(5_000), {
    state: "healthy",
    runner: "claude",
    model: "claude-sonnet-5",
    failureCount: 0,
    lastError: null,
    nextRetryAt: null,
  });

  value.onSuccess();
  assert.equal(value.shouldProbe(), false);
  assert.equal(value.setIdentity({ runner: "claude", model: "claude-sonnet-5" }), "same");

  assert.equal(
    value.setIdentity({ runner: "claude", model: "claude-haiku-4-5" }),
    "changed",
  );
  assert.equal(value.shouldProbe(), true, "a backlog-model-only edit did not rearm planning");
});

test("an operator retry spends one immediate probe and preserves the safe fallback on failure", () => {
  const value = circuit();
  for (let i = 0; i < 3; i++) value.onPlanningFailure("rate limited", 1_000 + i);

  value.requestProbe();
  assert.equal(value.serial(), false);
  assert.equal(value.shouldProbe(), true);
  assert.equal(value.health(4_000)?.nextRetryAt, 4_000);

  value.onPlanningFailure("still rate limited", 4_100);
  assert.equal(value.serial(), true, "a failed manual probe removed serial safety");
  assert.equal(value.health(4_200)?.failureCount, 4);
  assert.equal(value.health(4_200)?.nextRetryAt, 604_100);
});

test("plan storage outages use the same visible serial fallback and recover only after a write", () => {
  const value = circuit();
  value.onStoreFailure(new Error("daemon refused write"), 1_000);
  value.onStoreFailure(new Error("daemon refused write"), 20_000);
  value.onStoreFailure(new Error("daemon refused write"), 60_000);
  assert.equal(value.serial(), true);
  assert.equal(value.health(60_100)?.failureCount, 3);
  assert.match(value.health(60_100)?.lastError ?? "", /daemon refused write/);

  value.onSuccess();
  assert.deepEqual(value.health(70_000), {
    state: "healthy",
    runner: "codex",
    model: "gpt-5.6-terra",
    failureCount: 0,
    lastError: null,
    nextRetryAt: null,
  });
});
