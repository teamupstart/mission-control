import assert from "node:assert/strict";
import test from "node:test";
import type { ProductIssueRequest } from "../src/shared/product-issues.ts";
import { publishProductIssue } from "../src/web/lib/product-issue-submission.ts";

const REQUEST: ProductIssueRequest = {
  type: "bug",
  title: "One click",
  details: "Publish the rendered report from one deliberate press.",
  attachmentUploadIds: [],
  requestId: "11111111-2222-4333-8444-555555555555",
  client: "electron",
};
test("one submission call confirms and publishes in order", async () => {
  const calls: string[] = [];
  const result = await publishProductIssue(REQUEST, {
    confirm: async () => {
      calls.push("confirm");
      return {
        outcome: "confirmation",
        requestId: REQUEST.requestId,
        draftIdentity: "a".repeat(64),
        target: "acme/public-issues",
        token: "b".repeat(64),
        expiresAt: Date.now() + 1000,
      };
    },
    submit: async (_request, token) => {
      calls.push(`submit:${token}`);
      return {
        outcome: "created",
        issueUrl: "https://github.com/acme/public-issues/issues/1",
        target: "acme/public-issues",
      };
    },
  });
  assert.deepEqual(calls, [
    "confirm",
    `submit:${"b".repeat(64)}`,
  ]);
  assert.equal(result.result.outcome, "created");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.refreshPreview, false);
});

test("a confirmation refusal reaches no submit", async () => {
  let calls = 0;
  const result = await publishProductIssue(REQUEST, {
    confirm: async () => ({
      outcome: "refused",
      message: "The trusted Report click was not observed",
      retrySafe: true,
    }),
    submit: async () => {
      calls++;
      throw new Error("submit should not run");
    },
  });
  assert.equal(result.result.outcome, "refused");
  assert.equal(result.retryAllowed, true);
  assert.equal(calls, 0);
});

test("an unknown result blocks retry while a refusal refreshes the preview", async () => {
  const unknown = await publishProductIssue(REQUEST, {
    confirm: async () => ({
      outcome: "unknown",
      message: "May already exist",
      retrySafe: false,
    }),
    submit: async () => {
      throw new Error("submit should not run");
    },
  });
  assert.equal(unknown.retryAllowed, false);
  assert.equal(unknown.refreshPreview, false);

  const refused = await publishProductIssue(REQUEST, {
    confirm: async () => ({ outcome: "refused", message: "Changed", retrySafe: true }),
    submit: async () => {
      throw new Error("submit should not run");
    },
  });
  assert.equal(refused.retryAllowed, true);
  assert.equal(refused.refreshPreview, true);
});
