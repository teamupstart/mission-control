import { watch, type FSWatcher } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { isArchiveId, archiveKey, type ArchiveIdentity } from "@shared/archives.ts";
import { unref } from "../util/timers.ts";
import {
  readBundleFingerprint,
  readBundleManifest,
  sameFingerprint,
  settleSignature,
  verifyArchiveBundle,
  type ArchiveBundleFingerprint,
} from "./bundle.ts";
import { statRealDirectory, trashRoot } from "./paths.ts";
import type { IndexedArchiveFingerprint, ArchiveStore } from "./store.ts";

/**
 * Incremental discovery of the archive library.
 *
 * The contract this exists to hold: the FILESYSTEM is the library, and SQLite is a cache of
 * it. So there is no import step, no reindex button, and no startup migration. A bundle that
 * appears - because this daemon published it, because an operator dragged it in, because a
 * sync tool delivered it - is found by the next pass. A database that was deleted simply has
 * no fingerprints, so every bundle looks new and the whole index rebuilds in the background.
 *
 * Three properties do most of the work:
 *
 * - **Unchanged bundles cost one `lstat`.** The manifest's size and mtime are compared with
 *   the stored fingerprint before anything is opened, so a startup with a thousand archives
 *   parses no HTML and hashes no bytes.
 * - **A new or changed bundle must settle before it is believed.** Sync tools expose a
 *   directory before its payload finishes arriving. A candidate is verified only after two
 *   observations agree about the manifest AND every file it declares, so a half-copied
 *   archive stays invisible instead of flashing up as corrupt.
 * - **Pruning follows a COMPLETE walk.** Rows are removed for bundles the finished pass did
 *   not see, never for a file that happened to be missing at the moment it was looked at.
 *
 * The recurring scan is the authority and the watcher is only a latency hint: watchers drop
 * events on network and synchronised directories, which is exactly where foreign bundles
 * arrive from.
 *
 * A pass walks EVERY root the library owns, in order, and the first root to yield a key wins
 * it. That is what lets bundles published before archives declared a kind stay exactly where
 * they were written while new ones land beside them - one catalog over two directories,
 * rather than a migration that rewrites evidence.
 */

/** How long a filesystem hint waits for its neighbours before triggering a pass. */
const WATCH_DEBOUNCE_MS = 750;

/**
 * How many candidate bundles one pass will look at.
 *
 * A ceiling rather than a promise: crossing it is logged by name, because a library that
 * silently stopped being discovered past entry 20,000 would read as evidence that never
 * arrived rather than as a limit somebody chose.
 */
const MAX_CANDIDATES = 20_000;

/**
 * How many settled-but-incomplete observations a bundle gets before it is called unreadable.
 *
 * The first is ordinary - a copy in progress can hold still for one pass and still be
 * missing a file. By the third look at unchanged bytes that do not match their own manifest,
 * "still arriving" has stopped being the likely explanation, and an archive that is
 * permanently invisible is worse than one listed with a reason.
 */
const MAX_INCOMPLETE_OBSERVATIONS = 2;

/**
 * How many passes an indexed archive keeps its row while its manifest is unreadable.
 *
 * A manifest being replaced non-atomically - an rsync `--inplace`, an editor, an unpacker -
 * is momentarily absent, and pruning on that observation drops a live archive out of the
 * catalog and then pays a full re-verify, up to 512 MiB of hashing, two cadences later. The
 * class contract is that rows go when a finished pass did not SEE a bundle, never because a
 * file happened to be missing at the instant it was looked at, so a present directory buys a
 * few passes of grace. It is bounded rather than indefinite: a directory whose manifest is
 * really gone is not an archive, and it should not hold a row for ever.
 */
const MAX_MANIFEST_GONE_OBSERVATIONS = 2;

export interface ArchiveReconcilerOptions {
  /**
   * Every library root, in discovery order. None has to exist; an absent root is an empty
   * one, and an empty list is an empty library.
   */
  roots: readonly string[];
  store: ArchiveStore;
  /** Called once after a pass that changed derived state. Never once per file. */
  onChanged?: () => void;
  /** Recurring cadence in ms, or null to run only when triggered. */
  intervalMs?: number | null;
  /** Whether to install a filesystem watcher. Off in tests that drive passes directly. */
  watch?: boolean;
  now?: () => number;
}

