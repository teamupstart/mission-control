import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CANONICAL_REPO } from "../shared/install-receipt-schema.mjs";
import { readReceipt } from "../shared/install-receipt.mjs";
import type { InstallReceipt } from "../shared/install-receipt-schema.mjs";
import {
  isNewerVersion,
  versionFromReleaseTag,
  type UpdateApplyOutcome,
  type UpdateSnapshot,
} from "../shared/update.ts";
import { loginShellPath } from "./path-env.ts";
import { clearUpdateOutcome, readUpdateOutcome, updateOutcomePath } from "./update-outcome.ts";
import { findSystemNode } from "./system-node.ts";

const FIRST_CHECK_MIN_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 60_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;
const RECHECK_JITTER_MS = 15 * 60 * 1000;
const MAX_RELEASE_NOTES = 4_000;
const MAX_LOG_BYTES = 1_000_000;

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
  // Rate limiting first. GitHub's own 403 body reads "higher rate limits apply to authenticated
  // requests", so an auth test run first would claim a working credential had lapsed.
  if (/rate limit|HTTP 403|HTTP 429|abuse detection/i.test(detail)) {
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length > MAX_RELEASE_NOTES
    ? `${plain.slice(0, MAX_RELEASE_NOTES - 1).trimEnd()}…`
    : plain;
}

/** Remove credentials and absolute paths before update diagnostics reach disk or UI. */
export function sanitizeLogLine(line: string): string {
  return line
    .replace(/Authorization\s*:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: <redacted>")
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/\b(token|access_token|auth)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>")
    .replace(/\bfile:\/\/\/[^\s"')]+/g, "file://<path>")
    .replace(/(^|[\s"'(=])\/(?:[^\s"'),]+\/?)+/g, "$1<path>");
}

export function createRotatingUpdateLogger(path: string): (line: string) => void {
  return (line: string) => {
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      if (statSync(path, { throwIfNoEntry: false })?.size && statSync(path).size >= MAX_LOG_BYTES) {
        rmSync(`${path}.1`, { force: true });
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${new Date().toISOString()} ${sanitizeLogLine(line)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // A diagnostic log must never break update behavior.
    }
  };
}

export async function spawnDetachedUpdateHelper(args: HelperHandoff): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mission-control-update-"));
  try {
    const helper = join(directory, basename(args.helperSource));
    copyFileSync(args.helperSource, helper);
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
          ],
          { detached: true, stdio: ["ignore", logFd, logFd] },
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
  private releaseDecisionPending = false;
  private manualCheckRequested = false;
  private listeners = new Set<(snapshot: UpdateSnapshot) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastBackgroundAttempt = 0;

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
      else if (this.receipt.repo !== CANONICAL_REPO) {
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
  }

  onActivate(): void {
    if (
      this.snapshot.phase !== "disabled" &&
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
    if (this.snapshot.phase === "disabled" || this.snapshot.phase === "applying") {
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
          if (choice === "apply") await this.apply();
          else this.defer();
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

  apply(): Promise<boolean> {
    if (this.applyPromise) return this.applyPromise;
    if (this.snapshot.phase !== "available" || !this.receipt || !this.node) {
      return Promise.resolve(false);
    }
    const available = this.snapshot;
    this.publish({
      phase: "applying",
      newVersion: available.newVersion,
      stage: "starting",
      lastOutcome: available.lastOutcome,
    });
    this.applyPromise = (async () => {
      try {
        const node = this.port.systemNode();
        if (!node) throw new UpdateError("A system Node.js installation is required to apply updates.");
        await this.port.handoff({
          node,
          helperSource: this.port.helperSource(),
          sourceClone: this.receipt!.sourceClone,
          targetTag: available.releaseTag,
          appPath: this.receipt!.appPath,
          parentPid: process.pid,
          stateDirectory: this.port.stateDirectory(),
          logPath: join(this.port.stateDirectory(), "update.log"),
        });
        this.publish({
          phase: "applying",
          newVersion: available.newVersion,
          stage: "handed-off",
          lastOutcome: available.lastOutcome,
        });
        this.port.requestQuit();
        return true;
      } catch (error) {
        const safe = safeUpdateError(error);
        this.port.log(`update handoff failed: ${error instanceof Error ? error.message : String(error)}`);
        this.publish({
          phase: "error",
          currentVersion: available.currentVersion,
          message: safe.message,
          manual: true,
          retryable: safe.retryable,
          lastOutcome: available.lastOutcome,
        });
        await this.port.dialogs.error(safe.message);
        return false;
      } finally {
        this.applyPromise = null;
      }
    })();
    return this.applyPromise;
  }

  defer(): void {
    if (this.snapshot.phase !== "available") return;
    this.publish(
      idleSnapshot(this.snapshot.currentVersion, this.snapshot.lastOutcome, this.snapshot.checkedAt),
    );
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
    requestQuit: options.requestQuit,
    readOutcome: () => readUpdateOutcome(updateOutcomePath(options.stateDirectory)),
    clearOutcome: () => clearUpdateOutcome(updateOutcomePath(options.stateDirectory)),
    now: Date.now,
    random: Math.random,
    log,
    dialogs: options.dialogs,
  };
}
