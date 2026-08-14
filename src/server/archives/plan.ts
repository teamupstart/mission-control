import {
  ARCHIVE_LIMITS,
  ARCHIVE_REPORT_DIR,
  ARCHIVE_TEXT_LIMITS,
  type ArchiveCaptureStatus,
  type ArchiveManifestArtifact,
  type ArchiveManifestMissing,
} from "@shared/archives.ts";
import type { ArchiveCaptureJob, ArchiveRepoSlot } from "./capture-store.ts";

/**
 * What a capture is going to copy, and who decides.
 *
 * The seam between the two halves of capture. Everything else in this directory is
 * kind-agnostic bundle mechanics - stage, copy, digest, verify, rename - and none of it
 * knows what a scout is or where a report lives. A KIND contributes exactly one thing: a
 * planner that turns "this job, these checkouts" into "these files, at these paths inside
 * the bundle, and here is what is honestly missing". `planners.ts` is the registry that
 * maps one to the other.
 *
 * The plan is produced BEFORE anything is written, which is what lets a bad submission be
 * refused with every offending path named at once rather than one per round trip.
 */

/** A checkout this capture may read from, with its root resolved to a real path. */
export interface ResolvedRoot extends ArchiveRepoSlot {
  /** The realpath of `root`, or null when the checkout is gone or was never provisioned. */
  realRoot: string | null;
}

export interface PlannedFile {
  /** Absolute, realpath'd, proven to be a regular file with no symlinked component. */
  source: string;
  /** The validated file identity. The opened handle must still name this exact inode. */
  sourceDev: number;
  sourceIno: number;
  /** Where it lands inside the bundle. Already `validateArchivePath`-legal. */
  archivePath: string;
  role: ArchiveManifestArtifact["role"];
  repoSlot: string;
  /** The checkout-relative path, recorded in the manifest as provenance. */
  originalPath: string;
  bytes: number;
}

export type CapturePlan =
  | { ok: true; files: PlannedFile[]; missing: ArchiveManifestMissing[]; captureStatus: ArchiveCaptureStatus }
  | { ok: false; problems: string[] };

/**
 * The injection points a planner may be handed. Deliberately narrow.
 *
 * A planner gets no library root, no producer label, and no rename hook: it decides what to
 * copy and nothing about where bytes land, which is what keeps "which files" and "where do
 * they go" separable questions.
 */
export interface CapturePlanDeps {
  /** Injected so a test can swap a report subdirectory immediately before it is traversed. */
  beforeCompanionDirectory?: (directory: string) => Promise<void>;
}

/** How one kind decides which checkout files become its bundle. */
export type CapturePlanner = (
  job: ArchiveCaptureJob,
  roots: ResolvedRoot[],
  deps: CapturePlanDeps,
) => Promise<CapturePlan>;

/** Every limit a planned capture would cross, by name. Applied before anything is written. */
export function limitProblems(files: readonly PlannedFile[]): string[] {
  const problems: string[] = [];
  const reportFiles = files.filter((file) => file.archivePath.startsWith(`${ARCHIVE_REPORT_DIR}/`));
  const reportBytes = reportFiles.reduce((sum, file) => sum + file.bytes, 0);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (reportFiles.length > ARCHIVE_LIMITS.reportDirectoryEntries) {
    problems.push(
      `the report directory holds ${reportFiles.length} files, over the ${ARCHIVE_LIMITS.reportDirectoryEntries} limit`,
    );
  }
  if (reportBytes > ARCHIVE_LIMITS.reportDirectoryBytes) {
    problems.push(
      `the report directory is ${reportBytes} bytes, over the ${ARCHIVE_LIMITS.reportDirectoryBytes} limit`,
    );
  }
  if (files.length > ARCHIVE_LIMITS.entries) {
    problems.push(`the archive would hold ${files.length} files, over the ${ARCHIVE_LIMITS.entries} limit`);
  }
  if (totalBytes > ARCHIVE_LIMITS.bundleBytes) {
    problems.push(`the archive would be ${totalBytes} bytes, over the ${ARCHIVE_LIMITS.bundleBytes} limit`);
  }
  return problems;
}

/** A refusal or omission reason, bounded to what an index row can safely carry. */
export function clipReason(reason: string): string {
  return reason.slice(0, ARCHIVE_TEXT_LIMITS.error);
}

