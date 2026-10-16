import type { ReleaseVersions } from './assert-release-version.mjs';
export function distributionInput(input: {ref: string; commit: string; head: string; versions: ReleaseVersions;
  commitTags?: string[];
  ciRuns: Array<{head_sha: string; event: string; conclusion: string; head_repository?: {full_name: string}}>;
  releasePulls?: Array<{merged_at?: string | null; merge_commit_sha?: string; base?: {ref: string; repo?: {full_name: string}};
    head?: {ref: string; repo?: {full_name: string}}; labels?: Array<{name: string}>}>;
}): {commit: string; channel: 'stable' | 'alpha' | 'skip'; tag: string};
