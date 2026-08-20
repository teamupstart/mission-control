import type { spawnSync } from "node:child_process";

export interface ElectronRuntimeProbeReady {
  ok: true;
  version: string;
  executable: string;
}

export interface ElectronRuntimeProbeFailed {
  ok: false;
  reason: string;
}

export type ElectronRuntimeProbe = ElectronRuntimeProbeReady | ElectronRuntimeProbeFailed;

export interface ElectronRuntimeEnvironment {
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawnSync;
}

export interface ElectronRuntimeEnsureOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn">;
}

export function probeElectronRuntime(
  electronPackageDir: string,
  options?: ElectronRuntimeEnvironment,
): ElectronRuntimeProbe;

export function ensureElectronRuntime(
  electronPackageDir?: string,
  options?: ElectronRuntimeEnsureOptions,
): { repaired: boolean; probe: ElectronRuntimeProbeReady };
