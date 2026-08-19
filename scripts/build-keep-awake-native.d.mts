export type NativeBuildTarget =
  | { kind: "skip"; platform: string }
  | { kind: "build"; arch: "arm64" | "x64" };

export function nativeBuildTarget(platform: string, arch: string): NativeBuildTarget;