/** What one pass did, for tests and for a log line. */
export interface ArchiveReconcilePass {
  epoch: number;
  scanned: number;
  unchanged: number;
  indexed: number;
  unreadable: number;
  pending: number;
  pruned: number;
  changed: boolean;
  failed: string | null;
}

interface PendingCandidate {
  signature: string;
  incompleteObservations: number;
  /** Consecutive passes that found the directory but no readable manifest. */
  manifestGoneObservations: number;
}

export class ArchiveReconciler {
  private readonly roots: readonly string[];
  private readonly store: ArchiveStore;
  private readonly onChanged: () => void;
  private readonly intervalMs: number | null;
  private readonly wantsWatch: boolean;
  private readonly now: () => number;

  private readonly pending = new Map<string, PendingCandidate>();
  /**
   * Keys this daemon just published, which skip the settle wait exactly once.
   *
   * Publication is an atomic rename of a directory that was already verified in staging, so
   * the bundle is complete at the instant it becomes visible and there is nothing to wait
   * for. It is a fast path, not a trust exemption: the bundle is still fully verified.
   */
  private readonly justPublished = new Set<string>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchers: FSWatcher[] = [];
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ArchiveReconcilePass> | null = null;
  private retrigger = false;
  private stopped = false;
  private lastEpoch = 0;
  private sweptTrash = false;
  private passes = 0;

  constructor(options: ArchiveReconcilerOptions) {
    this.roots = [...options.roots];
    this.store = options.store;
    this.onChanged = options.onChanged ?? ((): void => {});
    this.intervalMs = options.intervalMs ?? null;
    this.wantsWatch = options.watch ?? false;
    this.now = options.now ?? Date.now;
  }

  /**
   * Begin discovering in the background.
   *
   * The first pass is deliberately NOT awaited by the caller: a fresh installation restored
   * onto a large library would otherwise hold the daemon's startup for as long as it takes
   * to hash somebody's whole archive history, and every route above it would 503 while a
   * cache warmed. Serving first and discovering after is the same ordering the plan requires.
   */
  start(): void {
    if (this.stopped) return;
    this.installWatcher();
    void this.trigger();
    this.schedule();
  }

  /** Close the watcher and the timer. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  /**
   * Ask for a pass, coalescing with one already running.
   *
   * Passes are strictly serialized. Two concurrent walks would race on the same rows and, far
   * worse, could prune with a stale epoch. A trigger that arrives mid-pass sets a flag and
   * gets exactly one more pass afterwards, however many triggers arrived.
   */
  trigger(): Promise<ArchiveReconcilePass> {
    if (this.running) {
      this.retrigger = true;
      return this.running;
    }
    const pass = this.runPass()
      .catch((error: unknown) => failedPass(this.lastEpoch, error))
      .then(async (result) => {
        this.running = null;
        if (this.retrigger && !this.stopped) {
          this.retrigger = false;
          return this.trigger();
        }
        this.retrigger = false;
        return result;
      });
    this.running = pass;
    return pass;
  }

  /** Await whatever pass is in flight, or run one. Used by tests and by the routes' warm-up. */
  async settle(): Promise<ArchiveReconcilePass> {
    return this.trigger();
  }

  /**
   * A bundle this daemon just renamed into place. Phase 2's publication calls this so a
   * finished scout appears without waiting a cadence.
   */
  notifyPublished(identity: ArchiveIdentity): void {
    this.justPublished.add(archiveKey(identity.producerId, identity.archiveId));
    void this.trigger();
  }

  /**
   * How many passes have actually run.
   *
   * Exposed because coalescing is otherwise unobservable: three triggers arriving during one
   * walk must produce two passes, and nothing about the resulting rows can tell that apart
   * from four.
   */
  get passCount(): number {
    return this.passes;
  }

  /** Forget in-memory settle state for a key the daemon removed itself. */
  forget(key: string): void {
    this.pending.delete(key);
    this.justPublished.delete(key);
  }

