import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeStateLockBinding {
  acquire(path: string, owner: string): unknown;
  release(handle: unknown): void;
}

type RequireFn = (id: string) => unknown;

export function nativeStateLockAddonPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../dist/native/state-lock.node");
}

export function validateNativeStateLockBinding(value: unknown): NativeStateLockBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("acquire" in value) ||
    typeof value.acquire !== "function" ||
    !("release" in value) ||
    typeof value.release !== "function"
  ) {
    throw new Error("native state lock addon must export acquire and release functions");
  }
  return value as NativeStateLockBinding;
}

export function loadNativeStateLockBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeStateLockBinding {
  return validateNativeStateLockBinding(requireFn(nativeStateLockAddonPath()));
}
