import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "./state-ownership-native.ts";

interface NativeSymlinkPublicationBinding {
  linkSymlinkNoReplace(source: string, destination: string): void;
}

export function validateNativeSymlinkPublicationBinding(value: unknown): NativeSymlinkPublicationBinding {
  if (typeof value !== "object" || value === null || !("linkSymlinkNoReplace" in value)
    || typeof value.linkSymlinkNoReplace !== "function") {
    throw new Error("native filesystem addon must export linkSymlinkNoReplace");
  }
  return value as NativeSymlinkPublicationBinding;
}

const require = createRequire(import.meta.url);

/** Uses the already-shipped OS addon: Node's linkSync follows symlinks on macOS. */
export function publishSymlinkNoReplace(source: string, destination: string): void {
  validateNativeSymlinkPublicationBinding(require(nativeStateLockAddonPath()))
    .linkSymlinkNoReplace(source, destination);
}
