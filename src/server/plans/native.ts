import { createRequire } from "node:module";
import { nativeStateLockAddonPath } from "../state-ownership-native.ts";

interface NativePlanFilesBinding {
  openPlanEntry(parent: number, name: string, flags: number): number;
  makePlanDirectory(parent: number, name: string): void;
  renamePlanEntry(parent: number, source: string, destination: string, exchange: boolean): void;
  unlinkPlanEntry(parent: number, name: string, directory: boolean): void;
  readPlanDirectory(parent: number): string[];
  readPlanDirectoryEntries(parent: number, limit: number, timeoutMs: number): Promise<Array<{ name: string; directory: boolean }>>;
  removePlanDirectory(parent: number, name: string): Promise<void>;
}

export function validateNativePlanFilesBinding(value: unknown): NativePlanFilesBinding {
  for (const name of ["openPlanEntry", "makePlanDirectory", "renamePlanEntry", "unlinkPlanEntry", "readPlanDirectory", "readPlanDirectoryEntries", "removePlanDirectory"] as const) {
    if (typeof value !== "object" || value === null || !(name in value)
      || typeof (value as Record<string, unknown>)[name] !== "function") {
      throw new Error(`native filesystem addon must export ${name}`);
    }
  }
  return value as NativePlanFilesBinding;
}

const require = createRequire(import.meta.url);
export function nativePlanFiles(): NativePlanFilesBinding {
  return validateNativePlanFilesBinding(require(nativeStateLockAddonPath()));
}
