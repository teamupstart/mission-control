import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { isAbsolute, relative } from "node:path";
import {
  ProductIssueRequestSchema,
} from "@shared/protocol.ts";
import {
  PRODUCT_ISSUE_BODY_MARKER,
  PRODUCT_ISSUE_CONFIRMATION_TTL_MS,
  PRODUCT_ISSUE_LIMITS,
  PRODUCT_ISSUE_MINIMUM_GH_VERSION,
  PRODUCT_ISSUE_REQUIRED_LABELS,
  PRODUCT_ISSUE_SOURCE_LABELS,
  PRODUCT_ISSUE_STATUS_LABEL,
  PRODUCT_ISSUE_TYPE_LABELS,
  type ProductIssueAttachmentState,
  type ProductIssueConfirmResponse,
  type ProductIssueDraft,
  type ProductIssueEnvironment,
  type ProductIssuePreflight,
  type ProductIssuePreviewResponse,
  type ProductIssueRequest,
  type ProductIssueSource,
  type ProductIssueSubmitResult,
} from "@shared/product-issues.ts";
import {
  ghBin,
  productIssuesRepo,
  type ProductIssuesRepoConfig,
} from "./config.ts";
import {
  resolveConsentPort,
  type ProductIssueConsentPort,
} from "./product-issue-consent.ts";
import { githubIssueCreateOutcome } from "./github/issue-create.ts";
import {
  detectImageExt,
  resolveImageUpload,
  UPLOADS_DIR,
  type SavedUpload,
} from "./uploads.ts";
import { run, type RunResult } from "./util/exec.ts";

const ISSUE_CREATE_TIMEOUT_MS = 20_000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_REQUESTS = 512;
const ATTACHMENTS_DISABLED_REASON =
  "Screenshot upload is waiting for first-party GitHub CLI support";
const ATTACHMENTS_VERSION_REASON =
  `Screenshot upload requires GitHub CLI ${PRODUCT_ISSUE_MINIMUM_GH_VERSION} or newer`;

export type ProductIssueRunner = (
  bin: string,
  args: string[],
  options?: Parameters<typeof run>[2],
) => Promise<RunResult>;

export type ProductIssueAttachmentCapability =
  | { enabled: false }
  | {
      enabled: true;
      uploadRoot: string;
      resolveUpload: (uploadId: string, now: number) => SavedUpload | null;
    };

/** Production passes this exact capability. There is intentionally no environment override. */
export const PRODUCT_ISSUE_ATTACHMENTS_DISABLED: ProductIssueAttachmentCapability = {
  enabled: false,
};

/** Shipped production capability. Locators still resolve through the daemon-owned upload store. */
export const PRODUCT_ISSUE_ATTACHMENTS_ENABLED: ProductIssueAttachmentCapability = {
  enabled: true,
  uploadRoot: UPLOADS_DIR,
  resolveUpload: resolveImageUpload,
};

/** Parse only stable `gh version X.Y.Z` output and compare numeric components. */
export function supportsProductIssueAttachments(versionOutput: string): boolean {
  const match = /^gh version (\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(versionOutput);
  if (!match) return false;
  const installed = match.slice(1, 4).map(Number);
  const minimum = PRODUCT_ISSUE_MINIMUM_GH_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (installed[index]! > minimum[index]!) return true;
    if (installed[index]! < minimum[index]!) return false;
  }
  return true;
}

export interface ProductIssueServiceOptions {
  runner?: ProductIssueRunner;
  attachments?: ProductIssueAttachmentCapability;
  now?: () => number;
  target?: () => ProductIssuesRepoConfig;
  version?: string;
  platform?: string;
  architecture?: string;
  demoMode?: boolean;
  /**
   * Who is asked before a publish is authorized.
   *
   * Injectable so tests can drive a refusal, a grant and an unavailable shell without an
   * Electron shell in the room - never so production can choose a weaker one. The default is
   * whatever this daemon actually has, which for a daemon nobody can ask is a port that always
   * answers no.
   */
  consent?: ProductIssueConsentPort;
}

interface PreviewClaim {
  identity: string;
  expiresAt: number;
}

