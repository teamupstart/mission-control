import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  STORAGE_CATEGORIES,
  STORAGE_USAGE_POOL_LIMIT,
  type StorageCategoryId,
  type StorageUsage,
  type StorageVolume,
} from "@shared/storage-health.ts";
import { storageWarnAtBytes, type StorageLimitsConfig } from "@shared/storage-limits.ts";
import { run, type RunResult } from "./util/exec.ts";

/**
 * Measuring walks every file in the state directory, which on a machine with large native
 * pools is millions of files and minutes of disk reads. It runs in a `du` child, so the walk
 * never touches the daemon's event loop or libuv's file threads, and it is stopped after this
 * long rather than left running.
 */
const MEASURE_TIMEOUT_MS = 15 * 60 * 1_000;

/** A depth-3 listing of a large state directory runs to tens of thousands of lines. */
const MEASURE_MAX_BUFFER = 64 * 1024 * 1024;

/** Directories are listed three levels down: `worktree-pools/<pool>/<slot>` is the deepest wanted. */
const MEASURE_DEPTH = 3;

const POOLS_ROOT = "worktree-pools";

/**
 * Directories whose contents can change while a walk is still running elsewhere, re-summed the
 * moment it finishes. A backup capture that lands after `du` has passed `backups/database` but
 * before the walk ends would otherwise be missing from the measurement, while the kept-copies
 * baseline Storage takes at that moment includes it, and the backups figure and the limit warning
 * would stay low until the next walk. Re-summed synchronously, in the same step that publishes the
 * measurement, the directory and the baseline describe the same instant.
 */
const SETTLED_AT_FINISH = ["backups/database"];

/**
 * Free space moves with every write on the machine. A reading is replaced only once it has
 * moved this far, so a quiet machine does not publish a new aggregate to every open window each
 * minute. A reading on the other side of a threshold (`volumeThresholds`, the free-space floor)
 * is always taken at once, however small the move, so the floor is judged on every check.
 */
const VOLUME_STEP_BYTES = 64 * 1024 * 1024;

/**
 * Between scheduled walks, a storage limit is judged against the last measured total, and the
 * state directory can grow by gigabytes in that time. Growth on this volume always shows up as
 * lost free space first, which the minute-by-minute check already reads for free. So once the
 * volume has lost enough since the last walk began to carry the total across the next threshold,
 * the walk runs again then instead of hours later. This is the most that "enough" ever is.
 */
const REMEASURE_GROWTH_BYTES = 1024 ** 3;

/** The soonest a growth-triggered walk may follow the last one, which bounds its disk cost. */
const REMEASURE_MIN_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * Lost free space is net of every program on the volume: the state directory can grow while
 * something else frees as much, and the volume never shows it. So while a storage limit is set
 * the walk also runs on age alone: at least this often, and every `REMEASURE_MIN_INTERVAL_MS`
 * while the measured total is within a GiB of its next threshold. A growth past the warning
 * therefore surfaces within the hour, and within a quarter of it once close, whatever the
 * volume's free space did. Without a limit, the six-hourly walk is the only one.
 */
const LIMIT_SET_MAX_AGE_MS = 60 * 60 * 1_000;

/**
 * How much growth since the last walk can carry `measuredTotalBytes` across the next storage
 * threshold, capped at 1 GiB; null without a storage limit. The thresholds are the warning, then
 * the limit itself, whose message changes from "near" to "over". Sized from the distance left,
 * so a quarter-GiB limit is caught after the few MiB that cross it, not after a whole GiB. Once
 * past both, the cap keeps the "over" figure current.
 */
export function remeasureGrowthFor(limits: StorageLimitsConfig, measuredTotalBytes: number): number | null {
  const warnAt = storageWarnAtBytes(limits);
  if (warnAt === null || limits.limitBytes === null) return null;
  const next = [warnAt, limits.limitBytes].find((threshold) => threshold > measuredTotalBytes);
  if (next === undefined) return REMEASURE_GROWTH_BYTES;
  return Math.max(1, Math.min(REMEASURE_GROWTH_BYTES, next - measuredTotalBytes));
}

