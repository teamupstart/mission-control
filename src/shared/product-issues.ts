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

/** First stable GitHub CLI release with first-party `gh issue create --attach`. */
export const PRODUCT_ISSUE_MINIMUM_GH_VERSION = "2.99.0";

/** Trusted launch context passed from the daemon to its bundled MCP child. */
export const PRODUCT_ISSUE_CLIENT_ENV = "MISSION_PRODUCT_ISSUE_CLIENT";

/** Unknown or absent launch context is the standalone browser/daemon mode. */
export function productIssueClientFromEnvironment(
  value: string | undefined,
): ProductIssueClient {
  return value === "electron" ? "electron" : "browser";
}

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
  // Legacy append-only value retained for compatibility with older daemon responses.
  "consent-unavailable",
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
      /** Present when gh created the issue but returned non-zero after a partial upload. */
      warning?: string;
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

/**
 * A grant to publish one exact report, once, soon.
 *
 * This is deliberately NOT part of the preview reply. A preview is a read: it renders what
 * would become public so a person can read it, and it is re-issued on every keystroke that
 * settles. Handing publishing authority out with a read means the authority is a side effect
 * of looking, which is precisely what a reader is not agreeing to.
 *
 * So the grant is minted only by its own internal step when the user presses Report, then spent
 * immediately by that same UI action. It is bounded three ways: to one `requestId`, to one
 * `draftIdentity` (so it dies the instant the daemon's own derivation moves), and to `expiresAt`.
 * It is retired on first terminal use.
 *
 * This is the shape `WorktreeActionPreview` already uses for the other irreversible action in
 * this app, and the bound is the same one: it establishes that the caller took the confirming
 * step for this exact content, not that the caller is a person. On a loopback API with no
 * authentication, no server-side value can establish the second - see docs/security.md.
 */
export interface ProductIssueConfirmation {
  outcome: "confirmation";
  requestId: string;
  /** The derivation this grant is pinned to; a submission whose identity differs is refused. */
  draftIdentity: string;
  /** Repeated from the preview so the confirming step names the destination it publishes to. */
  target: string;
  /** Unguessable, single-use, held only by the daemon and the reply it went out in. */
  token: string;
  /** Epoch milliseconds after which the grant is refused and the person must confirm again. */
  expiresAt: number;
}

export type ProductIssueConfirmResponse =
  | ProductIssueConfirmation
  | Extract<ProductIssueSubmitResult, { outcome: "refused" | "configuration" | "unknown" }>;

/** How long a confirmation grant stays usable. Matches the worktree action grant. */
export const PRODUCT_ISSUE_CONFIRMATION_TTL_MS = 2 * 60_000;
