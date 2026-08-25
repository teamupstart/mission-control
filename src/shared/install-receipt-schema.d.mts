export interface InstallReceipt {
  /** Append-only schema number. See `INSTALL_RECEIPT_SCHEMA`. */
  schema: number;
  /** Repository the app was installed from, as `owner/name`. */
  repo: string;
  /** Release tag installed, or `null` when installed from an untagged ref. */
  releaseTag: string | null;
  /** `package.json` version of the tree the installed app was built from. */
  installedVersion: string;
  /** Absolute path to the updater-owned clone the app was built in. */
  sourceClone: string;
  /** Absolute path to the installed app bundle. */
  appPath: string;
  /** ISO 8601 timestamp of the install. */
  installedAt: string;
}

export const CANONICAL_REPO: string;
export const FORMER_CANONICAL_REPO: string;
export function isTrustedInstallRepo(repo: string): boolean;
export const INSTALL_RECEIPT_SCHEMA: number;
export function validateReceipt(value: unknown): string | null;
