export interface BundleOps {
  copy(from: string, to: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export const APP_BUNDLE_NAME: string;
export const DEFAULT_APPS_DIR: string;
export const ADMINISTRATOR_AUTHORIZATION_PROMPT: string;
export const PRIVILEGED_SWAP_APPLESCRIPT: string;

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
}): string;
export function privilegedBundleSwapCommand(input: {
  sourceBundle: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious: boolean;
}): { command: string | null; problem: string | null };
export function swapAppBundle(input: {
  packagedApp: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  ops: BundleOps;
}): string | null;
export function directoryIsWritable(
  path: string,
  access?: (path: string, mode: number) => void,
): boolean;
export function directoryTreeIsWritable(root: string): boolean;
export function replaceAppBundle(input: {
  sourceBundle: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  platform?: NodeJS.Platform;
  writable?: boolean;
  ops?: BundleOps;
  runElevated?: (command: string) => void;
}): { problem: string | null; elevated: boolean; failedBundle: string | null };
