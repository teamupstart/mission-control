import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  SCOUT_REPORT_PATH_SHAPE,
  decodeScoutCursor,
  parseScoutArchiveKey,
  scoutArchiveKey,
  type ScoutArchiveDetail,
  type ScoutArchivePage,
  type ScoutArchiveSummary,
  type ScoutArtifactView,
  type ScoutCaptureStatus,
  type ScoutSearchQuery,
  type ScoutSubmissionInput,
} from "@shared/scouts.ts";
import type { Session } from "@shared/types.ts";
import { SCOUTS_DIR, scoutReconcileMs } from "../config.ts";
import { openFile, type OpenFileOutcome } from "../open-targets/index.ts";
import { captureScoutArchive, type ScoutCaptureOutcome } from "./capture.ts";
import { ScoutCaptureStore, type ScoutCaptureJob } from "./capture-store.ts";
import { ScoutPathError, archiveDir, isInside, resolveArchiveFile, statRealDirectory, trashRoot } from "./paths.ts";
import { loadScoutProducer, type ScoutProducerIdentity } from "./producer.ts";
import { ScoutReconciler, type ScoutReconcilePass } from "./reconciler.ts";
import { ScoutStore, type ScoutArchiveRow } from "./store.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "./submission-tool.ts";
import type { ScoutSessionEvidence, ScoutSubject, ScoutTaskGateway } from "./task-gateway.ts";

/**
 * The daemon's one owner of the scout library.
 *
 * Routes talk to this and never to the store, the verifier, or the filesystem. That is the
 * boundary that keeps "which archive" and "which file" server-side questions: a request
 * names an opaque archive key and an opaque artifact id, and this class is the only thing
 * that turns them into a path - always by GENERATING the path from a decoded key and
 * re-checking containment, never by trusting a stored or claimed path.
 */

export class ScoutArchiveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

/** One artifact, opened for streaming. The caller owns closing the handle. */
export interface ScoutArtifactBody {
  view: ScoutArtifactView;
  handle: FileHandle;
  /** The size of the OPEN file, so a Content-Length cannot describe different bytes. */
  bytes: number;
  fileName: string;
}

/** One artifact, resolved to a real file that may be handed to a local application. */
export interface ScoutArtifactFile {
  view: ScoutArtifactView;
  /** The verified absolute path. Never leaves the daemon; the browser gets ids. */
  path: string;
  /** The size on disk right now, which is what a Content-Length must report. */
  bytes: number;
  /** A safe download name, built from the archive path rather than from any claim. */
  fileName: string;
}

/** What a submission, a completion gate, or a cleanup guard answers with. */
export type ScoutCaptureResult =
  | {
      ok: true;
      /** Absent when there was nothing to capture - a ship task, or a task already gone. */
      archive: {
        key: string;
        relativePath: string;
        captureStatus: ScoutCaptureStatus;
        artifactCount: number;
      } | null;
      replayed: boolean;
    }
  | {
      ok: false;
      /** Every offending path or rule, named, so one round trip fixes all of them. */
      problems: string[];
      /** A final key that already holds different content. Both sides are preserved. */
      conflict: boolean;
    };

