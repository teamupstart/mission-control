// Browser-safe update contracts. This module is consumed by Electron today and by the
// renderer in Phase 3, so it must not import any node: modules.

import type { UpdatePrepareStage } from "./update-stages.mjs";

export {
  UPDATE_PREPARE_STAGES,
  UPDATE_PROGRESS_MARKER,
  UPDATE_STAGED_MARKER,
  isUpdatePrepareStage,
  parseUpdateProgressLine,
  updatePrepareProgress,
} from "./update-stages.mjs";
export type {
  UpdatePrepareProgress,
  UpdatePrepareStage,
  UpdateProgressLine,
} from "./update-stages.mjs";

export const UPDATE_PHASES = [
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "preparing",
  "ready",
  "applying",
  "error",
] as const;

export type UpdateApplyOutcome =
  | { result: "in-progress"; targetVersion: string; recordedAt: string }
  | { result: "success"; targetVersion: string; recordedAt: string; launchVerified?: boolean }
  | { result: "failure"; targetVersion: string; recordedAt: string; message: string };

export interface UpdateMigration {
  kind?: "rename";
  source: string;
  target: string;
  status: "offered" | "repair-required" | "complete";
  repairs: {id: string; message: string}[];
}

export interface UpdateTransfer { received: number; total: number }

interface SnapshotBase {
  lastOutcome: UpdateApplyOutcome | null;
  /** Absent on older desktop bridges; alpha is opt-in. */
  alpha?: boolean;
  migration?: UpdateMigration;
}

export type UpdateSnapshot =
  | (SnapshotBase & { phase: "disabled"; reason: string })
  | (SnapshotBase & {
      phase: "idle";
      currentVersion: string;
      lastCheckedAt: number | null;
    })
  | (SnapshotBase & { phase: "checking"; currentVersion: string; manual: boolean })
  | (SnapshotBase & { phase: "up-to-date"; currentVersion: string; checkedAt: number })
  | (SnapshotBase & {
      phase: "available";
      currentVersion: string;
      newVersion: string;
      releaseTag: string;
      /** Full main commit for an alpha offer; releaseTag carries the same pinned build ref. */
      commitSha?: string;
      releaseName: string;
      releaseNotes: string;
      publishedAt: string;
      checkedAt: number;
      /** A recoverable prerequisite failure. The release remains visible, but cannot build. */
      blocker?: string;
    })
  /**
   * The binary update is being prepared while this app keeps running.
   *
   * Download and verification use a private attempt directory without changing the installed
   * app. `stage` is what the preparation worker last reported; together with `transfer`, it
   * supplies the step and progress that `updatePrepareProgress` renders.
   */
  | (SnapshotBase & {
      phase: "preparing";
      currentVersion: string;
      newVersion: string;
      releaseTag: string;
      stage: UpdatePrepareStage;
      /** Actual downloaded bytes; absent on older bridges and non-download stages. */
      transfer?: UpdateTransfer;
      /**
       * Cancel was pressed and binary preparation is stopping.
       *
       * Remain `preparing` until the attempt's worker and subprocess group have settled and
       * its private directory has been cleaned up. Only then does the offer return and a new
       * attempt become available; cancellation never changes the installed app or receipt.
       */
      cancelling: boolean;
    })
  /** Built and verified, waiting for the person to accept the restart that installs it. */
  | (SnapshotBase & {
      phase: "ready";
      currentVersion: string;
      newVersion: string;
      releaseTag: string;
      stagedAt: number;
    })
  /**
   * The seconds between accepting the restart and this process going away.
   *
   * Everything long has already happened: the detached helper waits for this process to exit,
   * swaps the bundle it was handed, and relaunches.
   */
  | (SnapshotBase & {
      phase: "applying";
      currentVersion: string;
      newVersion: string;
      stage: "starting" | "handed-off";
    })
  | (SnapshotBase & {
      phase: "error";
      currentVersion: string;
      message: string;
      manual: boolean;
      retryable: boolean;
    });

/** Parse the stable numeric version format emitted by Release Please. */
export function parseReleaseVersion(version: string): number[] | null {
  const normalized = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(normalized)) return null;
  return normalized.split(".").map(Number);
}

/** Whether a release candidate is strictly newer than the running app. */
export function isNewerVersion(currentVersion: string, candidateVersion: string): boolean {
  const currentParts = parseReleaseVersion(currentVersion);
  const candidateParts = parseReleaseVersion(candidateVersion);
  if (!currentParts || !candidateParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index]! > currentParts[index]!;
    }
  }
  return false;
}

export function versionFromReleaseTag(tag: string): string | null {
  const parts = parseReleaseVersion(tag);
  return parts ? parts.join(".") : null;
}
