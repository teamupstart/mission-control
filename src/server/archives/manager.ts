import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  archiveKey,
  decodeArchiveCursor,
  parseArchiveKey,
  type ArchiveArtifactView,
  type ArchiveCaptureStatus,
  type ArchiveDetail,
  type ArchivePage,
  type ArchiveSearchQuery,
  type ArchiveSummary,
} from "@shared/archives.ts";
import { SCOUT_REPORT_PATH_SHAPE, type ScoutSubmissionInput } from "@shared/scouts.ts";
import type { Session } from "@shared/types.ts";
import { archiveReconcileMs } from "../config.ts";
import { openFile, type OpenFileOutcome } from "../open-targets/index.ts";
import { captureArchive, type ArchiveCaptureOutcome } from "./capture.ts";
import { ArchiveCaptureStore, type ArchiveCaptureJob } from "./capture-store.ts";
import { ArchiveLibrary } from "./library.ts";
import { ArchivePathError, archiveDir, isInside, resolveArchiveFile, statRealDirectory, trashRoot } from "./paths.ts";
import { loadArchiveProducer, type ArchiveProducerIdentity } from "./producer.ts";
import { ArchiveReconciler, type ArchiveReconcilePass } from "./reconciler.ts";
import { ArchiveStore, type ArchiveRow } from "./store.ts";
import { SUBMIT_SCOUT_ARTIFACTS_TOOL } from "../scouts/submission-tool.ts";
import type { ScoutSubmissionAuthority } from "../scouts/submission-auth.ts";
import type { ScoutSubject, ScoutTaskGateway } from "../scouts/task-gateway.ts";

/**
 * The daemon's one owner of the archive library.
 *
 * Routes talk to this and never to the store, the verifier, or the filesystem. That is the
 * boundary that keeps "which archive" and "which file" server-side questions: a request
 * names an opaque archive key and an opaque artifact id, and this class is the only thing
 * that turns them into a path - always by GENERATING the path from a decoded key and
 * re-checking containment, never by trusting a stored or claimed path.
 */

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

/** One artifact, opened for streaming. The caller owns closing the handle. */
export interface ArchiveArtifactBody {
  view: ArchiveArtifactView;
  handle: FileHandle;
  /** The size of the OPEN file, so a Content-Length cannot describe different bytes. */
  bytes: number;
  fileName: string;
}

/** One artifact, resolved to a real file that may be handed to a local application. */
export interface ArchiveArtifactFile {
  view: ArchiveArtifactView;
  /** The verified absolute path. Never leaves the daemon; the browser gets ids. */
  path: string;
  /** The size on disk right now, which is what a Content-Length must report. */
  bytes: number;
  /** A safe download name, built from the archive path rather than from any claim. */
  fileName: string;
}