  private schedule(): void {
    if (this.stopped || this.intervalMs === null) return;
    // Jittered so several daemons, or a daemon and a sync tool, do not settle into lockstep
    // and rescan in the same instant forever.
    const jitter = Math.floor(this.intervalMs * 0.2 * Math.random());
    this.timer = unref(
      setTimeout(() => {
        void this.trigger().finally(() => this.schedule());
      }, this.intervalMs + jitter),
    );
  }

  /**
   * Watch the library for hints.
   *
   * Best-effort in every direction: recursive watching is not available on every platform,
   * a watcher can overflow, and a synchronised directory can simply not report. Each of
   * those degrades to the recurring scan, which is why none of them is fatal here.
   */
  private installWatcher(): void {
    if (!this.wantsWatch || this.watchers.length > 0) return;
    for (const root of this.roots) {
      const open = (recursive: boolean): FSWatcher | null => {
        try {
          return watch(root, { recursive, persistent: false }, () => this.hint());
        } catch {
          return null;
        }
      };
      const watcher = open(true) ?? open(false);
      if (!watcher) continue;
      watcher.on("error", () => {
        watcher.close();
        this.watchers = this.watchers.filter((entry) => entry !== watcher);
      });
      this.watchers.push(watcher);
    }
  }

  private hint(): void {
    if (this.stopped || this.watchTimer) return;
    this.watchTimer = unref(
      setTimeout(() => {
        this.watchTimer = null;
        void this.trigger();
      }, WATCH_DEBOUNCE_MS),
    );
  }

  private async runPass(): Promise<ArchiveReconcilePass> {
    this.passes += 1;
    const epoch = Math.max(this.lastEpoch + 1, this.now());
    this.lastEpoch = epoch;
    const result: ArchiveReconcilePass = {
      epoch,
      scanned: 0,
      unchanged: 0,
      indexed: 0,
      unreadable: 0,
      pending: 0,
      pruned: 0,
      changed: false,
      failed: null,
    };

    if (!this.sweptTrash) {
      this.sweptTrash = true;
      await this.finishInterruptedDeletions();
    }

    const indexed = new Map<string, IndexedArchiveFingerprint>();
    for (const row of this.store.fingerprints()) indexed.set(row.key, row);
    const observed = new Set<string>();

    for (const root of this.roots) {
      const pass = await this.runRootPass(root, epoch, result, indexed, observed);
      if (pass.failed) return { ...result, failed: pass.failed };
    }

    // Deleting the current key mid-iteration is defined behaviour for a Map iterator, so this
    // does not need a copy of the key set.
    for (const key of this.pending.keys()) {
      if (!observed.has(key)) this.pending.delete(key);
    }
    const pruned = this.store.pruneUnseen(epoch);
    result.pruned = pruned.length;
    if (pruned.length > 0) result.changed = true;
    for (const key of pruned) this.forget(key);

    if (result.changed) this.onChanged();
    return result;
  }

