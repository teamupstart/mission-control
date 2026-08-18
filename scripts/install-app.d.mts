export interface CommandResult {
  status: number;
  stdout: string;
  stderr?: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

export interface ParsedRemote {
  slug: string;
  transport: "ssh" | "https";
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
export function originMismatchMessage(originSlug: string): string;
export function resolveInstallRepo(input: {
  originSlug: string | null;
  fromOrigin?: boolean;
}): { repo: string | null; problem: string | null };
export function newestStableReleaseTag(input: {
  repo?: string;
  run: CommandRunner;
}): string | null;
export function resolveTargetRef(input: {
  requestedRef?: string | null;
  releaseTag?: string | null;
  defaultBranchRef: string;
}): { ref: string; source: TargetRefSource };
export function receiptReleaseTag(input: { ref: string; source: TargetRefSource }): string | null;
export function plistVersion(text: string | null | undefined): string | null;
export function packagedVersionProblem(input: {
  packagedVersion: string | null;
  sourceVersion: string;
}): string | null;
export function parseArgs(argv: string[]): {
  options: { ref: string | null; fromOrigin: boolean; dryRun: boolean; appsDir: string };
  help: boolean;
  problem: string | null;
};
