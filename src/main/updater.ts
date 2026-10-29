import { spawnBundledUpdateHelper } from "../../scripts/update-helper-runtime.mjs";
import { prepareSourceUpdate, validateStagedInstall, type StagedInstallDescriptor } from "../../scripts/install-staged-app.mjs";
import { readReceipt } from "../shared/install-receipt.mjs";
import { assertSafeAppLaunch } from "../../scripts/mac-app-lifecycle.mjs";
import { UPDATE_HELPER_FILES } from "../../scripts/update-helper-files.mjs";
import { prepareInPlaceInstall, prepareMigration, keepSystemInstallation, readMigrationJournal, receiptDigest, type MigrationPlan } from "../../scripts/install-migration.mjs";
import { PORT } from "../shared/harness-runtime.mjs";
import { APP_BUNDLE_NAME, LEGACY_APP_BUNDLE_NAME } from "../shared/app-naming.mjs";
import type { UpdateMigration } from "../shared/update.ts";
import { execFile } from "node:child_process";
import { statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CANONICAL_REPO,
  isTrustedInstallRepo,
} from "../shared/install-receipt-schema.mjs";
import { stagedBundleRevision } from "../shared/staged-bundle.mjs";
import type { InstallReceipt } from "../shared/install-receipt-schema.mjs";
import {
  isNewerVersion,
  updatePrepareProgress,
  versionFromReleaseTag,
  type UpdateApplyOutcome,
  type UpdatePrepareStage,
  type UpdateSnapshot,
} from "../shared/update.ts";
// The updater asks the same locator as the daemon before it invokes `gh`, so detection and
// execution retain one absolute identity even when Electron started with a minimal PATH.
import { locateExecutable } from "../server/executables/locator.ts";
import { appSourceCommit, bundleShortVersion } from "./bundle-version.ts";
import { isCommitSha, sourceCommitProblem } from "../shared/update-source.mjs";
import { readUpdatePreferences, writeUpdatePreferences, type UpdatePreferences } from "./update-preferences.ts";
import { createRotatingUpdateLogger } from "./update-log.ts";
import { clearUpdateOutcome, readSettledUpdateOutcome, updateOutcomePath } from "./update-outcome.ts";
import { latestStableBinary, binaryForCommit, BINARY_PENDING, BinaryUpdateError, type BinaryOffer } from "./update-binary-release.ts";
import { stageBinaryUpdate, discardBinaryUpdate, retainBinaryHandoff, cleanupSettledBinaryDownloads, type BinaryStageRequest, type BinaryStageOutcome } from "./update-binary.ts";
import type { UpdateTransfer } from "../shared/update.ts";

/**
 * The staged build and the detached helper need the same login-shell PATH for the same
 * reason, so they share one owner. Re-exported under the name the helper's callers use.
 */
export { updateChildEnvironment as detachedUpdateHelperEnvironment } from "./update-build.ts";
/** The log rule now has its own owner, shared with the staged build that also writes there. */
export { createRotatingUpdateLogger, sanitizeLogLine } from "./update-log.ts";

const FIRST_CHECK_MIN_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 60_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const RECHECK_JITTER_MS = 15 * 60 * 1000;
const UPDATE_SNOOZE_MS = 48 * 60 * 60 * 1000;
export const ALPHA_RECHECK_MS = 5 * 60 * 1000;
const MAX_RELEASE_NOTES = 4_000;

export interface ReleaseInfo {
  binary?: BinaryOffer;
  unavailable?: string;
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  body: string;
}

export interface MainCommitInfo {
  sha: string;
  message: string;
  committedAt: string;
}

export interface OutcomeDelivery {
  delivered(): void;
  acknowledged(): void;
}

export interface UpdateDialogs {
  available(release: {
    currentVersion: string;
    newVersion: string;
    name: string;
    notes: string;
  }): Promise<"apply" | "defer">;
  upToDate(version: string): Promise<void>;
  /** Preparation is already running, with the stage it last reached. */
  preparing(version: string, stage: string): Promise<void>;
  /** Downloaded, verified, and waiting: the only remaining question is whether to restart now. */
  ready(version: string, migration?: UpdateMigration): Promise<"install" | "defer" | "system">;
  applying(version: string): Promise<void>;
  error(message: string): Promise<void>;
  outcome(outcome: UpdateApplyOutcome, delivery: OutcomeDelivery): Promise<void>;
}

/** One coherent reading of what is installed and whether this process may update it. */
export interface InstallSnapshot {
  receipt: InstallReceipt | null;
  /** Why this bundle may not update anything, or null when it may. */
  problem: string | null;
}

export interface HelperHandoff {
  node?: string;
  descriptor?: StagedInstallDescriptor;
  receipt?: InstallReceipt;
  env?: NodeJS.ProcessEnv;
  helperSource: string;
  sourceClone?: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
  /** Verified candidate only. A missing candidate is refused before shutdown. */
  stagedBundle: string | null;
  /** The revision observed when bytes, signature and build identity were verified. */
  stagedRevision: string | null;
  migration?: MigrationPlan;
  migrationInventory?: unknown;
}

/** Identity of the prepared candidate at the moment of the read. */
export interface StagedBundleIdentity {
  /** CFBundleShortVersionString of the bundle now at that path. */
  version: string | null;
  /** An opaque token that changes when the bundle is rebuilt or replaced. */
  revision: string | null;
  commit?: string | null;
}

/** Binary preparation runs in the app-owned worker. */
export type UpdateStageRequest = BinaryStageRequest;

