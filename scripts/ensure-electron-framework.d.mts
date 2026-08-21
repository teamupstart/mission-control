export type ElectronFrameworkState =
  | "not-applicable"
  | "payload-missing"
  | "present"
  | "repaired";

export function ensureElectronFramework(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronFrameworkState;
