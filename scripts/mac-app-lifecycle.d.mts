export interface AppProcess { pid: number; ppid: number; state: string; executable: string }
export interface AppRegistration { pid: number; bundle: string; id?: string; type?: string }
export interface LaunchAck { identity: string; nonce: string; pid: number; bundle: string }
export interface MacAppOps {
  uid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  run(command: string, args: string[], timeout?: number): Promise<{code: number; stdout: string}>;
  identity(pid: number): string | null;
  /** The kernel's argv and environment entries; undefined once the pid has exited, null when unreadable. */
  processArguments?(pid: number): {argv: string[]; env: string[]} | null | undefined;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  readAck(nonce: string): LaunchAck | null;
}
export const APP_ID: string;
export const LAUNCH_TIMEOUT_MS: number;
export const COMMAND_TIMEOUT_MS: number;
export const LAUNCH_INSPECTION_TIMEOUT_MS: number;
export function launchAckPath(directory: string, nonce: string): string;
export function updateProgressRequestPath(directory: string, nonce: string): string;
export function realMacAppOps(directory?: string): MacAppOps;
export function parseAppProcesses(output: string): AppProcess[];
export function parseLaunchServices(output: string): AppRegistration[];
export function jobLaunchesBundle(text: string, bundle: string): boolean;
export function parseGuiJobs(dump: string, uid: number): Map<string, string> | null;
export function inspectAppLaunch(bundle: string, ops?: MacAppOps, timeout?: number): Promise<{jobs: string[]; unregistered: number[]}>;
export function inspectAppLaunches(bundles: string[], ops?: MacAppOps, timeout?: number): Promise<Array<{jobs: string[]; unregistered: number[]}>>;
export function launchConflictMessage(conflicts: {jobs: string[]; unregistered: number[]}, uid: number): string | null;
export function assertSafeAppLaunch(bundle: string, ops?: MacAppOps, timeout?: number): Promise<void>;
export function assertSafeAppLaunches(bundles: string[], ops?: MacAppOps, timeout?: number): Promise<void>;
export const BUNDLE_HOLDERS_NAMED: number;
export function waitForBundleExit(bundle: string, ops: MacAppOps, timeout?: number, onWaiting?: (message: string) => void, owners?: import('./update-process-owners.mjs').UpdateProcessOwner[]): Promise<void>;
export function prepareAppLaunch(bundle: string, ops: MacAppOps, timeout?: number): Promise<void>;
export function verifyAppLaunch(bundle: string, nonce: string, ops: MacAppOps, timeout?: number): Promise<void>;
export function stopAttemptLaunch(bundle: string, nonce: string, ops: MacAppOps): Promise<void>;

export function showUpdateProgress(message: string, launch?: typeof import("node:child_process").spawn, onHidden?: () => void): () => void;
