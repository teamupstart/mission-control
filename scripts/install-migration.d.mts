import type { InstallReceipt } from '../src/shared/install-receipt-schema.mjs';
import type { LockOperations, ProcessRecord } from './update-lock.mjs';
export interface MigrationIdentity { commit: string | null; version: string | null; revision: string | null; protocol: number | null; automatic: boolean }
export interface MigrationPlan {
  protocol: number; nonce: string; source: string; target: string; stateDirectory: string;
  stagedBundle: string; stagedRevision: string; sourceIdentity: MigrationIdentity; targetIdentity: MigrationIdentity;
  oldReceipt: InstallReceipt; intendedReceipt: InstallReceipt;
}
export interface MigrationRepair { id: string; status: 'complete' | 'pending'; message: string }
export interface MigrationJournal {
  plan: MigrationPlan; owner: ProcessRecord; ownerRole: 'helper' | 'recovery'; stage: string; repairs: MigrationRepair[];
  inventory: unknown; targetProcess: ProcessRecord | null;
}
export interface MigrationPolicy { home?: string; systemDirectory?: string }
export const MIGRATION_PROTOCOL: number;
export const MIGRATION_JOURNAL: string;
export const MIGRATION_ACK: string;
export const MIGRATION_LAUNCH: string;
export const MIGRATION_STAGES: string[];
export const MIGRATION_TIMEOUT_MS: number;
export function readMigrationJson(path: string): any;
export function atomicMigrationJson(path: string, value: unknown): void;
export function receiptDigest(receipt: InstallReceipt): string;
export function migrationBundleIdentity(bundle: string): MigrationIdentity;
export function migrationPaths(home?: string, systemDirectory?: string): { source: string; target: string };
export function validateMigrationPaths(plan: MigrationPlan, policy?: MigrationPolicy): void;
export function prepareMigration(args: { receipt: InstallReceipt; stagedBundle: string; stagedRevision: string; stateDirectory: string; home?: string; systemDirectory?: string }): MigrationPlan | null;
export function validateMigrationPlan(plan: unknown, policy?: MigrationPolicy): MigrationPlan;
export function readMigrationJournal(stateDirectory: string, policy?: MigrationPolicy): MigrationJournal | null;
export function migrationIsCommitted(journal: MigrationJournal, receipt: InstallReceipt | null): boolean;
export function ownsMigrationTarget(plan: MigrationPlan): boolean;
export function stageMigrationTarget(plan: MigrationPlan, options?: { policy?: MigrationPolicy; checkpoint?: (stage: string) => void }): void;
export function validateMigrationTarget(plan: MigrationPlan): void;
export function migrationReceipt(stateDirectory: string): InstallReceipt;
export function withMigrationLock<T>(stateDirectory: string, action: (owner: ProcessRecord) => Promise<T> | T, lock?: LockOperations): Promise<T>;
export interface MigrationPorts {
  inventory?: unknown; checkpoint?: (stage: string) => void;
  waitForParent(): Promise<void>; waitForDaemonExit(): Promise<void>;
  launchTarget(plan: MigrationPlan): Promise<ProcessRecord>; waitForReady(journal: MigrationJournal): Promise<void>;
  stopTarget(journal: MigrationJournal): Promise<void>; launchSource(source: string): Promise<void>;
}
export function runMigration(plan: MigrationPlan, ports: MigrationPorts, options?: {policy?: MigrationPolicy; lock?: LockOperations}): Promise<{ committed: boolean; journal: MigrationJournal; error?: string; diagnostic?: string }>;
export function recoverMigration(stateDirectory: string, ports: Pick<MigrationPorts, 'stopTarget' | 'launchSource'>, options?: {policy?: MigrationPolicy; lock?: LockOperations}): Promise<MigrationJournal | null>;
export function repairMigration(stateDirectory: string, repair: (journal: MigrationJournal) => Promise<MigrationRepair[]>, options?: {policy?: MigrationPolicy; lock?: LockOperations}): Promise<MigrationJournal | null>;

export function claimInstallReceiptWriter(stateDirectory: string): () => void;
export function keepSystemInstallation(plan: MigrationPlan): Promise<InstallReceipt>;
