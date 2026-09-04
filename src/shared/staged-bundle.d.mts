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
