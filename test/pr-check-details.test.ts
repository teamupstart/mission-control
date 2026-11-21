import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDetails } from "../src/server/github/check-details.ts";
import { prCheckSummary } from "../src/shared/pr-check-details.ts";

test("display retains cancellations and successful reruns without calling them failures", () => {
  const details = checkDetails([
    { name: "Catalog", conclusion: "CANCELLED", detailsUrl: "https://github.com/o/r/actions/runs/1/job/1" },
    { name: "Catalog", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/2/job/2" },
    { name: "title", conclusion: "CANCELLED" },
  ]);
  assert.equal(details.complete, true);
  assert.equal(details.results.length, 3);
  assert.equal(details.results[0]?.url, "https://github.com/o/r/actions/runs/1/job/1");
  assert.match(prCheckSummary(details), /2 cancelled checks; no failures/);
});

test("only explicit failures get failure wording; other conclusions remain verbatim", () => {
  for (const conclusion of ["TIMED_OUT", "ACTION_REQUIRED", "STALE", "STARTUP_FAILURE", "FUTURE_RESULT", "IN_PROGRESS"]) {
    const details = checkDetails([{ name: "build", status: conclusion }]);
    assert.equal(details.results[0]?.conclusion, conclusion);
    assert.doesNotMatch(prCheckSummary(details), /reported failure/);
  }
  const details = checkDetails([{ context: "legacy", state: "ERROR", targetUrl: "https://ci.example/result" }]);
  assert.match(prCheckSummary(details), /1 CI check reported failure/);
  assert.equal(details.results[0]?.url, "https://ci.example/result");
});

test("missing, partial and malformed details never imply a complete clean result", () => {
  assert.match(prCheckSummary(null), /unavailable/);
  assert.equal(checkDetails(undefined).complete, false);
  assert.equal(checkDetails([null]).complete, false);
  const bounded = checkDetails(Array.from({ length: 101 }, () => ({ name: "build", conclusion: "SUCCESS" })));
  assert.equal(bounded.results.length, 100);
  assert.equal(bounded.complete, false);
  for (const detailsUrl of ["javascript:alert(1)", "file:///secret", "malformed", undefined]) {
    assert.equal(checkDetails([{ name: "build", conclusion: "FAILURE", detailsUrl }]).results[0]?.url, null);
  }
});
