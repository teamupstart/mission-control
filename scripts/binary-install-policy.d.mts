import type { InstallReceipt, BinaryInstallReceipt } from '../src/shared/install-receipt-schema.mjs';
export function readBinaryReceipt(directory: string): InstallReceipt | null;
export function temporaryInstallLocation(path: string): boolean;
export function assertPersistentDestination(appPath: string, temporary?: (path: string) => boolean): void;
export function parseBinaryInstallArgs(argv: string[]): {bundle: string; manifest: string; scope: string | null; appsDir: string | null; dryRun: boolean; enroll: boolean};
export function binaryInstallReceipt(text: string, destination: {appsDir: string | null; installScope: string | null; problem: string | null}, previous: InstallReceipt | null, installedAt?: string): BinaryInstallReceipt;
