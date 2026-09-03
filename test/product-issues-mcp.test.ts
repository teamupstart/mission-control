import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_ISSUE_REVIEW_DECISION_ID,
  PRODUCT_ISSUE_REVIEW_OPTION_ID,
  reportProductIssueWithConfirmation,
  type ProductIssueMcpDependencies,
} from "../src/mcp/product-issues.ts";
import type { ProductIssueDraft } from "../src/shared/product-issues.ts";
import type { ReviewItem } from "../src/shared/types.ts";

const REQUEST_ID = "3a0a8d96-56c7-4c39-9768-c35633d96889";
const DRAFT: ProductIssueDraft = {
  type: "bug" as const,
  title: "The task board loses focus",
  details: "Selecting the next card should preserve keyboard focus.",
  attachmentUploadIds: [],
};

function preview(draft = DRAFT) {
  return {
    outcome: "preview" as const,
    requestId: REQUEST_ID,
    draftIdentity: "a".repeat(64),
    draft,
    target: "mancej/mission-controller-control-issues",
    labels: ["bug", "status:needs-triage", "source:agent"],
    environment: {
      missionControlVersion: "0.1.0",
      platform: "macOS" as const,
      architecture: "arm64" as const,
      client: "browser" as const,
    },
    body: [
      "## Details",
      "",
      draft.details,
      "",
      "## Environment",
      "",
      "- Mission Control: 0.1.0",
      "- Platform: macOS / arm64",
      "- Client: browser",
      "",
      "<!-- mission-control-product-report:v1 -->",
    ].join("\n"),
    attachments: {
      enabled: false,
      reason: "Screenshot upload is waiting for first-party GitHub CLI support",
    },
  };
}

function review(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id: "review-1",
    sessionId: "session-1",
    kind: "input",
    title: "Report product issue",
    body: "Public preview",
    status: "answered",
    response: "Submit public issue",
    decisions: null,
    selections: [{
      decisionId: PRODUCT_ISSUE_REVIEW_DECISION_ID,
      selected: [PRODUCT_ISSUE_REVIEW_OPTION_ID],
      other: null,
    }],
    resolvedBy: "human",
    createdAt: 1,
    resolvedAt: 2,
    ...overrides,
  };
}

function dependencies(
  resolution: ReviewItem,
  observed: {
    reviews: Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>;
    submissions: unknown[];
  },
  expectedDraft = DRAFT,
): ProductIssueMcpDependencies {
  return {
    requestId: () => REQUEST_ID,
    preview: async (request) => {
      assert.deepEqual(request, { ...expectedDraft, requestId: REQUEST_ID, client: "browser" });
      return { status: 200, body: preview(expectedDraft) };
    },
    submit: async (request) => {
      observed.submissions.push(request);
      return {
        status: 201,
        body: {
          outcome: "created",
          issueUrl: "https://github.com/mancej/mission-controller-control-issues/issues/12",
          target: "mancej/mission-controller-control-issues",
        },
      };
    },
    createReview: async (input) => {
      observed.reviews.push(input);
      return "review-1";
    },
    waitForResolution: async (id) => {
      assert.equal(id, "review-1");
      return resolution;
    },
  };
}

test("the exact human submit selection publishes the original bounded draft", async () => {
  const observed = { reviews: [] as Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>, submissions: [] as unknown[] };
  const result = await reportProductIssueWithConfirmation(
    DRAFT,
    "browser",
    dependencies(review({}), observed),
  );

  assert.deepEqual(result, {
    text: "Product issue created: https://github.com/mancej/mission-controller-control-issues/issues/12",
    isError: false,
  });
  assert.equal(observed.submissions.length, 1);
  assert.deepEqual(observed.submissions[0], {
    ...DRAFT,
    requestId: REQUEST_ID,
    client: "browser",
  });
  assert.equal(observed.reviews.length, 1);
  assert.match(observed.reviews[0]!.body, /This report will be public on GitHub/);
  assert.match(observed.reviews[0]!.body, /source:agent/);
  assert.match(observed.reviews[0]!.body, /Screenshots: 0/);
  assert.deepEqual(observed.reviews[0]!.decisions, [{
    id: PRODUCT_ISSUE_REVIEW_DECISION_ID,
    question: "Publish this public issue to mancej/mission-controller-control-issues?",
    options: [{ id: PRODUCT_ISSUE_REVIEW_OPTION_ID, label: "Submit public issue" }],
  }]);
});

