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
  | { result: "success"; targetVersion: string; recordedAt: string }
  | { result: "failure"; targetVersion: string; recordedAt: string; message: string };

interface SnapshotBase {
  lastOutcome: UpdateApplyOutcome | null;
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
      releaseName: string;
      releaseNotes: string;
      publishedAt: string;
      checkedAt: number;
      /** A recoverable prerequisite failure. The release remains visible, but cannot build. */
      blocker?: string;
    })
  /**
   * The new version is being built while this app keeps running.
   *
   * The build touches only the updater-owned clone, so nothing about it needs the app gone -
   * and the app is the only thing that can show a person it is happening at all. `stage` is
   * what the install script last reported, and is the whole of what a surface needs: it names
   * the step and, through `updatePrepareProgress`, places the bar.
   */
  | (SnapshotBase & {
      phase: "preparing";
      currentVersion: string;
      newVersion: string;
      releaseTag: string;
      stage: UpdatePrepareStage;
      /**
       * Cancel was pressed and the build is being torn down.
       *
       * Still `preparing`, because the work is still happening - the difference is that it is
       * now shutting down, nothing new can start until it has, and there is nothing left to
       * cancel. The offer comes back when the process group is actually gone.
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
