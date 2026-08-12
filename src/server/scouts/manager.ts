import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { OpenTargetId } from "@shared/open-targets.ts";
import {
  decodeScoutCursor,
  parseScoutArchiveKey,
  scoutArchiveKey,
  type ScoutArchiveDetail,
  type ScoutArchivePage,
  type ScoutArchiveSummary,
  type ScoutArtifactView,
  type ScoutSearchQuery,
} from "@shared/scouts.ts";
import { SCOUTS_DIR, scoutReconcileMs } from "../config.ts";
import { openFile, type OpenFileOutcome } from "../open-targets/index.ts";
import { ScoutPathError, archiveDir, isInside, resolveArchiveFile, statRealDirectory, trashRoot } from "./paths.ts";
import { loadScoutProducer, type ScoutProducerIdentity } from "./producer.ts";
import { ScoutReconciler, type ScoutReconcilePass } from "./reconciler.ts";
import { ScoutStore, type ScoutArchiveRow } from "./store.ts";

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

export interface ScoutArchiveManagerOptions {
  root?: string;
  store?: ScoutStore;
  producer?: ScoutProducerIdentity;
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
}

export class ScoutArchiveManager {
  readonly libraryPath: string;
  readonly producer: ScoutProducerIdentity;
  private readonly store: ScoutStore;
  private readonly reconciler: ScoutReconciler;
  private readonly renameDir: (from: string, to: string) => Promise<void>;
  private readonly handToTarget: (target: OpenTargetId, path: string) => Promise<OpenFileOutcome>;

  constructor(options: ScoutArchiveManagerOptions = {}) {
    this.libraryPath = options.root ?? SCOUTS_DIR;
    this.producer = options.producer ?? loadScoutProducer(undefined, this.libraryPath);
    this.store = options.store ?? new ScoutStore();
    this.renameDir = options.rename ?? ((from, to) => rename(from, to));
    this.handToTarget = options.openTarget ?? openFile;
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
