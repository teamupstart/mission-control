import type { BinaryIdentity } from './binary-distribution.mjs';
export const APPROVED_DEVELOPER_TEAM_ID: string;
export const BINARY_MANIFEST_NAME: string;
export const MAX_BINARY_MANIFEST_BYTES: number;
export const MINIMUM_DISTRIBUTION_MACOS: string;
export function binaryPublisherPolicy(): {repo: string; bundleId: string; teamId: string; notarized: true};
export function appPublisherRequirement(teamId: string): string;
export function imagePublisherRequirement(teamId: string): string;
export function binaryReleaseTag(identity: BinaryIdentity): string;
