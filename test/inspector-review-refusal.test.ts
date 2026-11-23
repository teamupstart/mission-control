import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReviewRefusal, refusalReason } from "../src/server/inspector/github.ts";
import type { GhResult } from "../src/server/inspector/github.ts";

// One classifier decides whether a refused review can be pinned on a finding at all.
// `validation` lets a refusal count toward a draft's cap; everything else is
// `whole-review` and counts against nothing. The failure mode worth guarding is the wrong
// direction: a rate limit or an auth problem read as "this finding is bad" would retire a
// valid draft after three bad afternoons, so anything unrecognized lands on `whole-review`.

function refused(stderr: string): GhResult<void> {
  return { ok: false, error: `gh api (create review) failed (exit 1): ${stderr.slice(0, 300)}`, outcomeUnknown: false, stderr };
}

/** A head reader that answers `unmoved`, and counts how often it was asked. */
function head(unmoved: boolean): { read: () => Promise<boolean>; calls: () => number } {
  let calls = 0;
  return { read: async () => { calls++; return unmoved; }, calls: () => calls };
}

test("a 422 on a head that has not moved is a validation refusal", async () => {
  const h = head(true);
  const res = refused("gh: Unprocessable Entity: Line could not be resolved (HTTP 422)\n");
  assert.equal(await classifyReviewRefusal(res, h.read), "validation");
  assert.equal(h.calls(), 1, "the moved-head check is the one extra request");
});

test("a 422 whose status sits past the 300 bytes the error keeps is still read", async () => {
  const long = `gh: Validation Failed: ${"pull request review thread line must be part of the diff; ".repeat(10)}(HTTP 422)`;
  assert.equal(await classifyReviewRefusal(refused(long), head(true).read), "validation");
});

const WHOLE_REVIEW: [string, string][] = [
  ["a rate limit (429)", "gh: API rate limit exceeded for user (HTTP 429)"],
  ["a secondary rate limit (403)", "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)"],
  ["an auth refusal (401)", "gh: Bad credentials (HTTP 401)"],
  [
    "an SSO refusal",
    "gh: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization. The 'teamupstart' organization has enabled or enforced SAML SSO. (HTTP 403)",
  ],
  ["an SSO refusal reported with a 422", "GraphQL: Resource protected by organization SAML enforcement. (HTTP 422)"],
  ["a server error (5xx)", "gh: Bad Gateway (HTTP 502)"],
  ["an unrecognized non-422 status", "gh: Conflict (HTTP 409)"],
  ["no status at all", "something went wrong"],
];

for (const [name, stderr] of WHOLE_REVIEW) {
  test(`${name} is a whole-review refusal, without reading the head`, async () => {
    const h = head(true);
    assert.equal(await classifyReviewRefusal(refused(stderr), h.read), "whole-review");
    assert.equal(h.calls(), 0, "only a 422 costs a head read");
  });
}

test("a 422 on a head that moved is a whole-review refusal", async () => {
  const h = head(false);
  const res = refused("gh: Unprocessable Entity: Line could not be resolved (HTTP 422)");
  assert.equal(await classifyReviewRefusal(res, h.read), "whole-review");
  assert.equal(h.calls(), 1);
});

const REVIEW_LEVEL_422: [string, string][] = [
  ["the one-pending-review limit", "gh: Unprocessable Entity: User can only have one pending review per pull request (HTTP 422)"],
  ["a bare 422", "gh: Unprocessable Entity (HTTP 422)"],
  ["a body validation failure", "gh: Validation Failed: body is too long (maximum is 65536 characters) (HTTP 422)"],
];

for (const [name, stderr] of REVIEW_LEVEL_422) {
  test(`a 422 for ${name} names no comment, so it is a whole-review refusal without reading the head`, async () => {
    const h = head(true);
    assert.equal(await classifyReviewRefusal(refused(stderr), h.read), "whole-review");
    assert.equal(h.calls(), 0);
  });
}

test("each way GitHub says a comment could not be anchored is a validation refusal", async () => {
  for (const message of [
    "Unprocessable Entity: Line could not be resolved",
    "Unprocessable Entity: Path could not be resolved",
    "Validation Failed: pull_request_review_thread.line must be part of the diff",
    "Validation Failed: pull_request_review_thread.start_line must be part of the diff",
    "Validation Failed: Position is invalid",
  ]) {
    assert.equal(await classifyReviewRefusal(refused(`gh: ${message} (HTTP 422)`), head(true).read), "validation", message);
  }
});

test("a result that is not a refusal is never a validation refusal", async () => {
  const h = head(true);
  const lost: GhResult<void> = { ok: false, error: "killed", outcomeUnknown: true, stderr: "(HTTP 422)" };
  const unflagged: GhResult<void> = { ok: false, error: "x", stderr: "(HTTP 422)" };
  const overflowed: GhResult<void> = { ok: false, outcomeUnknown: false, tooLarge: true, stderr: "(HTTP 422)" };
  for (const res of [lost, unflagged, overflowed, { ok: true }]) {
    assert.equal(await classifyReviewRefusal(res, h.read), "whole-review");
  }
  assert.equal(h.calls(), 0);
});

test("the recorded reason is GitHub's words, scrubbed and clipped to 300 bytes", () => {
  const reason = refusalReason(refused("gh: Unprocessable Entity:\n  Line could not be resolved (HTTP 422)\n"));
  assert.equal(reason, "Unprocessable Entity: Line could not be resolved (HTTP 422)");

  const secret = refusalReason(refused("gh: rejected ghp_abcdefghijklmnopqrstuvwxyz0123456789 (HTTP 422)"));
  assert.doesNotMatch(secret, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);

  const long = refusalReason(refused(`gh: ${"é".repeat(400)} (HTTP 422)`));
  assert.ok(Buffer.byteLength(long, "utf8") <= 300);
});
