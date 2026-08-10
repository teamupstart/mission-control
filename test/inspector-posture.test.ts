import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectorPosture, reviewNeedsLiveRerun } from "../src/shared/inspector.ts";
import { InspectorConfigSchema } from "../src/shared/protocol.ts";
import { mergeVerdict } from "../src/shared/shipping.ts";
import { ShippingConfigSchema } from "../src/shared/protocol.ts";

// What is at stake: this predicate is the difference between "the Inspector looked at
// this" and "the Inspector published what it found", and only the second is something an
// auto-merger may act on. It has two callers who must never disagree - the worker
// deciding whether to post a comment, and `mergeVerdict` deciding whether to land a
// commit - because the first one drifting from the second is how an unpublished review
// merges itself. The tests below pin each switch separately, since each is a consent the
// operator gave separately.

const live = InspectorConfigSchema.parse({
  enabled: true,
  mode: "live",
  repoAllowlist: ["/repo"],
});

test("all three switches on, in a trusted repo: live", () => {
  assert.equal(inspectorPosture(live, "/repo", "/repo"), "live");
});

test("the shipped defaults are the off position", () => {
  const fresh = InspectorConfigSchema.parse({});
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.mode, "dry-run");
  assert.deepEqual(fresh.repoAllowlist, []);
  assert.equal(inspectorPosture(fresh, "/repo", "/repo"), "off");
});

test("disabled reports off, whatever the other two say", () => {
  assert.equal(inspectorPosture({ ...live, enabled: false }, "/repo", "/repo"), "off");
});

test("dry run reports dry-run, even in a trusted repo", () => {
  assert.equal(inspectorPosture({ ...live, mode: "dry-run" }, "/repo", "/repo"), "dry-run");
});

test("an untrusted repo reports not-allowlisted, even switched on and live", () => {
  assert.equal(inspectorPosture(live, "/elsewhere", "/elsewhere"), "not-allowlisted");
  assert.equal(inspectorPosture({ ...live, repoAllowlist: [] }, "/repo", "/repo"), "not-allowlisted");
});

// Same widening every other consent gate in the app gets, and it matters more here than
// most: the Inspector reviews PRs opened from pooled session worktrees under ~/.treehouse,
// so a rule that only matched the repo itself would report `not-allowlisted` for
// practically every real pull request - and now that the merge gate reads this value,
// that would silently stop YOLO mode rather than just the commenting.
test("a worktree of a trusted repo is trusted", () => {
  assert.equal(inspectorPosture(live, "/tmp/pool/wt-3", "/repo"), "live");
});

test("switching live makes a dry-run or legacy review due again", () => {
  assert.equal(reviewNeedsLiveRerun("live", "dry-run"), true);
  assert.equal(reviewNeedsLiveRerun("live", "not-allowlisted"), true);
  assert.equal(reviewNeedsLiveRerun("live", null), true);
  assert.equal(reviewNeedsLiveRerun("live", "live"), false);
  assert.equal(reviewNeedsLiveRerun("dry-run", "dry-run"), false);
});

// The order is a product decision, not an implementation detail: an operator whose
// Inspector is switched off cannot act on being told their repo is untrusted as well.
test("the reason reported is the outermost switch that is withholding consent", () => {
  const nothingOn = InspectorConfigSchema.parse({ enabled: false, mode: "dry-run" });
  assert.equal(inspectorPosture(nothingOn, "/elsewhere", "/elsewhere"), "off");
  const onlyOff = { ...live, enabled: true, mode: "dry-run" as const, repoAllowlist: [] };
  assert.equal(inspectorPosture(onlyOff, "/elsewhere", "/elsewhere"), "dry-run");
});

// The end-to-end statement of the bug, in the terms the operator hit it: their config had
// YOLO mode armed and the repo trusted for shipping, while the Inspector sat in dry-run
// with an empty allowlist. Every PR gate was green and the review was clean, and it
// merged. This is the assertion that it does not any more.
test("the operator's config: armed for shipping, unpublished by the Inspector, does not merge", () => {
  const shipping = ShippingConfigSchema.parse({
    autoMerge: true,
    soakMinutes: 5,
    repoAllowlist: ["/repo"],
  });
  const inspector = InspectorConfigSchema.parse({
    enabled: true,
    mode: "dry-run",
    repoAllowlist: [],
  });
  const NOW = 1_800_000_000_000;

  const verdict = mergeVerdict({
    cfg: shipping,
    inspector: inspectorPosture(inspector, "/tmp/pool/wt-8", "/repo"),
    cwd: "/tmp/pool/wt-8",
    repoRoot: "/repo",
    pr: {
      state: "OPEN",
      isDraft: false,
      headSha: "deadbeef",
      createdAt: NOW - 3_600_000,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      checks: "passing",
      unresolvedThreads: 0,
    },
    // A completed, clean review of exactly this head - which dry run produces.
    reviewedSha: "deadbeef",
    reviewPosture: "dry-run",
    workflowGate: "none",
    rounds: 1,
    openFindings: 0,
    now: NOW,
  });

  assert.equal(verdict.merge, false, "an unpublished review must never land a commit");
  assert.equal(verdict.block, "inspector-dry-run");
});