/**
 * A minted, unused grant to publish one opening's currently derived content.
 *
 * Kept apart from `PreviewClaim` on purpose. A preview is re-issued on every settled
 * keystroke and must stay a pure read; a grant is minted only by the confirming step, is
 * pinned to the derivation it was taken against, and dies of age. Merging the two puts a
 * publishing capability back on the read, which is the thing being fixed here.
 */
interface ConfirmationGrant {
  identity: string;
  token: string;
  expiresAt: number;
}

/** Compare two hex tokens without leaking their divergence point through timing. */
function tokenMatches(provided: string, expected: string | null): boolean {
  if (!expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

interface SubmitClaim {
  state: "in-flight" | "terminal";
  expiresAt: number;
}

function refused(
  message: string,
): Extract<ProductIssueSubmitResult, { outcome: "refused" }> {
  return { outcome: "refused", message, retrySafe: true };
}

function configuration(
  message: string,
): Extract<ProductIssueSubmitResult, { outcome: "configuration" }> {
  return { outcome: "configuration", message, retrySafe: true };
}

function unknown(
  message: string,
): Extract<ProductIssueSubmitResult, { outcome: "unknown" }> {
  return { outcome: "unknown", message, retrySafe: false };
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === "string" && version ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function platformFamily(value: string): ProductIssueEnvironment["platform"] {
  if (value === "darwin") return "macOS";
  if (value === "linux") return "Linux";
  if (value === "win32") return "Windows";
  return "Other";
}

function architectureFamily(value: string): ProductIssueEnvironment["architecture"] {
  if (value === "arm64" || value === "x64" || value === "arm" || value === "ia32") {
    return value;
  }
  return "other";
}

export function productIssueLabels(
  type: ProductIssueDraft["type"],
  source: ProductIssueSource,
): string[] {
  return [
    PRODUCT_ISSUE_TYPE_LABELS[type],
    PRODUCT_ISSUE_STATUS_LABEL,
    PRODUCT_ISSUE_SOURCE_LABELS[source],
  ];
}

export function renderProductIssueBody(
  draft: Pick<ProductIssueDraft, "details">,
  environment: ProductIssueEnvironment,
): string {
  return [
    "## Details",
    "",
    draft.details,
    "",
    "## Environment",
    "",
    `- Mission Control: ${environment.missionControlVersion}`,
    `- Platform: ${environment.platform} / ${environment.architecture}`,
    `- Client: ${environment.client}`,
    "",
    PRODUCT_ISSUE_BODY_MARKER,
  ].join("\n");
}

/** Fixed argv only. Reporter details travel on stdin through `--body-file -`. */
export function productIssueCreateArgs(
  target: string,
  draft: Pick<ProductIssueDraft, "title">,
  labels: readonly string[],
  attachmentArgs: readonly string[] = [],
): string[] {
  return [
    "issue",
    "create",
    "--repo",
    target,
    "--title",
    draft.title,
    "--body-file",
    "-",
    ...labels.flatMap((label) => ["--label", label]),
    ...attachmentArgs,
  ];
}

/**
 * The first-party GitHub CLI attachment adapter.
 * Every locator is resolved again, contained by realpath, size-checked, and byte-sniffed
 * immediately before its absolute path becomes one repeated `--attach` pair.
 */
export function productIssueAttachmentArgs(
  capability: Extract<ProductIssueAttachmentCapability, { enabled: true }>,
  uploadIds: readonly string[],
  now: number,
): { ok: true; args: string[] } | { ok: false; error: string } {
  let root: string;
  try {
    root = realpathSync(capability.uploadRoot);
  } catch {
    return { ok: false, error: "Product issue upload storage is unavailable" };
  }

  let aggregateBytes = 0;
  const paths: string[] = [];
  for (const uploadId of uploadIds) {
    const upload = capability.resolveUpload(uploadId, now);
    if (!upload) {
      return { ok: false, error: "A screenshot upload is missing, stale, or invalid" };
    }

    let resolved: string;
    try {
      if (lstatSync(upload.path).isSymbolicLink()) {
        return { ok: false, error: "A screenshot upload cannot be a symbolic link" };
      }
      resolved = realpathSync(upload.path);
    } catch {
      return { ok: false, error: "A screenshot upload can no longer be read" };
    }
    const inside = relative(root, resolved);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      return { ok: false, error: "A screenshot upload is outside Mission Control storage" };
    }

    let fd: number | null = null;
    try {
      fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        return { ok: false, error: "A screenshot upload is not a regular file" };
      }
      if (stat.size > PRODUCT_ISSUE_LIMITS.attachmentBytes) {
        return {
          ok: false,
          error: `Each screenshot must be at most ${PRODUCT_ISSUE_LIMITS.attachmentBytes} bytes`,
        };
      }
      aggregateBytes += stat.size;
      if (aggregateBytes > PRODUCT_ISSUE_LIMITS.attachmentAggregateBytes) {
        return {
          ok: false,
          error:
            `Screenshots must total at most ` +
            `${PRODUCT_ISSUE_LIMITS.attachmentAggregateBytes} bytes`,
        };
      }
      const head = Buffer.alloc(32);
      const bytesRead = readSync(fd, head, 0, head.byteLength, 0);
      if (!detectImageExt(head.subarray(0, bytesRead))) {
        return { ok: false, error: "A screenshot upload is not a PNG, JPEG, GIF, or WebP image" };
      }
    } catch {
      return { ok: false, error: "A screenshot upload could not be validated" };
    } finally {
      if (fd !== null) closeSync(fd);
    }
    paths.push(resolved);
  }
  return { ok: true, args: paths.flatMap((path) => ["--attach", path]) };
}

export class ProductIssueService {
  private readonly runner: ProductIssueRunner;
  private readonly attachments: ProductIssueAttachmentCapability;
  private readonly now: () => number;
  private readonly target: () => ProductIssuesRepoConfig;
  private readonly version: string;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly demoMode: boolean;
  /** Who gets asked before anything is published. See ./product-issue-consent.ts. */
  private readonly consent: ProductIssueConsentPort;
  private readonly previews = new Map<string, PreviewClaim>();
  private readonly grants = new Map<string, ConfirmationGrant>();
  private readonly claims = new Map<string, SubmitClaim>();

  constructor(options: ProductIssueServiceOptions = {}) {
    this.runner = options.runner ?? run;
    this.attachments = options.attachments ?? PRODUCT_ISSUE_ATTACHMENTS_DISABLED;
    this.now = options.now ?? Date.now;
    this.target = options.target ?? productIssuesRepo;
    this.version = options.version ?? readVersion();
    this.platform = options.platform ?? hostPlatform();
    this.architecture = options.architecture ?? hostArch();
    this.demoMode = options.demoMode ?? Boolean(process.env.MISSION_DEMO_SCENARIO_DIR);
    // Resolved per service rather than per call, so a daemon that cannot ask anybody says so
    // in preflight instead of discovering it at the moment somebody presses publish.
    this.consent = options.consent ?? resolveConsentPort();
  }

  attachmentState(): ProductIssueAttachmentState {
    return this.attachments.enabled
      ? { enabled: true, reason: null }
      : { enabled: false, reason: ATTACHMENTS_DISABLED_REASON };
  }

  async preflight(): Promise<ProductIssuePreflight> {
    const target = this.target();
    let attachments = this.attachmentState();
    if (!target.ok) {
      return {
        ready: false,
        target: null,
        attachments,
        problems: [{ code: "invalid-target", message: target.error }],
      };
    }
    if (this.demoMode) {
      return {
        ready: false,
        target: target.repo,
        attachments,
        problems: [{
          code: "demo-mode",
          message: "Product issue reporting is disabled in demo mode",
        }],
      };
    }
    if (this.consent.unavailable) {
      // Reported here rather than at the press, because "you cannot publish from this daemon"
      // is a property of the daemon and a person deserves it before typing a bug report, not
      // after. The form still previews; reading the public content is useful on its own.
      return {
        ready: false,
        target: target.repo,
        attachments,
        problems: [{ code: "consent-unavailable", message: this.consent.unavailable }],
      };
    }

    const version = await this.runner(ghBin(), ["--version"], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    if (version.outcomeUnknown || version.code !== 0) {
      return this.preflightFailure(
        target.repo,
        "gh-unavailable",
        version.outcomeUnknown
          ? "The GitHub CLI availability check did not report back; try again"
          : "GitHub CLI is unavailable; install gh and run `gh auth login`",
        attachments,
      );
    }
    if (this.attachments.enabled && !supportsProductIssueAttachments(version.stdout)) {
      attachments = { enabled: false, reason: ATTACHMENTS_VERSION_REASON };
    }

    const auth = await this.runner(ghBin(), ["auth", "status"], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
    });
    if (auth.outcomeUnknown || auth.code !== 0) {
      return this.preflightFailure(
        target.repo,
        "gh-auth",
        auth.outcomeUnknown
          ? "GitHub authentication could not be checked; try again"
          : "GitHub CLI is not authenticated; run `gh auth login`",
        attachments,
      );
    }

    const repository = await this.runner(
      ghBin(),
      ["repo", "view", target.repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    if (repository.outcomeUnknown || repository.code !== 0) {
      return this.preflightFailure(
        target.repo,
        "repository",
        repository.outcomeUnknown
          ? `The target repository ${target.repo} could not be checked; try again`
          : `GitHub CLI cannot reach ${target.repo}; verify that the repository exists and is accessible`,
        attachments,
      );
    }

    const labels = await this.runner(
      ghBin(),
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${target.repo}/labels?per_page=100`,
      ],
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    if (labels.outcomeUnknown || labels.code !== 0) {
      return this.preflightFailure(
        target.repo,
        "labels",
        labels.outcomeUnknown
          ? `Labels in ${target.repo} could not be checked; try again`
          : `GitHub CLI could not list labels in ${target.repo}`,
        attachments,
      );
    }
    let names: Set<string>;
    try {
      const parsed = JSON.parse(labels.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("unexpected label list");
      names = new Set(
        parsed.flatMap((page) => {
          if (!Array.isArray(page)) throw new Error("unexpected label page");
          return page.flatMap((entry) => {
            const name = (entry as { name?: unknown })?.name;
            return typeof name === "string" ? [name] : [];
          });
        }),
      );
    } catch {
      return this.preflightFailure(
        target.repo,
        "labels",
        `GitHub CLI returned an unreadable label list for ${target.repo}`,
        attachments,
      );
    }
    const missing = PRODUCT_ISSUE_REQUIRED_LABELS.filter((label) => !names.has(label));
    if (missing.length > 0) {
      return this.preflightFailure(
        target.repo,
        "labels",
        `Create the missing labels in ${target.repo}: ${missing.join(", ")}`,
        attachments,
      );
    }
    return { ready: true, target: target.repo, attachments, problems: [] };
  }

  preview(source: ProductIssueSource, input: unknown): ProductIssuePreviewResponse {
    const parsed = ProductIssueRequestSchema.safeParse(input);
    if (!parsed.success) return refused(`Invalid product issue draft: ${parsed.error.message}`);
    const request = parsed.data;
    if (this.demoMode) {
      return configuration("Product issue reporting is disabled in demo mode; nothing was published");
    }
    if (!this.attachments.enabled && request.attachmentUploadIds.length > 0) {
      return refused(`${ATTACHMENTS_DISABLED_REASON}; remove screenshots and preview again`);
    }
    const target = this.target();
    if (!target.ok) return configuration(target.error);

    const now = this.now();
    this.purgeExpired(now);
    if (!this.previews.has(request.requestId) && this.previews.size >= MAX_OPEN_REQUESTS) {
      return refused("Too many product issue previews are open; close one and try again");
    }
    const environment = this.environment(request);
    const draft = this.draft(request);
    const body = renderProductIssueBody(draft, environment);
    if (new TextEncoder().encode(body).byteLength > PRODUCT_ISSUE_LIMITS.reportBodyBytes) {
      return refused("The rendered public issue body is too large");
    }
    const identity = this.identity(source, request, target.repo);
    const claimed = this.claims.get(request.requestId);
    const existing = this.previews.get(request.requestId);
    if (claimed && existing?.identity !== identity) {
      return refused("This report opening has already submitted a different draft");
    }
    this.previews.set(request.requestId, { identity, expiresAt: now + REQUEST_TTL_MS });
    /**
     * A preview whose content moved drops any grant taken against the old content.
     *
     * Without this, a person could confirm, keep typing, and have the older grant still be
     * live when they pressed publish. `submit` would refuse it on the identity comparison
     * anyway, so this is not the boundary - it is the state matching what the screen says,
     * which is what puts the confirming press back in front of the person.
     */
    const grant = this.grants.get(request.requestId);
    if (grant && grant.identity !== identity) this.grants.delete(request.requestId);
    return {
      outcome: "preview",
      requestId: request.requestId,
      draftIdentity: identity,
      draft,
      target: target.repo,
      labels: productIssueLabels(request.type, source),
      environment,
      body,
      attachments: this.attachmentState(),
    };
  }


  /**
   * Take the confirming step for one report, and mint the grant that publishes it.
   *
   * This exists as a step of its own rather than as a field on the preview reply, and that is
   * the whole point of it. Previewing is a read that happens on every settled keystroke;
   * something that arrives by reading is not a decision. Publishing to a public tracker is
   * irreversible, so it is gated on a caller that came back a second time, naming the same
   * opening and the same derived content, within two minutes.
   *
   * The grant is minted only after `this.consent` reports that a person answered yes. That
   * call leaves the HTTP surface entirely - in the shipped app it is a native dialog raised by
   * the desktop shell over the utility-process port - which is what makes this an attestation
   * rather than a value a caller could present. Everything a caller CAN present was tried in
   * three earlier revisions and refused, correctly: `/api/*` is unauthenticated, so whatever
   * the dashboard sends a local process sends too.
   *
   * What it still does not establish: that the person answering is the person who typed the
   * report. One human at the machine is the unit here, as it is for every other confirmation
   * in this app.
   *
   * Dashboard only. The agent path's authorization is its submitted `input` review over a
   * token-guarded transport, and a grant an agent could mint for itself would be a second way
   * in beside the confirmation Phase 1 built.
   */
  async confirm(
    source: ProductIssueSource,
    input: unknown,
  ): Promise<ProductIssueConfirmResponse> {
    if (source !== "dashboard") {
      return refused("Only the dashboard confirms product issues; the agent path uses a review");
    }
    const parsed = ProductIssueRequestSchema.safeParse(input);
    if (!parsed.success) return refused(`Invalid product issue draft: ${parsed.error.message}`);
    const request = parsed.data;
    if (this.demoMode) {
      return configuration("Product issue reporting is disabled in demo mode; nothing was published");
    }
    if (!this.attachments.enabled && request.attachmentUploadIds.length > 0) {
      return refused(`${ATTACHMENTS_DISABLED_REASON}; remove screenshots and preview again`);
    }
    const target = this.target();
    if (!target.ok) return configuration(target.error);

    const now = this.now();
    this.purgeExpired(now);
    const identity = this.identity(source, request, target.repo);
    const preview = this.previews.get(request.requestId);
    // Confirming something that was never rendered is refused, so the grant can only ever
    // describe content this daemon has actually served to somebody to read.
    if (!preview) return refused("Preview this product issue before confirming it");
    if (preview.identity !== identity) {
      return refused("The product issue changed after preview; preview the current draft again");
    }
    if (this.claims.has(request.requestId)) {
      return unknown(
        "This report opening is already submitting or has an uncertain result; check GitHub before retrying",
      );
    }
    if (this.consent.unavailable) return configuration(this.consent.unavailable);
    // The one step that is not a computation. Everything above narrowed WHAT would be
    // published; this asks whether anybody wants it published, and it is the only question
    // whose answer a caller cannot supply.
    const granted = await this.consent.ask({ target: target.repo, title: request.title });
    if (!granted) {
      return refused("Publishing was not confirmed; nothing was published");
    }
    // Re-checked after the wait: a dialog can sit open for two minutes, and the claim state
    // may have moved underneath it.
    if (this.claims.has(request.requestId)) {
      return unknown(
        "This report opening is already submitting or has an uncertain result; check GitHub before retrying",
      );
    }
    const after = this.now();
    const token = randomBytes(32).toString("hex");
    const expiresAt = after + PRODUCT_ISSUE_CONFIRMATION_TTL_MS;
    this.grants.set(request.requestId, { identity, token, expiresAt });
    return {
      outcome: "confirmation",
      requestId: request.requestId,
      draftIdentity: identity,
      target: target.repo,
      token,
      expiresAt,
    };
  }

  /**
   * File one report.
   *
   * `confirmation` carries the single-use grant minted by `confirm`. Omitted for the MCP
   * path, whose authorization is the session's submitted `input` review and whose transport
   * is token-guarded.
   *
   * Three separate things are checked, and each covers a different failure. The grant proves
   * the confirming step was taken rather than the value being computed from the draft or
   * picked up by reading a preview. Its expiry proves that step was taken recently rather
   * than being an old approval held for later. The identity comparison proves the daemon's
   * own derivation - target, labels, source, environment, body - has not moved since, so a
   * configuration change between reading and pressing cannot publish content nobody saw.
   */
  async submit(
    source: ProductIssueSource,
    input: unknown,
    confirmation?: { token: string },
  ): Promise<ProductIssueSubmitResult> {
    const parsed = ProductIssueRequestSchema.safeParse(input);
    if (!parsed.success) return refused(`Invalid product issue draft: ${parsed.error.message}`);
    const request = parsed.data;
    if (this.demoMode) {
      return configuration("Product issue reporting is disabled in demo mode; nothing was published");
    }
    if (!this.attachments.enabled && request.attachmentUploadIds.length > 0) {
      return refused(`${ATTACHMENTS_DISABLED_REASON}; nothing was published`);
    }
    const target = this.target();
    if (!target.ok) return configuration(target.error);

    const now = this.now();
    this.purgeExpired(now);
    const identity = this.identity(source, request, target.repo);
    const preview = this.previews.get(request.requestId);
    if (!preview) return refused("Preview this product issue before submitting it");
    if (preview.identity !== identity) {
      return refused("The product issue changed after preview; preview the current draft again");
    }
    // BEFORE the confirmation check, and the order is load-bearing. Retiring the token on a
    // terminal outcome means a replay after a successful publish would otherwise fail the
    // token check and come back as a retry-safe `refused` - telling somebody it is safe to
    // press again when an issue provably already exists. "This opening has already published"
    // is both the stronger statement and the true one, so it answers first.
    if (this.claims.has(request.requestId)) {
      return unknown(
        "This report opening is already submitting or has an uncertain result; check GitHub before retrying",
      );
    }
    if (confirmation) {
      // `purgeExpired(now)` above already dropped a grant that aged out, so a missing grant
      // and an expired one arrive here identically - which is correct, because the recovery
      // is identical too: confirm again in front of the content.
      const grant = this.grants.get(request.requestId);
      if (!grant || !tokenMatches(confirmation.token, grant.token)) {
        return refused(
          "This report was not confirmed, its confirmation expired, or it has already been " +
            "used; review the public content and confirm it again",
        );
      }
      // Belt to the identity comparison's braces. That one asks whether the derivation moved
      // since the PREVIEW; this asks whether it moved since the CONFIRMATION, which is the
      // narrower window a person actually agreed within.
      if (grant.identity !== identity) {
        return refused("The product issue changed after it was confirmed; confirm it again");
      }
    }

    // Reserve the opening before the read-only version probe yields. Without this, two
    // attachment submissions can both pass the guard above and both reach issue creation.
    // Pre-publication refusals release the reservation; from the create call onward it is
    // retained unless gh proves that nothing was published.
    this.claims.set(request.requestId, {
      state: "in-flight",
      expiresAt: now + REQUEST_TTL_MS,
    });

    let attachmentArgs: string[] = [];
    if (this.attachments.enabled && request.attachmentUploadIds.length > 0) {
      let version: RunResult;
      try {
        version = await this.runner(ghBin(), ["--version"], {
          timeoutMs: PREFLIGHT_TIMEOUT_MS,
        });
      } catch (error) {
        this.claims.delete(request.requestId);
        throw error;
      }
      if (
        version.outcomeUnknown ||
        version.code !== 0 ||
        !supportsProductIssueAttachments(version.stdout)
      ) {
        this.claims.delete(request.requestId);
        return configuration(`${ATTACHMENTS_VERSION_REASON}; nothing was published`);
      }

      const resolved = productIssueAttachmentArgs(
        this.attachments,
        request.attachmentUploadIds,
        now,
      );
      if (!resolved.ok) {
        this.claims.delete(request.requestId);
        return refused(`${resolved.error}; nothing was published`);
      }
      attachmentArgs = resolved.args;
    }

    const draft = this.draft(request);
    const environment = this.environment(request);
    const body = renderProductIssueBody(draft, environment);
    const labels = productIssueLabels(request.type, source);
    let result: RunResult;
    try {
      result = await this.runner(
        ghBin(),
        productIssueCreateArgs(target.repo, draft, labels, attachmentArgs),
        { timeoutMs: ISSUE_CREATE_TIMEOUT_MS, input: body },
      );
    } catch {
      this.claims.set(request.requestId, {
        state: "terminal",
        expiresAt: this.now() + REQUEST_TTL_MS,
      });
      this.retireConfirmation(request.requestId);
      return unknown(
        "GitHub issue creation did not report back; the issue may exist, so check GitHub before retrying",
      );
    }

    const outcome = githubIssueCreateOutcome(result, target.repo);
    switch (outcome.kind) {
      case "created":
        this.claims.set(request.requestId, {
          state: "terminal",
          expiresAt: this.now() + REQUEST_TTL_MS,
        });
        this.retireConfirmation(request.requestId);
        return {
          outcome: "created",
          issueUrl: outcome.url,
          target: target.repo,
          ...(outcome.partialFailure
            ? {
                warning: attachmentArgs.length > 0
                  ? `The issue was created, but GitHub CLI reported that one or more ` +
                    `screenshots were not attached.`
                  : `The issue was created, but GitHub CLI also reported an error.`,
              }
            : {}),
        };
      case "refused":
        if (attachmentArgs.length > 0) {
          this.claims.set(request.requestId, {
            state: "terminal",
            expiresAt: this.now() + REQUEST_TTL_MS,
          });
          this.retireConfirmation(request.requestId);
          return unknown(
            "GitHub CLI failed during attachment publication without returning the target " +
              "issue URL; the issue may exist, so check GitHub before retrying",
          );
        }
        this.claims.delete(request.requestId);
        return refused(
          `GitHub CLI refused the issue${outcome.detail ? `: ${outcome.detail}` : ""}`,
        );
      case "unknown":
        this.claims.set(request.requestId, {
          state: "terminal",
          expiresAt: this.now() + REQUEST_TTL_MS,
        });
        this.retireConfirmation(request.requestId);
        return unknown(
          outcome.reason === "process"
            ? "GitHub issue creation did not report back; the issue may exist, so check GitHub before retrying"
            : "GitHub CLI reported success without an issue URL; the issue may exist, so check GitHub before retrying",
        );
    }
  }

  /**
   * Retire this opening's confirmation, so the token that authorized a publish cannot
   * authorize a second one.
   *
   * Called on `created` and on `unknown` - the two outcomes where an issue may exist - and
   * deliberately NOT on a retry-safe refusal, where nothing was published and the person is
   * expected to press the same confirmed content again.
   */
  private retireConfirmation(requestId: string): void {
    this.grants.delete(requestId);
  }

  private preflightFailure(
    target: string,
    code: ProductIssuePreflight["problems"][number]["code"],
    message: string,
    attachments: ProductIssueAttachmentState = this.attachmentState(),
  ): ProductIssuePreflight {
    return {
      ready: false,
      target,
      attachments,
      problems: [{ code, message }],
    };
  }

  private environment(request: ProductIssueRequest): ProductIssueEnvironment {
    return {
      missionControlVersion: this.version,
      platform: platformFamily(this.platform),
      architecture: architectureFamily(this.architecture),
      client: request.client,
    };
  }

  private draft(request: ProductIssueRequest): ProductIssueDraft {
    return {
      type: request.type,
      title: request.title,
      details: request.details,
      attachmentUploadIds: [...request.attachmentUploadIds],
    };
  }

  private identity(source: ProductIssueSource, request: ProductIssueRequest, target: string): string {
    return createHash("sha256")
      .update(JSON.stringify({ source, target, ...request }))
      .digest("hex");
  }

  private purgeExpired(now: number): void {
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id);
    }
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(id);
    }
    for (const [id, claim] of this.claims) {
      if (claim.expiresAt <= now) this.claims.delete(id);
    }
  }
}
