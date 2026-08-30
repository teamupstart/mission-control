export type StateLockBuildTarget = {
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
};

export function stateLockBuildTarget(platform: string, arch: string): StateLockBuildTarget;
export function buildStateLockNative(): Promise<void>;
