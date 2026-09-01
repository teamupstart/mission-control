export interface ApplyUpdateArgs {
  sourceClone: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
}

/** A helper's claim on the update lock, identified by pid and the writer's process start time. */
export interface ClaimEntry {
  createdAtMs: number;
  pid: number;
  name: string;
  startedAt?: string | null;
}

export interface HelperLockOps {
  /** This helper's own pid, so a test can act as a helper other than the test process. */
  pid: number;
  now(): number;
  startedAt(pid: number): string | null;
  isLive(entry: { pid: number; startedAt?: string | null }): boolean;
  ensureDirectory(directory: string): void;
  list(directory: string): string[];
  /** Must publish the entry atomically, so it is never visible half-written. */
  writeEntry(directory: string, name: string, body: string): void;
  readEntry(directory: string, name: string): { pid?: number; startedAt?: string | null } | null;
  removeEntry(directory: string, name: string): void;
}

export interface ApplyOperations {
  exists(path: string): boolean;
  remove(path: string): void;
  move(from: string, to: string): void;
  copy(from: string, to: string): void;
  nowIso(): string;
  waitForParent(pid: number): Promise<void>;
  install(node: string, script: string, tag: string, appsDir: string): void;
  restoreApp(backupApp: string, appPath: string, pid: number): string | null;
  bundleVersion(path: string): string | null;
  lock: HelperLockOps;
  launch(appPath: string): void;
  log(line: string): void;
}

export const UPDATE_OUTCOME_SCHEMA: number;
export const INSTALL_TIMEOUT_MS: number;
export const RETAINED_FAILURE_DIR_NAME: string;
export const HELPER_LOCK_DIR_NAME: string;
export function processIsAlive(pid: number, kill?: (pid: number) => void): boolean;
export function processStartedAt(
  pid: number,
  run?: (pid: number) => string,
): string | null;
export function claimIsLive(
  entry: { pid: number; startedAt?: string | null },
  deps?: { alive?: (pid: number) => boolean; startedAt?: (pid: number) => string | null },
): boolean;
export function claimPrecedes(
  a: { createdAtMs: number; pid: number },
  b: { createdAtMs: number; pid: number },
): boolean;
export function claimEntryName(input: { createdAtMs: number; pid: number }): string;
export function parseClaimEntryName(name: string): ClaimEntry | null;
export function acquireHelperLock(
  directory: string,
  ops: HelperLockOps,
): { ok: boolean; heldBy: number | null; entryName: string | null; problem?: string };
export function releaseHelperLock(
  directory: string,
  entryName: string,
  ops: HelperLockOps,
): void;
export function realHelperLockOperations(): HelperLockOps;
export function rollbackIsNeeded(input: {
  installedVersion: string | null;
  backupVersion: string | null;
}): boolean;
export function parseArgs(argv: string[]): {
  args: ApplyUpdateArgs | null;
  problem: string | null;
};
export function sanitizeDiagnostic(value: unknown): string;
export function installFailureSummary(output: unknown): string;
export function writeOutcome(path: string, outcome: Record<string, unknown>): void;
export function realApplyOperations(
  logPath: string,
  installTimeoutMs?: number,
): ApplyOperations;
export function runApplyUpdate(
  args: ApplyUpdateArgs,
  ops?: ApplyOperations,
): Promise<{ ok: boolean; message: string | null }>;
