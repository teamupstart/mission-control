export type RecoveryRequest =
  | { kind: "restore"; candidatePath: string }
  | { kind: "rollback"; recoveryId: string };

export type DaemonHealth = {
  pid: number;
  port: number;
  version: string;
};

export type RecoveryAttempt = {
  id: string;
  digest: string;
  status: string;
  startedAt?: string;
  finishedAt?: string | null;
  rollbackDirectory?: string | null;
  rollbackOf?: string | null;
  databaseMode?: number;
  message?: string | null;
};

export type RecoveryLedger = {
  schema: 1;
  attempts: RecoveryAttempt[];
};

export type DurableWriteOperations = {
  mkdir(path: string, options: { recursive: true; mode: number }): unknown;
  write(path: string, data: string, options: { mode: number }): unknown;
  open(path: string, flags: "r"): number;
  fsync(fd: number): unknown;
  close(fd: number): unknown;
  rename(from: string, to: string): unknown;
  remove(path: string, options: { force: true }): unknown;
};

export type RecoveryOperations = {
  verifyApp(home: string, bundleId: string): string | Promise<string>;
  appIsRunning(): boolean | Promise<boolean>;
  quitApp(bundleId: string): unknown | Promise<unknown>;
  identifyDaemon(home: string): DaemonHealth | null | Promise<DaemonHealth | null>;
  signalDaemon(pid: number): unknown;
  tryAcquireLock(home: string): { release(): void } | null;
  tryAcquireLedgerLock(home: string): { release(): void } | null;
  tryAcquireRecoveryLock(home: string): { release(): void } | null;
  sleep(ms: number): Promise<unknown>;
  launchApp(appPath: string, bundleId: string): unknown;
  now(): string;
};

export type RecoveryResult = {
  ok: true;
  kind: "applied" | "already-applied" | "rolled-back";
  message: string;
  recoveryId: string;
  health: DaemonHealth | null;
  warnings: string[];
};

export const APP_BUNDLE_ID: string;
export const DATABASE_FILE: string;
export const RECOVERY_DIRECTORY: string;
export const RECOVERY_LEDGER: string;
export const STOP_TIMEOUT_MS: number;
export const HEALTH_TIMEOUT_MS: number;
export const MAX_RECOVERY_ATTEMPTS: number;
export const MAX_ROLLBACK_DIRECTORIES: number;
export const LEDGER_LOCK_TIMEOUT_MS: number;
export const RECOVERY_LOCK_TIMEOUT_MS: number;

export function parseArgs(argv: string[]): {
  args: RecoveryRequest | null;
  problem: string | null;
};
export function readRecoveryLedger(home: string): RecoveryLedger;
export function durableWriteJson(
  path: string,
  value: unknown,
  operations?: DurableWriteOperations,
): void;
export function prepareCandidate(candidatePath: string, home: string): {
  digest: string;
  stagedDatabase: string;
  stagingDirectory: string;
  cleanup(): void;
};
export function identifyLiveDaemon(home: string): Promise<DaemonHealth | null>;
export function recoveryStateLockAddonPath(moduleUrl?: string): string;
export function realRecoveryOperations(): RecoveryOperations;
export function runDatabaseRecovery(
  request: RecoveryRequest,
  options?: {
    home?: string;
    ops?: RecoveryOperations | null;
    stopTimeoutMs?: number;
    healthTimeoutMs?: number;
    installDatabase?: (home: string, stagedDatabase: string) => void;
    pruneRollbacks?: (home: string, keepId: string) => void | Promise<void>;
    beforeAppliedLedgerWrite?: (() => void | Promise<void>) | null;
  },
): Promise<RecoveryResult>;
