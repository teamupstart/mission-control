export interface ReleaseVersions {
  packageVersion: string | undefined;
  lockVersion: string | undefined;
  lockPackageVersion: string | undefined;
}

export function versionFromTag(tag: string | null | undefined): string | null;
export function releaseVersionProblem(
  input: ReleaseVersions & { tag: string | null | undefined },
): string | null;
export function readVersions(repoRoot: string): ReleaseVersions;
export function assertReleaseVersion(input: { tag: string; repoRoot: string }): number;
