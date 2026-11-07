import assert from "node:assert/strict";
import test from "node:test";
import type { InspectorInspection } from "../src/shared/types.ts";
import type { StackStanding } from "../src/shared/stacking.ts";
import { mergeBucket, mergeTallies } from "../src/web/lib/pr-standing.ts";

// Which merge-queue pile a stacked child sits in. A child with a lifecycle label is held by
// its stack whatever its gate value says: `waiting` while a restack is under way, which clears
// itself, and `blocked` for everything that needs a person or a prompt. A released child, with
// no label, is an ordinary pull request again. Retired rows keep their own piles.

function row(over: Partial<InspectorInspection> = {}): InspectorInspection {
  return {
    key: "acme/repo#8", url: "https://github.com/acme/repo/pull/8", owner: "acme", repo: "repo", number: 8,
    repoRoot: "/repo", cwd: "/repo", sessionId: null, source: "hook", state: "open", headSha: null, reviewPosture: null,
    round: 0, lastReviewedAt: null, lastError: null, failCount: 0, lastFailKind: null, nextAttemptAt: null,
    lastAttemptSha: null, mergedAt: null, mergeBlock: null, observedHeadSha: null, observedState: null, observedAt: null,
    headRefName: "feat/child", title: null, adoptedAt: 0, updatedAt: 0,
    openFindings: 0, postedOpenFindings: 0, resolvedFindings: 0, ...over,
  } as InspectorInspection;
}

function standing(label: string | null, inProgress: boolean, state: StackStanding["state"]): StackStanding {
  return { state, label, inProgress } as StackStanding;
}

const RESTACKING = standing("Restacking onto main", true, "restack-needed");
const BROKEN = standing("Stack broken: #7 closed", false, "broken");
const FOREMAN_OFF = standing("Restack needed: Foreman is off", false, "restack-needed");
const NO_SESSION = standing("Catch-up needed: no session", false, "parent-moved");
const UNCERTAIN = standing("Restack prompt delivery uncertain", false, "restack-needed");
const WAITING_ON_PARENT = standing("Stacked on #7 (waiting for it to merge)", false, "current");
const RETARGET_FAILED = standing("Retarget failed: HTTP 422", false, "parent-merged-needs-retarget");
const RELEASED = standing(null, false, "released");

test("a restack under way is waiting, even while its gate still holds it", () => {
  assert.equal(mergeBucket(row({ mergeBlock: "stack-hold", stackStanding: RESTACKING })), "waiting");
  assert.equal(mergeBucket(row({ mergeBlock: null, stackStanding: RESTACKING })), "waiting");
});

test("every other labelled stack state is blocked, whatever the gate value", () => {
  for (const s of [BROKEN, FOREMAN_OFF, NO_SESSION, UNCERTAIN, WAITING_ON_PARENT, RETARGET_FAILED]) {
    assert.equal(mergeBucket(row({ mergeBlock: "stack-hold", stackStanding: s })), "blocked", s.label!);
    assert.equal(mergeBucket(row({ mergeBlock: "stacked-base", stackStanding: s })), "blocked", s.label!);
    // Even before the merge gate has looked at it (no gate value yet), it is held.
    assert.equal(mergeBucket(row({ mergeBlock: null, stackStanding: s })), "blocked", s.label!);
  }
});

test("a released child, with no lifecycle label, is bucketed by its gate like any pull request", () => {
  assert.equal(mergeBucket(row({ mergeBlock: "soaking", stackStanding: RELEASED })), "soaking");
  assert.equal(mergeBucket(row({ mergeBlock: null, stackStanding: RELEASED })), "waiting");
  assert.equal(mergeBucket(row({ mergeBlock: "checks-failing", stackStanding: RELEASED })), "blocked");
  // ...and so is a pull request with no stack at all.
  assert.equal(mergeBucket(row({ mergeBlock: "soaking" })), "soaking");
  assert.equal(mergeBucket(row({ mergeBlock: null, stackStanding: null })), "waiting");
});

test("retired rows keep their own piles: a stack label never reopens a merged or closed row", () => {
  assert.equal(mergeBucket(row({ mergedAt: 1, state: "closed", stackStanding: BROKEN })), "merged");
  assert.equal(mergeBucket(row({ state: "closed", stackStanding: BROKEN })), "closed");
  assert.equal(mergeBucket(row({ state: "closed", stackStanding: standing("Replaced by #9", false, "broken") })), "closed");
});

test("the strip's tallies count stack rows in the same piles", () => {
  const tallies = mergeTallies([
    row({ mergeBlock: "stack-hold", stackStanding: RESTACKING }),
    row({ mergeBlock: "stack-hold", stackStanding: BROKEN }),
    row({ mergeBlock: "stacked-base", stackStanding: FOREMAN_OFF }),
    row({ mergeBlock: "soaking", stackStanding: RELEASED }),
    row({ state: "closed", stackStanding: BROKEN }),
  ]);
  assert.deepEqual(tallies, { merged: 0, soaking: 1, blocked: 2, waiting: 1, closed: 1 });
});
