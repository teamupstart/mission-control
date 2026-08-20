export type ElectronFrameworkState = "not-applicable" | "present" | "repaired";

export function ensureElectronFramework(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronFrameworkState;
