import { createHash } from "node:crypto";
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
  PRODUCT_ISSUE_LIMITS,
  PRODUCT_ISSUE_REQUIRED_LABELS,
  PRODUCT_ISSUE_SOURCE_LABELS,
  PRODUCT_ISSUE_STATUS_LABEL,
  PRODUCT_ISSUE_TYPE_LABELS,
  type ProductIssueAttachmentState,
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
import { githubIssueCreateOutcome } from "./github/issue-create.ts";
import { detectImageExt, type SavedUpload } from "./uploads.ts";
import { run, type RunResult } from "./util/exec.ts";

const ISSUE_CREATE_TIMEOUT_MS = 20_000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OPEN_REQUESTS = 512;
const ATTACHMENTS_DISABLED_REASON =
  "Screenshot upload is waiting for first-party GitHub CLI support";

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

export interface ProductIssueServiceOptions {
  runner?: ProductIssueRunner;
  attachments?: ProductIssueAttachmentCapability;
  now?: () => number;
  target?: () => ProductIssuesRepoConfig;
  version?: string;
  platform?: string;
  architecture?: string;
  demoMode?: boolean;
}

interface PreviewClaim {
  identity: string;
  expiresAt: number;
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
 * The isolated anticipated attachment adapter. It remains unreachable from production.
 * Every locator is resolved again, contained by realpath, size-checked, and byte-sniffed
 * immediately before its absolute path becomes one repeated `--attach` pair.
 */
export function anticipatedProductIssueAttachmentArgs(
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
  private readonly previews = new Map<string, PreviewClaim>();
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
  }

  attachmentState(): ProductIssueAttachmentState {
    return this.attachments.enabled
      ? { enabled: true, reason: null }
      : { enabled: false, reason: ATTACHMENTS_DISABLED_REASON };
  }

  async preflight(): Promise<ProductIssuePreflight> {
    const target = this.target();
    const attachments = this.attachmentState();
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
      );
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
      );
    }

    const labels = await this.runner(
      ghBin(),
      ["label", "list", "--repo", target.repo, "--limit", "100", "--json", "name"],
      { timeoutMs: PREFLIGHT_TIMEOUT_MS },
    );
    if (labels.outcomeUnknown || labels.code !== 0) {
      return this.preflightFailure(
        target.repo,
        "labels",
        labels.outcomeUnknown
          ? `Labels in ${target.repo} could not be checked; try again`
          : `GitHub CLI could not list labels in ${target.repo}`,
      );
    }
    let names: Set<string>;
    try {
      const parsed = JSON.parse(labels.stdout) as unknown;
      if (!Array.isArray(parsed)) throw new Error("unexpected label list");
      names = new Set(
        parsed.flatMap((entry) => {
          const name = (entry as { name?: unknown })?.name;
          return typeof name === "string" ? [name] : [];
        }),
      );
    } catch {
      return this.preflightFailure(
        target.repo,
        "labels",
        `GitHub CLI returned an unreadable label list for ${target.repo}`,
      );
    }
    const missing = PRODUCT_ISSUE_REQUIRED_LABELS.filter((label) => !names.has(label));
    if (missing.length > 0) {
      return this.preflightFailure(
        target.repo,
        "labels",
        `Create the missing labels in ${target.repo}: ${missing.join(", ")}`,
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
    this.previews.set(request.requestId, {
      identity,
      expiresAt: now + REQUEST_TTL_MS,
    });
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

  async submit(source: ProductIssueSource, input: unknown): Promise<ProductIssueSubmitResult> {
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
    if (this.claims.has(request.requestId)) {
      return unknown(
        "This report opening is already submitting or has an uncertain result; check GitHub before retrying",
      );
    }

    let attachmentArgs: string[] = [];
    if (this.attachments.enabled && request.attachmentUploadIds.length > 0) {
      const resolved = anticipatedProductIssueAttachmentArgs(
        this.attachments,
        request.attachmentUploadIds,
        now,
      );
      if (!resolved.ok) return refused(`${resolved.error}; nothing was published`);
      attachmentArgs = resolved.args;
    }

    const draft = this.draft(request);
    const environment = this.environment(request);
    const body = renderProductIssueBody(draft, environment);
    const labels = productIssueLabels(request.type, source);
    this.claims.set(request.requestId, {
      state: "in-flight",
      expiresAt: now + REQUEST_TTL_MS,
    });

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
      return unknown(
        "GitHub issue creation did not report back; the issue may exist, so check GitHub before retrying",
      );
    }

    const outcome = githubIssueCreateOutcome(result);
    switch (outcome.kind) {
      case "created":
        this.claims.set(request.requestId, {
          state: "terminal",
          expiresAt: this.now() + REQUEST_TTL_MS,
        });
        return { outcome: "created", issueUrl: outcome.url, target: target.repo };
      case "refused":
        this.claims.delete(request.requestId);
        return refused(
          `GitHub CLI refused the issue${outcome.detail ? `: ${outcome.detail}` : ""}`,
        );
      case "unknown":
        this.claims.set(request.requestId, {
          state: "terminal",
          expiresAt: this.now() + REQUEST_TTL_MS,
        });
        return unknown(
          outcome.reason === "process"
            ? "GitHub issue creation did not report back; the issue may exist, so check GitHub before retrying"
            : "GitHub CLI reported success without an issue URL; the issue may exist, so check GitHub before retrying",
        );
    }
  }

  private preflightFailure(
    target: string,
    code: ProductIssuePreflight["problems"][number]["code"],
    message: string,
  ): ProductIssuePreflight {
    return {
      ready: false,
      target,
      attachments: this.attachmentState(),
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
    for (const [id, claim] of this.claims) {
      if (claim.expiresAt <= now) this.claims.delete(id);
    }
  }
}