export interface StorageMeasurement {
  measuredAt: number;
  durationMs: number;
  totalBytes: number;
  categories: Array<{ id: StorageCategoryId; bytes: number }>;
  /** Largest first, every pool. */
  pools: Array<{ name: string; bytes: number }>;
  /**
   * `worktree-pools/<pool>/<ordinal>` relative path to its size: the directory that holds one
   * slot's checkout (`<ordinal>/<repository>`), and everything else that slot keeps. Daemon-only.
   */
  slotBytes: Map<string, number>;
  /** The walk could not read everything, so some sizes may be low. */
  partial: string | null;
}

export interface DiskUsageListing {
  /** Path relative to the root (`""` for the root itself) to bytes. */
  directories: Map<string, number>;
  partial: string | null;
}

export interface StorageUsageDeps {
  /** The state directory. */
  root: string;
  /** Lists directory sizes to `MEASURE_DEPTH` beneath `root`. Defaults to `du`. */
  listDirectories?: (root: string) => Promise<DiskUsageListing>;
  /**
   * The allocated bytes beneath one directory right now, or null when it cannot be read. Used for
   * `SETTLED_AT_FINISH`. Defaults to a synchronous `lstat` sum that follows no symlink.
   */
  directoryBytes?: (path: string) => number | null;
  /** Allocated bytes of one top-level file, or null when it cannot be read. */
  fileBytes?: (path: string) => number | null;
  volume?: (root: string) => Promise<Omit<StorageVolume, "checkedAt">>;
  /** Whether a measured slot directory still holds anything. */
  slotPresent?: (path: string) => boolean;
  /**
   * How much free space the volume must lose, since the last walk began, before an early walk
   * runs, given that walk's measured total; or null for never. The daemon answers with
   * `remeasureGrowthFor` over the saved limits. Absent: never.
   */
  remeasureGrowthBytes?: (measuredTotalBytes: number) => number | null;
  /**
   * Free-space levels a reading must never be held across: the free-space floor. A reading on
   * the other side of one replaces the held one at once, whatever the 64 MiB step says.
   */
  volumeThresholds?: () => number[];
  remeasureMinIntervalMs?: number;
  now?: () => number;
  /** Called whenever the measurement, its state or the volume moved. */
  onChange: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse `du -k` output into sizes relative to `root`. Lines it cannot read are skipped. */
export function parseDiskUsage(stdout: string, root: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kib = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1);
    if (!Number.isFinite(kib) || kib < 0 || !isAbsolute(path)) continue;
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    sizes.set(rel.split(sep).join("/"), kib * 1024);
  }
  return sizes;
}

/**
 * The state directory as `du` must be given it. `du` does not follow a symlink named on its
 * command line, so a `MISSION_HOME` that is a link would measure the link and nothing in it. The
 * root is resolved first, and every path `du` prints is read back against that same resolved
 * root. Symlinks inside the directory are still not followed.
 */
function walkRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

async function duListing(root: string): Promise<DiskUsageListing> {
  const resolved = walkRoot(root);
  const result: RunResult = await run(
    "du",
    ["-k", "-x", "-d", String(MEASURE_DEPTH), resolved],
    { timeoutMs: MEASURE_TIMEOUT_MS, maxBuffer: MEASURE_MAX_BUFFER },
  );
  if (result.outcomeUnknown) {
    throw new Error("Measuring took longer than 15 minutes and was stopped.");
  }
  if (result.overflowed) throw new Error("The state directory listing was too large to read.");
  const directories = parseDiskUsage(result.stdout, resolved);
  if (!directories.has("")) {
    throw new Error(result.stderr.trim().split("\n")[0] || "du returned no total for the state directory.");
  }
  return {
    directories,
    // `du` exits 1 when it could not read some entries but still prints what it could.
    partial: result.code === 0 ? null : "Some files could not be read, so sizes may be low.",
  };
}

function allocatedBytes(path: string): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? null : stat.blocks * 512;
  } catch {
    return null;
  }
}