export interface ScoutArchiveManagerOptions {
  root?: string;
  store?: ScoutStore;
  producer?: ScoutProducerIdentity;
  /** The local capture-job ledger. Defaults to the daemon's database. */
  captureStore?: ScoutCaptureStore;
  /**
   * How this manager learns what a task is. Absent in the read-only construction the
   * Phase 1 route tests use, which is why every capture entry point degrades to "nothing to
   * do" rather than throwing when it is missing.
   */
  tasks?: ScoutTaskGateway;
  /** Raised once after a reconciliation batch changed derived state. */
  onChanged?: () => void;
  /** Recurring cadence in ms, or null for trigger-only. Defaults to the shipped cadence. */
  intervalMs?: number | null;
  /** Whether to install a filesystem watcher. Off by default; the daemon turns it on. */
  watch?: boolean;
  /** Injected so a test can prove that a failed publication leaves the archive readable. */
  rename?: (from: string, to: string) => Promise<void>;
  /**
   * Injected so a test can assert WHICH path reaches a launcher without spawning one.
   *
   * The launcher hands a path to an application on this machine, so the interesting
   * assertion is exactly the one a real open cannot make: that the path is inside the
   * verified bundle and nowhere else.
   */
  openTarget?: (target: OpenTargetId, path: string) => Promise<OpenFileOutcome>;
  /** Where a background capture failure goes. Defaults to the console. */
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export class ScoutArchiveManager {
  readonly libraryPath: string;
  readonly producer: ScoutProducerIdentity;
  private readonly store: ScoutStore;
  private readonly captureStore: ScoutCaptureStore;
  private readonly tasks: ScoutTaskGateway | null;
  private readonly reconciler: ScoutReconciler;
  private readonly renameDir: (from: string, to: string) => Promise<void>;
  private readonly handToTarget: (target: OpenTargetId, path: string) => Promise<OpenFileOutcome>;
  private readonly log: (message: string, detail: Record<string, unknown>) => void;
  /**
   * One capture in flight per operation key, chained rather than deduplicated.
   *
   * Chained because a second call may be acting on a NEWER job - a scout correcting an
   * invalid report while the first attempt is still failing - and handing it the first
   * attempt's answer would report the old problem about the new submission. Each link
   * re-reads the job, and publication is idempotent against the filesystem anyway, so the
   * cost of serializing is a wait rather than a wrong answer.
   */
  private readonly captureRuns = new Map<string, Promise<ScoutCaptureOutcome>>();
  private acceptingJobs = true;

  constructor(options: ScoutArchiveManagerOptions = {}) {
    this.libraryPath = options.root ?? SCOUTS_DIR;
    this.producer = options.producer ?? loadScoutProducer(undefined, this.libraryPath);
    this.store = options.store ?? new ScoutStore();
    this.captureStore = options.captureStore ?? new ScoutCaptureStore();
    this.tasks = options.tasks ?? null;
    this.renameDir = options.rename ?? ((from, to) => rename(from, to));
    this.handToTarget = options.openTarget ?? openFile;
    this.log =
      options.log ??
      ((message, detail) => console.warn(`[scouts] ${message}`, JSON.stringify(detail)));
    this.reconciler = new ScoutReconciler({
      root: this.libraryPath,
      store: this.store,
      onChanged: options.onChanged,
      intervalMs: options.intervalMs === undefined ? scoutReconcileMs() : options.intervalMs,
      watch: options.watch ?? false,
    });
  }

  /** Begin background discovery. The daemon calls this after it is already serving. */
  start(): void {
    this.reconciler.start();
  }

  stop(): void {
    // New work stops; rows and staging directories are left exactly as they are, so the next
    // start resumes them. Discarding a reserved job on shutdown would be the one way to lose
    // evidence that survived the crash it was written to survive.
    this.acceptingJobs = false;
    this.reconciler.stop();
  }

  /** Run one pass now and wait for it. Tests and the publication path use this. */
  reconcileNow(): Promise<ScoutReconcilePass> {
    return this.reconciler.settle();
  }

  /** Phase 2's hook: a bundle this daemon just renamed into its final place. */
  notifyPublished(producerId: string, archiveId: string): void {
    this.reconciler.notifyPublished({ producerId, archiveId });
  }

  // -------------------------------------------------------------------------
  // Capture: submission, completion gating, cleanup safety, exit recovery
  // -------------------------------------------------------------------------

  /**
   * The `submit_scout_artifacts` path: attribute, reserve, capture, publish.
   *
   * The caller supplies no identity at all. Which task, which episode, which checkouts, which
   * producer namespace, which archive id, and which destination directory are ALL derived
   * here from the authenticated session - so a submission cannot archive on another scout's
   * behalf, cannot choose where bytes land, and cannot claim an archive that already exists.
   *
   * Idempotent by the operation key: an MCP retry, a lost HTTP response, and a duplicate call
   * converge on one job and therefore one archive, and a replay re-verifies the published
   * bundle rather than writing a second one.
   */
  async submit(
    input: ScoutSessionEvidence & { submission: ScoutSubmissionInput },
  ): Promise<ScoutCaptureResult | { ok: false; status: number; problems: string[] }> {
    if (!this.tasks) {
      return { ok: false, status: 503, problems: ["this build cannot accept scout submissions"] };
    }
    const lookup = this.tasks.subjectForSession({
      env: input.env,
      sessionId: input.sessionId,
      cwd: input.cwd,
    });
    if (!lookup.ok) return { ok: false, status: lookup.status, problems: [lookup.detail] };
    if (!this.acceptingJobs) {
      return { ok: false, status: 503, problems: ["Mission Control is shutting down; try again after it restarts"] };
    }

    const job = this.reserve(lookup.subject);
    const recorded = this.captureStore.recordSubmission(job.operationKey, input.submission);
    if (!recorded) {
      // This episode's archive is already published, and a published archive is immutable.
      // Answering "recorded" would be a lie the scout only discovers when its corrected page
      // is not the one in the bundle - so the replay is returned when it holds the answer, and
      // the refusal is explicit when it does not.
      const replay = await this.runCapture(job.operationKey);
      if (replay.ok && replay.captureStatus === "complete") return this.result(replay);
      return {
        ok: false,
        status: 409,
        problems: [
          "an archive for this scout's current work episode was already published without a " +
            "report, and a published archive cannot be rewritten. Tell your operator; the page " +
            "you wrote is still in the checkout.",
        ],
      };
    }
    return this.result(await this.runCapture(recorded.operationKey));
  }

  /**
   * The completion gate: does this task have a verified COMPLETE bundle?
   *
   * Called before every transition of a scout to `done`, and it deliberately does not
   * recover. A normal completion with nothing submitted must come back to the agent with the
   * required path, not quietly publish a partial - a partial burns the reserved archive id
   * and would leave a corrected resubmission with nowhere to go, turning "you forgot the
   * report" into "the report can never be archived".
   *
   * A non-scout, an unknown task, and a build with no task gateway all answer "nothing to
   * do", which is what keeps ship completion byte-for-byte what it was.
   */
  async ensureReady(taskId: string): Promise<ScoutCaptureResult> {
    if (!this.tasks?.isScout(taskId)) return { ok: true, archive: null, replayed: false };
    const jobs = this.captureStore.forTask(taskId);

    // An already-published COMPLETE archive satisfies this task whichever episode produced it.
    let publishedIncomplete = false;
    for (const job of jobs) {
      if (job.status !== "published") continue;
      // The index row is a PROJECTION of the reconciler's own verification of this exact
      // bundle, so reading it answers "is this complete?" without opening a file. That matters
      // because a merged scout with a partial archive is re-examined by every merge
      // reconciliation tick, and re-digesting a 512 MiB bundle a minute is not a completion
      // gate, it is a background job nobody asked for.
      const row = this.store.get(scoutArchiveKey(job.producerId, job.archiveId));
      if (row) {
        if (row.status === "ready") {
          return {
            ok: true,
            archive: {
              key: row.key,
              relativePath: row.relativePath,
              captureStatus: "complete",
              artifactCount: row.artifactCount,
            },
            replayed: true,
          };
        }
        publishedIncomplete = true;
        continue;
      }
      // Not indexed yet: the bundle was renamed into place moments ago, or the daemon died
      // between the rename and the row. Verify it from disk, which is both the answer and the
      // recovery.
      const outcome = await this.runCapture(job.operationKey);
      if (outcome.ok && outcome.captureStatus === "complete") return this.result(outcome);
      if (outcome.ok) publishedIncomplete = true;
    }

    const pending = jobs.find((job) => job.submission !== null && job.status !== "published");
    if (!pending) {
      return {
        ok: false,
        conflict: false,
        problems: [
          publishedIncomplete
            ? "this scout's archive is incomplete - its primary HTML report is missing - and a " +
              "published archive cannot be rewritten, so this task cannot be marked done."
            : `this scout has not submitted a report yet. Write a self-contained static page at ` +
              `${SCOUT_REPORT_PATH_SHAPE} and call the ${SUBMIT_SCOUT_ARTIFACTS_TOOL} tool with its ` +
              `path and a short summary, then mark the task done.`,
        ],
      };
    }
    const outcome = await this.runCapture(pending.operationKey);
    if (!outcome.ok) return this.result(outcome);
    if (outcome.captureStatus !== "complete") {
      return {
        ok: false,
        conflict: false,
        problems: [
          "this scout's archive is incomplete - its primary HTML report is missing, so the task " +
            "cannot be marked done.",
        ],
      };
    }
    return this.result(outcome);
  }

  /**
   * The cleanup guard: settle this scout's capture before its checkout is destroyed.
   *
   * Reclaim, remove, cancel, close-after-merge, and startup reconciliation all run
   * `git worktree remove --force` or hand a pooled lease back, and every one of them would
   * take an unarchived report with it. This is the last point at which the sources still
   * exist, so it publishes what is there - a complete recovery when exactly one conventional
   * report can be attributed, an honest partial otherwise - and REFUSES the cleanup when it
   * cannot, so the resources stay tracked and the operator can retry rather than losing the
   * evidence to a transient I/O error.
   *
   * A scout that completed normally already has its bundle, so this replays a verification
   * and returns; that is the common path and it is cheap.
   */
  async settleBeforeCleanup(taskId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.tasks?.isScout(taskId)) return { ok: true };
    const jobs = this.captureStore.forTask(taskId);
    const unfinished = jobs.filter((job) => job.status !== "published");

    // Nothing reserved yet, and sources still on disk: this is the operator cancelling or
    // reclaiming a scout whose agent never got as far as submitting. Reserve now, while the
    // checkout is still here, so whatever it did write is preserved.
    if (unfinished.length === 0) {
      if (jobs.length > 0) return { ok: true };
      const subject = this.tasks.subjectForTask(taskId);
      if (!subject || !subject.repos.some((repo) => repo.root !== null)) return { ok: true };
      unfinished.push(this.reserve(subject));
    }

    for (const job of unfinished) {
      const outcome = await this.runCapture(job.operationKey);
      if (!outcome.ok) {
        return {
          ok: false,
          error: `this scout's archive could not be published: ${outcome.problems.join("; ")}`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * The last-chance reservation, on `Registry.onSessionExit`.
   *
   * SYNCHRONOUS up to the durable row and asynchronous after it, and the split is the whole
   * design. `beginEviction` gives a session a few seconds before its row disappears, and it
   * runs listeners inline - so the reservation, which needs the session, the task binding and
   * the worktree paths, happens now, while they can still be derived; the capture, which needs
   * only what was just persisted, happens afterwards and cannot delay eviction or throw into
   * it.
   */
  reserveOnExit(session: Session): void {
    if (!this.tasks || !this.acceptingJobs) return;
    try {
      const subject = this.tasks.subjectForExitingSession(session);
      if (!subject) return;
      // Already archived: this is an ordinary scout finishing and its session going away.
      const jobs = this.captureStore.forTask(subject.taskId);
      if (jobs.some((job) => job.status === "published")) return;
      const job = this.reserve(subject);
      void this.runCapture(job.operationKey);
    } catch (error) {
      // A listener that threw would abandon the rest of `beginEviction`, taking task settling
      // and review orphaning with it. The job is durable or it is not; either way the failure
      // is a log line, and the next cleanup guard or restart retries.
      this.log("could not reserve a capture on session exit", {
        sessionId: session.id,
        error: describeError(error),
      });
    }
  }

  /**
   * Resume every capture this daemon owes, at startup.
   *
   * Deliberately skips a job whose task is still waiting on its agent: a `reserved` row for a
   * live scout means the daemon died between reserving and recording a submission, and
   * publishing a partial for it would burn the archive id the scout is about to submit
   * against. Those settle through the completion gate or the exit listener instead, which is
   * where the evidence about whether the agent is still there actually lives.
   */
  async recoverJobs(): Promise<void> {
    if (!this.tasks) return;
    for (const job of this.captureStore.unfinished()) {
      if (!this.acceptingJobs) return;
      if (this.tasks.awaitsAgent(job.taskId)) continue;
      const outcome = await this.runCapture(job.operationKey);
      if (!outcome.ok) {
        this.log("could not resume a capture job", {
          taskId: job.taskId,
          operationKey: job.operationKey,
          problems: outcome.problems,
        });
      }
    }
  }

  /** The capture job for one task, for tests and diagnostics. Never a durable read path. */
  captureJobsForTask(taskId: string): ScoutCaptureJob[] {
    return this.captureStore.forTask(taskId);
  }

  private reserve(subject: ScoutSubject): ScoutCaptureJob {
    return this.captureStore.reserve({
      taskId: subject.taskId,
      sessionId: subject.sessionId,
      episodeId: subject.episodeId,
      producerId: this.producer.id,
      title: subject.title,
      question: subject.question,
      origin: subject.origin,
      repos: subject.repos,
    });
  }

  private runCapture(operationKey: string): Promise<ScoutCaptureOutcome> {
    const previous = this.captureRuns.get(operationKey) ?? Promise.resolve(null);
    const run: Promise<ScoutCaptureOutcome> = previous
      .catch(() => null)
      .then(() => this.captureOnce(operationKey));
    const tracked = run.finally(() => {
      if (this.captureRuns.get(operationKey) === tracked) this.captureRuns.delete(operationKey);
    });
    this.captureRuns.set(operationKey, tracked);
    return tracked;
  }

  private async captureOnce(operationKey: string): Promise<ScoutCaptureOutcome> {
    const job = this.captureStore.get(operationKey);
    if (!job) return { ok: false, problems: ["that capture job is no longer on this machine"] };
    this.captureStore.noteAttempt(operationKey);
    let outcome: ScoutCaptureOutcome;
    try {
      outcome = await captureScoutArchive(job, {
        libraryRoot: this.libraryPath,
        producerLabel: this.producer.label,
        rename: this.renameDir,
      });
    } catch (error) {
      outcome = { ok: false, problems: [describeError(error)] };
    }
    if (!outcome.ok) {
      this.captureStore.markFailed(operationKey, outcome.problems.join("; "));
      return outcome;
    }
    this.captureStore.markPublished(operationKey, outcome.relativePath, outcome.captureStatus);
    // Optimistic, and fire-and-forget on purpose: the bundle is already durable and verified,
    // so readiness does not wait on a row. A pass that fails here is retried by the recurring
    // cadence, which is the difference between "the index is behind" and "the evidence is gone".
    this.notifyPublished(outcome.identity.producerId, outcome.identity.archiveId);
    return outcome;
  }

  private result(outcome: ScoutCaptureOutcome): ScoutCaptureResult {
    if (!outcome.ok) {
      return { ok: false, problems: outcome.problems, conflict: outcome.conflict ?? false };
    }
    return {
      ok: true,
      archive: {
        key: scoutArchiveKey(outcome.identity.producerId, outcome.identity.archiveId),
        relativePath: outcome.relativePath,
        captureStatus: outcome.captureStatus,
        artifactCount: outcome.artifactCount,
      },
      replayed: outcome.replayed,
    };
  }

  /** One bounded page of archives, with a snippet per row when the query searched. */
  list(query: ScoutSearchQuery): ScoutArchivePage {
    // Decoded HERE so an unusable cursor is refused rather than silently read as "start from
    // the beginning". Paging through the wrong window without noticing is worse than an
    // error the caller can see, and the store below takes a decoded cursor so there is no
    // string left for a second layer to reinterpret.
    const cursor = query.cursor === null ? null : decodeScoutCursor(query.cursor);
    if (query.cursor !== null && cursor === null) {
      throw new ScoutArchiveError("that page cursor is not usable", 400);
    }
    const { rows, nextCursor } = this.store.list({ ...query, cursor });
    return {
      archives: rows.map((row) => this.summary(row, query.q)),
      nextCursor,
      libraryPath: this.libraryPath,
    };
  }

  /** Everything about one archive except artifact bodies. */
  detail(key: string): ScoutArchiveDetail | null {
    const identity = parseScoutArchiveKey(key);
    if (!identity) return null;
    const row = this.store.get(key);
    if (!row) return null;
    return {
      ...this.summary(row, null),
      formatVersion: row.formatVersion,
      contentDigest: row.contentDigest,
      bundlePath: join(this.libraryPath, identity.producerId, identity.archiveId),
      relativePath: row.relativePath,
      primaryArtifactId: row.primaryArtifactId,
      artifacts: this.store.artifacts(key),
      missing: row.missing,
    };
  }

  /**
   * Resolve one artifact to a file on disk.
   *
   * Four separate facts have to line up, and each is checked here rather than assumed: the
   * key decodes to generated identity components, the index knows the artifact, the bundle
   * directory still resolves inside the library, and the stored archive path still lands on
   * a regular file inside that bundle. The stored path is an input to the last check, never
   * an authority for it - a row written before a symlink was swapped in is exactly the case
   * `resolveArchiveFile` re-resolves for.
   */
  async artifactFile(key: string, artifactId: string): Promise<ScoutArtifactFile> {
    const identity = parseScoutArchiveKey(key);
    if (!identity) throw new ScoutArchiveError("no such scout archive", 404);
    const view = this.store.artifact(key, artifactId);
    if (!view) throw new ScoutArchiveError("no such artifact", 404);
    const bundleReal = await this.resolveBundleDir(identity.producerId, identity.archiveId);
    const path = await resolveArchiveFile(bundleReal, view.archivePath);
    const info = await stat(path).catch(() => null);
    if (!info) throw new ScoutArchiveError("archived file is unavailable", 404);
    return { view, path, bytes: info.size, fileName: downloadName(view.archivePath) };
  }

  /**
   * Open one artifact for reading, returning the HANDLE rather than a path.
   *
   * The difference matters. Resolving a path and then reopening it by name reintroduces
   * exactly the window the containment check closed: swap the verified file for a symlink in
   * between and the daemon serves whatever it points at, under the archive's own content
   * type - and the size taken from the earlier `stat` no longer describes the bytes, so the
   * response is truncated or over-long as well. So the caller streams from this handle, the
   * length comes from `fstat` on the same open file, and `O_NOFOLLOW` refuses outright if
   * the final component became a link after the check.
   */
  async artifactBody(key: string, artifactId: string): Promise<ScoutArtifactBody> {
    const file = await this.artifactFile(key, artifactId);
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new ScoutArchiveError("archived file is unavailable", 404);
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ScoutArchiveError("archived file is unavailable", 404);
      return { view: file.view, handle, bytes: info.size, fileName: file.fileName };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /** Hand a verified artifact to a registered "Open in" target. */
  async openArtifact(key: string, artifactId: string, target: OpenTargetId): Promise<OpenFileOutcome> {
    const file = await this.artifactFile(key, artifactId);
    return this.handToTarget(target, file.path);
  }

  /**
   * Delete exactly one local bundle and its derived rows.
   *
   * Ordered so the durable half happens first and the recoverable half can be retried: the
   * bundle is atomically renamed under `.trash`, THEN the index rows go, then the trash entry
   * is removed. A crash after the rename leaves an archive that is gone from the library and
   * whose rows the next complete pass prunes; a crash before it leaves the archive intact.
   * There is no window in which the index says an archive exists and its bundle is half
   * deleted.
   *
   * `confirmKey` must equal the route's key exactly, and the path is GENERATED from the
   * decoded key rather than read from the row - so a bundle whose manifest cannot be parsed
   * is still deletable, and a manifest cannot nominate what gets removed.
   */
  async delete(key: string, confirmKey: string): Promise<{ ok: true; deletedBundle: boolean }> {
    if (confirmKey !== key) {
      throw new ScoutArchiveError("the confirmed archive key does not match this archive", 409);
    }
    const identity = parseScoutArchiveKey(key);
    if (!identity) throw new ScoutArchiveError("no such scout archive", 404);
    const indexed = this.store.get(key) !== null;

    // The SAME resolution every read goes through, rather than a bare join - which is what
    // this used to do, and which made delete the one place a key became a filesystem
    // mutation without the containment check. A symlinked producer namespace pointing out of
    // the library turned an ordinary delete into a recursive removal of whatever it pointed
    // at. A 403 from here propagates: "this key resolves somewhere I will not touch" must
    // never be flattened into "there is nothing here", which would report success and drop
    // the rows.
    let bundle: string | null;
    try {
      bundle = await this.resolveBundleDir(identity.producerId, identity.archiveId);
    } catch (error) {
      if (error instanceof ScoutArchiveError && error.status === 404) bundle = null;
      else throw error;
    }
    if (!indexed && !bundle) throw new ScoutArchiveError("no such scout archive", 404);

    let deletedBundle = false;
    let grave: string | null = null;
    if (bundle) {
      const trash = trashRoot(this.libraryPath);
      await mkdir(trash, { recursive: true, mode: 0o700 });
      grave = join(trash, `${scoutArchiveKey(identity.producerId, identity.archiveId)}.${randomUUID()}`);
      try {
        await this.renameDir(bundle, grave);
        deletedBundle = true;
      } catch (error) {
        throw new ScoutArchiveError(
          `could not remove the archive directory: ${error instanceof Error ? error.message : String(error)}`,
          500,
        );
      }
    }

    this.store.remove(key);
    this.reconciler.forget(key);

    if (grave) await rm(grave, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    // Tidy an emptied producer namespace. `rmdir` refuses a non-empty directory, so this can
    // never take a sibling archive with it.
    await rmdir(join(this.libraryPath, identity.producerId)).catch(() => {});
    return { ok: true, deletedBundle };
  }

  /**
   * The one way an archive key becomes a directory on disk.
   *
   * The check is EQUALITY, not containment: the bundle's realpath must be exactly
   * `<realpath of the library>/<producer-id>/<archive-id>`. Containment alone would accept a
   * symlinked producer namespace pointing at another archive in the same library, so a
   * request naming key A could act on the bundle of key B - and outside the library entirely
   * if the link led there. Equality means every component of the path is a real directory
   * that the server itself generated, and there is nothing left for a link to redirect.
   *
   * Used by every read, every open, and the delete, so there is exactly one answer to "which
   * directory is this key" rather than a strict one for reads and a looser one for the
   * operation that removes files.
   */
  private async resolveBundleDir(producerId: string, archiveId: string): Promise<string> {
    let root: string;
    try {
      root = await realpath(this.libraryPath);
    } catch {
      throw new ScoutArchiveError("the scout library is unavailable", 404);
    }
    const dir = archiveDir(root, producerId, archiveId);
    if (!(await statRealDirectory(dir))) {
      throw new ScoutArchiveError("this archive is no longer in the library", 404);
    }
    const real = await realpath(dir).catch(() => null);
    if (!real || real !== dir || !isInside(root, real)) {
      throw new ScoutArchiveError("this archive does not resolve to a bundle in the library", 403);
    }
    return real;
  }

  private summary(row: ScoutArchiveRow, query: string | null): ScoutArchiveSummary {
    return {
      key: row.key,
      producerId: row.producerId,
      producerLabel: row.producerLabel,
      archiveId: row.archiveId,
      status: row.status,
      captureStatus: row.captureStatus,
      title: row.title,
      question: row.question,
      summary: row.summary,
      tags: row.tags,
      agent: row.agent,
      model: row.model,
      source: row.source,
      repositories: row.repositories,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      indexedAt: row.indexedAt,
      artifactCount: row.artifactCount,
      bytes: row.bytes,
      hasPrimaryReport: row.primaryArtifactId !== null,
      missingCount: row.missing.length,
      error: row.error,
      snippet: query ? this.store.snippet(row.key, query) : null,
    };
  }
}

/** Map a `ScoutPathError` onto the manager's own error type so routes see one shape. */
export function scoutErrorStatus(error: unknown): { message: string; status: 400 | 403 | 404 | 409 | 500 } {
  if (error instanceof ScoutArchiveError) return { message: error.message, status: error.status };
  if (error instanceof ScoutPathError) {
    const status = error.status === 403 ? 403 : error.status === 404 ? 404 : 400;
    return { message: error.message, status };
  }
  // A file that vanished between the containment check and the open. Rare, and the honest
  // answer is the same one a missing artifact gets - not a 500, which would send somebody
  // looking for a daemon fault over a bundle an operator deleted a millisecond ago.
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return { message: "archived file is unavailable", status: 404 };
  }
  return { message: "could not read this scout archive", status: 500 };
}

/**
 * A safe download filename.
 *
 * Built from the archive path's last segment, which `validateScoutArchivePath` has already
 * proved contains no separator, control character, or quote. Anything left that a header
 * cannot carry is replaced rather than escaped, because a `Content-Disposition` that a
 * browser parses differently from this code is a filename somebody else chose.
 */
function downloadName(archivePath: string): string {
  const base = archivePath.split("/").pop() ?? "artifact";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe === "" ? "artifact" : safe;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
