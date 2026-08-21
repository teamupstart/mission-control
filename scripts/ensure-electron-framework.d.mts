export type ElectronFrameworkState = "not-applicable" | "present" | "repaired";
export type ElectronPayloadRestore = "not-applicable" | "restored";

export function ensureElectronFramework(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronFrameworkState;

export function electronPayloadPresent(
  repoRoot: string,
  platform?: NodeJS.Platform,
): boolean;

export function restoreElectronPayload(
  repoRoot: string,
  platform?: NodeJS.Platform,
): ElectronPayloadRestore;
