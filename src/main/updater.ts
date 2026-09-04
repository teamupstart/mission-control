import { execFile, spawn } from "node:child_process";
import { closeSync, copyFileSync, openSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CANONICAL_REPO,
  isTrustedInstallRepo,
} from "../shared/install-receipt-schema.mjs";
import { readReceipt } from "../shared/install-receipt.mjs";
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
import { loginShellPath } from "../server/util/path-env.ts";
import { bundleShortVersion } from "./bundle-version.ts";
import { createRotatingUpdateLogger } from "./update-log.ts";
import { clearUpdateOutcome, readUpdateOutcome, updateOutcomePath } from "./update-outcome.ts";
import { findSystemNode } from "./system-node.ts";
import {
  stageUpdateBuild,
  updateChildEnvironment,
  type StageOutcome,
} from "./update-build.ts";

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
const MAX_RELEASE_NOTES = 4_000;

export interface ReleaseInfo {
  tagName: string;
  name: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  body: string;
}

export interface UpdateDialogs {
  available(release: {
    currentVersion: string;
    newVersion: string;
    name: string;
    notes: string;
  }): Promise<"apply" | "defer">;
  upToDate(version: string): Promise<void>;
  /** A build is already running, with the stage it last reached. */
  preparing(version: string, stage: string): Promise<void>;
  /** Built, verified, and waiting: the only remaining question is whether to restart now. */
  ready(version: string): Promise<"install" | "defer">;
  applying(version: string): Promise<void>;
  error(message: string): Promise<void>;
  outcome(outcome: UpdateApplyOutcome): Promise<void>;
}

export interface HelperHandoff {
  node: string;
  helperSource: string;
  sourceClone: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
  /**
   * The bundle this app already built and verified, or null to let the helper build it.
   *
   * Null is the older path, and it is still reachable: a clone whose install script predates
   * `--stage-only` cannot stage, and an update is better applied blind than not at all.
   */
  stagedBundle: string | null;
  /**
   * What that bundle was when it was verified, for the install script to check again.
   *
   * The app's own check happens before it quits, and the swap happens up to two minutes later
   * in another process - long enough for a rebuild of the shared clone to land in between. The
   * token travels so the last reader before the swap can refuse a bundle that changed.
   */
  stagedRevision: string | null;
}

/**
 * What is at a staged bundle's path right now.
 *
 * Both fields are null when nothing is there. `revision` changes whenever the bundle directory
 * is replaced, which is what separates "the build I made" from "a build that happens to carry
 * the same version" - the updater-owned clone is shared, and `npm run package` inside it
 * removes and recreates this directory.
 */
export interface StagedBundleIdentity {
  /** CFBundleShortVersionString of the bundle now at that path. */
  version: string | null;
  /** An opaque token that changes when the bundle is rebuilt or replaced. */
  revision: string | null;
}

/** What the controller asks of a staged build; the port supplies the node binary and log. */
export interface UpdateStageRequest {
  sourceClone: string;
  targetTag: string;
  signal: AbortSignal;
  onStage(stage: UpdatePrepareStage): void;
}

