import type { ProcessRecord } from './update-lock.mjs';
import type { MigrationPorts, MigrationPolicy } from './install-migration.mjs';
export function migrationDelay(ms: number): Promise<void>;
export function boundedMigrationWait(predicate: () => boolean | Promise<boolean>, message: string, options?: {timeout?: number; delay?: (ms: number) => Promise<void>}): Promise<void>;
export function sameMigrationProcess(record: ProcessRecord | null): boolean;
export function migrationPortOccupied(port: number): Promise<boolean>;
export function migrationRuntimePorts(options: {parent?: ProcessRecord; port: number; timeout?: number; inventory?: unknown; checkpoint?: (stage: string) => void}): MigrationPorts;
export function verifyMigrationAssets(bundle: string): void;
export function migrationStartupGate(options: {stateDirectory: string; runningBundle: string; nonce?: string; port: number; policy?: MigrationPolicy; timeout?: number}): Promise<{proceed: boolean; committed: boolean; fresh: boolean}>;
