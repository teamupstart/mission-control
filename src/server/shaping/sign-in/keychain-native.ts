import { createRequire } from "node:module";
import { dirname, join, parse, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The native Keychain addon (`native/keychain/`), as the daemon sees it. Every call returns a
 * promise whose Security framework work runs off the event loop. A failure rejects with fixed
 * text and, for a Security failure, the OSStatus as `status`, never with a value.
 */
export interface NativeKeychainBinding {
  /** The item's value, or null when there is no such item. */
  get(service: string, account: string): Promise<string | null>;
  /** Adds the item, or replaces its value and label when it exists. A value over 256 KiB is refused. */
  set(service: string, account: string, value: string, label: string): Promise<void>;
  /** True when an item was removed, false when there was none. */
  remove(service: string, account: string): Promise<boolean>;
  /** The account of every item with this service. Reads attributes only, never a value. */
  accounts(service: string): Promise<string[]>;
}

type RequireFn = (id: string) => unknown;

const ADDON_FUNCTIONS = ["get", "set", "remove", "accounts"] as const;

/**
 * `dist/native/keychain.node` below the checkout or app root. This module runs from source
 * (`src/server/shaping/sign-in/`) and bundled into `dist/server/index.mjs`, at different
 * depths, so the root is found as the parent of the innermost `src/server` or `dist/server`.
 */
export function nativeKeychainAddonPath(moduleUrl = import.meta.url): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const { root } = parse(directory);
  const parts = directory.slice(root.length).split(sep);
  for (let i = parts.length - 1; i >= 1; i--) {
    if (parts[i] === "server" && (parts[i - 1] === "src" || parts[i - 1] === "dist")) {
      return join(root, ...parts.slice(0, i - 1), "dist", "native", "keychain.node");
    }
  }
  throw new Error("native Keychain addon path: module is not under src/server or dist/server");
}

export function validateNativeKeychainBinding(value: unknown): NativeKeychainBinding {
  for (const name of ADDON_FUNCTIONS) {
    if (
      typeof value !== "object" ||
      value === null ||
      !(name in value) ||
      typeof (value as Record<string, unknown>)[name] !== "function"
    ) {
      throw new Error("native Keychain addon must export get, set, remove and accounts functions");
    }
  }
  return value as NativeKeychainBinding;
}

/**
 * Load and validate the addon. Loading has no side effect: no Keychain call is made. Throws a
 * clear error when the addon is missing, does not load, or lacks one of its four functions.
 */
export function loadNativeKeychainBinding(
  requireFn: RequireFn = createRequire(import.meta.url),
): NativeKeychainBinding {
  const path = nativeKeychainAddonPath();
  let loaded: unknown;
  try {
    loaded = requireFn(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`native Keychain addon could not be loaded from ${path}: ${detail}`, { cause: err });
  }
  return validateNativeKeychainBinding(loaded);
}
