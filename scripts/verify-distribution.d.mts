import type { BinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';
import type { binaryPublisherPolicy } from '../src/shared/binary-publisher-policy.mjs';
import type { DistributionFiles } from './distribution-contract.mjs';
import type { DistributionToolResult } from './distribution-diagnostics.mjs';

type PublisherPolicy = ReturnType<typeof binaryPublisherPolicy>;
export function verifyDistributionApp(app: string, metadata: BinaryBuildMetadata, policy: PublisherPolicy): Promise<void>;
export function verifyDistributionDmg(dmg: string, policy: PublisherPolicy): Promise<void>;
export function validateDistributionTicket(path: string, options?: {
  run?: (command: string, args: string[]) => DistributionToolResult;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<void>;
export function verifyDistributionArchives(options: {
  app?: string; appDigest?: string; files: DistributionFiles; metadata: BinaryBuildMetadata;
  policy: PublisherPolicy; requalifyRuntime?: boolean;
}): Promise<void>;
