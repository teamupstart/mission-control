import type { BinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';
import type { Configuration } from 'electron-builder';
export function distributionCredentials(env: NodeJS.ProcessEnv, policy: {teamId: string}): {appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string};
export function distributionBuilderConfig(metadata: BinaryBuildMetadata, identity: string, output: string): Configuration;
export function packageDistribution(options?: {repoRoot?: string; env?: NodeJS.ProcessEnv}): Promise<void>;
export function runDistributionCli(produce?: () => Promise<void>): Promise<void>;
