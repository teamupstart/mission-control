import type { BinaryBuildMetadata, BinaryManifest } from '../src/shared/binary-distribution.mjs';
import type { DistributionFiles } from './distribution-contract.mjs';
import type { DistributionTransport, DistributionRelease } from './distribution-github.mjs';
export interface AlphaRetentionResult {retainedAlphaCommit: string; retiredAlphaCommits: string[]}
export function retainLatestAlpha(input: {release: DistributionRelease; manifest: BinaryManifest; transport: DistributionTransport}): Promise<AlphaRetentionResult>;
export function publishDistribution(input: {metadata: BinaryBuildMetadata; files: DistributionFiles; transport: DistributionTransport}): Promise<{manifest: BinaryManifest; alreadyPublished: boolean; retainedAlphaCommit?: string; retiredAlphaCommits?: string[]}>;
export function qualifiedDistribution(directory: string, policy: {teamId: string}): Promise<{metadata: BinaryBuildMetadata; files: DistributionFiles}>;
