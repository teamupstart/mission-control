import type { InstallReceipt, InstallScope } from "../src/shared/install-receipt-schema.mjs";

export const SYSTEM_APPS_DIR: string;
export const USER_APPS_DIR_NAME: string;

export function userAppsDir(home?: string): string;

/** `null` where the destination is indistinguishable from a legacy install. */
export function classifyAppsDir(appsDir: string, home: string): InstallScope | null;

export function resolveInstallDestination(input: {
  /** The proposed `--scope`, or null when it was not given. */
  scope?: string | null;
  /** The long-standing `--apps-dir` override, or null when it was not given. */
  appsDir?: string | null;
  receipt?: Pick<InstallReceipt, "appPath" | "installScope"> | null;
  home?: string;
}): {
  appsDir: string | null;
  /** null means: leave the receipt field absent, which reads as legacy. */
  installScope: InstallScope | null;
  problem: string | null;
};

export function receiptAppsDir(
  receipt: Pick<InstallReceipt, "appPath"> | null | undefined,
): string | null;

export function mayCreateAppsDir(input: { appsDir: string; home?: string }): boolean;

export function installDirectoryProblem(input: {
  appsDir: string;
  home?: string;
  exists: boolean;
  isDirectory: boolean;
  /** The path with symlinks expanded, or null when it could not be resolved. */
  resolvedPath?: string | null;
  /** The home directory with symlinks expanded. */
  realHome?: string;
  /** null when ownership could not be determined. */
  ownedByUser?: boolean | null;
  writable?: boolean;
}): string | null;

export function describeInstallScope(installScope: InstallScope | null): string;

/** Gather what `installDirectoryProblem` judges, from the real filesystem. */
export function inspectInstallDirectory(
  appsDir: string,
  home?: string,
): {
  appsDir: string;
  home: string;
  exists: boolean;
  isDirectory: boolean;
  resolvedPath: string | null;
  realHome: string;
  ownedByUser: boolean | null;
  writable: boolean;
};
