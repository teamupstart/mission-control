export interface ApplyUpdateArgs {
  sourceClone: string;
  targetTag: string;
  appPath: string;
  parentPid: number;
  stateDirectory: string;
  logPath: string;
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
  launch(appPath: string): void;
  log(line: string): void;
}

export const UPDATE_OUTCOME_SCHEMA: number;
export const INSTALL_TIMEOUT_MS: number;
export const RETAINED_FAILURE_DIR_NAME: string;
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
