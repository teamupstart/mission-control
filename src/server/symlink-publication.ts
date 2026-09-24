import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "./state-ownership-native.ts";

interface NativeSymlinkPublicationBinding {
  linkSymlinkNoReplace(source: string, destination: string): void;
  exchangePaths(source: string, destination: string): void;
  renameNoReplace(source: string, destination: string): void;
}

export function validateNativeSymlinkPublicationBinding(value: unknown): NativeSymlinkPublicationBinding {
  for (const name of ["linkSymlinkNoReplace", "exchangePaths", "renameNoReplace"] as const) {
    if (typeof value !== "object" || value === null || !(name in value)
      || typeof (value as Record<string, unknown>)[name] !== "function") {
      throw new Error(`native filesystem addon must export ${name}`);
    }
  }
  return value as NativeSymlinkPublicationBinding;
}

const require = createRequire(import.meta.url);

/** Uses the already-shipped OS addon: Node's linkSync follows symlinks on macOS. */
export function publishSymlinkNoReplace(source: string, destination: string): void {
  validateNativeSymlinkPublicationBinding(require(nativeStateLockAddonPath()))
    .linkSymlinkNoReplace(source, destination);
}

export function exchangePaths(source: string, destination: string): void {
  validateNativeSymlinkPublicationBinding(require(nativeStateLockAddonPath())).exchangePaths(source, destination);
}

export function renameNoReplace(source: string, destination: string): void {
  validateNativeSymlinkPublicationBinding(require(nativeStateLockAddonPath())).renameNoReplace(source, destination);
}