/** What a submission, a completion gate, or a cleanup guard answers with. */
export type ArchiveCaptureResult =
  | {
      ok: true;
      /** Absent when there was nothing to capture - a ship task, or a task already gone. */
      archive: {
        key: string;
        relativePath: string;
        captureStatus: ArchiveCaptureStatus;
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

export interface ArchiveManagerOptions {
  /** Where new bundles are published. Defaults to the daemon's archive root. */
  root?: string;
  /**
   * Roots that are read but never written - where earlier builds published.
   *
   * Defaults to the daemon's legacy scout root, and to NOTHING when `root` was named
   * explicitly: a caller pointing at its own directory is saying "this is the library", and
   * silently adding the machine's real one would make its reads depend on the disk.
   */
  legacyRoots?: readonly string[];
  store?: ArchiveStore;
  producer?: ArchiveProducerIdentity;
  /** The local capture-job ledger. Defaults to the daemon's database. */
  captureStore?: ArchiveCaptureStore;
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
  /** Injected so a test can pause an accepted submission before its durable record. */
  afterSubmissionAttribution?: (subject: ScoutSubject) => Promise<void>;
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

export class ArchiveManager {
  /** Where this daemon publishes. Not the only place it reads - see `library`. */
  readonly libraryPath: string;
  private readonly library: ArchiveLibrary;
  readonly producer: ArchiveProducerIdentity;
  private readonly store: ArchiveStore;
  private readonly captureStore: ArchiveCaptureStore;
  private readonly tasks: ScoutTaskGateway | null;
  private readonly reconciler: ArchiveReconciler;
  private readonly renameDir: (from: string, to: string) => Promise<void>;
  private readonly afterSubmissionAttribution:
    | ((subject: ScoutSubject) => Promise<void>)
    | undefined;
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
  private readonly captureRuns = new Map<string, Promise<ArchiveCaptureOutcome>>();
  /** Active submissions per work episode, so exit recovery cannot publish ahead of one. */
  private readonly submissionClaims = new Map<
    string,
    { pending: number; settled: Promise<void>; resolve: () => void }
  >();
  private acceptingJobs = true;

  constructor(options: ArchiveManagerOptions = {}) {
    this.library = new ArchiveLibrary({ writeRoot: options.root, legacyRoots: options.legacyRoots });
    this.libraryPath = this.library.writeRoot;
    this.producer = options.producer ?? loadArchiveProducer(undefined, this.libraryPath);
    this.store = options.store ?? new ArchiveStore();
    this.captureStore = options.captureStore ?? new ArchiveCaptureStore();
    this.tasks = options.tasks ?? null;
    this.renameDir = options.rename ?? ((from, to) => rename(from, to));
    this.afterSubmissionAttribution = options.afterSubmissionAttribution;
    this.handToTarget = options.openTarget ?? openFile;
    this.log =
      options.log ??
      ((message, detail) => console.warn(`[archives] ${message}`, JSON.stringify(detail)));
    this.reconciler = new ArchiveReconciler({
      roots: this.library.roots,
      store: this.store,
      onChanged: options.onChanged,
      intervalMs: options.intervalMs === undefined ? archiveReconcileMs() : options.intervalMs,
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
  reconcileNow(): Promise<ArchiveReconcilePass> {
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
   * The caller supplies no identity in its body. The route verifies a signed task/checkout
   * credential, and the gateway confirms its live session binding before this derives the
   * episode, checkouts, producer namespace, archive id, and destination. A submission cannot
   * archive on another scout's behalf, choose where bytes land, or claim an existing archive.
   *
   * Idempotent by the operation key: an MCP retry, a lost HTTP response, and a duplicate call
   * converge on one job and therefore one archive, and a replay re-verifies the published
   * bundle rather than writing a second one.
   */
  async submit(
    input: { authority: ScoutSubmissionAuthority; submission: ScoutSubmissionInput },
  ): Promise<ArchiveCaptureResult | { ok: false; status: number; problems: string[] }> {
    if (!this.tasks) {
      return { ok: false, status: 503, problems: ["this build cannot accept scout submissions"] };
    }
    const lookup = this.tasks.subjectForSubmission(input.authority);
    if (!lookup.ok) return { ok: false, status: lookup.status, problems: [lookup.detail] };
    const releaseClaim = this.claimSubmission(lookup.subject);
    try {
      if (!this.acceptingJobs) {
        return { ok: false, status: 503, problems: ["Mission Control is shutting down; try again after it restarts"] };
      }
      await this.afterSubmissionAttribution?.(lookup.subject);

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
    } finally {
      releaseClaim();
    }
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
  async ensureReady(taskId: string): Promise<ArchiveCaptureResult> {
    const subject = this.tasks?.subjectForTask(taskId);
    if (!subject) return { ok: true, archive: null, replayed: false };
    const jobs = this.captureStore
      .forTask(taskId)
      .filter((job) => job.episodeId === subject.episodeId);

    // Only this work episode can satisfy this completion. A cancelled and rescheduled scout
    // keeps its earlier immutable archive, but that archive answers the superseded attempt and
    // cannot stand in for evidence from the agent currently doing the work.
    let publishedIncomplete = false;
    for (const job of jobs) {
      if (job.status !== "published") continue;
      // The index is disposable discovery state, not completion authority. A bundle can be
      // deleted or damaged after its ready row was written, so every stated completion must
      // verify the filesystem through the capture path. An absent bundle is rebuilt from the
      // retained checkout; a damaged final directory is preserved and completion is refused.
      const outcome = await this.runCapture(job.operationKey);
      if (!outcome.ok) return this.result(outcome);
      if (outcome.captureStatus === "complete") return this.result(outcome);
      publishedIncomplete = true;
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
    const subject = this.tasks.subjectForTask(taskId);
    if (!subject) return { ok: true };
    await this.submissionClaims.get(this.submissionKey(subject))?.settled;
    const current = this.captureStore
      .forTask(taskId)
      .filter((job) => job.episodeId === subject.episodeId);

    // A prior episode's immutable archive answers that attempt only. If the current episode
    // has no job, reserve it now while its sources still exist. Published current jobs stay
    // in the list: a ledger row is not evidence that the bundle still exists and verifies,
    // so cleanup must replay verification before it destroys the last usable checkout.
    if (current.length === 0) {
      if (!subject.repos.some((repo) => repo.root !== null)) return { ok: true };
      current.push(this.reserve(subject));
    }

    for (const job of current) {
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
      // Already archived for THIS attempt: this is an ordinary scout finishing and its
      // session going away. A superseded episode's archive must not suppress reservation of
      // the checkout that is about to disappear.
      const jobs = this.captureStore
        .forTask(subject.taskId)
        .filter((job) => job.episodeId === subject.episodeId);
      if (jobs.some((job) => job.status === "published")) return;
      const job = this.reserve(subject);
      const activeSubmission = this.submissionClaims.get(this.submissionKey(subject))?.settled;
      if (activeSubmission) {
        void activeSubmission.then(() => this.runCapture(job.operationKey));
      } else {
        void this.runCapture(job.operationKey);
      }
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
   * Deliberately skips an UNSUBMITTED job whose task is still waiting on its agent: a
   * `reserved` row for a live scout means the daemon died between reserving and recording a
   * submission, and publishing a partial for it would burn the archive id the scout is about
   * to submit against. Once a submission is durable, startup must resume it even while the
   * scout is live; otherwise a crash after `recordSubmission` strands its accepted report.
   */
  async recoverJobs(): Promise<void> {
    if (!this.tasks) return;
    for (const job of this.captureStore.unfinished()) {
      if (!this.acceptingJobs) return;
      if (job.submission === null && this.tasks.awaitsAgent(job.taskId)) continue;
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
  captureJobsForTask(taskId: string): ArchiveCaptureJob[] {
    return this.captureStore.forTask(taskId);
  }

  private reserve(subject: ScoutSubject): ArchiveCaptureJob {
    return this.captureStore.reserve({
      // The only kind this manager reserves. A second kind arrives with its own entry point
      // and its own planner; it does not arrive by widening this one.
      kind: "scout",
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

  private submissionKey(subject: Pick<ScoutSubject, "taskId" | "episodeId">): string {
    return JSON.stringify([subject.taskId, subject.episodeId]);
  }

  /**
   * Claim one attributed submission until its durable record and capture have settled.
   *
   * The exit listener stays synchronous through reservation, but defers publication through
   * this promise. A request that already proved which live scout it belongs to therefore gets
   * to record its submitted report before recovery can burn the episode's immutable archive.
   */
  private claimSubmission(subject: ScoutSubject): () => void {
    const key = this.submissionKey(subject);
    let claim = this.submissionClaims.get(key);
    if (!claim) {
      let resolve!: () => void;
      const settled = new Promise<void>((done) => {
        resolve = done;
      });
      claim = { pending: 0, settled, resolve };
      this.submissionClaims.set(key, claim);
    }
    claim.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      claim!.pending -= 1;
      if (claim!.pending > 0) return;
      if (this.submissionClaims.get(key) === claim) this.submissionClaims.delete(key);
      claim!.resolve();
    };
  }

  private runCapture(operationKey: string): Promise<ArchiveCaptureOutcome> {
    const previous = this.captureRuns.get(operationKey) ?? Promise.resolve(null);
    const run: Promise<ArchiveCaptureOutcome> = previous
      .catch(() => null)
      .then(() => this.captureOnce(operationKey));
    const tracked = run.finally(() => {
      if (this.captureRuns.get(operationKey) === tracked) this.captureRuns.delete(operationKey);
    });
    this.captureRuns.set(operationKey, tracked);
    return tracked;
  }

  private async captureOnce(operationKey: string): Promise<ArchiveCaptureOutcome> {
    const job = this.captureStore.get(operationKey);
    if (!job) return { ok: false, problems: ["that capture job is no longer on this machine"] };
    this.captureStore.noteAttempt(operationKey);
    let outcome: ArchiveCaptureOutcome;
    try {
      outcome = await captureArchive(job, {
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

  private result(outcome: ArchiveCaptureOutcome): ArchiveCaptureResult {
    if (!outcome.ok) {
      return { ok: false, problems: outcome.problems, conflict: outcome.conflict ?? false };
    }
    return {
      ok: true,
      archive: {
        key: archiveKey(outcome.identity.producerId, outcome.identity.archiveId),
        relativePath: outcome.relativePath,
        captureStatus: outcome.captureStatus,
        artifactCount: outcome.artifactCount,
      },
      replayed: outcome.replayed,
    };
  }

  /** One bounded page of archives, with a snippet per row when the query searched. */
  list(query: ArchiveSearchQuery): ArchivePage {
    // Decoded HERE so an unusable cursor is refused rather than silently read as "start from
    // the beginning". Paging through the wrong window without noticing is worse than an
    // error the caller can see, and the store below takes a decoded cursor so there is no
    // string left for a second layer to reinterpret.
    const cursor = query.cursor === null ? null : decodeArchiveCursor(query.cursor);
    if (query.cursor !== null && cursor === null) {
      throw new ArchiveError("that page cursor is not usable", 400);
    }
    const { rows, nextCursor } = this.store.list({ ...query, cursor });
    return {
      archives: rows.map((row) => this.summary(row, query.q)),
      nextCursor,
      libraryPath: this.libraryPath,
    };
  }

  /** Everything about one archive except artifact bodies. */
  detail(key: string): ArchiveDetail | null {
    const identity = parseArchiveKey(key);
    if (!identity) return null;
    const row = this.store.get(key);
    if (!row) return null;
    return {
      ...this.summary(row, null),
      formatVersion: row.formatVersion,
      contentDigest: row.contentDigest,
      // The row's OWN root, not the write root: a bundle published before archives declared
      // a kind is still in the library it was written to, and an operator following this
      // path has to arrive at the directory that actually holds the files.
      bundlePath: join(row.libraryRoot, identity.producerId, identity.archiveId),
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
  async artifactFile(key: string, artifactId: string): Promise<ArchiveArtifactFile> {
    const identity = parseArchiveKey(key);
    if (!identity) throw new ArchiveError("no such archive", 404);
    const view = this.store.artifact(key, artifactId);
    if (!view) throw new ArchiveError("no such artifact", 404);
    const bundle = await this.resolveBundleDir(identity.producerId, identity.archiveId);
    const path = await resolveArchiveFile(bundle.dir, view.archivePath);
    const info = await stat(path).catch(() => null);
    if (!info) throw new ArchiveError("archived file is unavailable", 404);
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
  async artifactBody(key: string, artifactId: string): Promise<ArchiveArtifactBody> {
    const file = await this.artifactFile(key, artifactId);
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new ArchiveError("archived file is unavailable", 404);
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ArchiveError("archived file is unavailable", 404);
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
      throw new ArchiveError("the confirmed archive key does not match this archive", 409);
    }
    const identity = parseArchiveKey(key);
    if (!identity) throw new ArchiveError("no such archive", 404);
    const indexed = this.store.get(key) !== null;

    // The SAME resolution every read goes through, rather than a bare join - which is what
    // this used to do, and which made delete the one place a key became a filesystem
    // mutation without the containment check. A symlinked producer namespace pointing out of
    // the library turned an ordinary delete into a recursive removal of whatever it pointed
    // at. A 403 from here propagates: "this key resolves somewhere I will not touch" must
    // never be flattened into "there is nothing here", which would report success and drop
    // the rows.
    let bundle: { root: string; dir: string } | null;
    try {
      bundle = await this.resolveBundleDir(identity.producerId, identity.archiveId);
    } catch (error) {
      if (error instanceof ArchiveError && error.status === 404) bundle = null;
      else throw error;
    }
    if (!indexed && !bundle) throw new ArchiveError("no such archive", 404);

    let deletedBundle = false;
    let grave: string | null = null;
    if (bundle) {
      // Trashed inside the root that holds it, so the durable step stays a rename within one
      // directory tree rather than a move that could cross a filesystem.
      const trash = trashRoot(bundle.root);
      await mkdir(trash, { recursive: true, mode: 0o700 });
      grave = join(trash, `${archiveKey(identity.producerId, identity.archiveId)}.${randomUUID()}`);
      try {
        await this.renameDir(bundle.dir, grave);
        deletedBundle = true;
      } catch (error) {
        throw new ArchiveError(
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
    if (bundle) await rmdir(join(bundle.root, identity.producerId)).catch(() => {});
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
  private async resolveBundleDir(
    producerId: string,
    archiveId: string,
  ): Promise<{ root: string; dir: string }> {
    let refused: ArchiveError | null = null;
    let reachedARoot = false;
    for (const candidate of this.library.roots) {
      let root: string;
      try {
        root = await realpath(candidate);
      } catch {
        // A root that does not exist is an empty one, not a failure: the legacy root is
        // absent on a machine that never ran an older build.
        continue;
      }
      reachedARoot = true;
      const dir = archiveDir(root, producerId, archiveId);
      if (!(await statRealDirectory(dir))) continue;
      const real = await realpath(dir).catch(() => null);
      if (!real || real !== dir || !isInside(root, real)) {
        // Remembered rather than thrown: a key that resolves badly under one root may be a
        // perfectly ordinary bundle under another, and "I will not touch this" must still
        // be the answer if no root holds a usable one.
        refused ??= new ArchiveError("this archive does not resolve to a bundle in the library", 403);
        continue;
      }
      return { root, dir: real };
    }
    if (refused) throw refused;
    if (!reachedARoot) throw new ArchiveError("the archive library is unavailable", 404);
    throw new ArchiveError("this archive is no longer in the library", 404);
  }

  private summary(row: ArchiveRow, query: string | null): ArchiveSummary {
    return {
      key: row.key,
      producerId: row.producerId,
      producerLabel: row.producerLabel,
      archiveId: row.archiveId,
      kind: row.kind,
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

/** Map a `ArchivePathError` onto the manager's own error type so routes see one shape. */
export function archiveErrorStatus(error: unknown): { message: string; status: 400 | 403 | 404 | 409 | 500 } {
  if (error instanceof ArchiveError) return { message: error.message, status: error.status };
  if (error instanceof ArchivePathError) {
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
  return { message: "could not read this archive", status: 500 };
}

/**
 * A safe download filename.
 *
 * Built from the archive path's last segment, which `validateArchivePath` has already
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
