export interface ApplyUpdateArgs {
  sourceClone: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
  /**
   * A bundle the app already built and verified before it quit, or null to build from the
   * clone as the helper always did.
   */
  stagedBundle?: string | null;
  /**
   * What that bundle was when the app verified it, forwarded to the install script so the last
   * reader before the swap can refuse a bundle that changed in between.
   */
  stagedRevision?: string | null;
}

/**
 * A helper's claim on the update lock.
 *
 * `identity` is the writer's process start time AND command line, because the start time alone
 * has one-second granularity and would compare equal for a pid reused within the same second.
 */
export interface ClaimEntry {
  createdAtMs: number;
  pid: number;
  name: string;
  identity?: string | null;
}

export interface HelperLockOps {
  /** This helper's own pid, so a test can act as a helper other than the test process. */
  pid: number;
  now(): number;
  identity(pid: number): string | null;
  isLive(entry: { pid: number; identity?: string | null }): boolean;
  ensureDirectory(directory: string): void;
  list(directory: string): string[];
  /** Must publish the entry atomically, so it is never visible half-written. */
  writeEntry(directory: string, name: string, body: string): void;
  readEntry(directory: string, name: string): { pid?: number; identity?: string | null } | null;
  removeEntry(directory: string, name: string): void;
}

export interface ApplyOperations {
  exists(path: string): boolean;
  remove(path: string): void;
  move(from: string, to: string): void;
  copy(from: string, to: string): void;
  nowIso(): string;
  waitForParent(pid: number): Promise<void>;
  install(
    node: string,
    script: string,
    tag: string,
    appsDir: string,
    stagedBundle?: string | null,
    stagedRevision?: string | null,
  ): void;
  restoreApp(backupApp: string, appPath: string, pid: number): string | null;
  bundleVersion(path: string): string | null;
  lock: HelperLockOps;
  launch(appPath: string): void;
  log(line: string): void;
}

export const UPDATE_OUTCOME_SCHEMA: number;
export const INSTALL_TIMEOUT_MS: number;
export const STAGED_INSTALL_TIMEOUT_MS: number;
export const RETAINED_FAILURE_DIR_NAME: string;
export const HELPER_LOCK_DIR_NAME: string;
export function processIsAlive(pid: number, kill?: (pid: number) => void): boolean;
export function processIdentity(
  pid: number,
  run?: (pid: number) => string,
): string | null;
export function claimIsLive(
  entry: { pid: number; identity?: string | null },
  deps?: { alive?: (pid: number) => boolean; identity?: (pid: number) => string | null },
): boolean;
export function claimPrecedes(
  a: { createdAtMs: number; pid: number },
  b: { createdAtMs: number; pid: number },
): boolean;
export function claimEntryName(input: { createdAtMs: number; pid: number }): string;
export function parseClaimEntryName(name: string): ClaimEntry | null;
export function stagingEntryName(pid: number, createdAtMs: number): string;
export function parseStagingEntryName(
  name: string,
): { pid: number; name: string } | null;
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
  stagedInstallTimeoutMs?: number,
): ApplyOperations;
export function runApplyUpdate(
  args: ApplyUpdateArgs,
  ops?: ApplyOperations,
): Promise<{ ok: boolean; message: string | null }>;
