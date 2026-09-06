import type {
  ProductIssueConfirmResponse,
  ProductIssueRequest,
  ProductIssueSubmitResult,
} from "@shared/product-issues.ts";
import { confirmProductIssue, submitProductIssue } from "./api.ts";

export interface ProductIssueSubmissionOutcome {
  result: ProductIssueSubmitResult;
  retryAllowed: boolean;
  refreshPreview: boolean;
}

export interface ProductIssueSubmissionDependencies {
  confirm(request: ProductIssueRequest): Promise<ProductIssueConfirmResponse>;
  submit(request: ProductIssueRequest, token: string): Promise<ProductIssueSubmitResult>;
}

function outcome(result: ProductIssueSubmitResult): ProductIssueSubmissionOutcome {
  return {
    result,
    retryAllowed: result.outcome === "created" || result.retrySafe,
    refreshPreview: result.outcome === "refused" || result.outcome === "configuration",
  };
}

const DEFAULT_DEPENDENCIES: ProductIssueSubmissionDependencies = {
  confirm: confirmProductIssue,
  submit: submitProductIssue,
};

/**
 * Authorize, confirm, and publish one exact rendered preview from one Report press.
 *
 * This is deliberately outside the React layer. The ordering is security-sensitive, and the
 * retry classification must stay coupled to the typed daemon result rather than be re-created
 * in event-handler branches.
 */
export async function publishProductIssue(
  request: ProductIssueRequest,
  dependencies: ProductIssueSubmissionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProductIssueSubmissionOutcome> {
  const confirmation = await dependencies.confirm(request);
  if (confirmation.outcome !== "confirmation") return outcome(confirmation);
  return outcome(await dependencies.submit(request, confirmation.token));
}
