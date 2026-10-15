export interface BinaryIdentity {
  protocol: 1; repo: string; channel: 'stable' | 'alpha'; releaseTag: string | null;
  version: string; commit: string; platform: 'darwin'; arch: 'arm64'; bundleId: string;
  minimumSystemVersion: string; helperProtocol: {min: number; max: number};
}
export interface BinaryAsset {kind: 'app-zip' | 'dmg'; id: string; name: string; bytes: number; sha256: string}
export interface BinaryManifest extends BinaryIdentity {assets: BinaryAsset[]}
export interface BinaryBuildMetadata extends BinaryIdentity {receiptSchema: 2}
export interface BinaryProvenance {manifest: BinaryManifest; manifestSha256: string; assetId: string}
export const BINARY_MANIFEST_PROTOCOL: 1;
export const INSTALL_HELPER_PROTOCOL: 1;
export const BINARY_RECEIPT_SCHEMA: 2;
export const BINARY_REPO: string;
export const BINARY_BUNDLE_ID: string;
export const MAX_BINARY_ASSET_BYTES: number;
export function isBinaryDigest(value: unknown): boolean;
export function validateBinaryManifest(value: unknown): string | null;
export function validateBinaryBuildMetadata(value: unknown): string | null;
export function validateBinaryProvenance(value: unknown): string | null;