export interface UpdaterPort {
  packaged: boolean;
  arch: string;
  currentVersion(): string;
  currentCommit(): string | null;
  readAlpha(): boolean;
  writeAlpha(alpha: boolean): void;
  readSnoozes(): UpdatePreferences["snoozedUntil"];
  writeSnoozes(snoozedUntil: UpdatePreferences["snoozedUntil"]): void;
  /**
   * The receipt and this bundle's right to act on it, read together.
   *
   * ONE call, deliberately, and never two. The receipt names an absolute app path, and until
   * personal installs existed nothing compared it to the bundle the process came out of - so a
   * retained copy at the old location would happily build an update and swap it into the app
   * somebody else is running. Answering that needs the receipt AND the classification, and
   * splitting them across two port calls meant the two could describe different installations:
   * a receipt rewritten in between would be validated in one call and acted on in the other.
   * Returning both from one read makes that impossible rather than unlikely, and leaves the
   * caller nothing to coordinate. See `install-identity.ts` for how `problem` is reached.
   */
  installSnapshot(): InstallSnapshot;
  latestRelease(): Promise<ReleaseInfo | null>;
  latestMainCommit(): Promise<MainCommitInfo>;
  binaryForCommit(commit: string): Promise<BinaryOffer | null>;
  discard?(descriptor: StagedInstallDescriptor): Promise<void>;
  helperSource(): string;
  stateDirectory(): string;
  launchPreflight(appPath: string): Promise<void>;
  handoff(args: HelperHandoff): Promise<void>;
  stage(request: UpdateStageRequest): Promise<BinaryStageOutcome>;
  /** What is at a staged bundle's path now, so a caller can tell it is still the same build. */
  stagedBundleIdentity(path: string): StagedBundleIdentity;
  migrationPlan?(receipt: InstallReceipt, bundle: string, revision: string, descriptor?: StagedInstallDescriptor): MigrationPlan | null;
  migrationInventory?(plan: MigrationPlan): unknown;
  keepSystem?(plan: MigrationPlan): Promise<InstallReceipt>;
  migrationStatus?(): UpdateMigration | undefined;
  repairMigration?(confirmLogin?: boolean): Promise<void>;
  requestQuit(): void;
  readOutcome(): UpdateApplyOutcome | null | Promise<UpdateApplyOutcome | null>;
  clearOutcome(expected: UpdateApplyOutcome): void;
  now(): number;
  random(): number;
  log(line: string): void;
  dialogs: UpdateDialogs;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type GhRunner = (args: string[]) => Promise<CommandResult>;

export const UPDATE_GH_ARGS = {
  mainCommit: () => ["api", `repos/${CANONICAL_REPO}/commits/main`],
  releaseList: () => [
    "release",
    "list",
    "--repo",
    CANONICAL_REPO,
    "--exclude-drafts",
    "--exclude-pre-releases",
    "--order",
    "desc",
    "--limit",
    "1",
    "--json",
    "tagName,name,publishedAt,isDraft,isPrerelease",
  ],
  releaseView: (tag: string) => [
    "release",
    "view",
    tag,
    "--repo",
    CANONICAL_REPO,
    "--json",
    "body",
  ],
};

/** Resolve main once; every subsequent build and install uses this immutable SHA. */
export async function latestMainCommit(run: GhRunner): Promise<MainCommitInfo> {
  const result = await run(UPDATE_GH_ARGS.mainCommit());
  if (result.code !== 0) throw ghFailure(result);
  try {
    const value = JSON.parse(result.stdout);
    if (!isCommitSha(value?.sha) || typeof value?.commit?.message !== "string" ||
      typeof value?.commit?.committer?.date !== "string" ||
      !Number.isFinite(Date.parse(value.commit.committer.date))) throw new Error("invalid commit");
    return { sha: value.sha, message: value.commit.message, committedAt: value.commit.committer.date };
  } catch {
    throw new UpdateError("GitHub CLI returned an invalid main commit. Check again.");
  }
}

/**
 * What KIND of thing went wrong, as distinct from whether trying again might help.
 *
 * `retryable` answers "should this offer a retry"; it says nothing about whether the failure
 * will still be there in six hours. That distinction is what decides whether a background check
 * may interrupt someone: a lapsed credential is a standing condition only they can clear, while
 * a rate limit or a bad minute on the network clears itself.
 */
export type UpdateErrorKind = "gh-missing" | "gh-auth" | "gh-rate-limited" | "gh-failed";

/**
 * The kinds a background check is allowed to surface.
 *
 * Everything else stays quiet and goes back to idle, because a banner that appears for a
 * transient failure trains people to dismiss the one that matters.
 */
const PERSISTENT_ERROR_KINDS: ReadonlySet<UpdateErrorKind> = new Set(["gh-missing", "gh-auth"]);

export function surfacesFromBackgroundCheck(kind: UpdateErrorKind): boolean {
  return PERSISTENT_ERROR_KINDS.has(kind);
}

class UpdateError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly kind: UpdateErrorKind = "gh-failed",
  ) {
    super(message);
  }
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.slice(0, 240) ?? "";
}

export function ghFailure(result: CommandResult): UpdateError {
  if (result.errorCode === "ENOENT" || result.code === 127) {
    return new UpdateError(
      "GitHub CLI (gh) is not installed. Install gh, then check again.",
      true,
      "gh-missing",
    );
  }
  const detail = firstLine(result.stderr || result.stdout);
  // Rate limiting first, because GitHub's own rate-limit body reads "higher rate limits apply to
  // authenticated requests" and an auth test running first would call a working credential
  // lapsed.
  //
  // The status code alone decides nothing here. 403 is also how GitHub answers "Resource not
  // accessible by integration" and every other authorization refusal, and telling someone to
  // wait an hour for a permission they will never be granted is worse than saying nothing -
  // this class is suppressed during background checks precisely because it clears itself. So a
  // 403 has to carry a rate-limit marker of its own to land here; only 429, which GitHub uses
  // for nothing else, is taken on the code.
  if (/rate limit|HTTP 429|abuse detection|secondary rate/i.test(detail)) {
    return new UpdateError(
      "GitHub's API rate limit is reached, so updates cannot be checked right now. It resets within the hour and Mission Control will check again on its own.",
      true,
      "gh-rate-limited",
    );
  }
  // Narrower than it was. The old test matched a bare `login` or `auth` anywhere in the line,
  // so any URL containing "login" - and every `oauth`, `author`, and repository named for one -
  // read as a lapsed credential. That was survivable while this class only ever answered a
  // manual check; it is not, now that it is allowed to interrupt someone unprompted.
  if (/HTTP 401|credential|authenticat|not logged in|gh auth login/i.test(detail)) {
    return new UpdateError(
      "GitHub CLI is not authenticated. Run `gh auth login`, then check again.",
      true,
      "gh-auth",
    );
  }
  return new UpdateError(`GitHub CLI cannot check updates here (exit ${result.code}). Try again.`);
}

function releaseRecord(value: unknown): Omit<ReleaseInfo, "body"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const release = value as Record<string, unknown>;
  if (
    typeof release.tagName !== "string" ||
    typeof release.name !== "string" ||
    typeof release.publishedAt !== "string" ||
    typeof release.isDraft !== "boolean" ||
    typeof release.isPrerelease !== "boolean"
  ) {
    return null;
  }
  return release as unknown as Omit<ReleaseInfo, "body">;
}

/** Ask gh for the newest stable release, selecting stable candidates in the query itself. */
export async function latestStableRelease(run: GhRunner): Promise<ReleaseInfo | null> {
  const listed = await run(UPDATE_GH_ARGS.releaseList());
  if (listed.code !== 0) throw ghFailure(listed);
  let values: unknown;
  try {
    values = JSON.parse(listed.stdout || "[]");
  } catch {
    throw new UpdateError("GitHub CLI returned an unreadable release list.");
  }
  if (!Array.isArray(values)) throw new UpdateError("GitHub CLI returned an invalid release list.");
  if (values.length === 0) return null;
  const release = releaseRecord(values[0]);
  if (!release) throw new UpdateError("GitHub CLI returned an incomplete release record.");
  if (release.isDraft || release.isPrerelease) {
    throw new UpdateError("GitHub CLI returned an ineligible draft or prerelease.");
  }

  const viewed = await run(UPDATE_GH_ARGS.releaseView(release.tagName));
  if (viewed.code !== 0) throw ghFailure(viewed);
  let body: unknown;
  try {
    body = (JSON.parse(viewed.stdout || "{}") as Record<string, unknown>).body;
  } catch {
    throw new UpdateError("GitHub CLI returned unreadable release notes.");
  }
  return { ...release, body: typeof body === "string" ? body : "" };
}

