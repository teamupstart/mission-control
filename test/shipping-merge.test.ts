import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGE_BLOCK_LABEL, mergeVerdict } from "../src/shared/shipping.ts";
import type { MergeBlock, MergeInput } from "../src/shared/shipping.ts";
import { ShippingConfigSchema } from "../src/shared/protocol.ts";

// What is at stake: this is the only predicate in the app whose `true` lands a commit on
// somebody's default branch, and there is no undo behind it. Every test here is a gate
// that must hold - and the ones that matter most are the ones asserting a BLOCK, because
// a gate that quietly stops vetoing does not fail loudly anywhere else.

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const cfg = ShippingConfigSchema.parse({
  autoMerge: true,
  repoAllowlist: ["/repo"],
});

/** A pull request with every gate satisfied. Each test spoils exactly one thing. */
function ready(over: Partial<MergeInput> = {}): MergeInput {
  return {
    cfg,
    cwd: "/repo",
    repoRoot: "/repo",
    pr: {
      state: "OPEN",
      isDraft: false,
      headSha: "abc",
      createdAt: NOW - HOUR,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      checks: "passing",
      unresolvedThreads: 0,
      ...(over.pr ?? {}),
    },
    inspector: "live",
    reviewedSha: "abc",
    reviewPosture: "live",
    workflowGatePending: false,
    rounds: 1,
    openFindings: 0,
    now: NOW,
    ...over,
  };
}

function blockOf(input: MergeInput): MergeBlock | null {
  const v = mergeVerdict(input);
  assert.equal(v.merge, false, "expected this to be blocked");
  return v.block;
}

test("everything green, soak elapsed: it merges", () => {
  assert.deepEqual(mergeVerdict(ready()), { merge: true, block: null, waitMs: 0 });
});

// The shipped defaults are the off position, and this is the test that says so out loud:
// a config nobody has touched must not merge a PR that satisfies every other gate.
test("it ships off - a default config merges nothing, however green", () => {
  const off = ShippingConfigSchema.parse({});
  assert.equal(off.autoMerge, false);
  assert.equal(off.soakMinutes, 10, "the soak default is the documented ten minutes");
  assert.equal(blockOf(ready({ cfg: off })), "off");
});

test("a repo nobody trusted is not merged in, even with the switch on", () => {
  assert.equal(blockOf(ready({ cwd: "/elsewhere", repoRoot: "/elsewhere" })), "not-allowlisted");
});

// The allowlist is the same predicate Foreman and the Inspector use, so a worktree of a
// trusted repo is trusted. Pinned here because auto-merge acts almost exclusively on
// worktrees: sessions run in pooled checkouts under ~/.treehouse, not in the repo itself.
test("a worktree of a trusted repo is trusted", () => {
  assert.equal(mergeVerdict(ready({ cwd: "/tmp/pool/wt-3", repoRoot: "/repo" })).merge, true);
});

// ---- The Inspector's posture ----
//
// These are the two posture dimensions the merge must not collapse. Current posture
// vetoes acting while dry-run is still selected. Stored review posture prevents changing
// the setting later from retroactively promoting the already-reviewed head. A clean
// dry-run review has a matching head and zero findings, so `not-reviewed` cannot catch
// either case: a review DID happen, but it was not live.

test("a review the Inspector never published does not merge - dry run", () => {
  assert.equal(blockOf(ready({ inspector: "dry-run" })), "inspector-dry-run");
});

test("switching live cannot promote a review completed in dry run", () => {
  assert.equal(
    blockOf(ready({ inspector: "live", reviewPosture: "dry-run" })),
    "review-unpublished",
  );
});

test("a legacy review with unknown posture must be repeated live", () => {
  assert.equal(blockOf(ready({ inspector: "live", reviewPosture: null })), "review-unpublished");
});

test("a review the Inspector never published does not merge - untrusted repo", () => {
  assert.equal(blockOf(ready({ inspector: "not-allowlisted" })), "inspector-not-allowlisted");
});

// Unreachable through the worker today, which is exactly why it is pinned: `maybeMerge`
// is only called from inside the Inspector's tick, and that returns early while disabled.
// The day anything else calls this predicate - the second poller `shipping/merge.ts`
// argues against - the gate has to hold on its own rather than inherit a scheduling
// accident.
test("the Inspector being off is a veto here too, not just a tick that never runs", () => {
  assert.equal(blockOf(ready({ inspector: "off" })), "inspector-off");
});

// The two allowlists are deliberately separate - trusting YOLO mode to merge in a repo is
// a bigger grant than trusting the Inspector to comment on it - so this is the shape the
// bug had in the field: shipping trusts the repo, the Inspector does not, and the merge
// must lose that argument rather than win it.
test("shipping's allowlist does not stand in for the Inspector's", () => {
  const v = mergeVerdict(ready({ cwd: "/repo", repoRoot: "/repo", inspector: "not-allowlisted" }));
  assert.equal(v.merge, false);
  assert.equal(v.block, "inspector-not-allowlisted");
});

test("a draft is never merged", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, isDraft: true } })), "draft");
});