  /**
   * One root's half of a pass.
   *
   * `observed` is shared across the roots of a single pass and is what stops a bundle that
   * exists under two of them from being indexed twice - the first root to yield a key owns
   * it, and every later root skips it. Pruning still runs once, after every root, so a row
   * survives as long as ANY root still holds its bundle.
   */
  private async runRootPass(
    root: string,
    epoch: number,
    result: ArchiveReconcilePass,
    indexed: Map<string, IndexedArchiveFingerprint>,
    observed: Set<string>,
  ): Promise<{ failed: string | null }> {
    let libraryRealRoot: string;
    try {
      libraryRealRoot = await realpath(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // No library yet is an empty library, and an empty library is a complete pass: an index
      // left over from a state directory that is now gone should not keep answering queries.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return { failed: describe(error) };
      }
      libraryRealRoot = root;
    }

    const candidates = await this.discover(libraryRealRoot);
    if (candidates.failed) return { failed: candidates.failed };
    result.scanned += candidates.identities.length;

    for (const identity of candidates.identities) {
      if (this.stopped) return { failed: "stopped" };
      const key = archiveKey(identity.producerId, identity.archiveId);
      // Claimed by an earlier root in this same pass. A duplicate copy under a legacy root
      // is not a second archive, and re-indexing it would replace a row that was just
      // written from the copy this build actually publishes to.
      if (observed.has(key)) continue;
      const bundleDir = join(libraryRealRoot, identity.producerId, identity.archiveId);
      let fingerprint: ArchiveBundleFingerprint | null;
      try {
        fingerprint = await readBundleFingerprint(bundleDir);
      } catch (error) {
        return { failed: describe(error) };
      }
      const known = indexed.get(key);
      if (!fingerprint) {
        // No readable manifest right now. If the DIRECTORY is gone too, the archive really
        // has been removed and pruning is correct. If it is still there, the manifest is
        // most likely mid-replacement, so an already-indexed row is held for a few passes
        // rather than dropped on one unlucky observation.
        if (known && (await statRealDirectory(bundleDir))) {
          const entry = this.pendingFor(key);
          entry.manifestGoneObservations += 1;
          if (entry.manifestGoneObservations <= MAX_MANIFEST_GONE_OBSERVATIONS) {
            observed.add(key);
            this.store.markSeen(key, epoch);
            result.pending += 1;
            continue;
          }
        }
        continue;
      }
      observed.add(key);

      if (known) this.store.markSeen(key, epoch);
      if (known && sameFingerprint(known.fingerprint, fingerprint)) {
        result.unchanged += 1;
        this.pending.delete(key);
        continue;
      }

      const settled = await this.hasSettled(key, bundleDir, fingerprint);
      if (!settled) {
        result.pending += 1;
        continue;
      }

      const read = await verifyArchiveBundle(libraryRealRoot, identity);
      if (read.kind === "absent") {
        this.pending.delete(key);
        continue;
      }
      if (read.kind === "incomplete") {
        // The entry is CREATED if it is missing rather than only updated when it exists. A
        // locally published bundle takes the settle fast path, so it used to reach here with
        // no pending entry at all - the counter could never rise, and an incomplete
        // publication stayed invisible for ever with no diagnostic.
        const entry = this.pendingFor(key);
        entry.incompleteObservations += 1;
        if (entry.incompleteObservations < MAX_INCOMPLETE_OBSERVATIONS) {
          result.pending += 1;
          continue;
        }
        this.pending.delete(key);
        this.store.replaceUnreadable({
          identity,
          libraryRoot: libraryRealRoot,
          relativePath: `${identity.producerId}/${identity.archiveId}`,
          fingerprint,
          reason: read.reason,
          formatVersion: null,
          indexedAt: epoch,
          epoch,
        });
        result.unreadable += 1;
        result.changed = true;
        continue;
      }
      this.pending.delete(key);
      this.justPublished.delete(key);
      if (read.kind === "unreadable") {
        this.store.replaceUnreadable({
          identity,
          libraryRoot: libraryRealRoot,
          relativePath: `${identity.producerId}/${identity.archiveId}`,
          fingerprint,
          reason: read.reason,
          formatVersion: read.formatVersion,
          indexedAt: epoch,
          epoch,
        });
        result.unreadable += 1;
        result.changed = true;
        continue;
      }

      // An immutable key that now holds different content. Never a choice between two
      // candidates: the index says so and stops, because silently adopting either one would
      // rewrite history that somebody may already have cited.
      // The status is deliberately NOT part of this condition. Gating on
      // `status !== "unreadable"` made the guard one-shot: the refusal row it writes is
      // itself unreadable, so a SECOND rewrite sailed past and was indexed as ready - which
      // both adopted the attacker's content and erased the error that was the only record of
      // the first rewrite. What the row carries instead is the last digest this build was
      // willing to vouch for, so the key stays refused until those exact bytes come back.
      if (known && known.manifestDigest !== "" && known.manifestDigest !== read.bundle.manifestDigest) {
        this.store.replaceUnreadable({
          identity,
          libraryRoot: read.bundle.libraryRoot,
          relativePath: read.bundle.relativePath,
          fingerprint,
          // Carried forward, not replaced: remembering the tampered digest would let the NEXT
          // rewrite look like a return to a known state.
          manifestDigest: known.manifestDigest,
          reason:
            "this archive key now holds different content than it was indexed with; a completed archive is immutable",
          formatVersion: read.bundle.manifest.formatVersion,
          indexedAt: epoch,
          epoch,
        });
        result.unreadable += 1;
        result.changed = true;
        continue;
      }

      this.store.replaceArchive(read.bundle, epoch, epoch);
      result.indexed += 1;
      result.changed = true;
    }
    return { failed: null };
  }

