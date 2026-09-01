export interface ApplyUpdateArgs {
  sourceClone: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
}

export interface HelperLockOps {
  /** Must create exclusively, so an existing lock raises EEXIST rather than being overwritten. */
  open(path: string): number;
  write(fd: number, text: string): void;
  close(fd: number): void;
  read(path: string): string;
  /**
   * Must be atomic and must raise ENOENT when the source is gone. Stale-lock reclamation is
   * built on exactly one contender being able to move a given lock file.
   */
  move(from: string, to: string): void;
  remove(path: string): void;
  alive(pid: number): boolean;
  log?(line: string): void;
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
export const HELPER_LOCK_FILE_NAME: string;
export function processIsAlive(pid: number, kill?: (pid: number) => void): boolean;
export function acquireHelperLock(
  path: string,
  ops: HelperLockOps,
): { ok: boolean; heldBy: number | null; problem?: string };
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
