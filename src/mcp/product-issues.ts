import type { ReviewItem } from "@shared/types.ts";
import {
  ProductIssuePreviewResponseSchema,
  ProductIssueSubmitResultSchema,
} from "@shared/protocol.ts";
import type {
  ProductIssueDraft,
  ProductIssuePreview,
  ProductIssueRequest,
  ProductIssueSubmitResult,
} from "@shared/product-issues.ts";

export const PRODUCT_ISSUE_REVIEW_DECISION_ID = "product-issue-publication";
export const PRODUCT_ISSUE_REVIEW_OPTION_ID = "submit-public-issue";

export interface ProductIssueMcpResult {
  text: string;
  isError: boolean;
}

export interface ProductIssueMcpDependencies {
  requestId: () => string;
  preview: (request: ProductIssueRequest) => Promise<{ status: number; body: unknown }>;
  submit: (request: ProductIssueRequest) => Promise<{ status: number; body: unknown }>;
  createReview: (input: {
    title: string;
    body: string;
    decisions: Array<{
      id: string;
      question: string;
      options: Array<{ id: string; label: string }>;
    }>;
  }) => Promise<string>;
  waitForResolution: (id: string) => Promise<ReviewItem>;
}

export function formatProductIssueReview(preview: ProductIssuePreview): string {
  return [
    "# Public GitHub issue preview",
    "",
    "This report will be public on GitHub. Review it for secrets and personal information before submitting.",
    "",
    `- Repository: ${preview.target}`,
    `- Labels: ${preview.labels.join(", ")}`,
    `- Title: ${preview.draft.title}`,
    `- Screenshots: ${preview.draft.attachmentUploadIds.length}`,
    "",
    preview.body,
  ].join("\n");
}

function selectedSubmit(review: ReviewItem): boolean {
  if (
    review.status !== "answered" ||
    review.resolvedBy !== "human" ||
    review.selections?.length !== 1
  ) return false;
  const answer = review.selections[0]!;
  return (
    answer.decisionId === PRODUCT_ISSUE_REVIEW_DECISION_ID &&
    answer.selected.length === 1 &&
    answer.selected[0] === PRODUCT_ISSUE_REVIEW_OPTION_ID &&
    !answer.other
  );
}

function submitResult(result: ProductIssueSubmitResult): ProductIssueMcpResult {
  switch (result.outcome) {
    case "created":
      return {
        text:
          `Product issue created: ${result.issueUrl}` +
          (result.warning ? `\nWarning: ${result.warning}` : ""),
        isError: false,
      };
    case "refused":
      return {
        text: `Product issue was not published. Retrying is safe after fixing the refusal: ${result.message}`,
        isError: true,
      };
    case "configuration":
      return {
        text: `Product issue was not published because reporting is not configured: ${result.message}`,
        isError: true,
      };
    case "unknown":
      return {
        text: `Product issue publication outcome is unknown. Do not retry until GitHub is checked: ${result.message}`,
        isError: true,
      };
  }
}

/**
 * Prepare the daemon-derived public preview, block on the existing dashboard review channel,
 * and publish only for the exact structured submit selection.
 */
export async function reportProductIssueWithConfirmation(
  draft: ProductIssueDraft,
  client: ProductIssueRequest["client"],
  deps: ProductIssueMcpDependencies,
): Promise<ProductIssueMcpResult> {
  const request: ProductIssueRequest = {
    ...draft,
    requestId: deps.requestId(),
    client,
  };
  const previewResponse = await deps.preview(request);
  const parsedPreview = ProductIssuePreviewResponseSchema.safeParse(previewResponse.body);
  if (!parsedPreview.success) {
    return {
      text: `Could not prepare the public product issue: Mission Control returned an invalid preview (${previewResponse.status})`,
      isError: true,
    };
  }
  if (parsedPreview.data.outcome !== "preview") {
    const detail = parsedPreview.data.message;
    return { text: `Could not prepare the public product issue: ${detail}`, isError: true };
  }
  const preview = parsedPreview.data;
  const reviewId = await deps.createReview({
    title: `Report product issue: ${preview.draft.title}`,
    body: formatProductIssueReview(preview),
    decisions: [{
      id: PRODUCT_ISSUE_REVIEW_DECISION_ID,
      question: `Publish this public issue to ${preview.target}?`,
      options: [{
        id: PRODUCT_ISSUE_REVIEW_OPTION_ID,
        label: "Submit public issue",
      }],
    }],
  });
  const review = await deps.waitForResolution(reviewId);
  if (review.status === "dismissed") {
    return {
      text: "outcome=cancelled reason=dismissed published=false",
      isError: false,
    };
  }
  if (review.status === "orphaned") {
    return {
      text: "outcome=cancelled reason=orphaned published=false",
      isError: true,
    };
  }
  if (!selectedSubmit(review)) {
    return {
      text: "outcome=cancelled reason=unconfirmed published=false",
      isError: true,
    };
  }

  const submission = await deps.submit(request);
  const parsedSubmission = ProductIssueSubmitResultSchema.safeParse(submission.body);
  if (!parsedSubmission.success) {
    return {
      text: `Mission Control returned an invalid product issue result (${submission.status})`,
      isError: true,
    };
  }
  return submitResult(parsedSubmission.data);
}
