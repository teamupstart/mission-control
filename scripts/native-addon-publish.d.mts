export function clearDarwinProvenance(
  path: string,
  platform?: NodeJS.Platform,
  execute?: typeof import("node:child_process").execFileSync,
): boolean;

export function publishNativeAddon(built: string, output: string): Promise<void>;
