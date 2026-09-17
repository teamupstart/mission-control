import assert from "node:assert/strict";
import test from "node:test";
import { inspectorChipView } from "../src/web/components/session-bits.tsx";
import type { InspectorSummary } from "../src/shared/types.ts";

const reviewed: InspectorSummary = {
  prKey: "owner/repo#1", url: "https://github.com/owner/repo/pull/1", mode: "live",
  open: 0, postedOpen: 0, round: 1, lastReviewedAt: 1, failed: false,
  reviewedHeadSha: "a".repeat(40), observedHeadSha: "a".repeat(40), cleanReviewHeadSha: null,
};

test("zero open findings is pending until a clean review is confirmed for the observed head", () => {
  const pending = inspectorChipView(reviewed)!;
  assert.equal(pending.mark, "…");
  assert.match(pending.title, /no open findings at aaaaaaaa.*Final clean review pending/);
  const published = inspectorChipView({ ...reviewed, cleanReviewHeadSha: reviewed.reviewedHeadSha })!;
  assert.equal(published.mark, "✓");
  assert.match(published.title, /Workflow completion is separate/);
  const stale = inspectorChipView({ ...reviewed, cleanReviewHeadSha: reviewed.reviewedHeadSha, observedHeadSha: "b".repeat(40) })!;
  assert.equal(stale.mark, "…");
  assert.match(stale.title, /current PR commit/);
});

test("a dry-run conclusion never claims publication", () => {
  const dry = inspectorChipView({ ...reviewed, mode: "dry-run" })!;
  assert.equal(dry.mark, "✓");
  assert.equal(dry.tone, "insp-clean");
  assert.equal(dry.dry, true);
  assert.match(dry.title, /dry run - nothing was posted/);
  assert.doesNotMatch(dry.title, /Final clean review published/);
});

for (const [name, heads] of [
  ["stale", { observedHeadSha: "b".repeat(40) }],
  ["missing reviewed head", { reviewedHeadSha: null }],
  ["missing observed head", { observedHeadSha: null }],
] as const) {
  test(`a dry-run review with ${name} evidence stays pending`, () => {
    const view = inspectorChipView({ ...reviewed, mode: "dry-run", ...heads })!;
    assert.equal(view.mark, "…");
    assert.equal(view.tone, "insp-queued");
    assert.equal(view.dry, true);
    assert.match(view.title, /dry run - nothing was posted/);
    assert.match(view.title, /Waiting for the current PR commit to be reviewed/);
    assert.doesNotMatch(view.title, /Final clean review published/);
  });
}
