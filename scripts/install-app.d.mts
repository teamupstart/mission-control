export interface CommandResult {
  status: number;
  stdout: string;
  stderr?: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface ParsedRemote {
  host: string;
  slug: string;
  transport: "ssh" | "https";
}

export interface BundleOps {
  copy(from: string, to: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export interface CloneReplaceOps {
  move(from: string, to: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

export type TargetRefSource = "flag" | "release" | "default-branch";

export const APP_BUNDLE_NAME: string;
export const DEFAULT_APPS_DIR: string;
export const SOURCE_CLONE_DIR_NAME: string;
export const PACKAGED_APP_RELATIVE_PATH: string;

export const GH_ARGS: {
  authStatus(): string[];
  releaseList(repo?: string): string[];
};

export function parseRemote(url: string | null | undefined): ParsedRemote | null;
export function canonicalRemoteUrl(transport: string, repo?: string): string;
export function existingCloneCommands(input: {
  url: string;
  repo: string;
  clone: string;
}): {
  problem: string | null;
  commands: Array<[command: string, args: string[]]>;
};
export function firstUnwritableCloneDirectory(root: string): string | null;
export function rebuildUpdaterOwnedClone(input: {
  clone: string;
  remoteUrl: string;
  pid: number | string;
  run: CommandRunner;
  ops: CloneReplaceOps;
}): { problem: string | null; preserved: string | null };
export function originMismatchMessage(originSlug: string): string;
export function resolveInstallRepo(input: {
  originSlug: string | null;
  originHost: string | null;
  fromOrigin?: boolean;
}): { repo: string | null; problem: string | null };
export const REQUIRED_REMOTE_HOST: string;
export function remoteProblem(input: { url: string; repo: string }): string | null;
export function newestStableRelease(input: {
  repo?: string;
  run: CommandRunner;
}): { tag: string | null; problem: string | null };
export function stagingPaths(input: { appsDir: string; pid: number | string }): {
  staged: string;
  previous: string;
  failed: string;
};
export function swapAppBundle(input: {
  packagedApp: string;
  appPath: string;
  appsDir: string;
  pid: number | string;
  keepPrevious?: boolean;
  ops: BundleOps;
}): string | null;
export function resolveTargetRef(input: {
  requestedRef?: string | null;
  releaseTag?: string | null;
  defaultBranchRef: string;
}): { ref: string; source: TargetRefSource };
export function receiptReleaseTag(input: { ref: string; source: TargetRefSource }): string | null;
export function plistVersion(text: string | null | undefined): string | null;
export function stagedVersionProblem(input: {
  stagedVersion: string | null;
  ref: string | null;
}): string | null;
export function appsDirProblem(input: {
  appsDir: string;
  exists: boolean;
  isDirectory: boolean;
}): string | null;
export function packagedVersionProblem(input: {
  packagedVersion: string | null;
  sourceVersion: string;
}): string | null;
export function parseArgs(argv: string[]): {
  options: {
    ref: string | null;
    fromOrigin: boolean;
    dryRun: boolean;
    appsDir: string;
    /** Emit machine-readable stage markers for the app that is watching. */
    progress: boolean;
    /** Build and verify, then stop before touching the installed app. */
    stageOnly: boolean;
    /** Install this already-built bundle: swap and receipt only. */
    fromStaged: string | null;
    /** Refuse that bundle unless it is still the one this token identifies. */
    stagedRevision: string | null;
  };
  help: boolean;
  problem: string | null;
};
