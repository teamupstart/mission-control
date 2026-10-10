import assert from "node:assert/strict";
import test from "node:test";
import { waitForWorkerObservation } from "./helpers/worker-observation.ts";

test("a host pause longer than the whole allowance does not kill an unobserved worker on resume", async () => {
  let now = 0;
  let polls = 0;
  const observed = await waitForWorkerObservation(() => polls >= 3, 20_000, {
    now: () => now,
    sleep: async (delay) => { now += delay + (++polls === 1 ? 900_000 : 0); },
  });
  assert.equal(observed, true, "the worker must still have an opportunity to produce its completion signal after the host resumes");
  assert.equal(polls, 3);
});

test("an unresponsive worker still exhausts its ordinary action budget", async () => {
  let now = 0;
  const observed = await waitForWorkerObservation(() => false, 20_000, {
    now: () => now,
    sleep: async (delay) => { now += delay; },
  });
  assert.equal(observed, false);
  assert.equal(now, 20_000);
});

test("repeated scheduling contention remains bounded by the existing six-budget ceiling", async () => {
  let now = 0;
  const observed = await waitForWorkerObservation(() => false, 20_000, {
    now: () => now,
    sleep: async (delay) => { now += delay + 950; },
  });
  assert.equal(observed, false);
  assert.equal(now, 120_000);
});