export interface UpdaterPort {
  packaged: boolean;
  arch: string;
  currentVersion(): string;
  readReceipt(): InstallReceipt | null;
  latestRelease(): Promise<ReleaseInfo | null>;
  systemNode(): string | null;
  helperSource(): string;
  stateDirectory(): string;
  handoff(args: HelperHandoff): Promise<void>;
  stage(request: UpdateStageRequest): Promise<StageOutcome>;
  /** What is at a staged bundle's path now, so a caller can tell it is still the same build. */
  stagedBundleIdentity(path: string): StagedBundleIdentity;
  requestQuit(): void;
  readOutcome(): UpdateApplyOutcome | null;
  clearOutcome(): void;
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

function ghFailure(result: CommandResult): UpdateError {
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
      "GitHub's API rate limit is reached, so releases cannot be checked right now. It resets within the hour and Mission Control will check again on its own.",
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
  return new UpdateError(`GitHub CLI cannot list releases here (exit ${result.code}). Try again.`);
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

export function runGh(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, PATH: loginShellPath() },
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
  return [helperSource, join(dirname(helperSource), "app-bundle-swap.mjs")];
}

export async function spawnDetachedUpdateHelper(args: HelperHandoff): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mission-control-update-"));
  try {
    const helper = join(directory, basename(args.helperSource));
    for (const source of detachedUpdateHelperSources(args.helperSource)) {
      copyFileSync(source, join(directory, basename(source)));
    }
    const logFd = openSync(args.logPath, "a", 0o600);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          args.node,
          [
            helper,
            "--source-clone",
            args.sourceClone,
            "--target-tag",
            args.targetTag,
            "--app-path",
            args.appPath,
            "--parent-pid",
            String(args.parentPid),
            "--state-dir",
            args.stateDirectory,
            "--log-path",
            args.logPath,
            ...(args.stagedBundle ? ["--staged-bundle", args.stagedBundle] : []),
            ...(args.stagedBundle && args.stagedRevision
              ? ["--staged-revision", args.stagedRevision]
              : []),
          ],
          {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: updateChildEnvironment(),
          },
        );
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    } finally {
      closeSync(logFd);
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
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
  return error instanceof UpdateError
    ? { message: error.message, retryable: error.retryable, kind: error.kind }
    : {
        message: "The update check failed unexpectedly. Check the update log and try again.",
        retryable: true,
        kind: "gh-failed",
      };
}

export class UpdateController {
  private snapshot: UpdateSnapshot;
  private receipt: InstallReceipt | null = null;
  private node: string | null = null;
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
  /**
   * The verified bundle this app built, kept across a deferral.
   *
   * Someone who prepares an update and then chooses Later has already paid for the build;
   * offering to spend those minutes again when they come back would be the same insult as
   * the closed window this whole path replaces. Pinned to the release tag it was built from,
   * so a newer release never installs the previous one's bundle.
   */
  private staged: {
    releaseTag: string;
    version: string;
    bundlePath: string;
    revision: string | null;
  } | null = null;
  private preparation: AbortController | null = null;