export async function runGh(args: string[]): Promise<CommandResult> {
  const executable = await locateExecutable("gh");
  if (!executable) return { code: 1, stdout: "", stderr: "GitHub CLI was not found.", errorCode: "ENOENT" };
  return await new Promise((resolve) => {
    execFile(
      executable.path,
      args,
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {...executable.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: ""},
        maxBuffer: 2 * 1024 ** 2,
      },
      (error, stdout, stderr) => {
        const coded = error as NodeJS.ErrnoException & { code?: string | number };
        resolve({
          code: error ? (typeof coded.code === "number" ? coded.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(typeof coded?.code === "string" ? { errorCode: coded.code } : {}),
        });
      },
    );
  });
}

/** Strip markup and cap release notes before they can cross a UI boundary. */
export function sanitizeReleaseNotes(notes: string): string {
  const plain = notes
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^[\s]*(?:#{1,6}|[-*+])\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    // Release Please signs every release body it writes with a horizontal rule and a line
    // about itself. It is addressed to whoever reviewed the release pull request, and in the
    // banner and the native dialog it reads as part of what changed - so it is cut here,
    // where every consumer of the notes already passes through, rather than at each surface.
    .replace(/\n*-{3,}[ \t]*\n+This (?:PR|release) was generated with Release Please\b[^\n]*\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > MAX_RELEASE_NOTES
    ? `${plain.slice(0, MAX_RELEASE_NOTES - 1).trimEnd()}…`
    : plain;
}

export function detachedUpdateHelperSources(helperSource: string): string[] {
  const root = dirname(dirname(helperSource));
  return UPDATE_HELPER_FILES.map((path) => join(root, path));
}

export async function spawnDetachedUpdateHelper(args: HelperHandoff): Promise<void> {
  if (!args.stagedBundle || !args.stagedRevision) throw new Error("A verified staged bundle is required; desktop updates cannot compile source");
  const receipt = readReceipt(join(args.stateDirectory, "install-receipt.json"));
  if (!receipt || receipt.appPath !== args.appPath || (args.receipt && receiptDigest(receipt) !== receiptDigest(args.receipt))) throw new Error("The installation receipt changed before handoff");
  // The source descriptor branch remains solely for callers of the staged source
  // installer. The desktop controller always supplies its accepted binary descriptor.
  const descriptor = args.descriptor ?? prepareSourceUpdate({receipt, bundle: args.stagedBundle, revision: args.stagedRevision, targetTag: args.targetTag});
  if (descriptor.bundle !== args.stagedBundle || descriptor.revision !== args.stagedRevision) throw new Error("The accepted bundle identity changed");
  validateStagedInstall(descriptor);
  const supportsTransaction = JSON.parse(readFileSync(join(args.stagedBundle, "Contents/Resources/app/package.json"), "utf8")).missionInstallTransaction?.protocol === 1;
  if (descriptor.receipt.kind === "binary" && !supportsTransaction) throw new Error("The binary does not support the installation transaction");
  const plan = args.migration ?? (supportsTransaction ? prepareInPlaceInstall({descriptor, stateDirectory: args.stateDirectory}) : null);
  if (plan) retainBinaryHandoff(descriptor, args.stateDirectory, plan.nonce);
  await spawnBundledUpdateHelper({runtimeBundle: args.appPath, candidateBundle: args.stagedBundle, helperSource: args.helperSource, stateDirectory: args.stateDirectory,
    parentPid: args.parentPid, logPath: args.logPath, env: args.env,
    handoff: plan ? {plan, port: PORT, inventory: args.migrationInventory} : undefined, argv: [
      ...(receipt.sourceClone ? ["--source-clone", receipt.sourceClone] : []),
      "--target-tag", args.targetTag, "--app-path", args.appPath,
      "--parent-pid", String(args.parentPid), "--state-dir", args.stateDirectory, "--log-path", args.logPath,
      "--staged-bundle", args.stagedBundle, "--staged-revision", args.stagedRevision,
      ...(plan ? [] : ["--staged-digest", descriptor.digest]),
    ]});
}

/** Ordering seam protecting the hide-on-close window guard. */
export function requestUpdateQuit(setQuitting: () => void, quit: () => void): void {
  setQuitting();
  quit();
}

function idleSnapshot(
  currentVersion: string,
  lastOutcome: UpdateApplyOutcome | null,
  lastCheckedAt: number | null,
): UpdateSnapshot {
  return { phase: "idle", currentVersion, lastCheckedAt, lastOutcome };
}

function safeUpdateError(error: unknown): {
  message: string;
  retryable: boolean;
  kind: UpdateErrorKind;
} {
  if (error instanceof BinaryUpdateError) return {message: error.message, retryable: true, kind: "gh-failed"};
  return error instanceof UpdateError
    ? { message: error.message, retryable: error.retryable, kind: error.kind }
    : {
        message: "The update check failed unexpectedly. Check the update log and try again.",
        retryable: true,
        kind: "gh-failed",
      };
}

/**
 * Why a snapshot cannot drive an update, or null when it can.
 *
 * One reading rather than two: startup used to apply the receipt and trust checks while
 * `install()` re-checked only the identity, so a receipt rewritten to an untrusted repository
 * after launch was refused at the wrong moment or not at all. Every caller now asks the same
 * question of the same snapshot.
 */
export function updateIneligibility(snapshot: InstallSnapshot): string | null {
  if (!snapshot.receipt) return "This app was not installed with the managed install command.";
  if (!isTrustedInstallRepo(snapshot.receipt.repo)) {
    return `Updates are disabled because this app was installed from ${snapshot.receipt.repo}.`;
  }
  return snapshot.problem;
}

export class UpdateController {
  private migration: MigrationPlan | null = null;
  private systemPromise: Promise<boolean> | null = null;
  private policyPending = false;
  private repairPromise: Promise<void> | null = null;
  private alpha: boolean;
  private snoozedUntil: UpdatePreferences["snoozedUntil"];
  private snapshot: UpdateSnapshot;
  private receipt: InstallReceipt | null = null;
  private checkPromise: Promise<UpdateSnapshot> | null = null;
  private applyPromise: Promise<boolean> | null = null;
  private commandPromise: Promise<UpdateSnapshot> | null = null;
  private applyingNoticePromise: Promise<UpdateSnapshot> | null = null;
  private installPromise: Promise<boolean> | null = null;
  private releaseDecisionPending = false;
  private manualCheckRequested = false;
  private listeners = new Set<(snapshot: UpdateSnapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBackgroundAttempt = 0;
  /** Retained across Later, pinned to the accepted immutable release. */
  private staged: {
    binary: BinaryOffer;
    releaseTag: string;
    version: string;
    bundlePath: string;
    revision: string | null;
  } | null = null;
  private preparation: AbortController | null = null;
  private offeredBinary: BinaryOffer | null = null;
  private descriptor: StagedInstallDescriptor | null = null;

  private discardStaged(): void {
    const descriptor = this.descriptor;
    this.staged = null; this.descriptor = null; this.migration = null;
    if (descriptor) void this.port.discard?.(descriptor).catch(error => this.port.log(`could not remove abandoned binary: ${String(error)}`));
  }

  constructor(private readonly port: UpdaterPort) {
    this.alpha = port.readAlpha();
    this.snoozedUntil = port.readSnoozes();
    this.snapshot = { phase: "disabled", reason: "Update manager has not started.", lastOutcome: null };
  }

  getSnapshot(): UpdateSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(snapshot: UpdateSnapshot): UpdateSnapshot {
    const status = this.port.migrationStatus?.();
    const migration = status?.status === "repair-required" || (status?.status === "complete" && ["idle", "disabled"].includes(snapshot.phase))
      ? status : snapshot.migration?.status === "offered" ? snapshot.migration : undefined;
    this.snapshot = { ...snapshot, migration, alpha: this.alpha };
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  /** A channel change cannot retarget a check, consent dialog, or preparation already in flight. */
  setAlpha(alpha: boolean): UpdateSnapshot {
    if (typeof alpha !== "boolean") throw new Error("Alpha mode must be a boolean.");
    if (this.checkPromise || this.releaseDecisionPending || this.applyPromise || this.installPromise ||
      ["preparing", "ready", "applying"].includes(this.snapshot.phase)) {
      throw new Error("Finish or defer the current update before changing alpha mode.");
    }
    this.port.writeAlpha(alpha);
    this.alpha = alpha;
    this.discardStaged();
    this.offeredBinary = null;
    if (this.snapshot.phase === "disabled") return this.publish(this.snapshot);
    this.publish(idleSnapshot(this.currentLabel(), this.snapshot.lastOutcome, null));
    this.schedule(0);
    return this.snapshot;
  }

  private currentLabel(): string {
    const commit = this.port.currentCommit();
    return this.alpha && commit ? `${this.port.currentVersion()} (alpha ${commit.slice(0, 7)})` : this.port.currentVersion();
  }

  private recheckMs(): number {
    return this.alpha ? ALPHA_RECHECK_MS : RECHECK_MS;
  }

  async start(): Promise<void> {
    if (!this.port.packaged) {
      this.publish({
        phase: "disabled",
        reason: "Updates are available only in the packaged app.",
        lastOutcome: null,
      });
      return;
    }

    const storedOutcome = await this.port.readOutcome();
    let lastOutcome = storedOutcome;
    if (lastOutcome?.result === "in-progress") {
      lastOutcome = {
        result: "failure",
        targetVersion: lastOutcome.targetVersion,
        recordedAt: lastOutcome.recordedAt,
        message: "The previous update did not finish. Check the update log before retrying.",
      };
    }
    const disable = (reason: string) => this.publish({ phase: "disabled", reason, lastOutcome });
    if (this.port.arch !== "arm64") disable("Updates require an Apple silicon Mac.");
    else {
      const installed = this.port.installSnapshot();
      this.receipt = installed.receipt;
      const reason = updateIneligibility(installed);
      if (reason) disable(reason);
      else {
        this.lastBackgroundAttempt = this.port.now();
        this.publish(idleSnapshot(this.currentLabel(), lastOutcome, null));
      }
    }

    if (lastOutcome) {
      try {
        const notice = lastOutcome;
        const clear = () => {
          try { this.port.clearOutcome(storedOutcome!); }
          catch (error) { this.port.log(`could not retire update outcome: ${String(error)}`); }
        };
        await this.port.dialogs.outcome(notice, {
          delivered: () => {
            // Delivery proves only that the renderer ran once. It may hang before
            // an answer, so preserve the notice across relaunch until acknowledged.
            this.port.log("update outcome delivered; awaiting operator acknowledgment");
          },
          acknowledged: clear,
        });
      } catch (error) {
        this.port.log(`could not show the previous update outcome: ${String(error)}`);
      }
    }
    if (this.snapshot.phase !== "disabled") this.scheduleFirstCheck();
  }

  private scheduleFirstCheck(): void {
    const delay = FIRST_CHECK_MIN_MS + Math.floor(this.port.random() * FIRST_CHECK_JITTER_MS);
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.lastBackgroundAttempt = this.port.now();
      void this.check(false).finally(() => {
        this.schedule(this.recheckMs() + Math.floor(this.port.random() * (this.alpha ? 30_000 : RECHECK_JITTER_MS)));
      });
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The preparation adapter settles its worker group before removing partial staging.
    this.preparation?.abort();
    this.preparation = null;
  }

  onActivate(): void {
    if (
      this.snapshot.phase !== "disabled" &&
      this.snapshot.phase !== "preparing" &&
      this.snapshot.phase !== "ready" &&
      this.snapshot.phase !== "applying" &&
      !this.checkPromise &&
      !this.releaseDecisionPending &&
      this.port.now() - this.lastBackgroundAttempt >= this.recheckMs()
    ) {
      this.lastBackgroundAttempt = this.port.now();
      void this.check(false);
    }
  }

  check(manual: boolean): Promise<UpdateSnapshot> {
    if (this.snapshot.migration?.status === "repair-required") return Promise.resolve(this.snapshot);
    if (this.checkPromise) {
      if (manual) this.manualCheckRequested = true;
      return this.checkPromise;
    }
    if (!manual && this.releaseDecisionPending) return Promise.resolve(this.snapshot);
    // A build in flight, a bundle waiting to be installed, and a handoff already made are all
    // states a re-check could only damage: the answer it would publish is a release offer,
    // over the top of work already under way for that release.
    if (
      this.snapshot.phase === "disabled" ||
      this.snapshot.phase === "preparing" ||
      this.snapshot.phase === "ready" ||
      this.snapshot.phase === "applying"
    ) {
      return Promise.resolve(this.snapshot);
    }
    this.manualCheckRequested = manual;
    const previousCheckedAt =
      this.snapshot.phase === "idle" ? this.snapshot.lastCheckedAt : this.port.now();
    const currentVersion = this.currentLabel();
    this.lastBackgroundAttempt = this.port.now();
    const lastOutcome = this.snapshot.lastOutcome;
    this.publish({ phase: "checking", currentVersion, manual, lastOutcome });
    this.checkPromise = (async () => {
      try {
        // Stable release news remains part of alpha offers. A failed news lookup must not
        // prevent tracking main; a failed main lookup must never fall back to older source.
        const release = await this.port.latestRelease().catch((error: unknown) => {
          if (!this.alpha) throw error;
          this.port.log(`release news unavailable: ${String(error)}`);
          return null;
        });
        const commit = this.alpha ? await this.port.latestMainCommit() : null;
        const checkedAt = this.port.now();
        const releaseVersion = release ? versionFromReleaseTag(release.tagName) : null;
        const newerRelease = releaseVersion && isNewerVersion(this.port.currentVersion(), releaseVersion);
        if (commit ? commit.sha === this.port.currentCommit() : !release || !newerRelease) {
          return this.publish({ phase: "up-to-date", currentVersion, checkedAt, lastOutcome });
        }
        const targetRef = commit?.sha ?? release!.tagName;
        const newVersion = commit ? `alpha ${commit.sha.slice(0, 7)}` : releaseVersion!;
        const notes = commit
          ? [`Latest main commit ${commit.sha.slice(0, 7)}.`,
              ...(newerRelease ? [`Stable release ${release!.tagName} is also available.`] : []),
              commit.message, ...(newerRelease ? [release!.body] : [])].join("\n\n")
          : release!.body;
        const reusableStaged = this.staged?.releaseTag === targetRef && this.descriptor && this.stagedBundleIsIntact(this.staged);
        const binary = reusableStaged ? this.staged!.binary : commit ? await this.port.binaryForCommit(commit.sha) : release?.binary;
        this.offeredBinary = binary ? structuredClone(binary) : null;
        // Check after discovery's final await so a manual request joining a background
        // check can still show the offer. Explicit checks do not erase its saved snooze.
        if (!this.manualCheckRequested && (this.snoozedUntil[targetRef] ?? 0) > this.port.now()) {
          return this.publish(idleSnapshot(currentVersion, lastOutcome, checkedAt));
        }
        return this.publish({
          phase: "available",
          currentVersion,
          newVersion,
          releaseTag: targetRef,
          ...(commit ? { commitSha: commit.sha } : {}),
          releaseName: commit ? "Alpha update from main" : sanitizeReleaseNotes(release!.name || targetRef).slice(0, 200),
          releaseNotes: sanitizeReleaseNotes(notes),
          publishedAt: commit?.committedAt ?? release!.publishedAt,
          checkedAt,
          lastOutcome,
          ...(!this.offeredBinary ? { blocker: release?.unavailable ?? BINARY_PENDING } : {}),
        });
      } catch (error) {
        const safe = safeUpdateError(error);
        this.port.log(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
        const manual = this.manualCheckRequested;
        // A background check used to return to idle unconditionally, which made a lapsed `gh`
        // credential invisible by construction: it can only be noticed by someone who happens
        // to run a manual check. A standing, user-actionable condition now reaches the banner
        // on its own, while transient failures still go quietly back to idle.
        if (!manual && !surfacesFromBackgroundCheck(safe.kind)) {
          return this.publish(idleSnapshot(currentVersion, lastOutcome, previousCheckedAt));
        }
        return this.publish({
          phase: "error",
          currentVersion,
          message: safe.message,
          manual,
          retryable: safe.retryable,
          lastOutcome,
        });
      } finally {
        this.manualCheckRequested = false;
        this.checkPromise = null;
      }
    })();
    return this.checkPromise;
  }

  private reportApplying(version: string): Promise<UpdateSnapshot> {
    if (this.applyingNoticePromise) return this.applyingNoticePromise;
    this.applyingNoticePromise = this.port.dialogs
      .applying(version)
      .then(() => this.snapshot)
      .finally(() => {
        this.applyingNoticePromise = null;
      });
    return this.applyingNoticePromise;
  }

  /** Shared command seam used by both the app menu and tray. */
  checkForUpdates(): Promise<UpdateSnapshot> {
    if (this.snapshot.phase === "applying") {
      return this.reportApplying(this.snapshot.newVersion);
    }
    if (this.snapshot.phase === "preparing") {
      const { detail: label } = updatePrepareProgress(this.snapshot.stage, this.snapshot.transfer);
      const version = this.snapshot.newVersion;
      return this.port.dialogs.preparing(version, label).then(() => this.snapshot);
    }
    if (this.commandPromise) return this.commandPromise;
    this.commandPromise = (async () => {
      const snapshot = await this.check(true);
      switch (snapshot.phase) {
        case "available": {
          if (snapshot.blocker) {
            await this.port.dialogs.error(snapshot.blocker);
            return this.snapshot;
          }
          let choice: "apply" | "defer";
          this.releaseDecisionPending = true;
          try {
            choice = await this.port.dialogs.available({
              currentVersion: snapshot.currentVersion,
              newVersion: snapshot.newVersion,
              name: snapshot.releaseName,
              notes: snapshot.releaseNotes,
            });
          } finally {
            this.releaseDecisionPending = false;
          }
          if (choice !== "apply") {
            this.defer();
            return this.snapshot;
          }
          await this.apply();
          // Preparation has finished by the time apply() resolves, so this is the second half of
          // the same conversation rather than a new one: it asks for the restart the person
          // has now earned, in the same place they asked for the update.
          if (this.snapshot.phase === "ready") await this.confirmReady(this.snapshot.newVersion);
          return this.snapshot;
        }
        case "ready":
          await this.confirmReady(snapshot.newVersion);
          return this.snapshot;
        case "preparing": {
          const { detail: label } = updatePrepareProgress(snapshot.stage, snapshot.transfer);
          await this.port.dialogs.preparing(snapshot.newVersion, label);
          return this.snapshot;
        }
        case "up-to-date":
          await this.port.dialogs.upToDate(snapshot.currentVersion);
          return this.snapshot;
        case "error":
          await this.port.dialogs.error(snapshot.message);
          return this.snapshot;
        case "disabled":
          await this.port.dialogs.error(snapshot.reason);
          return this.snapshot;
        case "applying":
          return this.reportApplying(snapshot.newVersion);
        case "idle":
        case "checking":
          await this.port.dialogs.error(
            "The update check did not finish. Check the update log and try again.",
          );
          return this.snapshot;
      }
      const unhandled: never = snapshot;
      return unhandled;
    })().finally(() => {
      this.commandPromise = null;
    });
    return this.commandPromise;
  }

  /** Download and verify while the current app stays open. */
  apply(): Promise<boolean> {
    if (this.applyPromise) return this.applyPromise;
    if (this.snapshot.phase !== "available" || !this.receipt || this.snapshot.blocker || !this.offeredBinary) {
      return Promise.resolve(false);
    }
    const offer = this.snapshot;
    const binary = structuredClone(this.offeredBinary!);
    const lastOutcome = offer.lastOutcome;
    const preparing = (stage: UpdatePrepareStage, cancelling = false, transfer?: UpdateTransfer): UpdateSnapshot => ({
      phase: "preparing",
      currentVersion: offer.currentVersion,
      newVersion: offer.newVersion,
      releaseTag: offer.releaseTag,
      stage,
      transfer,
      cancelling,
      lastOutcome,
    });
    const ready = (): UpdateSnapshot => ({
      phase: "ready",
      currentVersion: offer.currentVersion,
      newVersion: offer.newVersion,
      releaseTag: offer.releaseTag,
      stagedAt: this.port.now(),
      lastOutcome,
      ...(this.migration ? {migration: {kind: this.migration.kind === "rename" ? "rename" : undefined, source: this.migration.source, target: this.migration.target, status: "offered" as const, repairs: []}} : {}),
    });

    // Later retains the verified bytes. Reuse only the exact accepted identity.
    if (
      this.staged?.releaseTag === offer.releaseTag &&
      this.stagedBundleIsIntact(this.staged)
    ) {
      try { this.refreshMigration(); }
      catch (error) { return this.reportFailure("migration preflight failed", offer, error); }
      this.publish(ready());
      return Promise.resolve(true);
    }

    this.discardStaged();
    const abort = new AbortController();
    this.preparation = abort;
    this.publish(preparing("download"));
    this.applyPromise = (async () => {
      try {
        const outcome = await this.port.stage({
          offer: binary,
          receipt: this.receipt!,
          targetTag: offer.releaseTag,
          signal: abort.signal,
          // Guarded on the phase rather than published blindly: a cancellation or a failure
          // has already moved the snapshot on, and a late stage line must not drag it back
          // into a build that is over.
          onStage: (stage, transfer) => {
            // A stage arriving after Cancel was pressed must not undo the cancelling state -
            // the build is on its way out, and the bar advancing again would say otherwise.
            if (this.snapshot.phase === "preparing" && !this.snapshot.cancelling) {
              this.publish(preparing(stage, false, transfer));
            }
          },
        });
        if (outcome.ok) {
          let retained = false;
          try {
            const sourceProblem = sourceCommitProblem(offer.releaseTag, this.identify(outcome.staged.bundlePath).commit ?? null);
            if (sourceProblem) throw new UpdateError(sourceProblem);
            if (abort.signal.aborted) {
              this.publish(offer);
              return false;
            }
            const descriptor = outcome.descriptor;
            const found = this.identify(outcome.staged.bundlePath);
            if (!descriptor || descriptor.receipt.kind !== "binary" ||
                JSON.stringify(descriptor.receipt.provenance.manifest) !== JSON.stringify(binary.manifest) ||
                descriptor.receipt.provenance.manifestSha256 !== binary.manifestSha256 ||
                descriptor.bundle !== outcome.staged.bundlePath || descriptor.revision !== outcome.staged.revision ||
                found.revision !== descriptor.revision || found.version !== binary.manifest.version || found.commit !== binary.manifest.commit) {
              throw new UpdateError("The prepared binary no longer matches the accepted build. Check again to retry.");
            }
            this.descriptor = descriptor;
            this.staged = {
              binary,
              releaseTag: offer.releaseTag,
              version: outcome.staged.version,
              bundlePath: outcome.staged.bundlePath,
              revision: descriptor.revision,
            };
            this.refreshMigration();
            this.publish(ready());
            retained = true;
            return true;
          } finally {
            if (!retained) {
              this.staged = null; this.descriptor = null; this.migration = null;
              try { await this.port.discard?.(outcome.descriptor); }
              catch (error) { this.port.log(`could not remove abandoned binary: ${String(error)}`); }
            }
          }
        }
        if (outcome.reason === "cancelled") {
          this.publish(offer);
          return false;
        }
        throw new UpdateError(outcome.message);
      } catch (error) {
        if (abort.signal.aborted) { this.publish(offer); return false; }
        return await this.reportFailure("binary update preparation failed", offer, error);
      } finally {
        this.applyPromise = null;
        if (this.preparation === abort) this.preparation = null;
      }
    })();
    return this.applyPromise;
  }

  /**
   * "Restart and Install": the only part of an update that needs this process gone.
   *
   * The helper waits for the exit, swaps the bundle it is handed, writes the receipt, and
   * relaunches - seconds of work, against the minutes that used to happen here.
   */
  install(): Promise<boolean> {
    if (this.policyPending) return Promise.resolve(false);
    if (this.installPromise) return this.installPromise;
    if (this.snapshot.phase !== "ready" || !this.receipt) return Promise.resolve(false);
    const target = this.snapshot;
    // Read again here, and not only at startup. An update prepared hours ago is installed by a
    // helper that swaps whatever `receipt.appPath` names, and between those two moments another
    // install can rewrite the receipt or replace a bundle. A stale answer would send the helper
    // to swap a bundle this process is not.
    //
    // The receipt the handoff uses is taken FROM this reading rather than left at the value
    // startup stored. Validating one receipt and then handing the helper another is the exact
    // incoherence the single snapshot exists to remove.
    const installed = this.port.installSnapshot();
    const reason = updateIneligibility(installed);
    if (reason) {
      this.publish({
        phase: "error",
        currentVersion: target.currentVersion,
        message: reason,
        manual: true,
        retryable: false,
        lastOutcome: target.lastOutcome,
      });
      return Promise.resolve(false);
    }
    this.receipt = installed.receipt;
    // A prepared rename changes only the basename. Require its recorded plan;
    // a new destination or scope still needs a fresh preparation.
    const plannedRename = this.migration?.protocol === 3 && this.migration.kind === "rename" &&
      this.migration.source === this.receipt!.appPath && this.migration.target === this.descriptor?.receipt.appPath &&
      this.migration.source === join(dirname(this.migration.target), LEGACY_APP_BUNDLE_NAME) &&
      this.migration.target === join(dirname(this.migration.source), APP_BUNDLE_NAME);
    if (this.descriptor && ((this.descriptor.receipt.appPath !== this.receipt!.appPath && !plannedRename) || this.descriptor.receipt.installScope !== this.receipt!.installScope)) {
      return this.reportFailure("installation destination changed", target, new UpdateError("The installation destination or scope changed after preparation. Check for updates again."));
    }
    const staged = this.staged;
    if (!staged || staged.releaseTag !== target.releaseTag) return Promise.resolve(false);
    // A deferred candidate can be removed or replaced. Refuse it before requesting quit.
    if (!this.stagedBundleIsIntact(staged)) {
      this.staged = null;
      this.publish({
        phase: "error",
        currentVersion: target.currentVersion,
        message: `The prepared Mission Control ${staged.version} is no longer there to install. Check for updates again to prepare it once more.`,
        manual: true,
        retryable: true,
        lastOutcome: target.lastOutcome,
      });
      return Promise.resolve(false);
    }
    // The revision travels with the path. This app's check above is the last one it can make -
    // the swap happens after it has quit - so the install script gets what to compare against.
    try {
      if (this.migration && receiptDigest(this.receipt!) !== receiptDigest(this.migration.oldReceipt)) throw new Error("The installation policy changed after preparation. Check for updates again.");
      this.refreshMigration();
    } catch (error) { return this.reportFailure("migration preflight failed", target, error); }
    this.installPromise = this.handOff(target, staged.bundlePath, staged.revision).finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  /**
   * Ask the port what is at a path, and never throw at the caller.
   *
   * Every caller sits somewhere a throw would be worse than an answer. `stagedBundleIsIntact`
   * is evaluated OUTSIDE a try by both of its callers - the reuse shortcut runs before
   * `apply()`'s async body exists, and `install()` runs before `installPromise` is assigned -
   * so an escape would reject an IPC call with the snapshot still reading `ready`, leaving no
   * dialog, no banner error, and nothing for the person to act on. Recording the revision after
   * a successful build sits INSIDE that try, where an escape is worse in the other direction:
   * it would report a build that actually succeeded as a failure.
   *
   * `statSync` is what makes this real rather than defensive. `throwIfNoEntry: false` suppresses
   * only ENOENT; EACCES on a parent directory and ELOOP on a replaced symlink still throw.
   * Unidentifiable is treated as "not the bundle I built", which is what null already means.
   */
  private identify(bundlePath: string): StagedBundleIdentity {
    try {
      return this.port.stagedBundleIdentity(bundlePath);
    } catch (error) {
      this.port.log(
        `could not identify the prepared update: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { version: null, revision: null };
    }
  }

  /** Same revision, version and signed commit; handoff revalidates the full bytes. */
  private stagedBundleIsIntact(staged: {
    releaseTag: string;
    version: string;
    bundlePath: string;
    revision: string | null;
  }): boolean {
    const found = this.identify(staged.bundlePath);
    if (sourceCommitProblem(staged.releaseTag, found.commit ?? null)) return false;
    if (this.descriptor?.receipt.kind === "binary" && found.commit !== this.descriptor.receipt.installedCommit) return false;
    if (found.version === null) return false;
    if (found.version !== staged.version) return false;
    // A port that cannot produce a revision (an unreadable directory) fails closed rather than
    // letting the version alone stand in for identity.
    return found.revision !== null && found.revision === staged.revision;
  }

  /** Retry remains unavailable until the worker acknowledges cancellation and exits. */
  cancel(): void {
    if (this.snapshot.phase !== "preparing" || this.snapshot.cancelling) return;
    this.publish({ ...this.snapshot, cancelling: true });
    this.preparation?.abort();
  }

  /** The copied helper owns replacement only after acknowledging the accepted descriptor. */
  private async handOff(
    target: {
      currentVersion: string;
      newVersion: string;
      releaseTag: string;
      lastOutcome: UpdateApplyOutcome | null;
    },
    stagedBundle: string | null,
    stagedRevision: string | null = null,
  ): Promise<boolean> {
    this.publish({
      phase: "applying",
      currentVersion: target.currentVersion,
      newVersion: target.newVersion,
      stage: "starting",
      lastOutcome: target.lastOutcome,
    });
    try {
      if (!stagedBundle || !stagedRevision || !this.descriptor) throw new UpdateError("The accepted binary is missing. Check again to retry.");
      try {
        await this.port.launchPreflight(this.receipt!.appPath);
        if (this.migration) await this.port.launchPreflight(this.migration.target);
      } catch (error) {
        throw new UpdateError(error instanceof Error ? error.message : "Could not verify macOS launch state.");
      }
      await this.port.handoff({
        descriptor: this.descriptor,
        receipt: this.receipt!,
        helperSource: this.port.helperSource(),
        targetTag: target.releaseTag,
        appPath: this.receipt!.appPath,
        parentPid: process.pid,
        stateDirectory: this.port.stateDirectory(),
        logPath: join(this.port.stateDirectory(), "update.log"),
        stagedBundle,
        stagedRevision,
        ...(this.migration ? {migration: this.migration, migrationInventory: this.port.migrationInventory?.(this.migration)} : {}),
      });
      this.publish({
        phase: "applying",
        currentVersion: target.currentVersion,
        newVersion: target.newVersion,
        stage: "handed-off",
        lastOutcome: target.lastOutcome,
      });
      this.port.requestQuit();
      return true;
    } catch (error) {
      return await this.reportFailure("update handoff failed", target, error);
    }
  }

  /**
   * How an update failure becomes something a person sees. One owner, because there is one
   * protocol.
   *
   * Both halves of an accepted update can fail - the build that runs while the app is open,
   * and the handoff that follows the restart - and both answer the same way: log what actually
   * went wrong, publish a retryable error snapshot the banner can act on, and say so in a
   * dialog for whoever started this from the menu bar. Splitting `apply()` in two is what made
   * it possible to write that twice; the two copies had already begun to differ in nothing but
   * their log prefix, which is exactly the shape a later divergence would take.
   *
   * `what` is that prefix, and it is the only thing the callers get to vary beyond the context
   * a failure is reported against. Returns false so a caller can `return await` it.
   */
  private async reportFailure(
    what: string,
    context: { currentVersion: string; lastOutcome: UpdateApplyOutcome | null },
    error: unknown,
  ): Promise<false> {
    const safe = safeUpdateError(
      what.includes("migration") || what.includes("preference") || what.includes("repair")
        ? new UpdateError("The installation change could not finish. Check the update log and try again.")
        : error,
    );
    // The real message goes to the log, where absolute paths and credentials are redacted;
    // the safe one goes to the person.
    this.port.log(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    this.publish({
      phase: "error",
      currentVersion: context.currentVersion,
      message: safe.message,
      manual: true,
      retryable: safe.retryable,
      lastOutcome: context.lastOutcome,
    });
    await this.port.dialogs.error(safe.message);
    return false;
  }

  private refreshMigration(): void {
    this.migration = this.receipt && this.staged?.revision
      ? this.port.migrationPlan?.(this.receipt, this.staged.bundlePath, this.staged.revision, this.descriptor ?? undefined) ?? null : null;
  }

  keepSystem(): Promise<boolean> {
    if (this.systemPromise) return this.systemPromise;
    if (this.installPromise || this.snapshot.phase !== "ready" || !this.migration || this.migration.kind === "rename" || !this.port.keepSystem) return Promise.resolve(false);
    const target = this.snapshot;
    const plan = this.migration;
    this.policyPending = true;
    this.systemPromise = (async () => {
      try {
        this.receipt = await this.port.keepSystem!(plan);
        if (this.descriptor) this.descriptor = {...this.descriptor, receipt: {...this.descriptor.receipt, installScope: this.receipt.installScope}};
        this.migration = null;
        this.publish({...target, migration: undefined});
        this.policyPending = false;
        return await this.install();
      } catch (error) { return this.reportFailure("system installation preference failed", target, error); }
      finally { this.policyPending = false; }
    })().finally(() => { this.systemPromise = null; });
    return this.systemPromise;
  }

  retryMigrationRepair(confirmLogin = false): Promise<void> {
    if (this.repairPromise) return this.repairPromise;
    const previous = this.snapshot;
    this.repairPromise = (async () => {
      try {
        await this.port.repairMigration?.(confirmLogin);
        this.publish(this.snapshot === previous && previous.phase === "error"
          ? idleSnapshot(this.currentLabel(), previous.lastOutcome, null)
          : this.snapshot);
      } catch (error) {
        await this.reportFailure("integration repair failed", {currentVersion: this.currentLabel(), lastOutcome: this.snapshot.lastOutcome}, error);
      }
    })().finally(() => { this.repairPromise = null; });
    return this.repairPromise;
  }

  /** The native half of the ready state: ask for the restart, then do it. */
  private async confirmReady(version: string): Promise<void> {
    let choice: "install" | "defer" | "system";
    this.releaseDecisionPending = true;
    try {
      choice = await this.port.dialogs.ready(version, this.snapshot.migration);
    } finally {
      this.releaseDecisionPending = false;
    }
    if (choice === "install") await this.install();
    else if (choice === "system") await this.keepSystem();
    else this.defer();
  }

  /**
   * "Later", from either the offer or a prepared update.
   *
   * A deferred build is kept rather than thrown away, so accepting it later is immediate.
   * Automatic reminders for this exact target stay quiet for 48 hours across app restarts.
   */
  defer(): void {
    if (this.policyPending) return;
    if (this.snapshot.phase === "available" || this.snapshot.phase === "ready") {
      const now = this.port.now();
      this.snoozedUntil = {
        ...Object.fromEntries(Object.entries(this.snoozedUntil).filter(([, until]) => until > now)),
        [this.snapshot.releaseTag]: now + UPDATE_SNOOZE_MS,
      };
      try { this.port.writeSnoozes(this.snoozedUntil); }
      catch (error) {
        // A disk error must not undo the dismissal for the running app.
        this.port.log(`could not save update snooze: ${String(error)}`);
      }
    }
    if (this.snapshot.phase === "available") {
      this.publish(
        idleSnapshot(this.snapshot.currentVersion, this.snapshot.lastOutcome, this.snapshot.checkedAt),
      );
      return;
    }
    if (this.snapshot.phase === "ready") {
      this.publish(
        idleSnapshot(this.snapshot.currentVersion, this.snapshot.lastOutcome, this.snapshot.stagedAt),
      );
    }
  }
}

export function createDefaultUpdaterPort(options: {
  packaged: boolean;
  currentVersion: () => string;
  currentCommit: () => string | null;
  /** Re-read on every call: the receipt and both bundles can change while the app is open. */
  installSnapshot: () => InstallSnapshot;
  arch?: string;
  helperSource: string;
  stateDirectory: string;
  requestQuit: () => void;
  dialogs: UpdateDialogs;
  migrationInventory?: (plan: MigrationPlan) => unknown;
  repairMigration?: (confirmLogin?: boolean) => Promise<void>;
}): UpdaterPort {
  const preferencesPath = join(options.stateDirectory, "update-preferences.json");
  const logPath = join(options.stateDirectory, "update.log");
  const log = createRotatingUpdateLogger(logPath);
  return {
    migrationPlan: (receipt, stagedBundle, stagedRevision, descriptor) => descriptor && descriptor.receipt.appPath !== receipt.appPath
      ? prepareInPlaceInstall({descriptor, stateDirectory: options.stateDirectory})
      : prepareMigration({receipt, stagedBundle, stagedRevision, descriptor, stateDirectory: options.stateDirectory}),
    migrationInventory: options.migrationInventory,
    keepSystem: keepSystemInstallation,
    repairMigration: options.repairMigration,
    migrationStatus: () => {
      const journal = readMigrationJournal(options.stateDirectory);
      if (!journal || journal.plan.kind === "in-place" || !["receipt-committed", "repair-required", "complete"].includes(journal.stage)) return undefined;
      return {kind: journal.plan.kind === "rename" ? "rename" as const : undefined, source: journal.plan.source, target: journal.plan.target, status: journal.stage === "complete" ? "complete" : "repair-required", repairs: journal.repairs.filter((item) => item.status === "pending")};
    },
    packaged: options.packaged,
    arch: options.arch ?? process.arch,
    currentVersion: options.currentVersion,
    currentCommit: options.currentCommit,
    installSnapshot: options.installSnapshot,
    readAlpha: () => readUpdatePreferences(preferencesPath).alpha,
    writeAlpha: (alpha) => { writeUpdatePreferences(preferencesPath, { ...readUpdatePreferences(preferencesPath), alpha }); },
    readSnoozes: () => readUpdatePreferences(preferencesPath).snoozedUntil,
    writeSnoozes: (snoozedUntil) => { writeUpdatePreferences(preferencesPath, { ...readUpdatePreferences(preferencesPath), snoozedUntil }); },
    latestRelease: () => latestStableBinary(runGh, options.currentVersion()),
    binaryForCommit: (commit) => binaryForCommit(runGh, commit),
    discard: (descriptor) => discardBinaryUpdate(descriptor, options.stateDirectory),
    latestMainCommit: () => latestMainCommit(runGh),
    helperSource: () => options.helperSource,
    stateDirectory: () => options.stateDirectory,
    launchPreflight: (bundle) => assertSafeAppLaunch(bundle),
    handoff: (args) =>
      spawnDetachedUpdateHelper({ ...args, helperSource: options.helperSource, logPath }),
    stage: async (request) => {
      const gh = await locateExecutable("gh");
      if (!gh) throw new UpdateError("GitHub CLI (gh) is not installed. Install gh, then check again.", true, "gh-missing");
      return stageBinaryUpdate(request, {worker: join(dirname(dirname(options.helperSource)), "dist/main/update-binary-worker.cjs"),
        stateDirectory: options.stateDirectory, gh: gh.path, env: gh.env, log});
    },
    stagedBundleIdentity: (path) => {
      // `mtimeMs` and the inode together: electron-builder removes and recreates this
      // directory, so a rebuild changes both, while a bundle sitting untouched for hours
      // changes neither.
      //
      // Wrapped, because `throwIfNoEntry: false` suppresses only ENOENT. EACCES on a parent
      // directory and ELOOP on a replaced symlink still throw, and this runs on the path that
      // builds `install()`'s promise - an escape would reject the IPC call with the snapshot
      // still reading `ready`, leaving no banner error and no way forward. Unreadable is
      // "not the bundle I built", which is what the callers already do with null.
      let stats;
      try {
        stats = statSync(path, { throwIfNoEntry: false });
      } catch {
        return { version: null, revision: null };
      }
      if (!stats?.isDirectory()) return { version: null, revision: null };
      return {
        version: bundleShortVersion(path),
        commit: appSourceCommit(join(path, "Contents", "Resources", "app")),
        // One formula, shared with the install script that checks it again before the swap.
        revision: stagedBundleRevision(stats),
      };
    },
    requestQuit: options.requestQuit,
    readOutcome: async () => {
      const outcome = await readSettledUpdateOutcome(options.stateDirectory);
      try { await cleanupSettledBinaryDownloads(options.stateDirectory); }
      catch (error) { log(`binary download cleanup retained material: ${String(error)}`); }
      return outcome;
    },
    clearOutcome: (expected) => clearUpdateOutcome(updateOutcomePath(options.stateDirectory), expected),
    now: Date.now,
    random: Math.random,
    log,
    dialogs: options.dialogs,
  };
}