/** A slot's directory is gone once it is missing or empty: removal can leave the empty ordinal. */
function slotDirectoryPresent(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/**
 * The measured key for a path beneath the root: relative, `/`-separated, and for anything inside
 * a pool cut to `worktree-pools/<pool>/<ordinal>`, the depth the walk lists slots at.
 */
function measuredKey(root: string, path: string): string {
  const parts = relative(root, path).split(sep);
  return (parts[0] === POOLS_ROOT ? parts.slice(0, 3) : parts).join("/");
}

/** Allocated bytes beneath `path`, counted as `du` counts them: every file once, no link followed. */
function allocatedTreeBytes(path: string): number | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return stat.blocks * 512;
    let total = stat.blocks * 512;
    for (const entry of readdirSync(path)) total += allocatedTreeBytes(join(path, entry)) ?? 0;
    return total;
  } catch {
    return null;
  }
}

/**
 * Replace each settled directory's size in a finished listing with what it holds now, moving its
 * ancestors (the root included) by the same difference so everything still adds up.
 */
export function settleListing(
  listing: DiskUsageListing,
  root: string,
  directoryBytes: (path: string) => number | null,
  settled: readonly string[] = SETTLED_AT_FINISH,
): DiskUsageListing {
  const directories = new Map(listing.directories);
  for (const rel of settled) {
    const listed = directories.get(rel);
    if (listed === undefined) continue;
    const now = directoryBytes(join(root, rel));
    if (now === null || now === listed) continue;
    const delta = now - listed;
    directories.set(rel, now);
    const parts = rel.split("/");
    for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
      const ancestor = parts.slice(0, depth).join("/");
      const size = directories.get(ancestor);
      if (size !== undefined) directories.set(ancestor, Math.max(0, size + delta));
    }
  }
  return { ...listing, directories };
}

async function volumeOf(root: string): Promise<Omit<StorageVolume, "checkedAt">> {
  const stats = await statfs(root);
  return {
    totalBytes: Math.max(0, Math.round(stats.blocks * stats.bsize)),
    freeBytes: Math.max(0, Math.round(stats.bavail * stats.bsize)),
  };
}

/**
 * Turn one directory listing into category sizes. Each category owns its roots; whatever no
 * category names, including top-level files such as logs, lands in `other`, so the categories
 * add up to the measured total.
 */
export function measurementFrom(input: {
  root: string;
  listing: DiskUsageListing;
  fileBytes: (path: string) => number | null;
  measuredAt: number;
  durationMs: number;
}): StorageMeasurement {
  const { root, listing, fileBytes } = input;
  const total = listing.directories.get("") ?? 0;
  const categories: Array<{ id: StorageCategoryId; bytes: number }> = [];
  let claimed = 0;
  for (const category of STORAGE_CATEGORIES) {
    if (category.id === "other") continue;
    let bytes = 0;
    for (const entry of category.roots) {
      const listed = listing.directories.get(entry);
      bytes += listed ?? (entry.includes("/") ? 0 : fileBytes(join(root, entry)) ?? 0);
    }
    claimed += bytes;
    categories.push({ id: category.id, bytes });
  }
  categories.push({ id: "other", bytes: Math.max(0, total - claimed) });

  const pools: Array<{ name: string; bytes: number }> = [];
  const slotBytes = new Map<string, number>();
  for (const [path, bytes] of listing.directories) {
    const parts = path.split("/");
    if (parts[0] !== POOLS_ROOT) continue;
    if (parts.length === 2) pools.push({ name: parts[1]!, bytes });
    else if (parts.length === 3) slotBytes.set(path, bytes);
  }
  pools.sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
  return {
    measuredAt: input.measuredAt,
    durationMs: input.durationMs,
    totalBytes: total,
    categories,
    pools,
    slotBytes,
    partial: listing.partial,
  };
}

/**
 * The state directory's measured size and its volume's free space, behind Settings > Storage.
 *
 * A measurement is one background `du` walk, single-flight, on a schedule and on request; the
 * last one stays shown, with when it finished, until the next replaces it. The volume is a
 * `statfs` call, cheap enough to repeat every minute, which is what lets a low-space warning
 * arrive while it can still help.
 */
