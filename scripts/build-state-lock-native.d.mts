export type StateLockBuildTarget = {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
};

export function stateLockBuildTarget(platform: string, arch: string): StateLockBuildTarget;
export function clearDarwinProvenance(
  path: string,
  platform?: NodeJS.Platform,
  execute?: typeof import("node:child_process").execFileSync,
): boolean;
export function buildStateLockNative(): Promise<void>;
