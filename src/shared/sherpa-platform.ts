/** Platforms for which the build publishes the sherpa addon and its helper entry points. */
export function supportsSherpaHelpers(platform: string, arch: string): boolean {
  return (platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64");
}
