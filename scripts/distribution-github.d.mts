import type { BinaryBuildMetadata } from '../src/shared/binary-distribution.mjs';
export interface DistributionRelease {id: number; tag: string}
export interface AlphaDistributionRelease extends DistributionRelease {retired?: boolean}
export interface RemoteAsset {id: number | string; name: string; state: string; size: number}
export interface DistributionTransport {
  ensureRelease(metadata: BinaryBuildMetadata): Promise<DistributionRelease>;
  listAssets(release: DistributionRelease): Promise<RemoteAsset[]>;
  upload(release: DistributionRelease, path: string): Promise<void>;
  readAsset(id: string, maxBytes: number, text?: boolean): Promise<{bytes: number; sha256: string; text?: string}>;
  listAlphaReleases(): Promise<AlphaDistributionRelease[]>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  retireAlphaRelease(release: AlphaDistributionRelease): Promise<void>;
}
export function githubDistributionTransport(options?: {command?: string; env?: NodeJS.ProcessEnv}): DistributionTransport;
