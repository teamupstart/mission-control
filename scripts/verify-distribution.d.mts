import type { BinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';
import type { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import type { DistributionFiles } from './distribution-contract.mjs';

type PublisherPolicy = ReturnType<typeof binaryPublisherPolicy>;
export function verifyDistributionApp(app: string, metadata: BinaryBuildMetadata, policy: PublisherPolicy): Promise<void>;
export function verifyDistributionDmg(dmg: string, policy: PublisherPolicy): void;
export function verifyDistributionArchives(options: {
  app?: string; appDigest?: string; files: DistributionFiles; metadata: BinaryBuildMetadata;
  policy: PublisherPolicy; requalifyRuntime?: boolean;
}): Promise<void>;
