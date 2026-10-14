export interface AppProcess { pid: number; ppid: number; state: string; executable: string }
export interface AppRegistration { pid: number; bundle: string; id?: string; type?: string }
export interface LaunchAck { identity: string; nonce: string; pid: number; bundle: string }
export interface MacAppOps {
  uid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  run(command: string, args: string[], timeout?: number): Promise<{code: number; stdout: string}>;
  identity(pid: number): string | null;
  kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  readAck(nonce: string): LaunchAck | null;
}
export const APP_ID: string;
export const LAUNCH_TIMEOUT_MS: number;
export function launchAckPath(directory: string, nonce: string): string;
export function realMacAppOps(directory?: string): MacAppOps;
export function parseAppProcesses(output: string): AppProcess[];
export function parseLaunchServices(output: string): AppRegistration[];
export function jobLaunchesBundle(text: string, bundle: string): boolean;
export function inspectAppLaunch(bundle: string, ops?: MacAppOps, timeout?: number): Promise<{jobs: string[]; unregistered: number[]}>;
export function launchConflictMessage(conflicts: {jobs: string[]; unregistered: number[]}, uid: number): string | null;
export function assertSafeAppLaunch(bundle: string, ops?: MacAppOps): Promise<void>;
export function waitForBundleExit(bundle: string, ops: MacAppOps, timeout?: number): Promise<void>;
export function prepareAppLaunch(bundle: string, ops: MacAppOps, timeout?: number): Promise<void>;
export function verifyAppLaunch(bundle: string, nonce: string, ops: MacAppOps, timeout?: number): Promise<void>;
export function stopAttemptLaunch(bundle: string, nonce: string, ops: MacAppOps): Promise<void>;