test("an active workflow final gate narrowly vetoes YOLO merge", () => {
  assert.equal(blockOf(ready({ workflowGatePending: true })), "workflow-gate-pending");
  assert.equal(mergeVerdict(ready({ workflowGatePending: false })).merge, true);
  assert.match(MERGE_BLOCK_LABEL["workflow-gate-pending"], /workflow/i);
});

// The whole point of the feature is that the Inspector looked at THIS code. A review of a
// previous push is not a review of what would land.
test("a review of an older push does not license merging the new one", () => {
  assert.equal(blockOf(ready({ reviewedSha: "older" })), "not-reviewed");
});

test("an adopted but never-reviewed PR is not merged", () => {
  assert.equal(blockOf(ready({ rounds: 0 })), "not-reviewed");
});

test("an open Inspector finding blocks the merge", () => {
  assert.equal(blockOf(ready({ openFindings: 1 })), "findings");
});

// Stricter than the spec ("no open comments by the Inspector") on purpose: merging over a
// colleague's unanswered question is not a thing an automation gets to do, whoever asked.
test("somebody else's unresolved thread blocks the merge too", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, unresolvedThreads: 1 } })), "threads");
});

test("a human who requested changes outranks a clean review", () => {
  const pr = { ...ready().pr, reviewDecision: "CHANGES_REQUESTED" as const };
  assert.equal(blockOf(ready({ pr })), "changes-requested");
});

test("a required review that has not been given blocks the merge", () => {
  const pr = { ...ready().pr, reviewDecision: "REVIEW_REQUIRED" as const };
  assert.equal(blockOf(ready({ pr })), "review-required");
});

test("an approval does not skip any other gate", () => {
  const pr = { ...ready().pr, reviewDecision: "APPROVED" as const, checks: "failing" as const };
  assert.equal(blockOf(ready({ pr })), "checks-failing");
});

test("failing CI blocks, and pending CI blocks", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, checks: "failing" } })), "checks-failing");
  assert.equal(blockOf(ready({ pr: { ...ready().pr, checks: "pending" } })), "checks-pending");
});

// The one that would turn this feature into something nobody switched on. A repo with no
// workflow, or a workflow that failed to trigger, reports NO checks - and if silence read
// as success, YOLO mode there would mean "merge everything the moment it is reviewed".
test("no checks at all is not the same as passing", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, checks: "none" } })), "no-checks");
});

test("a conflicting branch is not merged", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, mergeable: "CONFLICTING" } })), "conflicting");
});

// GitHub computes mergeability lazily, so UNKNOWN is the ordinary answer just after a
// push. Waiting a poll costs nothing; merging on it means merging without ever having
// been told the merge is clean.
test("mergeability GitHub has not worked out yet is a block, not a maybe", () => {
  const pr = { ...ready().pr, mergeable: "UNKNOWN" as const };
  assert.equal(blockOf(ready({ pr })), "mergeability-unknown");
});

test("a PR younger than the soak window waits, and reports how long", () => {
  const pr = { ...ready().pr, createdAt: NOW - 4 * 60_000 };
  const v = mergeVerdict(ready({ pr }));
  assert.equal(v.merge, false);
  assert.equal(v.block, "soaking");
  assert.equal(v.waitMs, 6 * 60_000, "ten minutes of soak, four of them served");
});

test("the soak is measured against the configured minutes, not a constant", () => {
  const slow = ShippingConfigSchema.parse({ ...cfg, soakMinutes: 120 });
  assert.equal(blockOf(ready({ cfg: slow })), "soaking", "an hour-old PR is young at 120m");
  const none = ShippingConfigSchema.parse({ ...cfg, soakMinutes: 0 });
  const fresh = { ...ready().pr, createdAt: NOW };
  assert.equal(mergeVerdict(ready({ cfg: none, pr: fresh })).merge, true, "zero means no soak");
});

// A soak that can be skipped by a parse failure is not a soak. GitHub's timestamp is the
// only source for "how long has this been open", so an unreadable one has to fail closed.
test("a PR whose open time we cannot read never finishes soaking", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, createdAt: null } })), "soaking");
});

test("a PR that is no longer open is not merged", () => {
  assert.equal(blockOf(ready({ pr: { ...ready().pr, state: "MERGED" } })), "not-open");
  assert.equal(blockOf(ready({ pr: { ...ready().pr, state: "CLOSED" } })), "not-open");
});

// The panel reads a stored block code and expands it into a sentence. A code with no
// label falls through to the raw string, which for a real `MergeBlock` would show the
// operator a slug where a reason should be.
test("every block code the gate can return has a sentence for the panel", () => {
  const codes: MergeBlock[] = [
    "off",
    "not-allowlisted",
    "inspector-off",
    "inspector-dry-run",
    "inspector-not-allowlisted",
    "review-unpublished",
    "not-open",
    "draft",
    "workflow-gate-pending",
    "not-reviewed",
    "findings",
    "threads",
    "changes-requested",
    "review-required",
    "checks-failing",
    "checks-pending",
    "no-checks",
    "conflicting",
    "mergeability-unknown",
    "soaking",
  ];
  for (const c of codes) assert.ok(MERGE_BLOCK_LABEL[c], `no label for ${c}`);
  assert.equal(
    Object.keys(MERGE_BLOCK_LABEL).length,
    codes.length,
    "a label was added or removed without this list following it",
  );
});
