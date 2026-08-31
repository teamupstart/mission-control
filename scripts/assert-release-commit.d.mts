export function releaseCommitProblem(value: unknown): string | null;

export function firstParentSubjects(input: {
  repoRoot: string;
  baseSha?: string;
  headSha?: string;
}): string[];

export function assertReleaseCommits(subjects: string[]): number;
