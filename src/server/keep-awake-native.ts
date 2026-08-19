import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeKeepAwakeBinding {
  create(reason: string): unknown;
  release(handle: unknown): void;
}

type RequireFn = (id: string) => unknown;

/**
 * Both source (`src/server/`) and bundle (`dist/server/`) execution are two
 * directories below the repository's `dist/native` directory.
 */
export function nativeKeepAwakeAddonPath(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../dist/native/keep-awake.node");
}

export function validateNativeKeepAwakeBinding(value: unknown): NativeKeepAwakeBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("create" in value) ||
    typeof value.create !== "function" ||
    !("release" in value) ||
    typeof value.release !== "function"
  ) {
    throw new Error("native keep-awake addon must export create and release functions");
  }
  return value as NativeKeepAwakeBinding;
}

/** Load and validate the side-effect-free native module without creating an assertion. */
export function loadNativeKeepAwakeBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeKeepAwakeBinding {
  return validateNativeKeepAwakeBinding(requireFn(nativeKeepAwakeAddonPath()));
}
