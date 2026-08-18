/**
 * Browser-safe contracts for public product issue reporting.
 *
 * Report type values and the body marker are append-only once shipped. The daemon owns
 * every value that can steer GitHub beyond the reporter-authored title and details: target,
 * labels, source, and generated environment are never draft fields.
 */

export const PRODUCT_ISSUE_TYPES = [
  "bug",
  "feature-request",
  "documentation",
  "usability",
  "other",
] as const;
export type ProductIssueType = (typeof PRODUCT_ISSUE_TYPES)[number];

export const PRODUCT_ISSUE_TYPE_LABELS = {
  bug: "bug",
  "feature-request": "feature-request",
  documentation: "documentation",
  usability: "usability",
  other: "other",
} as const satisfies Record<ProductIssueType, string>;

export const PRODUCT_ISSUE_STATUS_LABEL = "status:needs-triage";

export const PRODUCT_ISSUE_SOURCES = ["dashboard", "agent"] as const;
export type ProductIssueSource = (typeof PRODUCT_ISSUE_SOURCES)[number];

export const PRODUCT_ISSUE_SOURCE_LABELS = {
  dashboard: "source:dashboard",
  agent: "source:agent",
} as const satisfies Record<ProductIssueSource, string>;

/** The complete label set a target repository must provide before reports are enabled. */
export const PRODUCT_ISSUE_REQUIRED_LABELS = [
  ...PRODUCT_ISSUE_TYPES.map((type) => PRODUCT_ISSUE_TYPE_LABELS[type]),
  PRODUCT_ISSUE_STATUS_LABEL,
  PRODUCT_ISSUE_SOURCE_LABELS.dashboard,
  PRODUCT_ISSUE_SOURCE_LABELS.agent,
] as const;

export const PRODUCT_ISSUE_CLIENTS = ["browser", "electron"] as const;
export type ProductIssueClient = (typeof PRODUCT_ISSUE_CLIENTS)[number];

/** Every public-payload and future-attachment bound, shared with the Phase 2 consumer. */
export const PRODUCT_ISSUE_LIMITS = {
  titleBytes: 200,
  detailsBytes: 16 * 1024,
  reportBodyBytes: 20 * 1024,
  attachmentUploadIdChars: 200,
  attachmentCount: 5,
  attachmentBytes: 10 * 1024 * 1024,
  attachmentAggregateBytes: 25 * 1024 * 1024,
  requestJsonBytes: 16 * 1024 * 6 + 8 * 1024,
} as const;

export const PRODUCT_ISSUE_BODY_MARKER = "<!-- mission-control-product-report:v1 -->";

export interface ProductIssueDraft {
  type: ProductIssueType;
  title: string;
  details: string;
  attachmentUploadIds: string[];
}

/**
 * One preview/submission opening. The client id is only a duplicate guard; it grants no
 * authority, and the daemon binds it to the re-derived draft, source, target, and client.
 */
export interface ProductIssueRequest extends ProductIssueDraft {
  requestId: string;
  client: ProductIssueClient;
}

export interface ProductIssueEnvironment {
  missionControlVersion: string;
  platform: "macOS" | "Linux" | "Windows" | "Other";
  architecture: "arm64" | "x64" | "arm" | "ia32" | "other";
  client: ProductIssueClient;
}

export interface ProductIssueAttachmentState {
  enabled: boolean;
  reason: string | null;
}

export interface ProductIssuePreview {
  outcome: "preview";
  requestId: string;
  draftIdentity: string;
  draft: ProductIssueDraft;
  target: string;
  labels: string[];
  environment: ProductIssueEnvironment;
  body: string;
  attachments: ProductIssueAttachmentState;
}

export const PRODUCT_ISSUE_PREFLIGHT_PROBLEMS = [
  "demo-mode",
  "invalid-target",
  "gh-unavailable",
  "gh-auth",
  "repository",
  "labels",
] as const;
export type ProductIssuePreflightProblemCode =
  (typeof PRODUCT_ISSUE_PREFLIGHT_PROBLEMS)[number];

export interface ProductIssuePreflightProblem {
  code: ProductIssuePreflightProblemCode;
  message: string;
}

export interface ProductIssuePreflight {
  ready: boolean;
  target: string | null;
  attachments: ProductIssueAttachmentState;
  problems: ProductIssuePreflightProblem[];
}

export type ProductIssueSubmitResult =
  | {
      outcome: "created";
      issueUrl: string;
      target: string;
    }
  | {
      outcome: "refused";
      message: string;
      retrySafe: true;
    }
  | {
      outcome: "configuration";
      message: string;
      retrySafe: true;
    }
  | {
      outcome: "unknown";
      message: string;
      retrySafe: false;
    };

export type ProductIssuePreviewResponse =
  | ProductIssuePreview
  | Extract<ProductIssueSubmitResult, { outcome: "refused" | "configuration" }>;
