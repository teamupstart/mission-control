import type { InstallReceipt } from '../src/shared/install-receipt-schema.mjs';
export interface PublisherPolicy {teamId: string; notarized: true}
export interface StagedInstallDescriptor {protocol: 1; bundle: string; revision: string; digest: string; bytes: number; receipt: InstallReceipt; publisher?: PublisherPolicy}
export interface StagedInstallOptions {home?: string; verifyPublisher?: (bundle: string, publisher?: PublisherPolicy) => void; checkpoint?: (stage: string) => void}
export function bundleCommit(bundle: string): string | null;
export function inspectBundle(bundle: string): {digest: string; bytes: number};
export function verifyBinaryPublisher(bundle: string, publisher?: PublisherPolicy): void;
export function prepareStagedInstall(args: {bundle: string; revision?: string | null; receipt: InstallReceipt; publisher?: PublisherPolicy}, options?: StagedInstallOptions): StagedInstallDescriptor;
export function validateStagedInstall(descriptor: StagedInstallDescriptor, options?: StagedInstallOptions): StagedInstallDescriptor;
export function requireInstallSpace(claims: {path: string; bytes: number}[], inspect?: (path: string) => {bavail: number; bsize: number}): void;
export function stageInstallBundle(descriptor: StagedInstallDescriptor, options?: StagedInstallOptions): {failedBundle: string | null};
export function installStagedApp(descriptor: StagedInstallDescriptor, options: StagedInstallOptions & {stateDirectory: string}): string;
export { isolateStagedBundle } from './install-app.mjs';

export function prepareSourceUpdate(args: {receipt: InstallReceipt; bundle: string; revision?: string | null; targetTag: string}): StagedInstallDescriptor;

export function verifyBinaryBuild(bundle: string, receipt: import("../src/shared/install-receipt-schema.mjs").BinaryInstallReceipt, publisher?: PublisherPolicy, verifyPublisher?: (bundle: string, publisher?: PublisherPolicy) => void): void;
