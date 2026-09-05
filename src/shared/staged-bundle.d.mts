/** The fields of a directory stat this module reads. */
export interface StagedBundleStats {
  ino: number;
  mtimeMs: number;
}

export function stagedBundleRevision(stats: StagedBundleStats | null | undefined): string | null;

export function stagedRevisionProblem(input: {
  expected: string | null | undefined;
  found: string | null | undefined;
}): string | null;

export interface StagedBuildIdentity {
  version: string;
  revision?: string | null;
}

export interface StagedBundlePresence {
  version: string | null;
  revision: string | null;
}

export type StagedBuildAcceptance =
  | { verdict: "installable"; revision: string }
  | { verdict: "unpinnable" }
  | { verdict: "replaced" };

export function stagedBuildAcceptance(input: {
  staged: StagedBuildIdentity | null | undefined;
  found: StagedBundlePresence | null | undefined;
}): StagedBuildAcceptance;
