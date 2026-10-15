import type { MigrationPlan } from './install-migration.mjs';
import type { ProcessRecord } from './update-lock.mjs';
export function cleanupHelperSnapshots(stateDirectory: string, options?: {isLive?: (record: ProcessRecord) => boolean}): void;
export function spawnBundledUpdateHelper(args: {runtimeBundle: string; helperSource: string; stateDirectory: string; parentPid: number;
  logPath: string; argv: string[]; candidateBundle?: string; recovery?: boolean; handoff?: {plan: MigrationPlan; port: number; inventory?: unknown}; env?: NodeJS.ProcessEnv}): Promise<string>;
export function acknowledgeHelper(directory: string): void;
export function finishHelper(directory: string): void;