export class StorageUsageMonitor {
  private last: StorageMeasurement | null = null;
  private running: Promise<void> | null = null;
  private error: string | null = null;
  private volumeReading: StorageVolume | null = null;
  private lastMeasureStartedAt: number | null = null;
  /** Free space when the last successful walk began: the baseline growth is measured from. */
  private freeAtLastMeasure: number | null = null;
  private readonly listDirectories: (root: string) => Promise<DiskUsageListing>;
  private readonly directoryBytes: (path: string) => number | null;
  private readonly fileBytes: (path: string) => number | null;
  private readonly readVolume: (root: string) => Promise<Omit<StorageVolume, "checkedAt">>;
  private readonly slotPresent: (path: string) => boolean;
  private readonly now: () => number;

  constructor(private readonly deps: StorageUsageDeps) {
    this.listDirectories = deps.listDirectories ?? duListing;
    this.directoryBytes = deps.directoryBytes ?? allocatedTreeBytes;
    this.fileBytes = deps.fileBytes ?? allocatedBytes;
    this.readVolume = deps.volume ?? volumeOf;
    this.slotPresent = deps.slotPresent ?? slotDirectoryPresent;
    this.now = deps.now ?? Date.now;
  }

  get root(): string {
    return this.deps.root;
  }

  /** The last measurement, including the per-slot sizes only the daemon reads. */
  measurement(): StorageMeasurement | null {
    return this.last;
  }

  /**
   * One native slot's measured size, from its recorded checkout path, or null when the last
   * measurement did not reach it. The recorded path and the measured root may be spelled
   * differently (a symlinked home, such as macOS's `/var` and `/private/var`), so a path that is
   * not beneath the root as spelled is tried again through `realpath`.
   */
  slotBytes(path: string): number | null {
    const sizes = this.last?.slotBytes;
    if (!sizes) return null;
    const direct = sizes.get(measuredKey(this.deps.root, path));
    if (direct !== undefined) return direct;
    try {
      return sizes.get(measuredKey(realpathSync(this.deps.root), realpathSync(path))) ?? null;
    } catch {
      return null;
    }
  }

  usage(): StorageUsage {
    const last = this.last;
    return {
      root: this.deps.root,
      measuredAt: last?.measuredAt ?? null,
      durationMs: last?.durationMs ?? null,
      measuring: this.running !== null,
      error: this.error ?? last?.partial ?? null,
      totalBytes: last?.totalBytes ?? null,
      categories: last?.categories ?? [],
      pools: last?.pools.slice(0, STORAGE_USAGE_POOL_LIMIT) ?? [],
    };
  }

  volume(): StorageVolume | null {
    return this.volumeReading;
  }

  /** Start a measurement, or join the one already running. Never rejects. */
  measure(): Promise<void> {
    if (this.running) return this.running;
    const started = this.now();
    const freeAtStart = this.volumeReading?.freeBytes ?? null;
    this.lastMeasureStartedAt = started;
    this.running = (async () => {
      try {
        // Settled with no await between it and the publish below (`changed` in `finally`), so
        // Storage reads the kept copies at the same instant the backup folder was summed.
        const listing = settleListing(await this.listDirectories(this.deps.root), this.deps.root, this.directoryBytes);
        const finished = this.now();
        this.last = measurementFrom({
          root: this.deps.root,
          listing,
          fileBytes: this.fileBytes,
          measuredAt: finished,
          durationMs: Math.max(0, finished - started),
        });
        this.freeAtLastMeasure = freeAtStart;
        this.error = null;
      } catch (error) {
        this.error = errorMessage(error);
        console.warn(`[mission-control] storage measurement failed: ${this.error}`);
      } finally {
        this.running = null;
        this.changed();
      }
    })();
    this.changed();
    return this.running;
  }