  constructor(private readonly port: UpdaterPort) {
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
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
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

    let lastOutcome = this.port.readOutcome();
    if (lastOutcome?.result === "in-progress") {
      lastOutcome = {
        result: "failure",
        targetVersion: lastOutcome.targetVersion,
        recordedAt: lastOutcome.recordedAt,
        message: "The previous update did not finish. The existing app was left in place.",
      };
    }
    const disable = (reason: string) => this.publish({ phase: "disabled", reason, lastOutcome });
    if (this.port.arch !== "arm64") disable("Updates require an Apple silicon Mac.");
    else {
      this.receipt = this.port.readReceipt();
      if (!this.receipt) disable("This app was not installed with the managed install command.");
      else if (!isTrustedInstallRepo(this.receipt.repo)) {
        disable(`Updates are disabled because this app was installed from ${this.receipt.repo}.`);
      } else {
        this.node = this.port.systemNode();
        if (!this.node) disable("A system Node.js installation is required to apply updates.");
        else {
          this.lastBackgroundAttempt = this.port.now();
          this.publish(idleSnapshot(this.port.currentVersion(), lastOutcome, null));
        }
      }
    }

    if (lastOutcome) {
      try {
        await this.port.dialogs.outcome(lastOutcome);
        this.port.clearOutcome();
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
        this.schedule(RECHECK_MS + Math.floor(this.port.random() * RECHECK_JITTER_MS));
      });
    }, delay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The build runs in its own process group so that this reaches npm and electron-builder
    // too. An abandoned build would go on writing into the clone that the next attempt is
    // about to check out.
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
      this.port.now() - this.lastBackgroundAttempt >= RECHECK_MS
    ) {
      this.lastBackgroundAttempt = this.port.now();
      void this.check(false);
    }
  }

  check(manual: boolean): Promise<UpdateSnapshot> {
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
    const currentVersion = this.port.currentVersion();
    this.lastBackgroundAttempt = this.port.now();
    const lastOutcome = this.snapshot.lastOutcome;
    this.publish({ phase: "checking", currentVersion, manual, lastOutcome });
    this.checkPromise = (async () => {
      try {
        const release = await this.port.latestRelease();
        const checkedAt = this.port.now();
        const newVersion = release ? versionFromReleaseTag(release.tagName) : null;
        if (!release || !newVersion || !isNewerVersion(currentVersion, newVersion)) {
          return this.publish({ phase: "up-to-date", currentVersion, checkedAt, lastOutcome });
        }
        return this.publish({
          phase: "available",
          currentVersion,
          newVersion,
          releaseTag: release.tagName,
          releaseName: sanitizeReleaseNotes(release.name || release.tagName).slice(0, 200),
          releaseNotes: sanitizeReleaseNotes(release.body),
          publishedAt: release.publishedAt,
          checkedAt,
          lastOutcome,
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
      const { label } = updatePrepareProgress(this.snapshot.stage);
      const version = this.snapshot.newVersion;
      return this.port.dialogs.preparing(version, label).then(() => this.snapshot);
    }
    if (this.commandPromise) return this.commandPromise;
    this.commandPromise = (async () => {
      const snapshot = await this.check(true);
      switch (snapshot.phase) {
        case "available": {
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
          // The build has finished by the time apply() resolves, so this is the second half of
          // the same conversation rather than a new one: it asks for the restart the person
          // has now earned, in the same place they asked for the update.
          if (this.snapshot.phase === "ready") await this.confirmReady(this.snapshot.newVersion);
          return this.snapshot;
        }
        case "ready":
          await this.confirmReady(snapshot.newVersion);
          return this.snapshot;
        case "preparing": {
          const { label } = updatePrepareProgress(snapshot.stage);
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

  /**
   * "Update Now": build the new version while this app stays open.
   *
   * This used to be the whole update - hand off to a detached helper and quit immediately -
   * and that is what made a normal update look like a failure. Everything long happens here
   * now, in front of a person, and the app is still running to say so. The quit is deferred
   * to `install()`, where it costs seconds.
   */
  apply(): Promise<boolean> {
    if (this.applyPromise) return this.applyPromise;
    if (this.snapshot.phase !== "available" || !this.receipt || !this.node) {
      return Promise.resolve(false);
    }
    const offer = this.snapshot;
    const lastOutcome = offer.lastOutcome;
    const preparing = (stage: UpdatePrepareStage, cancelling = false): UpdateSnapshot => ({
      phase: "preparing",
      currentVersion: offer.currentVersion,
      newVersion: offer.newVersion,
      releaseTag: offer.releaseTag,
      stage,
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
    });

    // Already built, still there, and still the same build. Reached by preparing an update,
    // choosing Later, and coming back to it - the minutes were already spent, so this goes
    // straight to the offer to restart. Anything else falls through and rebuilds.
    if (
      this.staged?.releaseTag === offer.releaseTag &&
      this.stagedBundleIsIntact(this.staged)
    ) {
      this.publish(ready());
      return Promise.resolve(true);
    }

    this.staged = null;
    const abort = new AbortController();
    this.preparation = abort;
    this.publish(preparing("starting"));
    this.applyPromise = (async () => {
      try {
        const outcome = await this.port.stage({
          sourceClone: this.receipt!.sourceClone,
          targetTag: offer.releaseTag,
          signal: abort.signal,
          // Guarded on the phase rather than published blindly: a cancellation or a failure
          // has already moved the snapshot on, and a late stage line must not drag it back
          // into a build that is over.
          onStage: (stage) => {
            // A stage arriving after Cancel was pressed must not undo the cancelling state -
            // the build is on its way out, and the bar advancing again would say otherwise.
            if (this.snapshot.phase === "preparing" && !this.snapshot.cancelling) {
              this.publish(preparing(stage));
            }
          },
        });
        if (outcome.ok) {
          // A build this app cannot pin is not staged at all.
          //
          // The pin has to come from the install script, which reads it in the same breath as
          // it verifies the bundle. Reading it here instead - after that process has exited -
          // would pin whatever is on disk by now, and anything that rebuilt the shared clone in
          // between would be pinned and installed as though it had been verified. A clone whose
          // script predates the field cannot answer, so rather than inventing a pin, the whole
          // install goes to the detached helper: no progress bar, and no claim about a bundle
          // nobody checked.
          if (outcome.staged.revision === null) {
            this.port.log(
              "the installed version's install script reports no bundle identity; handing the whole install to the detached helper rather than pinning one after the fact",
            );
            return await this.handOff(offer, null);
          }
          // Whatever the install script saw at the instant it verified this bundle, not
          // whatever is there now.
          const disk = this.identify(outcome.staged.bundlePath);
          const pinned = outcome.staged.revision;
          // Settled HERE rather than at the restart. A build that cannot be pinned, or that
          // has already been replaced, is not something to call ready: the person would spend
          // the minutes, be told it is ready, press Restart and Install, and only then be sent
          // back to rebuild. Saying so now costs them one retry instead of two waits.
          if (pinned === null || disk.revision !== pinned || disk.version !== outcome.staged.version) {
            throw new UpdateError(
              "The new version was replaced while it was being prepared, so it was not installed. Check for updates again to prepare it once more.",
            );
          }
          this.staged = {
            releaseTag: offer.releaseTag,
            version: outcome.staged.version,
            bundlePath: outcome.staged.bundlePath,
            revision: pinned,
          };
          this.publish(ready());
          return true;
        }
        if (outcome.reason === "cancelled") {
          this.publish(offer);
          return false;
        }
        if (outcome.reason === "unsupported") {
          // The clone's install script has no `--stage-only`, which means the installed
          // version predates staging. The old single-shot handoff still applies the update;
          // it just cannot show progress, which is exactly the version being replaced.
          this.port.log(
            "the installed version cannot build an update in the background; handing the whole install to the detached helper",
          );
          return await this.handOff(offer, null);
        }
        throw new UpdateError(outcome.message);
      } catch (error) {
        return await this.reportFailure("update build failed", offer, error);
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
    if (this.installPromise) return this.installPromise;
    if (this.snapshot.phase !== "ready" || !this.receipt) return Promise.resolve(false);
    const target = this.snapshot;
    const staged = this.staged;
    if (!staged || staged.releaseTag !== target.releaseTag) return Promise.resolve(false);
    // Checked again here, not only when it was built. A person can leave an update ready for
    // hours, and in that time the shared clone can be cleaned, or rebuilt at another ref -
    // which would otherwise send the helper off to swap a bundle that is missing, or worse,
    // one that is a different version than the person accepted. Both are refused here, before
    // the app quits, and the install script refuses a version mismatch again on its own.
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

  /**
   * Whether the bundle at the staged path is still the one this app built for this release.
   *
   * Existence is not enough, and that was the hole: the path lives in the updater-owned clone,
   * which is shared. Anything that rebuilds that clone between preparation and the restart -
   * an operator running `make install ARGS="--ref ..."`, an older helper finishing late -
   * leaves a perfectly valid app at the same path, and installing it would put a version
   * nobody accepted into /Applications under a receipt naming the tag they did accept.
   *
   * So the version has to match what was built, and the revision has to match too: a rebuild
   * at the same version is still not the bundle whose contents were verified.
   */
  private stagedBundleIsIntact(staged: {
    releaseTag: string;
    version: string;
    bundlePath: string;
    revision: string | null;
  }): boolean {
    const found = this.identify(staged.bundlePath);
    if (found.version === null) return false;
    if (found.version !== staged.version) return false;
    // A port that cannot produce a revision (an unreadable directory) fails closed rather than
    // letting the version alone stand in for identity.
    return found.revision !== null && found.revision === staged.revision;
  }

  /**
   * Stop a build in progress and return to the offer that started it.
   *
   * The offer comes back when the build's process group is actually gone, not when the signal
   * is sent: `npm` and `electron-builder` write into the shared clone, and the next preparation
   * force-checks-out and reinstalls in that same directory. Until then the phase stays
   * `preparing` with `cancelling` set - so the banner stops offering a Cancel that has already
   * been pressed, and `applyPromise` keeps a second build from starting.
   */
  cancel(): void {
    if (this.snapshot.phase !== "preparing" || this.snapshot.cancelling) return;
    this.publish({ ...this.snapshot, cancelling: true });
    this.preparation?.abort();
  }

  /**
   * Start the detached helper and quit, which is where every update ends.
   *
   * `stagedBundle` decides how much the helper still has to do: swap a bundle this app already
   * built and verified, or build one itself.
   */
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
      const node = this.port.systemNode();
      if (!node) throw new UpdateError("A system Node.js installation is required to apply updates.");
      await this.port.handoff({
        node,
        helperSource: this.port.helperSource(),
        sourceClone: this.receipt!.sourceClone,
        targetTag: target.releaseTag,
        appPath: this.receipt!.appPath,
        parentPid: process.pid,
        stateDirectory: this.port.stateDirectory(),
        logPath: join(this.port.stateDirectory(), "update.log"),
        stagedBundle,
        stagedRevision,
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
    const safe = safeUpdateError(error);
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

  /** The native half of the ready state: ask for the restart, then do it. */
  private async confirmReady(version: string): Promise<void> {
    let choice: "install" | "defer";
    this.releaseDecisionPending = true;
    try {
      choice = await this.port.dialogs.ready(version);
    } finally {
      this.releaseDecisionPending = false;
    }
    if (choice === "install") await this.install();
    else this.defer();
  }

  /**
   * "Later", from either the offer or a prepared update.
   *
   * A deferred build is kept rather than thrown away, so accepting it later is immediate.
   */
  defer(): void {
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
  arch?: string;
  helperSource: string;
  stateDirectory: string;
  requestQuit: () => void;
  dialogs: UpdateDialogs;
}): UpdaterPort {
  const logPath = join(options.stateDirectory, "update.log");
  const log = createRotatingUpdateLogger(logPath);
  return {
    packaged: options.packaged,
    arch: options.arch ?? process.arch,
    currentVersion: options.currentVersion,
    readReceipt,
    latestRelease: () => latestStableRelease(runGh),
    systemNode: findSystemNode,
    helperSource: () => options.helperSource,
    stateDirectory: () => options.stateDirectory,
    handoff: (args) =>
      spawnDetachedUpdateHelper({ ...args, helperSource: options.helperSource, logPath }),
    stage: async (request) => {
      // Electron's own executable cannot run npm, and a managed install already proved a
      // system Node.js exists - this only re-reads it, because PATH can change under a
      // long-running app.
      const node = findSystemNode();
      if (!node) {
        return {
          ok: false,
          reason: "failed",
          message: "A system Node.js installation is required to apply updates.",
        };
      }
      return stageUpdateBuild({ ...request, node, log });
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
        // One formula, shared with the install script that checks it again before the swap.
        revision: stagedBundleRevision(stats),
      };
    },
    requestQuit: options.requestQuit,
    readOutcome: () => readUpdateOutcome(updateOutcomePath(options.stateDirectory)),
    clearOutcome: () => clearUpdateOutcome(updateOutcomePath(options.stateDirectory)),
    now: Date.now,
    random: Math.random,
    log,
    dialogs: options.dialogs,
  };
}
