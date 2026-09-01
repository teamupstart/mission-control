export interface BundleOps {
  copy(from: string, to: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export interface SwapAttempt {
  problem: string | null;
  /** Whether the installed app survived the attempt, so a privileged retry is safe. */
  appIntact: boolean;
  /** Where the displaced bundle actually ended up when retaining it, including the fallback. */
  retainedAt: string | null;
  /** Paths this transaction could not clean up after itself and that still occupy disk. */
  stranded: string[];
}

export const APP_BUNDLE_NAME: string;
export const DEFAULT_APPS_DIR: string;
export const ADMINISTRATOR_AUTHORIZATION_PROMPT: string;
export const RESTORE_AUTHORIZATION_PROMPT: string;
export const PRIVILEGED_SWAP_APPLESCRIPT: string;

export function bundleOwnerSpec(
  uid: number | undefined,
  gid: number | undefined,
): string | null;
export function stagingPaths(input: { appsDir: string; pid: number | string }): {
  staged: string;
  previous: string;
  failed: string;
};
export function bundleSwapShellCommand(input: {
  sourceBundle: string;
  appPath: string;
  staged: string;
  previous: string;
  failed: string;
  keepPrevious: boolean;
  owner?: string | null;
}): string;
export function privilegedBundleSwapCommand(input: {
  sourceBundle: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious: boolean;
  owner?: string | null;
}): { command: string | null; problem: string | null };
export function attemptSwapAppBundle(input: {
  packagedApp: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  ops: BundleOps;
}): SwapAttempt;
export function swapAppBundle(input: {
  packagedApp: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  ops: BundleOps;
}): string | null;
export function plistVersion(text: unknown): string | null;
export function bundleShortVersion(
  appPath: string,
  read?: (path: string) => string,
): string | null;
export function directoryIsWritable(
  path: string,
  access?: (path: string, mode: number) => void,
): boolean;
export function directoryTreeIsWritable(root: string): boolean;
export function sweepDisplacedBundles(input: {
  appsDir: string;
  keepPid: number | string;
  readdir?: (path: string) => string[];
  remove?: (path: string) => void;
  /** Must be conservative: anything short of proof of absence keeps the bundle. */
  isRunning?: (pid: number) => boolean;
}): string[];
export function replaceAppBundle(input: {
  sourceBundle: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  prompt?: string;
  platform?: NodeJS.Platform;
  appsDirWritable?: boolean;
  owner?: string | null;
  sweep?: () => string[];
  ops?: BundleOps;
  runElevated?: (command: string, prompt: string) => void;
}): {
  problem: string | null;
  elevated: boolean;
  failedBundle: string | null;
  /**
   * Bundles that could not be reclaimed and still occupy disk: those displaced by earlier
   * privileged installs, and any this transaction could not clean up after itself.
   */
  stranded: string[];
};
