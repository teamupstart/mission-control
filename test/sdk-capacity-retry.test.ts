import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPACITY_RETRY_MAX_ATTEMPTS,
  capacityRetryActivity,
  capacityRetryPlan,
} from "../src/server/sdk/capacity-retry.ts";

test("capacity retries back off from 15 seconds, doubling to a 10 minute ceiling", () => {
  const delays: number[] = [];
  for (let attempt = 1; attempt <= CAPACITY_RETRY_MAX_ATTEMPTS; attempt++) {
    delays.push(capacityRetryPlan(attempt)!.delayMs / 1000);
  }
  assert.deepEqual(delays, [15, 30, 60, 120, 240, 480, 600, 600]);
  assert.equal(capacityRetryPlan(CAPACITY_RETRY_MAX_ATTEMPTS + 1), null, "the attempts run out");
  assert.equal(capacityRetryPlan(0), null);
});

test("the card says the model is at capacity, when the retry lands, and which attempt it is", () => {
  assert.equal(
    capacityRetryActivity(capacityRetryPlan(1)!),
    "Model at capacity - retrying in 15s (attempt 1 of 8)",
  );
  assert.equal(
    capacityRetryActivity(capacityRetryPlan(3)!),
    "Model at capacity - retrying in 1m (attempt 3 of 8)",
  );
});