test("MCP attachment ids survive review and a created warning remains non-error", async () => {
  const withScreenshot = { ...DRAFT, attachmentUploadIds: ["upload-1.png"] };
  const observed = {
    reviews: [] as Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>,
    submissions: [] as unknown[],
  };
  const deps = dependencies(review({}), observed, withScreenshot);
  deps.submit = async (request) => {
    observed.submissions.push(request);
    return {
      status: 201,
      body: {
        outcome: "created",
        issueUrl: "https://github.com/mancej/mission-controller-control-issues/issues/13",
        target: "mancej/mission-controller-control-issues",
        warning: "The issue was created, but one screenshot was not attached",
      },
    };
  };

  const result = await reportProductIssueWithConfirmation(
    withScreenshot,
    "browser",
    deps,
  );

  assert.equal(result.isError, false);
  assert.match(result.text, /issues\/13/);
  assert.match(result.text, /Warning:.*one screenshot was not attached/);
  assert.match(observed.reviews[0]!.body, /Screenshots: 1/);
  assert.deepEqual(observed.submissions[0], {
    ...withScreenshot,
    requestId: REQUEST_ID,
    client: "browser",
  });
});

test("dismiss and orphan settle without calling the mutation route", async (t) => {
  for (const [status, isError] of [
    ["dismissed", false],
    ["orphaned", true],
  ] as const) {
    await t.test(status, async () => {
      const observed = { reviews: [] as Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>, submissions: [] as unknown[] };
      const result = await reportProductIssueWithConfirmation(
        DRAFT,
        "browser",
        dependencies(review({
          status,
          response: null,
          selections: null,
          resolvedBy: status === "dismissed" ? "human" : null,
        }), observed),
      );
      assert.equal(result.isError, isError);
      assert.match(result.text, new RegExp(`reason=${status}`));
      assert.equal(observed.submissions.length, 0);
    });
  }
});

test("free-form, malformed, and non-human answers cannot publish", async (t) => {
  const cases: Array<[string, Partial<ReviewItem>]> = [
    ["free-form", { selections: null }],
    ["wrong option", {
      selections: [{
        decisionId: PRODUCT_ISSUE_REVIEW_DECISION_ID,
        selected: ["not-submit"],
        other: null,
      }],
    }],
    ["foreman", { resolvedBy: "foreman" }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const observed = { reviews: [] as Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>, submissions: [] as unknown[] };
      const result = await reportProductIssueWithConfirmation(
        DRAFT,
        "browser",
        dependencies(review(override), observed),
      );
      assert.deepEqual(result, {
        text: "outcome=cancelled reason=unconfirmed published=false",
        isError: true,
      });
      assert.equal(observed.submissions.length, 0);
    });
  }
});

test("preview and submit failures preserve retry-safety guidance", async () => {
  let createdReview = false;
  const previewFailure = await reportProductIssueWithConfirmation(DRAFT, "browser", {
    requestId: () => REQUEST_ID,
    preview: async () => ({
      status: 503,
      body: {
        outcome: "configuration",
        message: "GitHub CLI is not authenticated",
        retrySafe: true,
      },
    }),
    submit: async () => {
      throw new Error("must not submit");
    },
    createReview: async () => {
      createdReview = true;
      return "never";
    },
    waitForResolution: async () => review({}),
  });
  assert.equal(createdReview, false);
  assert.match(previewFailure.text, /not authenticated/);

  const unknownObserved = { reviews: [] as Array<Parameters<ProductIssueMcpDependencies["createReview"]>[0]>, submissions: [] as unknown[] };
  const deps = dependencies(review({}), unknownObserved);
  deps.submit = async () => ({
    status: 504,
    body: {
      outcome: "unknown",
      message: "the issue may exist",
      retrySafe: false,
    },
  });
  const unknown = await reportProductIssueWithConfirmation(DRAFT, "browser", deps);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Do not retry/);
});
