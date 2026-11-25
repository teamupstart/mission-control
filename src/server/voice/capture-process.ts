import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../state-ownership-native.ts";

const binding = (addon: string) => createRequire(import.meta.url)(addon) as {
  captureProcessLock(fd: number, offset: number, pid: number): number;
  captureProcessExited(watch: number): boolean;
};

function openLock(path: string, create: boolean) {
  const fd = openSync(path, constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY), 0o600);
  if (fstatSync(fd).isFile()) return fd;
  closeSync(fd);
  throw new Error("Invalid capture lifetime lock file.");
}

export function claimCaptureProcess(path: string, offset: number, addon: string) {
  const fd = openLock(path, true);
  try { binding(addon).captureProcessLock(fd, offset, 0); }
  catch (error) { closeSync(fd); throw error; }
  // Keep the process-owned POSIX lock until this listener exits.
  return fd;
}

export function watchCaptureProcess(path: string, offset: number, pid: number) {
  const native = binding(nativeStateLockAddonPath());
  const fd = openLock(path, false);
  try {
    const watch = native.captureProcessLock(fd, offset, pid);
    return { exited: () => native.captureProcessExited(watch), close: () => closeSync(watch) };
  } finally { closeSync(fd); }
}
