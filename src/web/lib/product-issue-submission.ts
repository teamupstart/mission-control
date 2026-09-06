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
  authorize(input: { requestId: string; draftIdentity: string }): Promise<boolean>;
  confirm(request: ProductIssueRequest): Promise<ProductIssueConfirmResponse>;
  submit(request: ProductIssueRequest, token: string): Promise<ProductIssueSubmitResult>;
}

function refused(message: string): ProductIssueSubmitResult {
  return { outcome: "refused", message, retrySafe: true };
}

function outcome(result: ProductIssueSubmitResult): ProductIssueSubmissionOutcome {
  return {
    result,
    retryAllowed: result.outcome === "created" || result.retrySafe,
    refreshPreview: result.outcome === "refused" || result.outcome === "configuration",
  };
}

function desktopAuthorize(
  input: { requestId: string; draftIdentity: string },
): Promise<boolean> {
  const authorize = window.missionDesktop?.authorizeProductIssue;
  if (!authorize) return Promise.resolve(false);
  return authorize(input);
}

const DEFAULT_DEPENDENCIES: ProductIssueSubmissionDependencies = {
  authorize: desktopAuthorize,
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
  draftIdentity: string,
  dependencies: ProductIssueSubmissionDependencies = DEFAULT_DEPENDENCIES,
): Promise<ProductIssueSubmissionOutcome> {
  let authorized = false;
  try {
    authorized = await dependencies.authorize({
      requestId: request.requestId,
      draftIdentity,
    });
  } catch {
    authorized = false;
  }
  if (!authorized) {
    return outcome(refused(
      "Publishing was not authorized by the Report click; nothing was published",
    ));
  }

  const confirmation = await dependencies.confirm(request);
  if (confirmation.outcome !== "confirmation") return outcome(confirmation);
  return outcome(await dependencies.submit(request, confirmation.token));
}
