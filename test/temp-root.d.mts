export const ROOT_PREFIX: string;
export const MARKER: string;
export const ROOT_ENV: string;
export const SYSTEM_TMP_ENV: string;
export const DEFAULT_SWEEP_MIN_AGE_MS: number;

export interface TempRootMarker {
  version?: number;
  kind?: string;
  pid?: unknown;
  startedAt?: unknown;
  createdAt?: unknown;
  host?: unknown;
  uid?: unknown;
}

export interface ListedProcess {
  pid: number;
  ppid?: number;
  startedAt: number | null;
  args: string;
}

export function processStartedAt(): number;
export function installTempRoot(options: { kind: string }): string;
export function testTempRoot(): string;
export function tempDir(prefix: string): string;
export function tempDirAsync(prefix: string): Promise<string>;
export function systemTempDir(): string;

export function listProcesses(): ListedProcess[] | null;
export function ownerState(marker: TempRootMarker, processes: ListedProcess[] | null | undefined): "alive" | "dead" | "unknown";
export function processesUnder(
  roots: readonly string[],
  options?: { anywhere?: boolean; processes?: ListedProcess[] | null },
): ListedProcess[];
export function reapProcessesUnder(
  roots: readonly string[],
  options?: { anywhere?: boolean; timeoutMs?: number },
): ListedProcess[];

export interface SweepResult {
  removed: string[];
  kept: { path: string; reason: string }[];
}
export function sweepTempRoots(options?: {
  tmp?: string;
  minAgeMs?: number;
  now?: number;
  dryRun?: boolean;
  processes?: ListedProcess[] | null;
}): SweepResult;

export function releaseNpmCompileCache(options?: {
  tmp?: string;
  processes?: ListedProcess[] | null;
  pid?: number;
}): boolean;

export function pruneStaleFiles(
  dir: string,
  options: { maxAgeMs: number; now?: number; dryRun?: boolean },
): { bytes: number; files: number };
