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
const IDENTITY = "a".repeat(64);

test("one submission call authorizes, confirms, and publishes in order", async () => {
  const calls: string[] = [];
  const result = await publishProductIssue(REQUEST, IDENTITY, {
    authorize: async (input) => {
      calls.push(`authorize:${input.requestId}:${input.draftIdentity}`);
      return true;
    },
    confirm: async () => {
      calls.push("confirm");
      return {
        outcome: "confirmation",
        requestId: REQUEST.requestId,
        draftIdentity: IDENTITY,
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
    `authorize:${REQUEST.requestId}:${IDENTITY}`,
    "confirm",
    `submit:${"b".repeat(64)}`,
  ]);
  assert.equal(result.result.outcome, "created");
  assert.equal(result.retryAllowed, true);
  assert.equal(result.refreshPreview, false);
});

test("refused authorization reaches neither HTTP step", async () => {
  let calls = 0;
  const result = await publishProductIssue(REQUEST, IDENTITY, {
    authorize: async () => false,
    confirm: async () => {
      calls++;
      throw new Error("confirm should not run");
    },
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
  const unknown = await publishProductIssue(REQUEST, IDENTITY, {
    authorize: async () => true,
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

  const refused = await publishProductIssue(REQUEST, IDENTITY, {
    authorize: async () => true,
    confirm: async () => ({ outcome: "refused", message: "Changed", retrySafe: true }),
    submit: async () => {
      throw new Error("submit should not run");
    },
  });
  assert.equal(refused.retryAllowed, true);
  assert.equal(refused.refreshPreview, true);
});