  /** Read the volume's free space now. A failure keeps the last reading. Never rejects. */
  async checkVolume(): Promise<void> {
    try {
      const reading = await this.readVolume(this.deps.root);
      this.remeasureIfGrown(reading.freeBytes);
      const previous = this.volumeReading;
      const crossed = previous !== null && (this.deps.volumeThresholds?.() ?? [])
        .some((level) => (previous.freeBytes < level) !== (reading.freeBytes < level));
      if (previous && !crossed && previous.totalBytes === reading.totalBytes &&
        Math.abs(previous.freeBytes - reading.freeBytes) < VOLUME_STEP_BYTES) {
        return;
      }
      this.volumeReading = { ...reading, checkedAt: this.now() };
      this.changed();
    } catch (error) {
      console.warn(`[mission-control] storage volume check failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Start an early walk, while a storage limit is set, when the volume has lost enough free space
   * since the last walk began that the state directory may have crossed its next threshold, or
   * when the last walk is old enough (`LIMIT_SET_MAX_AGE_MS`, or the minimum interval when close
   * to a threshold) that growth hidden by space freed elsewhere could have. The minimum interval
   * bounds what either costs.
   */
  private remeasureIfGrown(freeBytes: number): void {
    if (!this.last || this.running || this.lastMeasureStartedAt === null) return;
    const needed = this.deps.remeasureGrowthBytes?.(this.last.totalBytes) ?? null;
    if (needed === null) return;
    const age = this.now() - this.lastMeasureStartedAt;
    const minInterval = this.deps.remeasureMinIntervalMs ?? REMEASURE_MIN_INTERVAL_MS;
    if (age < minInterval) return;
    // Close to a threshold (less than the 1 GiB cap left), the walk is due every interval;
    // otherwise once its age reaches the hour. Either way, no net free-space loss is needed.
    const maxAge = needed < REMEASURE_GROWTH_BYTES ? minInterval : LIMIT_SET_MAX_AGE_MS;
    const lostEnough = this.freeAtLastMeasure !== null && this.freeAtLastMeasure - freeBytes >= needed;
    if (!lostEnough && age < maxAge) return;
    void this.measure();
  }

  /**
   * Drop measured slots that are gone from disk, so a cleanup shows in the totals at once
   * instead of at the next measurement. Only ever lowers the numbers; a slot created since the
   * measurement is counted by the next one.
   */
  forgetRemovedSlots(): void {
    const last = this.last;
    if (!last) return;
    let freed = 0;
    const byPool = new Map<string, number>();
    for (const [path, bytes] of last.slotBytes) {
      if (this.slotPresent(join(this.deps.root, path))) continue;
      last.slotBytes.delete(path);
      freed += bytes;
      const pool = path.split("/")[1]!;
      byPool.set(pool, (byPool.get(pool) ?? 0) + bytes);
    }
    if (freed === 0) return;
    this.last = {
      ...last,
      totalBytes: Math.max(0, last.totalBytes - freed),
      categories: last.categories.map((category) => category.id === "pools"
        ? { ...category, bytes: Math.max(0, category.bytes - freed) }
        : category),
      pools: last.pools
        .map((pool) => ({ ...pool, bytes: Math.max(0, pool.bytes - (byPool.get(pool.name) ?? 0)) }))
        .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name)),
    };
    this.changed();
  }

  /** Begin the schedule. Returns the function that stops it. */
  start(schedule: { firstMeasureMs: number; measureEveryMs: number; volumeEveryMs: number }): () => void {
    void this.checkVolume();
    const first = setTimeout(() => void this.measure(), schedule.firstMeasureMs);
    const measureLoop = setInterval(() => void this.measure(), schedule.measureEveryMs);
    const volumeLoop = setInterval(() => void this.checkVolume(), schedule.volumeEveryMs);
    first.unref?.();
    measureLoop.unref?.();
    volumeLoop.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(measureLoop);
      clearInterval(volumeLoop);
    };
  }

  private changed(): void {
    try {
      this.deps.onChange();
    } catch (error) {
      console.warn(`[mission-control] storage change listener failed: ${errorMessage(error)}`);
    }
  }
}
