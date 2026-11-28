import type { ChildProcess } from "node:child_process";

export const ELECTRON_STARTUP_MAX_HOLD_MS: number;

export function acquireElectronStartupSlot(): Promise<() => void>;
export function electronStarted(child: ChildProcess): Promise<void>;
export function releaseAfterStartup(child: ChildProcess, release: () => void): void;
export function withElectronStartupSlot<T>(start: () => Promise<T>): Promise<T>;
