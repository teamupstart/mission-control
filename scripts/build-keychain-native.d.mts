export type KeychainBuildTarget =
  | { kind: "skip"; platform: string }
  | { kind: "build"; arch: "arm64" | "x64" };

export function keychainBuildTarget(platform: string, arch: string): KeychainBuildTarget;

export function buildKeychainNative(): Promise<void>;