  /**
   * Whether a candidate has held still long enough to be worth verifying.
   *
   * The signature covers the manifest AND every file it declares, so "still copying" is
   * visible as a signature that keeps moving. A key this daemon just published skips the
   * wait once, because an atomic rename has no partially visible state to wait for.
   */
  private async hasSettled(
    key: string,
    bundleDir: string,
    fingerprint: ArchiveBundleFingerprint,
  ): Promise<boolean> {
    const read = await readBundleManifest(bundleDir);
    const manifest = read.kind === "manifest" ? read.manifest : null;
    const signature = await settleSignature(bundleDir, fingerprint, manifest);
    const entry = this.pendingFor(key);
    entry.manifestGoneObservations = 0;
    // One-shot, and the entry is recorded either way: skipping the WAIT must not also skip
    // the bookkeeping every later pass depends on.
    if (this.justPublished.delete(key)) {
      entry.signature = signature;
      return true;
    }
    if (entry.signature === signature) return true;
    entry.signature = signature;
    return false;
  }

  /** The in-memory settle record for a key, created on first sight. */
  private pendingFor(key: string): PendingCandidate {
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { signature: "", incompleteObservations: 0, manifestGoneObservations: 0 };
      this.pending.set(key, entry);
    }
    return entry;
  }

  /**
   * Walk exactly two levels: `<producer-id>/<archive-id>`.
   *
   * Both components must be generated UUIDs, which is what keeps `.staging`, `.trash`, a
   * stray `README`, and anything an operator dropped in by hand out of the candidate set
   * without a special case for each. Symlinked entries are skipped rather than followed:
   * `readdir` reports a link as a link, and following one would let a directory outside the
   * library present itself as a producer.
   */
  private async discover(
    libraryRealRoot: string,
  ): Promise<{ identities: ArchiveIdentity[]; failed: string | null }> {
    const identities: ArchiveIdentity[] = [];
    let producers: string[];
    try {
      producers = (await readdir(libraryRealRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && isArchiveId(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { identities, failed: null };
      return { identities, failed: describe(error) };
    }
    let capped = false;
    for (const producerId of producers) {
      let archives: string[];
      try {
        archives = (await readdir(join(libraryRealRoot, producerId), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && isArchiveId(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        return { identities, failed: describe(error) };
      }
      for (const archiveId of archives) {
        if (identities.length >= MAX_CANDIDATES) {
          capped = true;
          break;
        }
        identities.push({ producerId, archiveId });
      }
      if (capped) break;
    }
    if (capped) {
      console.warn(
        `[archives] stopped discovery at ${MAX_CANDIDATES} bundles; later archives in this library are not indexed`,
      );
    }
    return { identities, failed: null };
  }

  /**
   * Finish a deletion that was interrupted between the rename and the removal.
   *
   * Deletion moves a bundle into `.trash` first, so the durable step is the rename and this
   * is only the tidy-up. Everything found here has already lost its index rows, or will when
   * the pass that follows fails to observe it.
   */
  private async finishInterruptedDeletions(): Promise<void> {
    for (const root of this.roots) {
      const trash = trashRoot(root);
      let entries: string[];
      try {
        entries = await readdir(trash);
      } catch {
        continue;
      }
      for (const entry of entries) {
        await rm(join(trash, entry), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
    }
  }
}

function failedPass(epoch: number, error: unknown): ArchiveReconcilePass {
  console.error("[archives] reconciliation pass failed:", error);
  return {
    epoch,
    scanned: 0,
    unchanged: 0,
    indexed: 0,
    unreadable: 0,
    pending: 0,
    pruned: 0,
    changed: false,
    failed: describe(error),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
