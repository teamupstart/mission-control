export type ElectronFrameworkState =
  | "not-applicable"
  | "present"
  | "repaired"
  | "runtime-repair-required";

export function ensureElectronFramework(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronFrameworkState;

export function prepareElectronFrameworkForRuntimeRepair(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronFrameworkState;
