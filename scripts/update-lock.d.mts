export interface ProcessRecord { pid: number; identity: string | null }
export interface LockOperations {
  pid: number; now(): number; identity(pid: number): string | null;
  isLive(entry: ProcessRecord): boolean; ensureDirectory(path: string): void;
  list(path: string): string[]; writeEntry(dir: string, name: string, body: string): void;
  readEntry(dir: string, name: string): ProcessRecord | null; removeEntry(dir: string, name: string): void;
}
export const HELPER_LOCK_DIR_NAME: string;
export function processIdentity(pid: number): string | null;
export function processIsAlive(pid: number): boolean;
export function realHelperLockOperations(): LockOperations;
export function acquireHelperLock(directory: string, ops: LockOperations): { ok: boolean; heldBy: number | null; entryName: string | null };
export function releaseHelperLock(directory: string, entryName: string, ops: LockOperations): void;
