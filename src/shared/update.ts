// Browser-safe update contracts. This module is consumed by Electron today and by the
// renderer in Phase 3, so it must not import any node: modules.

export const UPDATE_PHASES = [
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
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
    })
  | (SnapshotBase & {
      phase: "applying";
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
